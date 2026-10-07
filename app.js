/**
 * 应用层 —— 把「核心引擎」「宿主」「界面」粘起来。
 *
 * 这一层完全不知道酒馆的存在，只依赖 `host` 对象暴露的抽象接口，
 * 所以同一份代码既跑在酒馆里，也跑在独立页面 / 用户脚本 / 其它应用里。
 */

import { TimerEngine, computeSignature } from './core/engine.js';
import { createDefaultConfig, mergeConfig, STATE_VERSION } from './core/default-config.js';
import { DEFAULT_TAG_NAMES, extractTagBlocks } from './core/parser.js';
import {
    activateProfileFor,
    addPrompt,
    bindProfile,
    deleteProfile,
    deletePrompt,
    duplicatePrompt,
    getActivePrompt,
    listProfileBindings,
    migrateLegacyPrompt,
    normalizeProfileStore,
    normalizePromptLibrary,
    renameProfile,
    renamePrompt,
    resolveProfileId,
    saveProfile,
    setActivePrompt,
    updatePrompt,
    writeBackActiveConfig,
} from './core/profiles.js';
import { applyCalendarSpec, buildCalendarPrompt, parseCalendarAnswer } from './core/calendar-infer.js';
import { describeBackend, runInference } from './ai-client.js';

/**
 * 提示词库里那五个字段。
 *
 * 空值 = 用内置文案。`ensurePromptDefaults()` 会把空字段补成内置模板，
 * 所以正常跑起来之后这里不该再出现空值。
 */
export const PROMPT_KEYS = ['protocol', 'mid', 'late', 'origin', 'due'];

export class TimerApp {    /**
     * @param {{ host: any, config?: any, ui?: any }} options
     */
    constructor(options) {
        this.host = options.host;
        this.config = normalizeAppConfig(mergeConfig(createDefaultConfig(), options.config || {}));
        this.ui = options.ui || null;

        /** @type {TimerEngine} */
        this.engine = new TimerEngine({ config: this.config });
        // 起始时间交给引擎的时间门面决定：计数制取 startDay/startMinute，
        // 日历制取 calendar.startDate。这里**不能**直接读 time.startDay，
        // 否则日历模式下的起始时间会错成「1年1月1日」。
        this.engine.resetInitialClockToBase();

        this._saveTimer = null;
        this._settingsTimer = null;
        this._rebuildTimer = null;
        this._lastInjection = '';
        this._dirty = true;
        this._subscribers = new Set();

        this.engine.on('change', () => this.notify());
        this.engine.on('due', (events) => this.onDue(events));
    }

    // ───────────────────────────── 生命周期 ─────────────────────────────

    async init() {
        const savedSettings = this.host.loadSettings?.();
        if (savedSettings && typeof savedSettings === 'object') {
            this.config = normalizeAppConfig(mergeConfig(createDefaultConfig(), savedSettings));
            this.engine.setConfig(this.config);
        }

        this.host.attach?.();

        const sub = (type, fn) => this.host.onEvent(type, fn);
        sub('chat-changed', () => {
            // 换聊天了 —— 上一条待认领的记录属于上一局，不能让它飘到新局里
            this._pendingInjection = null;
            this.scheduleRebuild('chat-changed');
        });
        sub('message-received', (payload) => this.onMessageReceived(payload));
        sub('character-message-rendered', (payload) => this.onMessageRendered(payload));
        sub('message-edited', () => this.scheduleRebuild('message-edited'));
        sub('message-deleted', () => this.scheduleRebuild('message-deleted'));
        sub('message-swiped', () => this.scheduleRebuild('message-swiped'));
        sub('message-updated', () => this.scheduleRebuild('message-updated'));
        // ⚠️ 提交必须在**生成前**，不能在收到消息时。
        //
        // 原因：时钟是在 AI 消息到达时才推进的，所以「该提醒了」这件事也发生在那一刻。
        // 如果那时就 commit，等到下一次 before-generation 时 selectReminders() 已经选不出它，
        // 重算出来的注入文本只剩协议说明 —— 而我们又是**无条件重写**宿主的，
        // 于是那条提醒会在拼提示词前一刻被覆盖掉，**模型根本收不到**。
        //
        // 放在这里 commit 才是对的：这一刻写下去的就是即将发给模型的东西。
        // `_pendingInjection` 也就记下了"这次生成到底发了什么"，等你的发言入栈后认领。
        //
        // ⚠️ 这里**不能**去找「最近一条用户消息」来挂 —— 那一刻你的发言还没进聊天。
        // 酒馆的顺序是：GENERATION_AFTER_COMMANDS（script.js:4262）
        //            → sendMessageAsUser（script.js:4394，你的发言在这一步才入栈）
        // 所以这时候找，永远只能找到**上一条**用户消息，块会整整错一楼。
        // 认领放到 onMessageReceived —— 那时你的发言已经在聊天里了。
        sub('before-generation', (payload) => {
            // ⚠️ dry run 不能提交。
            //
            // 酒馆的 Generate(type, opts, dryRun)：dryRun 只**拼提示词**用于计数，
            // 不会产生消息（script.js:4389 的 `!dryRun` 把它挡在 sendMessageAsUser 之前）。
            // 可 GENERATION_AFTER_COMMANDS（4262）不管 dryRun 都会触发。
            // 在这里 commit 的话，提醒会被记成「送过了」「次数+1」，
            // 却没有任何消息承载它 —— 面板显示提醒过，聊天记录里却什么都没有。
            if (payload?.args?.[2] === true) {
                this.refreshInjection({ commit: false });
                return;
            }
            this.refreshInjection({ commit: true });
            this.notify();
        });
        sub('generation-stopped', () => this.refreshInjection({ commit: false }));
        sub('settings-loaded', () => this.onSettingsLoaded());
        // 兜底：酒馆在加载聊天 / 初始化完成时会 clearChat() 把 extension_prompts 清空，
        // 这两个时机再写一遍，确保注入一定活着。
        sub('chat-loaded', () => this.refreshInjection({ commit: false }));
        sub('app-ready', () => this.refreshInjection({ commit: false }));

        // 进入时先按当前角色卡套用绑定的档案
        this.syncProfileForCurrentChat({ force: true });

        this.ensurePromptDefaults();

        await this.loadChat();
        this.notify();
        return this;
    }

