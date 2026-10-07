/**
 * 通用宿主适配 —— 用于酒馆之外的 AI 角色扮演应用 / 浏览器 / 用户脚本。
 *
 * 提供两种接入方式：
 *   1. **API 方式**：任何能执行 JS 的环境调用 `window.StoryTimer.observe(文本)` 投喂 AI 正文；
 *   2. **DOM 监听方式**：给一个 CSS 选择器，插件用 MutationObserver 自动抓取新出现的正文。
 *
 * 注入方面，通用宿主没有「隐形提示词」这种特权，所以走：
 *   - 生成提醒文本 → `window.StoryTimer.getInjection()` 取用，或
 *   - 自动写进指定输入框（`inputSelector`），或
 *   - 复制到剪贴板。
 */

const SETTINGS_KEY = 'story_timer.settings';
const STATE_PREFIX = 'story_timer.chat.';

function safeGet(key) {
    try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function safeSet(key, value) {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
        return true;
    } catch (err) {
        console.warn('[event-timer] localStorage 写入失败', err);
        return false;
    }
}

export function createGenericHost(options = {}) {
    const listeners = new Map();
    /** @type {Array<{index:number,text:string,isUser:boolean,isSystem:boolean,name:string}>} */
    let messages = [];
    let chatKey = options.chatKey || 'default';
    let observer = null;
    let injectionText = '';

    const emit = (type, payload) => {
        for (const fn of [...(listeners.get(type) ?? [])]) {
            try { fn(payload); } catch (err) { console.error(`[event-timer] ${type} 处理失败`, err); }
        }
    };

    const host = {
        kind: 'generic',
        label: '通用宿主（其它应用 / 浏览器）',
        storageKey: 'story_timer',

        capabilities: {
            injection: false,
            chatMetadata: false,
            extensionSettings: false,
            events: true,
            prefillInput: !!options.inputSelector,
            quietPrompt: false,
            slashCommands: false,
        },

        ready() { return true; },

        onEvent(type, handler) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
            return () => listeners.get(type)?.delete(handler);
        },

        attach() {
            if (options.autoObserveSelector) host.attachDomWatcher(options.autoObserveSelector);
        },

        detach() {
            host.detachDomWatcher();
        },

        // ───────────── 持久化 ─────────────

        loadSettings() { return safeGet(SETTINGS_KEY); },
        saveSettings(settings) { return safeSet(SETTINGS_KEY, settings); },

        loadChatState() { return safeGet(STATE_PREFIX + chatKey); },
        saveChatState(state) { return safeSet(STATE_PREFIX + chatKey, state); },

        getChatId() { return chatKey; },
        setChatId(key) {
            chatKey = String(key || 'default');
            emit('chat-changed', { chatId: chatKey });
        },

        // ───────────── 聊天内容 ─────────────

        getChatMessages() { return messages.map((m) => ({ ...m })); },

        /**
         * 投喂一条消息。这是通用宿主的入口。
         * @param {string} text
         * @param {{ isUser?: boolean, isSystem?: boolean, name?: string, silent?: boolean }} [meta]
         */
        pushMessage(text, meta = {}) {
            const entry = {
                index: messages.length,
                text: String(text ?? ''),
                isUser: !!meta.isUser,
                isSystem: !!meta.isSystem,
                name: String(meta.name ?? ''),
            };
            messages.push(entry);
            if (!meta.silent) {
                const type = entry.isUser ? 'message-sent' : 'message-received';
                emit(type, { index: entry.index, message: entry, args: [entry.index] });
            }
            return entry;
        },

        /** 清空已收集的消息（换聊天时用） */
        resetMessages() {
            messages = [];
            emit('chat-changed', { chatId: chatKey });
        },

        setMessages(list) {
            messages = (Array.isArray(list) ? list : []).map((m, i) => ({
                index: i,
                text: String(typeof m === 'string' ? m : (m?.text ?? '')),
                isUser: !!(typeof m === 'object' && m?.isUser),
                isSystem: !!(typeof m === 'object' && m?.isSystem),
                name: String((typeof m === 'object' && m?.name) || ''),
            }));
            emit('chat-changed', { chatId: chatKey });
        },

        /** 通知宿主：用户发了一条消息（用于触发注入） */
        notifyUserSent(text) {
            return host.pushMessage(text, { isUser: true });
        },

        // ───────────── DOM 监听 ─────────────

        /**
         * 监听某个容器里新出现的正文元素。
         * @param {string|{container:string, message:string, userMessage?:string}} selector
         */
        attachDomWatcher(selector) {
            host.detachDomWatcher();
            const spec = typeof selector === 'string'
                ? { container: selector, message: selector }
                : selector;
            if (!spec?.container) return false;

            const container = document.querySelector(spec.container);
            if (!container) {
                console.warn('[event-timer] 找不到监听容器', spec.container);
                return false;
            }

            const seen = new WeakSet();
            const collect = () => {
                const nodes = spec.message ? container.querySelectorAll(spec.message) : [container];
                for (const node of nodes) {
                    if (seen.has(node)) continue;
                    seen.add(node);
                    const text = node.innerText ?? node.textContent ?? '';
                    if (!text.trim()) continue;
                    const isUser = spec.userMessage ? node.matches(spec.userMessage) : false;
                    host.pushMessage(text, { isUser });
                }
            };

            observer = new MutationObserver(() => collect());
            observer.observe(container, { childList: true, subtree: true, characterData: true });
            collect();
            return true;
        },

        detachDomWatcher() {
            observer?.disconnect();
            observer = null;
        },

        // ───────────── 注入 ─────────────

        setInjection(text, opts = {}) {
            injectionText = String(text ?? '');
            const target = opts.inputSelector ?? options.inputSelector;
            if (target && injectionText) {
                // 通用宿主智能到「把提醒写进输入框」这一层，剩下的交给用户确认后发送
                try {
                    const el = document.querySelector(target);
                    if (el && 'value' in el) {
                        el.value = el.value.trim() ? `${el.value.trimEnd()}\n\n${injectionText}` : injectionText;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                } catch (err) {
                    console.warn('[event-timer] 写入输入框失败', err);
                }
            }
            emit('injection-changed', { text: injectionText });
            return true;
        },

        clearInjection() {
            injectionText = '';
            emit('injection-changed', { text: '' });
            return true;
        },

        getInjection() { return injectionText; },

        // ───────────── 配置档案 / 线索 ─────────────

        /** 通用宿主没有角色概念，用调用方设定的 chatKey 当档案键 */
        getCharacterKey() {
            return options.profileKeyFromChatKey === false ? null : `chat:${chatKey}`;
        },

        getCharacterLabel() {
            return options.chatLabel || `对话：${chatKey}`;
        },

        /** 通用宿主只有自己的消息缓存可以当线索 */
        async getContextClues(opts = {}) {
            const maxMessages = opts.maxMessages ?? 12;
            const picked = [];
            const seen = new Set();
            const head = messages.slice(0, 3);
            const tail = maxMessages > 3 ? messages.slice(-(maxMessages - 3)) : [];
            for (const msg of [...head, ...tail]) {
                if (seen.has(msg)) continue;   // 短对话时两头会重叠
                seen.add(msg);
                const text = String(msg.text ?? '').trim();
                if (!text) continue;
                picked.push({
                    name: msg.name || (msg.isUser ? '用户' : '角色'),
                    isUser: msg.isUser,
                    text: text.length > 600 ? `${text.slice(0, 600)}…` : text,
                });
            }
            return {
                chatName: chatKey,
                character: options.characterClues ?? null,
                persona: '',
                worldInfo: Array.isArray(options.worldInfoClues) ? options.worldInfoClues : [],
                recentMessages: picked,
            };
        },

        // ───────────── 输入框 ─────────────

        getInputText() {
            const selector = options.inputSelector;
            if (!selector) return '';
            const el = document.querySelector(selector);
            return el && 'value' in el ? String(el.value ?? '') : '';
        },

        setInputText(text) {
            const selector = options.inputSelector;
            if (!selector) return false;
            const el = document.querySelector(selector);
            if (!el || !('value' in el)) return false;
            el.value = String(text ?? '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        },

        appendToInput(text) {
            const current = host.getInputText();
            return host.setInputText(current.trim() ? `${current.trimEnd()}\n\n${text}` : String(text));
        },

        focusInput() {
            const selector = options.inputSelector;
            if (!selector) return;
            try { document.querySelector(selector)?.focus(); } catch { /* 忽略 */ }
        },

        async copyToClipboard(text) {
            // 走 ui/dom.js 里的 copyText：它会在非安全上下文里用 execCommand 兜底
            try {
                const { copyText } = await import('../ui/dom.js');
                return await copyText(text);
            } catch {
                return false;
            }
        },

        // ───────────── 提示 ─────────────

        toast(message, type = 'info') {
            import('../ui/dom.js').then(({ toast }) => toast(message, type)).catch(() => { });
        },

        getSettingsContainer() {
            return document.getElementById(options.settingsContainer || 'st-timer-settings-host');
        },
    };

    return host;
}
