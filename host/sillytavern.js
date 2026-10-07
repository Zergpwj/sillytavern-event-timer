/**
 * 酒馆（SillyTavern）宿主适配。
 *
 * 只使用官方对外接口：
 *   - `SillyTavern.getContext()`  —— 唯一的依赖注入入口
 *   - `context.eventSource` / `eventTypes`
 *   - `context.setExtensionPrompt()`  —— 隐形提示词注入
 *   - `context.chatMetadata` + `saveMetadataDebounced()` —— 随聊天记录存档
 *   - `context.extensionSettings` + `saveSettingsDebounced()` —— 全局设置
 *
 * 所有对 context 的读取都通过 `ctx()` 现取现用，绝不缓存，因为切换聊天时
 * 酒馆会整体替换 `chat` / `chat_metadata` 这两个变量。
 */

import { getSTContext, PROMPT_ROLE, stEventName } from './bridge.js';

export const STORAGE_KEY = 'story_timer';

/** 事件名 → 内部事件类型 */
const EVENT_MAP = {
    MESSAGE_RECEIVED: 'message-received',
    MESSAGE_SENT: 'message-sent',
    MESSAGE_EDITED: 'message-edited',
    MESSAGE_DELETED: 'message-deleted',
    MESSAGE_SWIPED: 'message-swiped',
    MESSAGE_UPDATED: 'message-updated',
    USER_MESSAGE_RENDERED: 'user-message-rendered',
    CHARACTER_MESSAGE_RENDERED: 'character-message-rendered',
    CHAT_CHANGED: 'chat-changed',
    CHAT_CREATED: 'chat-changed',
    CHAT_LOADED: 'chat-loaded',
    GENERATION_AFTER_COMMANDS: 'before-generation',
    GENERATION_STARTED: 'generation-started',
    GENERATION_ENDED: 'generation-ended',
    GENERATION_STOPPED: 'generation-stopped',
    APP_READY: 'app-ready',
    SETTINGS_LOADED_AFTER: 'settings-loaded',
};