    /**
     * 提示词库里的空字段补上内置模板。
     *
     * 空字段本来表示「用内置」，可用户点开编辑器看到一片空白会以为坏了，
     * 而且空着也没法看、没法改。补成模板之后：打开就有内容、想改直接改。
     *
     * ⚠️ 补的是**模板**（带 {{tag}} / {{timeClock}} 这些占位符），不是渲染好的文本 ——
     * 存渲染结果会把「当前剧情时间」「标签名」「时长门槛」冻在保存的那一刻，
     * 模型会一直看到那个旧时间，甚至照着它写，时钟就卡住了。
     */
    ensurePromptDefaults() {
        const items = this.config.prompts?.items;
        if (!Array.isArray(items) || !items.length) return false;

        let templates = null;
        let changed = false;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            templates = templates ?? this.engine.builtinPromptTemplates();
            for (const key of PROMPT_KEYS) {
                const current = key === 'due' ? (item.due ?? item.reminder) : item[key];
                if (typeof current === 'string' && current.trim()) continue;
                item[key] = templates[key];
                changed = true;
            }
            // 老字段已经被 due 取代，别留着让人误会
            if (item.reminder != null) {
                item.reminder = null;
                changed = true;
            }
        }

        if (changed) {
            this.engine.setConfig(this.config);
            this.saveSettings();
        }
        return changed;
    }

    onSettingsLoaded() {
        const saved = this.host.loadSettings?.();
        if (!saved || typeof saved !== 'object') return;
        this.config = normalizeAppConfig(mergeConfig(createDefaultConfig(), saved));
        this.engine.setConfig(this.config);
        this.notify();
    }

    /** 订阅状态变化（界面用） */
    subscribe(fn) {
        this._subscribers.add(fn);
        return () => this._subscribers.delete(fn);
    }

    notify() {
        for (const fn of this._subscribers) {
            try { fn(this); } catch (err) { console.error('[event-timer] 界面刷新失败', err); }
        }
    }

    dispose() {
        clearTimeout(this._saveTimer);
        clearTimeout(this._settingsTimer);
        clearTimeout(this._rebuildTimer);
        this.host.detach?.();
    }

    // ───────────────────────────── 聊天状态 ─────────────────────────────

    /** 读取当前聊天的 AI 消息文本 */
    getAssistantMessages() {
        const messages = this.host.getChatMessages?.() ?? [];
        return messages.filter((m) => !m.isUser && !m.isSystem);
    }

    async loadChat() {
        // 换聊天时先套用该角色卡绑定的配置档案（时间制式、历法、提示词……）
        this.syncProfileForCurrentChat();

        const saved = this.host.loadChatState?.();
        const assistantTexts = this.getAssistantMessages().map((m) => m.text);
        const signature = computeSignature(assistantTexts);

        // 注意：起始时间要由时间门面给（日历制取 calendar.startDate），不能直接读 time.startDay
        this.engine.resetInitialClockToBase();

        if (saved?.engine) {
            this.engine.restore(saved.engine, { applyDerived: true });
            if (saved.chatSignature === signature) {
                this._dirty = false;
                this.refreshInjection({ commit: false });
                return;
            }
            // 聊天记录变了（换聊天 / 外部编辑）→ 全量重放校正
        }

        this.rebuild({ reason: 'load' });
    }

    /** 从聊天记录整体重放（会保留手动干预） */
    rebuild({ reason = 'manual', silent = false } = {}) {
        const assistantTexts = this.getAssistantMessages().map((m) => m.text);
        const result = this.engine.rebuild(assistantTexts, { reason });
        this._dirty = false;
        this.saveState();
        this.refreshInjection({ commit: false });
        if (!silent) this.notify();
        return result;
    }

    scheduleRebuild(reason) {
        clearTimeout(this._rebuildTimer);
        // 聊天切换时酒馆还没把 chat 数组填好，给它一点时间
        this._rebuildTimer = setTimeout(() => {
            this._dirty = true;
            if (reason === 'chat-changed') this.loadChat().then(() => this.notify());
            else this.rebuild({ reason });
        }, 60);
    }

    saveState() {
        clearTimeout(this._saveTimer);
        // 记录调度时的聊天 id：如果 400ms 内用户换了聊天，这次写入必须作废，
        // 否则会把上一个聊天的状态写进新聊天的元数据里。
        const scheduledFor = this.host.getChatId?.() ?? null;
        this._saveTimer = setTimeout(() => {
            try {
                if ((this.host.getChatId?.() ?? null) !== scheduledFor) return;
                const payload = {
                    version: STATE_VERSION,
                    chatSignature: computeSignature(this.getAssistantMessages().map((m) => m.text)),
                    engine: this.engine.serialize(),
                };
                this.host.saveChatState?.(payload);
            } catch (err) {
                console.error('[event-timer] 保存聊天状态失败', err);
            }
        }, 400);
    }

    saveSettings() {
        clearTimeout(this._settingsTimer);
        this._settingsTimer = setTimeout(() => {
            try { this.host.saveSettings?.(this.config); } catch (err) {
                console.error('[event-timer] 保存设置失败', err);
            }
        }, 300);
    }

    // ───────────────────────────── 消息处理 ─────────────────────────────

    async onMessageReceived(payload) {
        const messages = this.host.getChatMessages?.() ?? [];
        let message = null;
        const index = Array.isArray(payload?.args) ? payload.args[0] : payload?.index;
        if (Number.isInteger(index) && messages[index]) message = messages[index];
        if (!message) message = messages[messages.length - 1];
        if (!message || message.isUser || message.isSystem) return;
        if (!message.text?.trim()) return;

        // ── 认领这次生成的注入 ──
        //
        // 认领放在这里，不放在 before-generation：那一刻你的发言还**没进聊天**
        // （script.js:4262 触发钩子，4394 才把你的话入栈），所以那时候找
        // 「最近一条用户消息」只能找到上一条，块会错一楼。
        //
        // 现在你的发言已经在聊天里了（AI 回复排在它后面），
        // `lastUserMessageIndex()` 拿到的正是**触发这次生成的那一条**。
        //
        // 必须在 ingest 之前读 —— 那里面会重算注入，把 _pendingInjection 顶掉。
        const pending = this._pendingInjection;
        this._pendingInjection = null;
        const target = this.lastUserMessageIndex();
        if (pending?.text && target != null) {
            this.engine.recordInjection(target, pending);
        }

        await this.ingest(message.text, { sourceIndex: message.index });
    }

    onMessageRendered(payload) {
        const index = Array.isArray(payload?.args) ? payload.args[0] : payload?.index;
        const messages = this.host.getChatMessages?.() ?? [];
        const message = Number.isInteger(index) ? messages[index] : null;
        if (!message || message.isUser || message.isSystem) return;
        // MESSAGE_RECEIVED 已经处理过，这里只补一次状态刷新
        this.notify();
    }

    /**
     * 主入口：把一段 AI 正文喂给引擎。
     * @param {string} text
     * @param {{ sourceIndex?: number }} [meta]
     */
    async ingest(text, meta = {}) {
        if (!this.config.enabled) return null;
        if (!text || !text.trim()) return null;

        let result;
        try {
            result = this.engine.observeMessage(text, meta);
        } catch (err) {
            console.error('[event-timer] 解析正文失败', err);
            return null;
        }


        this.saveState();
        // 记账要跟着聊天记录走：更新签名，免得下次重建时把它误判成「内容变了」而清掉
        this.engine.setSignature(computeSignature(this.getAssistantMessages().map((m) => m.text)));
        // 只重算、不提交 —— 提交留给 before-generation（见那里的说明）
        this.refreshInjection({ commit: false });
        this.notify();
        return result;
    }


    onDue(events) {
        if (!events?.length) return;
        const names = events.map((e) => `《${e.title}》`).join('、');
        this.host.toast?.(`剧情时间到达：${names} 该有结果了`, 'info');
        this.ui?.flash?.(events);
    }

    // ───────────────────────────── 注入 ─────────────────────────────

    /**
     * 重新计算注入文本。
     * @param {{ commit?: boolean, forceProtocol?: boolean }} [opts]
     *        commit=true 表示「这一轮的提醒已经确定要发给 AI 了」，会计入提醒次数。
     */
    refreshInjection(opts = {}) {
        const cfg = this.config.injection;

        if (!this.config.enabled) {
            this.host.clearInjection?.();
            this._lastInjection = '';
            this._lastInjectionKey = '';
            this._pendingInjection = null;
            return { text: '', events: [] };
        }

        let text = '';
        let events = [];

        if (opts.commit) {
            const built = this.engine.buildAndCommitInjection({ forceProtocol: opts.forceProtocol });
            text = built.text;
            events = built.events;
        } else {
            events = this.engine.selectReminders();
            text = this.engine.buildInjectionText({ events, forceProtocol: opts.forceProtocol });
        }

        const key = `${cfg.mode}|${cfg.position}|${cfg.depth}|${cfg.role}|${cfg.scan ? 1 : 0}`;
        const changed = text !== this._lastInjection || key !== this._lastInjectionKey;
        this._lastInjection = text;
        this._lastInjectionKey = key;

        // 记下这一轮**真的发给模型的东西**，等你的发言入栈后挂到它身上。
        //
        // ⚠️ 不只是带提醒的时候 —— 协议说明默认每轮都在发。
        // 只在有提醒时记的话，「没有块」会被误读成「什么都没注入」。
        //
        // 只在 opts.commit（= 生成前那一刻）刷新这个待认领值：
        // 其它时机的 refresh 只更新宿主，不该顶掉「这次生成到底发了什么」。
        if (opts.commit) {
            const invisible = cfg.mode === 'hidden' || cfg.mode === 'both';
            const next = text && invisible
                ? {
                    text,
                    points: events.map((e) => e.reminderPoint ?? 'due'),
                    titles: events.map((e) => e.title),
                }
                : null;

            /**
             * ⚠️ 已经待认领的**带提醒**记录，不能被后面的「只有协议说明」顶掉。
             *
             * 一次生成里 `before-generation` 会触发多次：
             *   - function tool 续跑：Generate 递归调用（script.js:5376 / 5499）
             *   - dry run：只拼提示词不产生消息（script.js:4389 的 `!dryRun`）
             * 每一次我们都重算注入，可提醒**在第一次就 commit 掉了**，
             * 于是重算只剩协议说明 —— 一覆盖，这条提醒就被记成「送过了」
             * 却在聊天记录里**永远看不到**。用户看到的就是
             * 「面板说提醒了一次，但哪一楼都没有提醒块」。
             */
            const pendingHasReminder = (this._pendingInjection?.points?.length ?? 0) > 0;
            const nextHasReminder = (next?.points?.length ?? 0) > 0;
            if (!pendingHasReminder || nextHasReminder) {
                this._pendingInjection = next;
            }
        }

        // ⚠️ 这里**必须每次无条件写一遍**，不能「文本没变就跳过」。
        //
        // 酒馆的 clearChat()（切角色、切聊天、新建聊天都会调）里有一句
        //     extension_prompts = {};
        // 会把整个注入表替换掉。如果我们因为「文本和上次一样」而不重新写，
        // 注入就会在第一次切聊天之后永久消失 —— 表现就是「完全看不到提示词发出去」。
        //
        // setExtensionPrompt 只是一次对象赋值，代价可以忽略，不值得为它做缓存。
        if (cfg.mode === 'hidden' || cfg.mode === 'both') {
            const ok = this.host.setInjection?.(text, {
                position: cfg.position,
                depth: cfg.depth,
                role: cfg.role,
                scan: cfg.scan,
            });
            if (!ok) {
                console.warn('[事件计时器] 当前宿主不支持隐形注入，已降级为仅界面提醒');
            } else if (changed && this.config.advanced?.debug) {
                console.debug(`[事件计时器] 已注入 ${text.length} 字符（position=${cfg.position} depth=${cfg.depth} role=${cfg.role}）`);
            }
        } else if (changed) {
            this.host.clearInjection?.();
        }

        if (opts.commit && events.length && (cfg.mode === 'prefill' || cfg.mode === 'both')) {
            this.applyVisibleReminder(events);
        }

        return { text, events };
    }

    /**
     * 自检：把「注入这一环」的实际状态汇总出来，供设置面板一键查看。
     * 用户反馈「看不到注入」时，先看这里。
     */
    diagnoseInjection() {
        const cfg = this.config.injection;
        const lines = [];
        const host = this.host;

        lines.push(`宿主：${host.label ?? '?'}（${host.kind ?? '?'}）`);
        lines.push(`扩展启用：${this.config.enabled ? '是' : '否'}`);
        // 轮次 / 事件数以前单摆在设置里当两行只读值 —— 它们是排错信息，收到这里来
        lines.push(`当前剧情时间：${this.engine.formatClock()}`);
        lines.push(`已解析轮次：${this.engine.turns}　事件总数：${this.engine.events.length}`);
        lines.push(`写入模式：${cfg.mode === 'hidden' ? '隐形注入' : cfg.mode === 'prefill' ? '填进输入框' : '两者都做'}`);

        const canInject = typeof host.setInjection === 'function';
        lines.push(`宿主支持隐形注入：${canInject ? '是' : '否'}`);

        if (!this.config.enabled) {
            lines.push('→ 扩展被停用了，不会注入任何东西。');
            return lines.join('\n');
        }
        if (cfg.mode !== 'hidden' && cfg.mode !== 'both') {
            lines.push('→ 当前是「填进输入框」模式，本来就不会隐形注入。');
        }

        const preview = this.engine.buildInjectionText({ events: this.engine.selectReminders() });
        const fallback = preview || this._lastInjection || '';
        lines.push(`本轮应注入：${fallback ? `${fallback.length} 字符` : '（空）'}`);

        // 回读宿主里真正存着的东西 —— 这才是「提示词到底有没有发出去」的真相
        let actual = null;
        try {
            actual = host.getInjection?.() ?? null;
        } catch (err) {
            lines.push(`回读失败：${err?.message ?? err}`);
        }
        if (actual != null) {
            lines.push(`宿主里实际存着：${actual ? `${actual.length} 字符` : '（空）'}`);
            if (!actual) {
                lines.push('→ ⚠ 宿主里是空的！如果刚切过角色卡或聊天，点下面的「重新注入」试试。');
            } else {
                lines.push(`实际内容开头：${actual.slice(0, 60).replace(/\n/g, ' / ')}…`);
            }
        }

        lines.push(`协议说明：${this.config.reminder.includeProtocol ? '开' : '关'}`);
        lines.push(`到期事件：${this.engine.dueEvents.length} 个　进行中：${this.engine.activeEvents.length} 个`);

        // 最近一次真的带提醒的注入 —— 用户问「到底发出去过什么」时看这里
        const last = this.engine.state.lastInjection;
        if (last?.text) {
            lines.push('');
            lines.push(`最近一次带提醒的注入：第 ${last.turn} 轮（时点 ${(last.points ?? []).join(' / ')}）`);
            lines.push(last.text.slice(0, 200));
        } else {
            const history = this.engine.reminderHistory();
            if (history.length) {
                lines.push('');
                lines.push('提醒记录（原文未留存 —— 这些是升级前注入的）：');
                for (const h of history) {
                    const pts = [...h.points, ...(h.originCount ? [`预定终点（旧）×${h.originCount}`] : [])].join(' / ');
                    lines.push(`  · 《${h.title}》 ${pts}　第 ${h.turn ?? '?'} 轮`);
                }
            } else {
                lines.push('最近还没有注入过带提醒的文本（只发过协议说明）。');
            }
        }

        if (!this.config.reminder.includeProtocol && !this.engine.dueEvents.length) {
            lines.push('→ 没有到期事件、协议说明又关着，所以本来就不会注入。');
        }

        return lines.join('\n');
    }

    /** 可见模式：把提醒文本追加到输入框（用户可以编辑 / 删除后再发送） */
    applyVisibleReminder(events) {
        const body = this.engine.buildInjectionText({ events, forceProtocol: false });
        if (!body) return;
        const current = this.host.getInputText?.() ?? '';
        const firstLine = body.split('\n')[0];
        if (current.includes(firstLine)) return; // 避免重复堆叠
        this.host.appendToInput?.(body);
        this.host.focusInput?.();
        this.host.toast?.('已把到期提醒填入输入框（可见模式）', 'success');
    }

    /** 手动往输入框塞一次当前提醒 */
    pushReminderToInput() {
        const events = this.engine.selectReminders();
        const text = this.engine.buildInjectionText({ events });
        if (!text) {
            this.host.toast?.('当前没有需要提醒的事件', 'info');
            return false;
        }
        this.host.appendToInput?.(text);
        this.host.focusInput?.();
        return true;
    }

    /**
     * 某条消息里该折叠显示什么。消息块（`ui/message-blocks.js`）只调这一个。
     *
     * 对称的两半，跟模型思考块一个道理：
     *   用户消息 → **计时注入**（我们注入进提示词的提醒）
     *   AI 消息  → **计时输出**（它写的 <timer> 区块）
     *
     * @param {number} index
     * @returns {{ kind: 'injection'|'tag', text: string, points?: string[] }|null}
     */
    messageBlockFor(index) {
        if (!Number.isInteger(index)) return null;
        const message = (this.host.getChatMessages?.() ?? [])[index];
        if (!message) return null;

        if (message.isUser) {
            const rec = this.engine.injectionFor(index);
            return rec?.text ? { kind: 'injection', text: rec.text, points: rec.points ?? [] } : null;
        }

        // AI 消息：把它写的标签区块原样提出来（正则把它从显示里藏了，这里补回来）
        const blocks = extractTagBlocks(message.text ?? '', this.config.tagNames);
        if (!blocks.length) return null;
        return { kind: 'tag', text: blocks.map((b) => b.raw).join('\n\n') };
    }

    /** 当前聊天里最后一条用户消息的下标 */
    lastUserMessageIndex() {
        const messages = this.host.getChatMessages?.() ?? [];
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.isUser) return i;
        }
        return null;
    }

    /**
     * 取注入预览（界面展示用）。返回两样东西：
     *
     *   text  —— **下一轮将会注入**什么（把当前该提醒的实时算出来）
     *   last  —— **上一轮实际注入过**什么（带提醒的那一份，已持久化）
     *
     * 为什么必须分开：一轮的提醒在收到 AI 消息时就被 `commit` 掉了，
     * 之后 `selectReminders()` 再也选不出它，而宿主里的文本会被后续
     * 「只有协议说明」的刷新覆盖。早先这里只在「事件已到期」时才回退到
     * 旧文本，于是**定期检查 / 即将结束 / 预定终点（旧）这类提醒事后完全看不到** ——
     * 用户明明被提醒过，界面上却显示「无需注入」。
     */
    previewInjection() {
        const events = this.engine.selectReminders();
        const fresh = this.engine.buildInjectionText({ events });
        return {
            text: events.length ? fresh : (fresh || this._lastInjection || ''),
            events,
            last: this.engine.state.lastInjection ?? null,
        };
    }

    // ───────────────────────────── 配置档案 ─────────────────────────────

    /** 当前角色卡 / 群聊的档案键 */
    currentProfileKey() {
        try {
            return this.host.getCharacterKey?.() ?? null;
        } catch {
            return null;
        }
    }

    /**
     * 按当前对话切换配置档案。
     * @param {{ force?: boolean }} [opts] force=true 时即使 activeId 相同也重新套用
     */
    syncProfileForCurrentChat(opts = {}) {
        const key = this.currentProfileKey();
        const result = activateProfileFor(this.config, key, {
            ...opts,
            // 没绑定过的角色卡自动新建一份，否则多张卡会共用「全局默认」——
            // 在 A 卡上改的设置会把 B 卡的也一起改掉。
            autoCreate: this.config.profiles?.autoCreateForCharacter !== false,
            name: this.host.getCharacterLabel?.(),
        });
        if (result.changed) {
            this.config = result.config;
            this.engine.setConfig(this.config);
            this.saveSettings();
            if (result.reason === 'created') {
                console.log(`[事件计时器] 已为「${result.config.profiles?.items?.[result.activeId]?.name ?? ''}」新建配置档案`);
            } else if (result.reason === 'profile') {
                const name = this.config.profiles?.items?.[result.activeId]?.name ?? result.activeId;
                console.log(`[事件计时器] 已切换到配置档案「${name}」`);
            }
        }
        return { ...result, targetKey: key };
    }

    /** 把当前设置存成一个新档案（或覆盖指定档案） */
    saveCurrentAsProfile(name, id = null) {
        const { config, profile } = saveProfile(this.config, { name, id });
        this.config = config;
        this.saveSettings();
        this.notify();
        return profile;
    }

    /** 手动套用某个档案 */
    applyProfile(id) {
        const store = normalizeProfileStore(this.config.profiles);
        if (id && !store.items[id]) return false;
        // 先把当前改动写回生效中的那一份
        this.config = writeBackActiveConfig(this.config);
        const store2 = normalizeProfileStore(this.config.profiles);
        const source = id ? store2.items[id]?.config : store2.baseConfig;
        const next = mergeConfig(createDefaultConfig(), source ?? this.config);
        next.prompts = this.config.prompts;
        next.profiles = { ...store2, activeId: id && store2.items[id] ? id : null };
        this.config = normalizeAppConfig(next);
        this.engine.setConfig(this.config);
        this.engine.resetInitialClockToBase();
        this.saveSettings();
        this.rebuild({ reason: 'profile-switch' });
        return true;
    }

    renameProfile(id, name) {
        this.config = renameProfile(this.config, id, name);
        this.saveSettings();
        this.notify();
    }

    removeProfile(id) {
        this.config = deleteProfile(this.config, id);
        this.saveSettings();
        this.notify();
    }

    /** 把某个档案绑定到当前角色卡 / 群聊（传 null 解绑） */
    bindProfileToCurrentChat(id) {
        const key = this.currentProfileKey();
        if (!key) {
            this.host.toast?.('当前没有打开角色卡或群聊，无法绑定', 'warning');
            return false;
        }
        this.config = bindProfile(this.config, key, id);
        this.saveSettings();
        this.notify();
        return true;
    }

    profileBindings(id) {
        return listProfileBindings(this.config, id);
    }

    resolveProfileForCurrentChat() {
        return resolveProfileId(this.config, this.currentProfileKey());
    }

    // ───────────────────────────── 提示词库 ─────────────────────────────

    get prompts() {
        return normalizePromptLibrary(this.config.prompts).items;
    }

    get activePrompt() {
        return getActivePrompt(this.config);
    }

    selectPrompt(id) {
        this.config = setActivePrompt(this.config, id);
        this.saveSettings();
        this.refreshInjection({ commit: false });
        this.notify();
    }

    addPrompt(input) {
        const { config, item } = addPrompt(this.config, input);
        this.config = { ...config, activePromptId: item.id };
        this.saveSettings();
        this.refreshInjection({ commit: false });
        this.notify();
        return item;
    }

    updatePrompt(id, patch) {
        this.config = updatePrompt(this.config, id, patch);
        this.saveSettings();
        this.refreshInjection({ commit: false });
        this.notify();
    }

    renamePrompt(id, name) {
        this.config = renamePrompt(this.config, id, name);
        this.saveSettings();
        this.notify();
    }

    duplicatePrompt(id, name) {
        const { config, item } = duplicatePrompt(this.config, id, name);
        this.config = { ...config, activePromptId: item.id };
        this.saveSettings();
        this.notify();
        return item;
    }

    removePrompt(id) {
        if (id === 'builtin-default') {
            this.host.toast?.('「默认提示词」不能删除，可以先另存为副本再改', 'warning');
            return;
        }
        this.config = deletePrompt(this.config, id);
        this.saveSettings();
        this.refreshInjection({ commit: false });
        this.notify();
    }

    /**
     * 导入一条提示词。
     *
     * ⚠️ 永远是**新增一条**，绝不覆盖已有的 —— 导入是别人给的东西，
     * 直接顶掉自己调了半天的文案是不可接受的。所以即使名字撞了也照加，
     * 让它自己在列表里重名，用户看得见、自己决定删哪个。
     *
     * @param {string} name
     * @param {{ protocol?: string|null, mid?: string|null, late?: string|null, origin?: string|null, due?: string|null }} fields
     */
    importPrompt(name, fields = {}) {
        const { config, item } = addPrompt(this.config, {
            name,
            protocol: fields.protocol ?? null,
            mid: fields.mid ?? null,
            late: fields.late ?? null,
            origin: fields.origin ?? null,
            due: fields.due ?? null,
        });
        // 导入的这条直接切过去用 —— 用户导它就是为了用
        this.config = { ...config, activePromptId: item.id };
        this.saveSettings();
        this.refreshInjection({ commit: false });
        this.notify();
        return item;
    }

    // ───────────────────────────── AI 推断历法 ─────────────────────────────

    /** 当前推断后端是否可用 */
    inferenceBackendStatus() {
        return describeBackend(this.host, this.config);
    }

    /**
     * 收集线索并让模型推断历法。
     * @param {{ onProgress?: (msg: string) => void }} [opts]
     * @returns {Promise<{ spec: any, clues: any, prompt: string, raw: string }|null>}
     */
    async inferCalendar(opts = {}) {
        const infer = this.config.infer ?? {};
        const status = this.inferenceBackendStatus();
        if (!status.ok) throw new Error(status.text);

        opts.onProgress?.('正在收集线索……');
        const clues = await this.host.getContextClues?.({
            sources: infer.sources,
            maxChars: infer.maxClueChars,
        });
        if (!clues) throw new Error('当前宿主不支持读取世界书 / 角色卡线索');

        const prompt = buildCalendarPrompt(clues, { maxChars: infer.maxClueChars });
        opts.onProgress?.('正在请求模型……');
        const raw = await runInference({ host: this.host, config: this.config }, prompt);

        const spec = parseCalendarAnswer(raw);
        if (!spec) throw new Error('模型没有返回可解析的历法 JSON');

        return { spec, clues, prompt, raw };
    }

    /** 把推断结果套用到配置（mode 会一并切到日历制） */
    applyInferredCalendar(spec) {
        const { config, applied } = applyCalendarSpec(this.config, spec, this.config.infer?.apply);
        this.config = normalizeAppConfig(config);
        this.engine.setConfig(this.config);
        this.engine.resetInitialClockToBase();
        this.saveSettings();
        this.rebuild({ reason: 'calendar-infer' });
        return applied;
    }

    // ───────────────────────────── 配置 ─────────────────────────────

    updateConfig(patch) {
        this.config = mergeConfig(this.config, patch);
        // 改动要写回「当前生效的那一份」（档案 or 全局基线），否则切回来就丢了
        this.config = writeBackActiveConfig(this.config);
        this.engine.setConfig(this.config);
        this.saveSettings();
        this.refreshInjection({ commit: false });
        this.notify();
    }

    /** 重置整场聊天（清空重放结果与手动干预） */
    resetAll({ keepInitialClock = true } = {}) {
        const initial = keepInitialClock
            ? this.engine.formatter.startClock()
            : { ...this.engine.initialClock };
        this.engine.clearEvents();
        this.engine.setInitialClock(initial);
        this.rebuild({ reason: 'reset' });
        this.host.toast?.('事件计时器已重置', 'success');
    }

    /** 把配置里的起始时间定为当前时间并重建 */
    applyStartClockAsInitial() {
        this.engine.resetInitialClockToBase();
        this.rebuild({ reason: 'initial-clock' });
    }

    /** 暴露给外部的 API（其它应用 / 脚本用） */
    getApi() {
        const app = this;
        return {
            version: STATE_VERSION,
            host: this.host.kind,
            get clock() { return { ...app.engine.clock }; },
            get events() { return app.engine.snapshot(); },
            get injection() { return app._lastInjection; },
            config: this.config,
            observe: (text) => app.ingest(text),
            snapshot: () => app.engine.snapshot(),
            inject: () => app.refreshInjection({ commit: false }).text,
            commit: () => app.refreshInjection({ commit: true }).text,
            advance: (minutes, label) => app.engine.advanceClock(minutes, label),
            addEvent: (input) => app.engine.addEvent(input),
            resolveEvent: (id, result) => app.engine.resolveEvent(id, { result }),
            removeEvent: (id) => app.engine.removeEvent(id),
            rebuild: () => app.rebuild({ reason: 'api' }),
            reset: () => app.resetAll(),
            on: (fn) => app.subscribe(fn),
            toast: (msg, type) => app.host.toast?.(msg, type),
        };
    }
}

/**
 * 规范化整个配置：
 *   - 提示词库补齐内置项、迁移老字段
 *   - 档案库丢弃坏数据
 *   - activePromptId 保证指向存在的提示词
 */
/** 换 ASCII 标签之前的默认顺序；只用来识别「用户没改过」 */
const LEGACY_TAG_ORDER = '计时器,timer,story_timer,storytimer,STIMER';

/**
 * 一次性迁移：把内置文案里的破折号改掉。
 *
 * 0.11.x 起会把内置文案自动填进提示词库，所以**光改内置文案对那些存档没用** ——
 * 提示词库里存着一份旧的副本，模型读的是那一份。
 *
 * 只替换**整句完全对得上**的旧句子：用户自己写的文字不会含这些长句，
 * 所以不会误伤。宁可漏改也不乱改。
 */
const PROMPT_DASH_FIXES = [
    ['不要写结束标记 —— 计时器会', '不要写结束标记。计时器会'],
    [
        '已经发生的一切 —— 外部环境的变化（战事、行情、局势、别人的行动）或者它自身的变数 —— 判断它有没有受到影响。',
        '已经发生的一切，包括外部环境的变化（战事、行情、局势、别人的行动）和它自身的变数，判断它有没有受到影响。',
    ],
    ['用一行把它写下来 —— **写在标签区块里，不要写进正文**。', '用一行把它写下来（**写在标签区块里，不要写进正文**）。'],
    ['请在正文里体现这件事带来的影响 ——', '请在正文里体现这件事带来的影响：'],
    ['不需要写结束标记 —— 计时器会自己收掉', '不需要写结束标记，计时器会自己收掉'],
    // 预定终点那句原来写的是「没回来 / 逾期未归」，那假设了事件一定是
    // 「某人离开又回来」。可事件也可以是熬药 / 赶路 / 送信 / 养伤，
    // 在那些身上「回来」讲不通。换成对任何事件都成立的说法。
    [
        '如果结果和「要点」有出入、或者它压根没回来（逾期未归本身就是剧情），照实写就行。',
        '如果结果和「要点」有出入，或者压根没有结果（悬而未决本身也可能是剧情），照实写就行。',
    ],
    // 「悬而未决本身就是剧情」那句断言太绝对 —— 这段提醒通篇是祈使句，
    // 中间夹一句陈述句容易被模型读成指令，以为"不写结果"才是正解。
    // 单独列一条，是为了让**已经迁到中间那一版**的存档也能补上「可能」。
    ['悬而未决本身就是剧情', '悬而未决本身也可能是剧情'],
    // 「定期检查」开头原来断言「事件仍在进行中」，把"还没完"写死了。
    // 可事件也可能是**提前完成**、或者**没结束但会比预定早完** ——
    // 一断言，后两种就没了抓手。改成中性的「由插件持续跟踪」，
    // 并把关注点落到真正的杠杆上：**完成时间**。
    [
        '下列事件仍在进行中。请结合这期间正文里已经发生的一切，包括外部环境的变化（战事、行情、局势、别人的行动）和它自身的变数，判断它有没有受到影响。',
        '下列事件由插件持续跟踪。请结合这期间正文里已经发生的一切，包括外部环境的变化（战事、行情、局势、别人的行动）和它自身的变数，判断它们的完成时间有没有变化。',
    ],
    // 协议段新增「事件名要写清主体」那条时，顺带把**内联了旧 hint**的存档补上。
    // 默认提示词模板用的是 {{reminderHint}} 占位符，那种存档会自动拿到新文案；
    // 但如果谁把 hint 直接抄进了自己的模板，就得靠这条迁移。
    [
        '· 「事件+」只在开始时写一次就够了，之后不用再向计时器汇报：不要写进度、也不要写结束标记。计时器会在后续时间点提醒你。\n',
        '· 「事件+」只在开始时写一次就够了，之后不用再向计时器汇报：不要写进度、也不要写结束标记。计时器会在后续时间点提醒你。\n'
        + '· 事件名要能看出是**谁**的事：牵扯到谁，就把谁的名字写进去（例「提莉静养疗伤」）。\n',
    ],
    // 主体那条规定最开始写的是「不是**自己的**事就加上主体」——
    // 但那句里的「自己」在 AI 读来是「AI 自己」（这套文案里「你」就是称呼 AI 的），
    // 而 AI 在剧情里不是任何一个角色，所指是空的。改成不提「自己」的说法。
    // 单列一条，让**已经存下那一版**的模板也能被纠正过来。
    [
        '不是自己的事就加上主体',
        '牵扯到谁，就把谁的名字写进去',
    ],
];