export function createSillyTavernHost() {
    const listeners = new Map();
    const bound = [];

    const ctx = () => getSTContext();

    const emit = (type, payload) => {
        for (const fn of [...(listeners.get(type) ?? [])]) {
            try { fn(payload); } catch (err) { console.error(`[event-timer] ${type} 处理失败`, err); }
        }
    };

    /** 从 chat 数组里取出规范化后的消息列表 */
    function getChatMessages() {
        const context = ctx();
        const chat = Array.isArray(context?.chat) ? context.chat : [];
        return chat.map((msg, index) => ({
            index,
            text: String(msg?.mes ?? ''),
            isUser: !!msg?.is_user,
            isSystem: !!msg?.is_system,
            name: String(msg?.name ?? ''),
            swipeId: msg?.swipe_id ?? 0,
        }));
    }

    const host = {
        kind: 'sillytavern',
        label: 'SillyTavern 酒馆',
        storageKey: STORAGE_KEY,

        capabilities: {
            injection: true,
            chatMetadata: true,
            extensionSettings: true,
            events: true,
            prefillInput: true,
            quietPrompt: true,
            slashCommands: true,
        },

        ready() {
            return !!ctx();
        },

        /** 注册宿主事件；返回取消订阅函数 */
        onEvent(type, handler) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
            return () => listeners.get(type)?.delete(handler);
        },

        /** 绑定酒馆 eventSource */
        attach() {
            const context = ctx();
            if (!context?.eventSource || typeof context.eventSource.on !== 'function') {
                console.warn('[event-timer] 找不到 eventSource，事件驱动不可用');
                return;
            }
            for (const [stName, internal] of Object.entries(EVENT_MAP)) {
                const eventName = stEventName(context, stName);
                if (!eventName) continue;
                const wrapper = (...args) => {
                    try {
                        emit(internal, { args, stName });
                    } catch (err) {
                        console.error('[event-timer] 事件转发失败', err);
                    }
                };
                context.eventSource.on(eventName, wrapper);
                bound.push([eventName, wrapper]);
            }
        },

        detach() {
            const context = ctx();
            for (const [name, wrapper] of bound) {
                try { context?.eventSource?.removeListener?.(name, wrapper); } catch { /* 忽略 */ }
            }
            bound.length = 0;
        },

        // ───────────── 持久化 ─────────────

        loadSettings() {
            const context = ctx();
            const fromContext = context?.extensionSettings?.[STORAGE_KEY];
            if (fromContext && typeof fromContext === 'object') return fromContext;
            const legacy = globalThis.extension_settings?.[STORAGE_KEY];
            return legacy && typeof legacy === 'object' ? legacy : null;
        },

        saveSettings(settings) {
            const context = ctx();
            const target = context?.extensionSettings ?? globalThis.extension_settings;
            if (!target) return false;
            target[STORAGE_KEY] = settings;
            try {
                if (typeof context?.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
                else if (typeof globalThis.saveSettingsDebounced === 'function') globalThis.saveSettingsDebounced();
            } catch (err) {
                console.warn('[event-timer] 保存设置失败', err);
                return false;
            }
            return true;
        },

        loadChatState() {
            const state = ctx()?.chatMetadata?.[STORAGE_KEY];
            return state && typeof state === 'object' ? state : null;
        },

        saveChatState(state) {
            const context = ctx();
            const meta = context?.chatMetadata;
            if (!meta) return false;
            meta[STORAGE_KEY] = state;
            try {
                if (typeof context.saveMetadataDebounced === 'function') context.saveMetadataDebounced();
                else if (typeof context.updateChatMetadata === 'function') context.updateChatMetadata({ [STORAGE_KEY]: state });
            } catch (err) {
                console.warn('[event-timer] 保存聊天数据失败', err);
                return false;
            }
            return true;
        },

        // ───────────── 聊天内容 ─────────────

        getChatMessages,
        getChatId() {
            const context = ctx();
            try {
                return context?.getCurrentChatId?.() ?? null;
            } catch {
                return null;
            }
        },

        // ───────────── 注入 ─────────────

        /**
         * 写入隐形提示词。
         * @param {string} text
         * @param {{position?:number, depth?:number, role?:number, scan?:boolean}} [opts]
         */
        setInjection(text, opts = {}) {
            const context = ctx();
            if (typeof context?.setExtensionPrompt !== 'function') return false;
            const position = Number.isFinite(opts.position) ? opts.position : 1; // IN_CHAT
            const depth = Number.isFinite(opts.depth) ? opts.depth : 0;
            const role = Number.isFinite(opts.role) ? opts.role : PROMPT_ROLE.SYSTEM;
            try {
                context.setExtensionPrompt(STORAGE_KEY, String(text ?? ''), position, depth, !!opts.scan, role);
                return true;
            } catch (err) {
                console.error('[event-timer] 注入失败', err);
                return false;
            }
        },

        clearInjection() {
            return host.setInjection('');
        },

        getInjection() {
            const prompts = ctx()?.extensionPrompts;
            return String(prompts?.[STORAGE_KEY]?.value ?? '');
        },

        // ───────────── 配置档案：当前对话的标识 ─────────────

        /**
         * 当前角色卡 / 群聊的**稳定标识**，用来把配置档案绑上去。
         * 用 avatar 文件名而不是名字，因为名字会被改，avatar 不会。
         * @returns {string|null} 形如 'char:alice.png' / 'group:123'
         */
        getCharacterKey() {
            const context = ctx();
            if (!context) return null;
            try {
                if (context.groupId) return `group:${context.groupId}`;
                const chid = context.characterId;
                if (chid == null || chid === '' || chid === -1) return null;
                const ch = context.characters?.[chid];
                if (!ch) return null;
                const avatar = String(ch.avatar || '').trim();
                if (avatar) return `char:${avatar}`;
                const name = String(ch.name || '').trim();
                return name ? `char:${name}` : null;
            } catch {
                return null;
            }
        },

        /** 给界面看的人类可读名字 */
        getCharacterLabel() {
            const context = ctx();
            try {
                if (context?.groupId) {
                    const group = context.groups?.find((g) => g.id == context.groupId);
                    return group?.name ? `群聊：${group.name}` : '群聊';
                }
                const ch = context?.characters?.[context.characterId];
                return ch?.name ? String(ch.name) : '（未选择角色）';
            } catch {
                return '（未知）';
            }
        },

        /**
         * 收集推断历法用的线索。
         * @param {{ sources?: any, maxEntries?: number, maxChars?: number, maxMessages?: number }} [opts]
         */
        async getContextClues(opts = {}) {
            const context = ctx();
            if (!context) return null;

            const sources = {
                worldInfo: true,
                character: true,
                chat: true,
                persona: false,
                ...(opts.sources ?? {}),
            };
            const maxEntries = opts.maxEntries ?? 40;
            const maxChars = opts.maxChars ?? 6000;
            const maxMessages = opts.maxMessages ?? 12;

            const clues = { chatName: null, character: null, persona: '', worldInfo: [], recentMessages: [] };

            try {
                clues.chatName = context.getCurrentChatId?.() ?? null;
            } catch { /* 忽略 */ }

            // ── 角色卡 ──
            if (sources.character) {
                try {
                    const ch = context.characters?.[context.characterId];
                    if (ch) {
                        clues.character = {
                            name: String(ch.name ?? ''),
                            description: String(ch.description ?? ''),
                            personality: String(ch.personality ?? ''),
                            scenario: String(ch.scenario ?? ''),
                            systemPrompt: String(ch.system_prompt ?? ch.data?.system_prompt ?? ''),
                        };
                    }
                } catch { /* 忽略 */ }
            }

            // ── 用户人设 ──
            if (sources.persona) {
                try {
                    clues.persona = String(context.powerUserSettings?.persona_description ?? '');
                } catch { /* 忽略 */ }
            }

            // ── 世界书 ──
            if (sources.worldInfo) {
                const names = new Set();
                try {
                    const chatBook = context.chatMetadata?.world_info;
                    if (chatBook) names.add(String(chatBook));
                } catch { /* 忽略 */ }
                try {
                    const ch = context.characters?.[context.characterId];
                    const cardBook = ch?.data?.extensions?.world;
                    if (cardBook) names.add(String(cardBook));
                } catch { /* 忽略 */ }

                // 没有任何绑定时，退而取前几个世界书（用户显式开启 worldInfoAll 才会这么做）
                if (!names.size && opts.worldInfoAll) {
                    try {
                        for (const n of context.getWorldInfoNames?.() ?? []) names.add(String(n));
                    } catch { /* 忽略 */ }
                }

                let budget = maxChars;
                for (const name of names) {
                    if (clues.worldInfo.length >= maxEntries || budget <= 0) break;
                    try {
                        const data = await context.loadWorldInfo?.(name);
                        const entries = data?.entries ?? {};
                        for (const entry of Object.values(entries)) {
                            if (clues.worldInfo.length >= maxEntries || budget <= 0) break;
                            if (entry?.disable) continue;
                            const content = String(entry?.content ?? '').trim();
                            if (!content) continue;
                            const clipped = content.length > budget ? content.slice(0, budget) : content;
                            budget -= clipped.length;
                            clues.worldInfo.push({
                                book: name,
                                comment: String(entry?.comment ?? ''),
                                key: Array.isArray(entry?.key) ? entry.key.join(', ') : String(entry?.key ?? ''),
                                content: clipped,
                            });
                        }
                    } catch (err) {
                        console.warn('[event-timer] 读取世界书失败', name, err);
                    }
                }
            }

            // ── 对话片段：开头几段（定基调）+ 结尾几段（当前时间）──
            if (sources.chat) {
                try {
                    const chat = Array.isArray(context.chat) ? context.chat : [];
                    const picked = [];
                    const seen = new Set();
                    // 开头几段定基调、结尾几段给当前时间；聊天很短时两头会重叠，去重
                    const head = chat.slice(0, 3);
                    const tail = maxMessages > 3 ? chat.slice(-(maxMessages - 3)) : [];
                    for (const msg of [...head, ...tail]) {
                        if (!msg || seen.has(msg)) continue;
                        seen.add(msg);
                        const text = String(msg?.mes ?? '').trim();
                        if (!text) continue;
                        picked.push({
                            name: String(msg?.name ?? (msg?.is_user ? '用户' : '角色')),
                            isUser: !!msg?.is_user,
                            text: text.length > 600 ? `${text.slice(0, 600)}…` : text,
                        });
                    }
                    clues.recentMessages = picked;
                } catch { /* 忽略 */ }
            }

            return clues;
        },

        // ───────────── 输入框 ─────────────

        getInputText() {
            const el = document.getElementById('send_textarea');
            return el ? String(el.value ?? '') : '';
        },

        setInputText(text) {
            const el = document.getElementById('send_textarea');
            if (!el) return false;
            el.value = String(text ?? '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        },

        appendToInput(text) {
            const current = host.getInputText();
            const joined = current.trim() ? `${current.trimEnd()}\n\n${text}` : String(text);
            return host.setInputText(joined);
        },

        focusInput() {
            try { document.getElementById('send_textarea')?.focus(); } catch { /* 忽略 */ }
        },

        // ───────────── 提示 ─────────────

        toast(message, type = 'info') {
            try {
                const t = globalThis.toastr;
                if (t && typeof t[type] === 'function') {
                    t[type](String(message), '事件计时器');
                    return;
                }
            } catch { /* 落到下面的通用实现 */ }
            import('../ui/dom.js').then(({ toast }) => toast(message, type)).catch(() => { });
        },

        // ───────────── 其它 ─────────────

        /** 安静地问一次模型（用于可选的 LLM 抽取） */
        async quietPrompt(prompt, { responseLength = 400 } = {}) {
            const context = ctx();
            if (typeof context?.generateQuietPrompt === 'function') {
                return context.generateQuietPrompt({ quietPrompt: prompt, quietToLoud: false, skipWIAN: true, responseLength });
            }
            if (typeof context?.generate === 'function') {
                return context.generate('quiet', { quiet_prompt: prompt, force_name2: true, skipWIAN: true });
            }
            throw new Error('当前酒馆版本不支持生成静默请求');
        },

        /** 把设置抽屉挂到扩展设置区 */
        getSettingsContainer() {
            return document.getElementById('extensions_settings2')
                ?? document.getElementById('extensions_settings')
                ?? null;
        },
    };

    return host;
}