/** 把提示词库里残留的旧破折号句子换成新写法 */
function migratePromptDashes(config) {    for (const item of config.prompts?.items ?? []) {
        if (!item || typeof item !== 'object') continue;
        for (const key of ['protocol', 'mid', 'late', 'origin', 'due', 'reminder']) {
            let text = item[key];
            if (typeof text !== 'string' || !text) continue;
            let changed = false;
            for (const [from, to] of PROMPT_DASH_FIXES) {
                if (text.includes(from)) { text = text.split(from).join(to); changed = true; }
            }
            if (changed) item[key] = text;
        }
    }
    return config;
}

/**
 * 「奇幻历」预设被删掉了，把它当年实际生效的值落成显式配置。
 *
 * ⚠️ 不能只把 preset 置空就完事。预设除了每月天数，还在给**闰年规则**和
 * **日期格式**兜底：`createCalendar` 里是 `cfg.leap ?? preset?.leap ?? 公历默认`。
 * 直接置空的话，选了奇幻历的存档会从「每 8 年一闰」**静默变成公历式
 * 4/100/400/2** —— 时间算得出来、也不报错，但结果不一样了。
 *
 * 所以这里把它当时给的那一套**写成显式值**，之后走不走预设都一样。
 * 用户自己改过的部分（months / leap / format）优先保留。
 */
function migrateFantasyPreset(config) {
    const cal = config?.time?.calendar;
    if (!cal || cal.preset !== 'fantasy') return config;

    // 这两个常量是那个预设当年的内容，抄在这里是因为它已经被删了。
    // 注意 leap.month 原写的是 13，而它只有 12 个月 —— 当时就被夹成了 12。
    const LEGACY_MONTHS = Array.from({ length: 12 }, () => 30);
    const LEGACY_LEAP = { every: 8, skip: 0, unless: 0, month: 12 };
    const LEGACY_FORMAT = '{era}{year}年{month}月{day}日';

    return {
        ...config,
        time: {
            ...config.time,
            calendar: {
                ...cal,
                preset: null,
                months: Array.isArray(cal.months) && cal.months.length ? cal.months : LEGACY_MONTHS,
                leap: cal.leap ?? LEGACY_LEAP,
                format: cal.format || LEGACY_FORMAT,
            },
        },
    };
}

function normalizeAppConfig(config) {
    let next = { ...createDefaultConfig(), ...config };
    next.prompts = normalizePromptLibrary(next.prompts);
    next.profiles = normalizeProfileStore(next.profiles);
    next = migratePromptDashes(next);
    next = migrateFantasyPreset(next);

    // 标签名默认值从中文换成 ASCII 的 timer。
    // 只迁移「原封不动还是旧默认值」的配置 —— 用户自己改过就不动。
    if (Array.isArray(next.tagNames) && next.tagNames.join(',') === LEGACY_TAG_ORDER) {
        next.tagNames = [...DEFAULT_TAG_NAMES];
    }

    // ── 一次性清掉已删除功能的配置键 ──
    //
    // 这五样东西都被删了（理由见 default-config.js 里各自位置的注释）。
    // 留着旧键虽然不会报错 —— mergeConfig 会把它们深合并进配置、引擎也不读 ——
    // 但用户的 settings.json 里会攒下一堆再也没人看的历史字段，
    // 而且「配置档案」是整份快照，每张卡都存一份，越积越多。
    if (next.parse && 'llm' in next.parse) {
        const { llm, ...rest } = next.parse;
        void llm;
        next.parse = rest;
    }
    if (next.parse && 'clockFromTimeOfDay' in next.parse) {
        const { clockFromTimeOfDay, ...rest } = next.parse;
        void clockFromTimeOfDay;
        next.parse = rest;
    }
    if (next.reminder && 'protocolEveryTurns' in next.reminder) {
        const { protocolEveryTurns, ...rest } = next.reminder;
        void protocolEveryTurns;
        next.reminder = rest;
    }
    if (next.time && 'defaultAdvanceMinutes' in next.time) {
        const { defaultAdvanceMinutes, ...rest } = next.time;
        void defaultAdvanceMinutes;
        next.time = rest;
    }
    if (next.time && 'autoAdvance' in next.time) {
        const { autoAdvance, ...rest } = next.time;
        void autoAdvance;
        next.time = rest;
    }
    if (next.time && 'defaultEventMinutes' in next.time) {
        const { defaultEventMinutes, ...rest } = next.time;
        void defaultEventMinutes;
        next.time = rest;
    }

    // 老字段 time.vagueMinutes（模糊时长词的分钟数）已经整个删掉了 ——
    // 它只在单位表没命中、且事件门槛又低于 10 分钟时才有影响，等于从来没有生效过。
    // 顺手把它从存档里清掉，免得留着一个已经没有对应实现的键。
    if (next.time && 'vagueMinutes' in next.time) {
        const { vagueMinutes, ...rest } = next.time;
        void vagueMinutes;
        next.time = rest;
    }

    // 老字段 reminder.midAt（定期检查的位置百分比）换成了「每几天一个点位」。
    // 新规则表达不出「定期检查放在 30%」，所以这个值没法迁移，只能清掉。
    // 单个事件的已提醒记录由 engine.restore() 里的 fired.mid → firedMids 迁移兜住。
    if (next.reminder && 'midAt' in next.reminder) {
        const { midAt, ...rest } = next.reminder;
        void midAt;
        next.reminder = rest;
    }

    // reminder.midEveryDays → reminder.checkEveryDays：**纯改名，值要原样搬过去**。
    //
    // ⚠️ 这里不能用 `rest.checkEveryDays ?? midEveryDays` —— normalizeAppConfig 拿到的是
    // **已经和默认配置合并过**的对象（三个调用点都是 mergeConfig 之后才进来），所以
    // `checkEveryDays` 早就被默认的 7 填上了，`??` 永远取不到老键的值。
    //
    // 沿用 defaultAdvanceMinutes 那套写法：**只在新键还停在默认值时才迁移**。
    // 这样用户后来自己设过的新值不会被老键盖掉。
    const LEGACY_CHECK_DAYS_DEFAULT = 7;
    const legacyCheckDays = Number(next.reminder?.midEveryDays);
    if (Number.isFinite(legacyCheckDays)
        && legacyCheckDays >= 0
        && Number(next.reminder?.checkEveryDays) === LEGACY_CHECK_DAYS_DEFAULT
        && legacyCheckDays !== LEGACY_CHECK_DAYS_DEFAULT) {
        next.reminder = { ...next.reminder, checkEveryDays: legacyCheckDays };
    }
    if (next.reminder && 'midEveryDays' in next.reminder) {
        const { midEveryDays, ...rest } = next.reminder;
        void midEveryDays;
        next.reminder = rest;
    }

    // 老配置里的 reminder.protocolTemplate / template → 一条命名提示词
    const migrated = migrateLegacyPrompt(next);
    next = migrated.config;

    // activePromptId 兜底
    const ids = next.prompts.items.map((p) => p.id);
    if (!ids.includes(next.activePromptId)) next.activePromptId = ids[0];

    return next;
}
