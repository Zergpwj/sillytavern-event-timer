/**
 * 计时器核心引擎 —— 纯逻辑，零宿主依赖。
 *
 * 职责：
 *   1. 维护一条「虚构剧情时间轴」；
 *   2. 从每轮 AI 正文里解析时间信息与耗时事件；
 *   3. 在剧情时间到达事件预定时间时，把该事件标记为「到期」；
 *   4. 生成注入给 AI 的提醒文本。
 *
 * 设计要点：
 *   - 事件 id 由「标题 + 到期绝对分钟」哈希而来，因此**同样的聊天记录重放会得到同样的状态**。
 *   - 用户的任何手动干预（加事件/删事件/改字段/推进时间）都记在 `overlays` 里，
 *     重放结束后再套用，所以「重建」不会丢手动修改。
 *   - 引擎不碰 DOM、不碰网络、不碰酒馆 API，可以直接在 Node 里跑测试。
 */

import { createDefaultConfig, mergeConfig, STATE_VERSION } from './default-config.js';
import { extractTagBlocks, parseTagBody, scanNarrative, stripTagBlocks } from './parser.js';
import { builtinPointTemplate, primaryTag, protocolReminderHint, protocolTooShort, renderProtocolText, renderReminderText } from './reminder.js';
import { createTimeFormatter } from './calendar.js';
import { getActivePrompt } from './profiles.js';
import {
    absToClock,
    addMinutes,
    cloneClock,
    clockToAbs,
    compareClock,
    diffMinutes,
    normalizeClock,
} from './story-time.js';

/** 32 位 FNV-1a 哈希，转成 8 位十六进制 */
export function fnv1a(text) {
    let h = 0x811c9dc5;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/** 归一化标题：用于事件匹配与去重 */
export function normalizeTitle(title) {
    return String(title ?? '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[《》「」【】"'“”‘’]/g, '')
        .replace(/[。．.！!？?，,、；;：:]+$/g, '')
        .toLowerCase();
}

/** 由标题与到期时间生成稳定的 id */
export function makeEventId(title, dueClock) {
    return `ev_${fnv1a(`${normalizeTitle(title)}@${clockToAbs(dueClock)}`)}`;
}

/** 计算聊天记录签名（用于判断是否需要重建） */
export function computeSignature(messages) {
    const joined = (messages || [])
        .map((m) => (typeof m === 'string' ? m : String(m?.text ?? m?.mes ?? '')))
        .join('\u0001');
    return `${(messages || []).length}:${fnv1a(joined)}`;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function nowIso() {
    return new Date().toISOString();
}

export class TimerEngine {
    /**
     * @param {{ config?: any, initialClock?: {day:number,minute:number} }} [options]
     */
    constructor(options = {}) {
        this.config = mergeConfig(createDefaultConfig(), options.config || {});
        this._listeners = new Map();
        /** 时间格式化 / 解析门面：自动适配「计数制」与「日历制」 */
        this.formatter = createTimeFormatter(this.config.time);

        const initial = options.initialClock
            ? normalizeClock(options.initialClock)
            : this.defaultInitialClock();

        this.state = {
            version: STATE_VERSION,
            initialClock: initial,
            clock: cloneClock(initial),
            turns: 0,
            events: [],
            history: [],
            overlays: createEmptyOverlays(),
            notes: [],
            /** 提醒计数：{ [eventId]: { count, turn, at } }。不属于重放派生量，需单独持久化 */
            notify: {},
            /** 最近一次带提醒的注入原文 */
            lastInjection: null,
            /** 每条 AI 消息注入了什么：{ [消息下标]: { text, points, titles, at } } */
            injections: {},
            updatedAt: nowIso(),
        };
        this._signature = null;
    }

    // ───────────────────────────── 基础访问 ─────────────────────────────

    defaultInitialClock() {
        return normalizeClock(this.formatter.startClock());
    }

    /** 当前用的是计数制还是日历制 */
    get timeMode() {
        return this.formatter.isCalendar ? 'calendar' : 'counter';
    }

    /**
     * 格式化时钟（界面 / 提醒文本统一走这里）。
     *
     * 第一个参数也给字符串，方便写成 `formatClock('date')` —— 这种写法太自然了，
     * 静默算出 NaN 还不如直接认下来。
     *
     * @param {{day:number,minute:number}|'full'|'date'|'time'|'short'|'cn'} [clock]
     * @param {'full'|'date'|'time'|'short'|'cn'} [style]
     */
    formatClock(clock = this.state.clock, style = 'full') {
        if (typeof clock === 'string') {
            style = clock;
            clock = this.state.clock;
        }
        return this.formatter.format(clock, style);
    }

    /** 把初始时间重设为当前时间基准（切换计数/日历模式后调用） */
    resetInitialClockToBase() {
        this.state.initialClock = normalizeClock(this.formatter.startClock());
        return this.state.initialClock;
    }

    get clock() { return this.state.clock; }
    get turns() { return this.state.turns; }
    get events() { return this.state.events; }
    get history() { return this.state.history; }
    get overlays() { return this.state.overlays; }
    get initialClock() { return this.state.initialClock; }
    get signature() { return this._signature; }

    /** 正在进行（未结束）的事件 */
    get activeEvents() {
        return this.state.events.filter((e) => e.status === 'pending' || e.status === 'due');
    }

    /** 已经到期、等待正文交代的事件 */
    get dueEvents() {
        return this.state.events.filter((e) => e.status === 'due');
    }

    setConfig(patch) {
        this.config = mergeConfig(this.config, patch || {});
        // 时间基准可能变了（计数制 ↔ 日历制），重建门面
        this.formatter = createTimeFormatter(this.config.time);
        this.refreshStatuses();
        this.emit('config', this.config);
        return this.config;
    }

    // ───────────────────────────── 事件总线 ─────────────────────────────

    on(type, handler) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(handler);
        return () => this.off(type, handler);
    }

    off(type, handler) {
        this._listeners.get(type)?.delete(handler);
    }

    emit(type, payload) {
        for (const fn of this._listeners.get(type) ?? []) {
            try { fn(payload, this); } catch (err) { console.error('[event-timer] listener error', err); }
        }
        for (const fn of this._listeners.get('*') ?? []) {
            try { fn({ type, payload }, this); } catch { /* ignore */ }
        }
    }

    // ───────────────────────────── 时间控制 ─────────────────────────────

    /** 设置「本轮聊天的起始时间」（相当于手动校时，会参与重放） */
    setInitialClock(clock) {
        this.state.initialClock = normalizeClock(clock);
        this.emit('change', { reason: 'initial-clock' });
    }

    /** 直接改写当前时钟（不写进重放基线） */
    setClock(clock, { silent = false } = {}) {
        const next = normalizeClock(clock);
        const changed = compareClock(next, this.state.clock) !== 0;
        this.state.clock = next;
        this.refreshStatuses();
        if (!silent) this.emit('change', { reason: 'set-clock', changed });
        return changed;
    }

    /**
     * 手动推进时间。会被记入 overlays，重放时按轮次重现。
     * @param {number} minutes 可正可负
     * @param {string} [label]
     */
    advanceClock(minutes, label = '手动推进') {
        const delta = Math.round(Number(minutes) || 0);
        const entry = { atTurn: this.state.turns, minutes: delta, label, at: nowIso() };
        this.state.overlays.advances.push(entry);
        this.state.clock = addMinutes(this.state.clock, delta);
        this._pushHistory({ type: 'advance', label, minutes: delta, clock: cloneClock(this.state.clock) });
        this.refreshStatuses();
        this.emit('change', { reason: 'manual-advance', minutes: delta });
        return entry;
    }

    // ───────────────────────────── 解析 ─────────────────────────────

    parseCtx(clock, overrides = {}) {
        return {
            clock,
            formatter: this.formatter,
            units: this.config.time.units,
            maxEventsPerMessage: this.config.parse.maxEventsPerMessage,
            ...overrides,
        };
    }

    /**
     * 解析一条消息，得到「本轮推进了多少时间 / 有哪些事件动作」。
     * 不修改状态，方便 UI 预览与测试。
     * @param {string} text
     */
    parseTurn(text) {
        const cfg = this.config;
        const baseClock = this.state.clock;
        const result = {
            advanceMinutes: 0,
            /** 结构化时长分量，日历模式下做精确的年/月加法 */
            advanceParts: [],
            narrativeAdvanceMinutes: 0,
            narrativeAdvanceParts: [],
            clock: null,
            events: [],
            note: null,
            matches: [],
            sources: [],
            errors: [],
            usedTag: false,
        };
        if (!text) return result;

        const raw = String(text);

        if (cfg.parse.tags) {
            const blocks = extractTagBlocks(raw, cfg.tagNames);
            if (blocks.length) {
                result.sources.push('tag');
                for (const block of blocks) {
                    const parsed = parseTagBody(block.body, this.parseCtx(baseClock));
                    result.usedTag = true;
                    if (parsed.clock) result.clock = parsed.clock;
                    if (parsed.advanceMinutes != null) result.advanceMinutes += parsed.advanceMinutes;
                    if (parsed.advanceParts?.length) result.advanceParts.push(...parsed.advanceParts);
                    for (const ev of parsed.events) result.events.push({ ...ev, source: ev.source || 'tag' });
                    if (parsed.note) result.note = parsed.note;
                    if (parsed.errors?.length) result.errors.push(...parsed.errors);
                }
            }
        }

        const tagProduced = result.usedTag && (result.clock || result.advanceMinutes || result.events.length);
        if (cfg.parse.narrative && (!tagProduced || cfg.parse.narrativeWhenTagged)) {
            const plain = result.usedTag ? stripTagBlocks(raw, cfg.tagNames) : raw;
            const scan = scanNarrative(plain, this.parseCtx(baseClock, {
                maxEventsPerMessage: cfg.parse.maxRegexEventsPerMessage,
            }));
            result.sources.push('regex');
            result.narrativeAdvanceMinutes = scan.advanceMinutes || 0;
            if (scan.advanceParts?.length) result.narrativeAdvanceParts.push(...scan.advanceParts);
            result.matches.push(...scan.matches);
            if (scan.clock) result.clock = scan.clock;
            for (const ev of scan.events) {
                if (!result.events.some((e) => normalizeTitle(e.title) === normalizeTitle(ev.title))) {
                    result.events.push(ev);
                }
            }
        }

        return result;
    }

    /**
     * 处理一条 AI 消息：推进时间、登记事件。
     * @param {string} text
     * @param {{ sourceIndex?: number, silent?: boolean, role?: string }} [meta]
     */
    observeMessage(text, meta = {}) {
        if (!text || !String(text).trim()) return { skipped: true };
        const parsed = this.parseTurn(text);
        return this.applyTurn(parsed, meta);
    }

    /**
     * 应用一份已解析的结果（正则/标签/LLM 抽取都走这里）。
     * @param {ReturnType<TimerEngine['parseTurn']>} parsed
     * @param {{ sourceIndex?: number, silent?: boolean, role?: string }} [meta]
     */
    applyTurn(parsed, meta = {}) {
        const cfg = this.config;
        if (!parsed) return { skipped: true };
        const beforeClock = cloneClock(this.state.clock);

        // ---- 1. 推进时间 ----
        let advance = clamp(
            Number(parsed.advanceMinutes) || 0,
            -cfg.time.maxAdvanceMinutes,
            cfg.time.maxAdvanceMinutes,
        );
        advance += clamp(
            Number(parsed.narrativeAdvanceMinutes) || 0,
            -cfg.time.maxJumpMinutes,
            cfg.time.maxJumpMinutes,
        );

        // 「时间推进控制（试验）」整个功能已删除 —— 见 default-config.js 里的说明。
        // 现在时钟只会因为：标签里的时间/流逝、正文里的时长表达、用户手动快进 而前进。

        const allParts = [
            ...(parsed.advanceParts ?? []),
            ...(parsed.narrativeAdvanceParts ?? []),
        ];

        let nextClock;
        if (this.formatter.isCalendar && allParts.length) {
            // 日历模式：「一个月后」按真实月份加，而不是固定 30 天
            nextClock = this.formatter.applyDuration(this.state.clock, allParts, advance);
            // 防止误判把时间轴甩飞
            const jumped = Math.abs(diffMinutes(nextClock, this.state.clock));
            if (jumped > cfg.time.maxAdvanceMinutes) {
                nextClock = this.formatter.applyDuration(this.state.clock, [], advance);
            }
        } else {
            nextClock = addMinutes(this.state.clock, advance);
        }

        let clockFromTag = false;
        if (parsed.clock) {
            nextClock = normalizeClock(parsed.clock);
            clockFromTag = true;
        }
        this.state.clock = nextClock;
        this.state.turns += 1;

        // ---- 2. 以「本轮结束时间」为基准登记事件 ----
        const created = [];
        const updated = [];
        const closed = [];

        for (const raw of parsed.events) {
            const op = raw.op || 'add';
            try {
                if (op === 'add') {
                    const ev = this._createEvent(raw, meta);
                    if (ev) created.push(ev);
                } else {
                    const target = this.findEvent(raw.id || raw.title);
                    if (!target) continue;
                    if (op === 'update') {
                        this._applyPatch(target, raw);
                        // 「事件~: X | 时长=3天 / 到期=…」—— 允许 AI 在被问到时调整时间
                        const newDue = raw.dueClock
                            ? raw.dueClock
                            : (raw.durationMinutes != null
                                ? addMinutes(target.createdClock, raw.durationMinutes)
                                : null);
                        if (newDue) this._rescheduleEvent(target, newDue, 'ai');
                        updated.push(target);
                    } else if (op === 'resolve') {
                        this._resolve(target, raw.result ?? raw.note ?? '', this.state.clock);
                        closed.push(target);
                    } else if (op === 'cancel') {
                        this._cancel(target, this.state.clock);
                        closed.push(target);
                    }
                }
            } catch (err) {
                (parsed.errors ??= []).push(String(err?.message || err));
                console.warn('[event-timer] 事件处理失败', err);
            }
        }

        // ---- 3. 套用「本回合」的手动推进 ----
        this._applyAdvancesForTurn(this.state.turns);

        // ---- 4. 刷新到期状态 ----
        const newlyDue = this.refreshStatuses();

        // ---- 4.5 上一轮发出过「到点提醒」、而 AI 已经回应了 → 自动归档 ----
        // （放在处理完本轮事件之后：如果 AI 主动写了「事件-」，以它写的为准）
        const autoArchived = this._archiveDeliveredEvents();

        // ---- 5. 历史 ----
        if (advance !== 0 || parsed.clock) {
            this._pushHistory({
                type: 'time',
                advance,
                clock: cloneClock(this.state.clock),
                turn: this.state.turns,
                fromTag: clockFromTag,
            });
        }

        const payload = {
            turn: this.state.turns,
            beforeClock,
            clock: cloneClock(this.state.clock),
            advance: diffMinutes(this.state.clock, beforeClock),
            parsed,
            created,
            updated,
            closed,
            newlyDue,
            autoArchived,
            sourceIndex: meta.sourceIndex ?? null,
        };
        if (!meta.silent) this.emit('change', { reason: 'observe', ...payload });
        return payload;
    }

    /**
     * 从零重放整段聊天记录，得到确定性状态。
     * @param {Array<string|{text?:string,mes?:string,role?:string,is_user?:boolean,is_system?:boolean}>} messages
     * @param {{ reason?: string, silent?: boolean }} [opts]
     */
    rebuild(messages, opts = {}) {
        const cfg = this.config;
        const list = Array.isArray(messages) ? messages : [];
        const normalized = list
            .map((m) => (typeof m === 'string' ? { text: m, role: 'assistant' } : {
                text: String(m?.text ?? m?.mes ?? ''),
                role: m?.is_user ? 'user' : m?.is_system ? 'system' : (m?.role || 'assistant'),
            }))
            .filter((m) => m.role === 'assistant' && m.text.trim());

        const maxReplay = cfg.advanced.maxReplayMessages;
        const skipped = Math.max(0, normalized.length - maxReplay);
        const replay = normalized.slice(skipped);

        /**
         * 聊天内容变了没有？
         *
         * 这件事很重要：提醒记账（`notify` 里的 fired / turn）**不是重放派生量**，
         * 它是「当时那个时间线」的快照。用户删楼 / 改楼之后，时间线被整体重写，
         * 那些记录就全部失效了 —— 第 N 轮可能已经不存在，某个时点也可能压根不该发过。
         *
         * 早先这里无条件保留记账，后果是：删掉两楼之后插件仍然显示
         * 「第 10 轮提醒过」，而且因为 fired.mid 还挂着，**该提醒的定期检查再也不会提醒**。
         */
        const nextSignature = computeSignature(replay.map((m) => m.text));
        const contentChanged = this._signature != null && this._signature !== nextSignature;
        if (contentChanged) this.invalidateReminderState();

        this.state.clock = cloneClock(this.state.initialClock);
        this.state.events = [];
        this.state.history = [];
        this.state.turns = 0;

        // 被裁掉的部分只补轮次计数
        if (skipped > 0) {
            this.state.turns = skipped;
            this._applyAdvancesForTurnUpTo(skipped);
        }

        for (const msg of replay) {
            this.observeMessage(msg.text, { silent: true, replay: true });
        }

        this._applyOverlays();
        this.refreshStatuses();
        this._signature = nextSignature;

        const payload = {
            reason: opts.reason || 'rebuild',
            turns: this.state.turns,
            events: this.state.events.length,
            clock: cloneClock(this.state.clock),
            skipped,
        };
        if (!opts.silent) this.emit('change', { reason: 'rebuild', ...payload });
        return payload;
    }

    // ───────────────────────────── 事件操作 ─────────────────────────────

    /**
     * 新建事件。
     * @param {{
     *   title: string, durationMinutes?: number, dueClock?: {day:number,minute:number},
     *   reward?: string, risk?: string, loss?: string, note?: string, progress?: number|null,
     *   source?: string, id?: string, createdClock?: {day:number,minute:number}
     * }} input
     * @param {{ manual?: boolean, silent?: boolean, dedupe?: boolean }} [opts]
     */
    addEvent(input, opts = {}) {
        const manual = opts.manual !== false;
        const ev = this._createEvent(
            input,
            { manual, source: input?.source || (manual ? 'manual' : 'tag') },
            opts,
        );
        if (ev && manual) {
            const snapshot = JSON.parse(JSON.stringify({ ...ev, manual: true }));
            const index = this.state.overlays.added.findIndex((e) => e.id === ev.id);
            if (index >= 0) this.state.overlays.added[index] = snapshot;
            else this.state.overlays.added.push(snapshot);
            ev.manual = true;
        }
        if (ev && !opts.silent) this.emit('change', { reason: 'event-added', event: ev });
        return ev;
    }

    _createEvent(input, meta = {}, opts = {}) {
        const cfg = this.config;
        const title = String(input.title ?? '').trim();
        if (!title) return null;

        const anchor = input.createdClock ? normalizeClock(input.createdClock) : this.state.clock;
        /**
         * ⚠️ 时长是**必填**的（要么给 `durationMinutes`，要么给 `dueClock`）。
         *
         * 以前这里会兜底成 `cfg.time.defaultEventMinutes`（60 分钟）。
         * 那个兜底已删除，理由：AI 漏写时长本来就是它没守协议，
         * 插件替它编一个"1 小时"只会把问题盖住（而且 60 分钟低于默认门槛，
         * 兜出来的事件转头就被忽略，等于白编）。现在直接拒绝创建，让问题暴露。
         */
        const hasDuration = Number.isFinite(Number(input.durationMinutes)) || !!input.dueClock;
        if (!hasDuration) {
            // 留痕，但**只对 AI 声明的**留 —— 手动入口由界面/命令当场提示，不需要进历史。
            // 不然用户在事件列表里什么都看不到，只会以为插件坏了。
            if (!meta.manual) {
                this._pushHistory({
                    type: 'event-ignored',
                    title,
                    minutes: null,
                    reason: 'missing-duration',
                    clock: cloneClock(this.state.clock),
                });
            }
            return null;
        }

        const duration = Number.isFinite(Number(input.durationMinutes))
            ? Number(input.durationMinutes)
            : diffMinutes(input.dueClock, anchor);

        // ── 时长门槛②：太短的事不值得跟踪，直接忽略（但留痕，免得用户不知道 AI 写了什么） ──
        // 只对 AI 声明的事件生效：用户自己手动加的，再短也是他想要的。
        const minEvent = Number(cfg.reminder?.minEventMinutes) || 0;
        if (minEvent > 0 && duration < minEvent && !meta.manual) {
            this._pushHistory({
                type: 'event-ignored',
                title,
                minutes: duration,
                threshold: minEvent,
                clock: cloneClock(this.state.clock),
            });
            return null;
        }

        // 日历模式下如果拿到了结构化的时长（「3个月」），按真实日历加；
        // 否则退回按分钟算。
        const dueClock = input.dueClock
            ? normalizeClock(input.dueClock)
            : (this.formatter.isCalendar && input.durationParts?.length
                ? this.formatter.applyDuration(anchor, input.durationParts, duration)
                : addMinutes(anchor, duration));
        let id = input.id ? `ev_${fnv1a(String(input.id))}` : makeEventId(title, dueClock);

        let existing = this.state.events.find((e) => e.id === id);
        if (existing && (existing.status === 'resolved' || existing.status === 'cancelled')) {
            // 同名又同到期，但上次已经结束了 → 视为「同一件事再做一次」，派生一个新 id
            let n = 2;
            while (this.state.events.some((e) => e.id === `${id}_r${n}`)) n += 1;
            id = `${id}_r${n}`;
            existing = null;
        }

        if (existing) {
            // 同 id 视为同一事件，合并补充信息
            if (opts.dedupe !== false) {
                this._applyPatch(existing, input);
                return existing;
            }
        }

        const ev = {
            id,
            title,
            status: 'pending',
            createdClock: cloneClock(anchor),
            dueClock: cloneClock(dueClock),
            /**
             * 初始时长：登记时写死，之后**永不改动**。
             * 它是「预定终点（旧）」的唯一来源 —— 事件被延长后，
             * 「预定终点（旧）」这个叙事节点就是靠它算出来的。
             */
            initialDurationMinutes: Math.max(0, diffMinutes(dueClock, anchor)),
            /** 当前总时长 = dueClock − createdClock */
            durationMinutes: Math.max(0, diffMinutes(dueClock, anchor)),
            /** 历次调整：{ at, turn, minutes, totalMinutes, by } */
            adjustments: [],
            /**
             * 被取代的旧到期时间（绝对分钟会被算出来）。
             * 每个到达时、若事件仍未结束，就提醒一次「预定终点（旧）」。
             */
            dueHistory: [],
            /** 已经提醒过的「预定终点（旧）」锚点（存绝对分钟） */
            firedOrigins: [],
            /**
             * 已经提醒过的「定期检查点位」（存绝对分钟）。
             *
             * 以前是一个 `fired.mid` 数字（轮次）—— 只有一个标志，
             * 所以发第一个定期检查就会把后面所有定期检查都标成已响，多个点位根本没法工作。
             */
            firedMids: [],
            progress: Number.isFinite(Number(input.progress)) ? clamp(Number(input.progress), 0, 100) : null,
            /** 预期：这件事大致会长成什么样（自由文本，可含成功 / 失败 / 条件） */
            expectation: input.expectation ? String(input.expectation) : '',
            /** 变数：什么会让它偏离预期（自由文本，内外都算） */
            variables: input.variables ? String(input.variables) : '',
            /** 资源：持续性的资源收支（自由文本，插件不解析）。老名字「账目」仍是别名 */
            ledger: input.ledger ? String(input.ledger) : '',
            /** 要点：「即将结束」时列出的交代清单（不是结局预告） */
            outline: input.outline ? String(input.outline) : '',
            /** 补充说明（场景事实） */
            note: input.note ? String(input.note) : '',
            /**
             * 老字段（收益 / 风险 / 损失）保留。
             * 新的 AI 会被教着写「预期」，但老存档和习惯写三格的 AI 仍然能正常显示。
             */
            reward: input.reward ? String(input.reward) : '',
            risk: input.risk ? String(input.risk) : '',
            loss: input.loss ? String(input.loss) : '',
            result: '',
            source: meta.source || input.source || 'tag',
            manual: !!meta.manual,
            createdAt: nowIso(),
            createdTurn: this.state.turns,
            resolvedClock: null,
            notifyCount: 0,
            lastNotifiedTurn: -1,
            lastNotifiedAt: null,
            /** 已提醒过的时点：{ mid?: turn, late?: turn, due?: turn } */
            fired: {},
            /** 「到点」提醒是在第几轮发出的（AI 回应后据此自动归档） */
            dueNotifiedTurn: null,
            /** 是否由插件自动归档 */
            autoResolved: false,
        };

        this.state.events.push(ev);
        this._foldLegacyFields(ev);
        this._trimEvents();
        if (!opts.silent) this._pushHistory({ type: 'event-add', id: ev.id, title: ev.title, dueClock: cloneClock(ev.dueClock), clock: cloneClock(this.state.clock) });
        this.emit('event-added', ev);
        return ev;
    }

    /** 按 id 或标题找事件；默认优先找「进行中」的 */
    findEvent(idOrTitle) {
        if (!idOrTitle) return null;
        const key = String(idOrTitle).trim();
        let ev = this.state.events.find((e) => e.id === key);
        if (ev) return ev;
        const normalized = normalizeTitle(key);
        const active = this.state.events.filter((e) => e.status === 'pending' || e.status === 'due');
        ev = active.find((e) => normalizeTitle(e.title) === normalized)
            ?? active.find((e) => normalizeTitle(e.title).includes(normalized) || normalized.includes(normalizeTitle(e.title)));
        if (ev) return ev;
        const all = [...this.state.events].reverse();
        return all.find((e) => normalizeTitle(e.title) === normalized) ?? null;
    }

    updateEvent(idOrTitle, patch, opts = {}) {
        const ev = this.findEvent(idOrTitle);
        if (!ev) return null;
        this._applyPatch(ev, patch);
        if (patch.dueClock || patch.durationMinutes != null) {
            // 说明：id 由「标题 + 到期时间」派生。改动到期时间后，重放会重新生成旧 id 的事件，
            // 而我们记录的 overlay 也挂在旧 id 上，两边依然对得上，因此这里**故意不换 id**。
            const nextDue = patch.dueClock
                ? normalizeClock(patch.dueClock)
                : addMinutes(ev.createdClock, Number(patch.durationMinutes) || 0);
            // 走 _rescheduleEvent，才能正确记下「预定终点（旧）」锚点和顺延次数 ——
            // 面板改时长和 AI 用「事件~」改时长必须是同一条路径。
            this._rescheduleEvent(ev, nextDue, opts.manual === false ? 'ai' : 'manual');
            if (ev.status === 'resolved' || ev.status === 'cancelled') {
                // 重新打开
                ev.status = 'pending';
                ev.resolvedClock = null;
                delete this.state.overlays.resolved[ev.id];
            }
            ev.lastNotifiedTurn = -1;
            ev.notifyCount = 0;
            ev.fired = {};
            ev.firedOrigins = [];
        }
        if (opts.manual !== false) {
            this.state.overlays.patches[ev.id] = { ...(this.state.overlays.patches[ev.id] || {}), ...snapshotPatch(patch) };
            const added = this.state.overlays.added.find((e) => e.id === ev.id);
            if (added) Object.assign(added, snapshotPatch(patch));
        }
        this.refreshStatuses();
        if (!opts.silent) this.emit('change', { reason: 'event-updated', event: ev });
        return ev;
    }

    _applyPatch(ev, patch) {
        if (!patch) return;
        if (patch.title != null && String(patch.title).trim()) ev.title = String(patch.title).trim();
        for (const key of [
            'expectation', 'variables', 'ledger', 'outline',
            'reward', 'risk', 'loss', 'note', 'result',
        ]) {
            if (patch[key] != null && String(patch[key]) !== '') ev[key] = String(patch[key]);
        }
        if (patch.progress != null && patch.progress !== '') {
            const p = Number(String(patch.progress).replace('%', ''));
            if (Number.isFinite(p)) ev.progress = clamp(p, 0, 100);
        }
        this._foldLegacyFields(ev);
    }

    /**
     * 把老的三格（收益 / 风险 / 损失）折叠进「预期 / 变数」。
     *
     * 只在**新字段为空**时折叠 —— AI 写了 `预期=` 就听它的，
     * 老存档则能靠这个继续在提醒和面板里正常显示。
     */
    _foldLegacyFields(ev) {
        if (!ev) return ev;
        if (!ev.expectation) {
            const parts = [];
            if (ev.reward) parts.push(ev.reward);
            if (ev.loss) parts.push(`失败：${ev.loss}`);
            if (parts.length) ev.expectation = parts.join('；');
        }
        if (!ev.variables && ev.risk) ev.variables = ev.risk;
        return ev;
    }

    resolveEvent(idOrTitle, { result = '', clock = null, manual = true } = {}) {
        const ev = this.findEvent(idOrTitle);
        if (!ev) return null;
        this._resolve(ev, result, clock ? normalizeClock(clock) : this.state.clock);
        if (manual) {
            this.state.overlays.resolved[ev.id] = { result: String(result || ''), clock: cloneClock(ev.resolvedClock) };
            this.state.overlays.removed = this.state.overlays.removed.filter((id) => id !== ev.id);
        }
        this.refreshStatuses();
        this.emit('change', { reason: 'event-resolved', event: ev });
        return ev;
    }

    _resolve(ev, result, clock) {
        ev.status = 'resolved';
        if (result) ev.result = String(result);
        ev.progress = 100;
        ev.resolvedClock = cloneClock(clock);
        this._pushHistory({ type: 'event-resolve', id: ev.id, title: ev.title, result: ev.result, clock: cloneClock(clock) });
    }

    cancelEvent(idOrTitle, { manual = true } = {}) {
        const ev = this.findEvent(idOrTitle);
        if (!ev) return null;
        this._cancel(ev, this.state.clock);
        if (manual) this.state.overlays.resolved[ev.id] = { result: '', clock: cloneClock(this.state.clock), cancelled: true };
        this.refreshStatuses();
        this.emit('change', { reason: 'event-cancelled', event: ev });
        return ev;
    }

    _cancel(ev, clock) {
        ev.status = 'cancelled';
        ev.resolvedClock = cloneClock(clock);
        this._pushHistory({ type: 'event-cancel', id: ev.id, title: ev.title, clock: cloneClock(clock) });
    }

    /** 删除事件（记进 overlays，重放后依然不出现） */
    removeEvent(idOrTitle, opts = {}) {
        const ev = this.findEvent(idOrTitle);
        if (!ev) return false;
        this.state.events = this.state.events.filter((e) => e !== ev);
        if (opts.manual !== false) {
            if (!this.state.overlays.removed.includes(ev.id)) this.state.overlays.removed.push(ev.id);
            this.state.overlays.added = this.state.overlays.added.filter((e) => e.id !== ev.id);
            delete this.state.overlays.patches[ev.id];
            delete this.state.overlays.resolved[ev.id];
        }
        this.emit('change', { reason: 'event-removed', event: ev });
        return true;
    }

    /** 清空所有事件（含重放出来的） */
    clearEvents({ keepOverlays = false } = {}) {
        this.state.events = [];
        this.state.history = [];
        if (!keepOverlays) this.state.overlays = createEmptyOverlays();
        this.emit('change', { reason: 'cleared' });
    }

    _trimEvents() {
        const limit = this.config.advanced.maxEvents;
        if (this.state.events.length <= limit) return;
        // 优先保留未结束的事件
        const active = this.state.events.filter((e) => e.status === 'pending' || e.status === 'due');
        const closed = this.state.events.filter((e) => e.status !== 'pending' && e.status !== 'due');
        const keepClosed = Math.max(0, limit - active.length);
        this.state.events = [...closed.slice(-keepClosed), ...active];
    }

    _pushHistory(entry) {
        this.state.history.push({ ...entry, at: nowIso() });
        const limit = this.config.advanced.historyLimit;
        if (this.state.history.length > limit) {
            this.state.history.splice(0, this.state.history.length - limit);
        }
    }

    // ───────────────────────────── 到期与提醒 ─────────────────────────────

    /**
     * 重算所有事件状态，返回「本次新到期」的事件。
     */
    refreshStatuses() {
        const now = this.state.clock;
        const newlyDue = [];
        for (const ev of this.state.events) {
            if (ev.status === 'pending' && clockToAbs(ev.dueClock) <= clockToAbs(now)) {
                ev.status = 'due';
                newlyDue.push(ev);
            }
        }
        if (newlyDue.length) {
            for (const ev of newlyDue) {
                this._pushHistory({ type: 'event-due', id: ev.id, title: ev.title, clock: cloneClock(now) });
            }
            this.emit('due', newlyDue);
        }
        this.state.updatedAt = nowIso();
        return newlyDue;
    }

    /**
     * 算出某个事件当前需要提醒哪个「时点」。
     *
     * 四个时点，各自职责完全不同：
     *   mid    —— 给世界一个伸手进来影响它的机会（静默，只需要调整参数）
     *   late   —— 初步结算，列一份「到点要交代什么」的清单（静默，不预设结果）
     *   origin —— 预定终点（旧），但它还没结束（**唯一一个让玩家意识到出岔子的时点**）
     *   due    —— 最终结算，写进正文
     *
     * 一次只返回**最靠后的那个**未提醒时点：如果时钟一口气从 40% 跳到 95%，
     * 只需要提醒最重要的那个，不必补发一堆过时的。
     *
     * @param {any} ev
     * @param {{mid:boolean,late:boolean,origin:boolean,due:boolean,everyTurn:boolean}} points
     * @returns {Array<{point:string, originAbs?:number}>} 0 或 1 项
     */
    _pendingPoints(ev, points) {
        if (ev.status === 'resolved' || ev.status === 'cancelled') return [];
        const cfg = this.config.reminder;
        const fired = ev.fired ?? {};
        const nowAbs = clockToAbs(this.state.clock);
        const dueAbs = clockToAbs(ev.dueClock);

        // ── 1. 到点（最高优先级：事情该结了） ──
        if (nowAbs >= dueAbs) {
            if (!points.due) return [];
            if (!fired.due) return [{ point: 'due' }];
            if (points.everyTurn) {
                const gap = this.state.turns - (fired.due ?? -1);
                if (gap >= Math.max(1, Number(cfg.repeatEveryTurns) || 1)) {
                    if (!cfg.maxReminders || (ev.notifyCount || 0) < cfg.maxReminders) return [{ point: 'due' }];
                }
            }
            return [];
        }

        // ── 2. 时长门槛①：太短的事件只走到点提醒 ──
        // 5 分钟的「拔剑出鞘」不该收到「定期检查，要不要把时长改成 3 天」。
        const checkpointMin = Number(cfg.checkpointMinMinutes) || 0;
        const total = diffMinutes(ev.dueClock, ev.createdClock);
        if (checkpointMin > 0 && total < checkpointMin) return [];

        // ── 3. 预定终点（旧）（被延后过，旧的到期时间已经过去） ──
        if (points.origin) {
            const firedOrigins = new Set((ev.firedOrigins ?? []).map(Number));
            const passed = (ev.dueHistory ?? [])
                .map((c) => clockToAbs(c))
                .filter((abs) => abs <= nowAbs && !firedOrigins.has(abs))
                .sort((a, b) => a - b);
            if (passed.length) return [{ point: 'origin', originAbs: passed[0] }];
        }

        // ── 4. 即将结束（按**当前**总时长的百分比） ──
        if (total <= 0) return [];
        const pct = (diffMinutes(this.state.clock, ev.createdClock) / total) * 100;

        // 「即将结束」优先于定期检查：它更靠后，而且能把「事情拖到末期了」一次讲清楚。
        if (points.late && !fired.late && pct >= (Number(cfg.lateAt) || 85)) {
            return [{ point: 'late' }];
        }

        // ── 5. 定期检查点位 ──
        // 报「已经到时间、且还没响过」里**最靠后**的那一个。
        // 更早的那些由 commitReminder 一并标记 —— 事件一次跨过好几个点位时，
        // 事后补发一条「你已经到 21% 了」是荒谬的。
        if (points.mid) {
            const firedMids = new Set((ev.firedMids ?? []).map(Number));
            let latest = null;
            for (const p of this._midPoints(ev)) {
                if (p.abs > nowAbs) break;
                if (!firedMids.has(p.abs)) latest = p.abs;
            }
            // 和某个还没兑现的旧期限挤在同一天时不报定期检查 ——
            // 那一刻该说的是「你之前答应的期限过去了」，不是「进度过半了」
            if (latest != null && !this._nearUnfiredOrigin(ev, latest)) {
                return [{ point: 'mid', midAbs: latest }];
            }
        }
        return [];
    }

    /**
     * 定期检查点位（`{ abs, clock }`，已过滤掉落在到期时间之后和「即将结束」之后的）。
     *
     * 规则：**每 N 天一 次，从事件开始算起，位置固定不变。**
     *
     * 两个刻意的设计：
     *
     * ① 用 `initialDurationMinutes`（登记时写死、永不改动），不是当前时长 ——
     *    所以事件被延长之后，**已有的点位日期一个都不动**，只在尾部接着往下排。
     *    这就是「出现变故后依然按原本的规律 N 天一次」的实现方式。
     *
     * ② 事件比 N 天还短时退到 D÷2（正中间一次）—— 否则短事件会一个点位都没有，
     *    而它以前是有一个 50% 的定期检查的。
     */
    _midPoints(ev) {
        const total = Number(ev.initialDurationMinutes) || Number(ev.durationMinutes) || 0;
        /**
         * ⚠️ 配置缺失时要有兜底。别的设置都写了 `|| 默认值`（lateAt / checkpointMinMinutes…），
         * 这里漏了的话，任何传入部分 reminder 配置的代码路径都会**静默丢掉所有定期检查** ——
         * 界面上还写着「每 7 天一次」，实际一个点位都不生成。
         *
         * 另外要区分「没设」和「设成 0」：0 是明确要关掉。
         */
        const raw = this.config.reminder?.checkEveryDays;
        const everyDays = raw == null ? 7 : Number(raw);
        if (total <= 0 || !Number.isFinite(everyDays) || everyDays <= 0) return [];

        const spacing = Math.min(everyDays * 1440, total / 2);
        const cfg = this.config.reminder;
        const curTotal = Number(ev.durationMinutes) || 0;
        const lateAbs = curTotal > 0
            ? clockToAbs(addMinutes(ev.createdClock, (curTotal * (Number(cfg.lateAt) || 85)) / 100))
            : Infinity;
        const dueAbs = clockToAbs(ev.dueClock);

        const out = [];
        /**
         * ⚠️ 循环的上界是**当前到期时间**，不是 `total`（初始时长）。
         *
         * 用 total 当上界的话，事件延长之后点位就不会往后续了 ——
         * 而「延长时在尾部接着排下去」正是这个功能的核心。
         */
        for (let k = 1; k <= 10000; k++) {
            const clock = addMinutes(ev.createdClock, k * spacing);
            const abs = clockToAbs(clock);
            // 到期之后的点位没有意义；挤到「即将结束」上的，交给 late 去说
            if (abs >= dueAbs || abs >= lateAbs) break;
            out.push({ abs, clock });
        }
        return out;
    }

    /**
     * 这个时刻是不是紧贴着一个「还没兑现的旧期限」（同一天内）。
     *
     * 定期检查点位和「预定终点（旧）」撞在一起时只报后者 —— 同一天里连打扰两次、
     * 说的还是同一件事，没有必要。
     */
    _nearUnfiredOrigin(ev, abs) {
        const firedOrigins = new Set((ev.firedOrigins ?? []).map(Number));
        for (const c of ev.dueHistory ?? []) {
            const a = clockToAbs(c);
            if (firedOrigins.has(a)) continue;
            if (Math.abs(a - abs) <= 1440) return true;
        }
        return false;
    }

    /** 当前配置下启用哪些时点 */
    _enabledPoints() {
        const cfg = this.config.reminder;
        const mode = cfg.mode ?? 'checkpoints';
        if (mode === 'once') return { mid: false, late: false, origin: false, due: true, everyTurn: false };
        if (mode === 'checkpoints') return { mid: true, late: true, origin: true, due: true, everyTurn: false };
        const p = cfg.points ?? {};
        return {
            mid: p.mid === true,
            late: p.late === true,
            origin: p.origin === true,
            due: p.due !== false,
            everyTurn: !!p.everyTurn,
        };
    }

    /**
     * 选出「本轮应当提醒」的项。
     *
     * 返回的是事件的**浅拷贝**，额外带 `reminderPoint`（'mid' / 'late' / 'due'），
     * 这样调用方照旧用 `ev.title` / `ev.id`，但能据此渲染不同的提醒文案。
     */
    selectReminders() {
        this.refreshStatuses();
        const cfg = this.config.reminder;
        const points = this._enabledPoints();
        const removed = new Set(this.state.overlays.removed);
        const out = [];

        for (const ev of this.state.events) {
            if (removed.has(ev.id)) continue;
            for (const item of this._pendingPoints(ev, points)) {
                out.push({
                    ...ev,
                    reminderPoint: item.point,
                    reminderOriginAbs: item.originAbs ?? null,
                    // 定期检查点位是按绝对分钟逐个记的，锚点必须一起带出去 ——
                    // 漏了它 commitReminder 就不知道该标记哪一个，同一个点位会反复提醒
                    reminderMidAbs: item.midAbs ?? null,
                });
            }
        }

        return out
            .sort((a, b) => {
                // 到点最急，其次预定终点（旧），再次即将结束 / 定期检查
                const rank = { due: 0, origin: 1, late: 2, mid: 3 };
                const d = (rank[a.reminderPoint] ?? 9) - (rank[b.reminderPoint] ?? 9);
                return d !== 0 ? d : clockToAbs(a.dueClock) - clockToAbs(b.dueClock);
            })
            .slice(0, Math.max(1, Number(cfg.maxPerTurn) || 4));
    }

    /**
     * 记下「这些时点已经提醒过了」。
     * 传进来的通常是 selectReminders() 的浅拷贝，所以要按 id 写回真正的事件对象。
     */
    commitReminder(reminders) {
        const list = Array.isArray(reminders) ? reminders : [reminders];
        const turn = this.state.turns;
        // 注意：origin 不参与「比它早的时点一并标记」—— 它是独立锚点。
        // 定期检查点位也不在这里，它按绝对分钟逐个记（见下面的 firedMids）。
        const ORDER = ['late', 'due'];

        for (const item of list) {
            if (!item) continue;
            const ev = this.state.events.find((e) => e.id === item.id);
            if (!ev) continue;
            // ⚠️ 定期检查必须在这个白名单里。以前 ORDER 同时兼任「白名单」和「谁比谁晚」，
            // 把 mid 从 ORDER 里拿掉之后，定期检查会被当成未知值兜底成 'due' ——
            // 于是发一个定期检查就会把 late 和 due 一起标记掉，后面两个再也不响。
            const point = item.reminderPoint === 'origin' || ['mid', 'late', 'due'].includes(item.reminderPoint)
                ? item.reminderPoint
                : 'due';

            if (point === 'origin') {
                ev.firedOrigins = [...new Set([...(ev.firedOrigins ?? []), Number(item.reminderOriginAbs)])]
                    .filter((n) => Number.isFinite(n));
                // 贴着这个旧期限的那一个定期检查点位一并作废 —— 同一天不该连打扰两次
                const originAbs = Number(item.reminderOriginAbs);
                const mids = new Set((ev.firedMids ?? []).map(Number));
                for (const p of this._midPoints(ev)) {
                    if (Math.abs(p.abs - originAbs) <= 1440) mids.add(p.abs);
                }
                ev.firedMids = [...mids].sort((a, b) => a - b);
            } else {
                ev.fired = ev.fired ?? {};
                // 把「不比本次晚」的时点一并标记为已提醒，避免过时补发
                for (const p of ORDER) {
                    if (ORDER.indexOf(p) <= ORDER.indexOf(point) && !ev.fired[p]) ev.fired[p] = turn;
                }
                if (point === 'due') ev.dueNotifiedTurn = turn;

                // 定期检查点位：报出去的那个、以及所有比它早的，一起标记。
                // 报 late / due 时，把已经到时间的点位全部标记（同上，避免过时补发）。
                const upto = point === 'mid' ? Number(item.reminderMidAbs) : clockToAbs(this.state.clock);
                const mids = new Set((ev.firedMids ?? []).map(Number));
                for (const p of this._midPoints(ev)) {
                    if (p.abs <= upto) mids.add(p.abs);
                }
                ev.firedMids = [...mids].sort((a, b) => a - b);
            }

            ev.notifyCount = (ev.notifyCount || 0) + 1;
            ev.lastNotifiedTurn = turn;
            ev.lastNotifiedAt = nowIso();

            this.state.notify[ev.id] = {
                count: ev.notifyCount,
                turn,
                at: ev.lastNotifiedAt,
                fired: { ...ev.fired },
                firedOrigins: [...(ev.firedOrigins ?? [])],
                firedMids: [...(ev.firedMids ?? [])],
            };
        }
        this.state.updatedAt = nowIso();
    }

    /**
     * 把「到点提醒已经发出」的事件在 AI 回应后自动归档。
     *
     * 这是「插件主导」的关键一步：AI 不需要写任何结束标记，
     * 它看到提醒、在正文里交代了，这件事就算完了。
     *
     * ⚠️ 只有「到点」才算交付。「即将结束」只是初步结算（列「要点」），
     * 它不会让事件结束 —— 否则 AI 一听话就把结果写早了，时限就变成摆设。
     */
    _archiveDeliveredEvents() {
        const now = this.state.turns;
        const archived = [];
        for (const ev of this.state.events) {
            if (ev.status !== 'due') continue;
            const delivered = ev.dueNotifiedTurn;
            if (typeof delivered !== 'number' || delivered >= now) continue;
            const result = ev.result || '';
            this._resolve(ev, result, this.state.clock);
            ev.autoResolved = true;
            this._pushHistory({
                type: 'event-auto-resolved',
                id: ev.id,
                title: ev.title,
                clock: cloneClock(this.state.clock),
            });
            archived.push(ev);
        }
        if (archived.length) this.emit('auto-archived', archived);
        return archived;
    }

    /**
     * 重新排期（AI 在定期检查被问到时可以改时长 / 到期时间）。
     * @param {any} ev
     * @param {import('./story-time.js').Clock} newDue
     * @param {'ai'|'manual'} by
     */
    _rescheduleEvent(ev, newDue, by = 'ai') {
        const oldAbs = clockToAbs(ev.dueClock);
        const oldClock = cloneClock(ev.dueClock);
        const next = normalizeClock(newDue);
        const nextAbs = clockToAbs(next);
        if (nextAbs === oldAbs) return ev;

        // 被取代的旧到期时间 → 记进 dueHistory。
        // 它将来到达时就是「预定终点（旧）」那个叙事节点（前提是事件那时还没结束）。
        if (nextAbs > oldAbs) {
            ev.dueHistory = [...(ev.dueHistory ?? []), oldClock];
        }

        ev.dueClock = next;
        ev.durationMinutes = Math.max(0, diffMinutes(next, ev.createdClock));

        // 初始时长登记时写死；老事件没有这个字段就补上当前值
        if (!Number.isFinite(Number(ev.initialDurationMinutes))) {
            ev.initialDurationMinutes = ev.durationMinutes;
        }
        ev.adjustments = [
            ...(ev.adjustments ?? []),
            {
                at: nowIso(),
                turn: this.state.turns,
                by,
                /** 相对上一次的增量 */
                minutes: diffMinutes(next, oldClock),
                /** 相对**初始时长**的累计调整 */
                totalMinutes: ev.durationMinutes - ev.initialDurationMinutes,
                totalDurationMinutes: ev.durationMinutes,
            },
        ];

        // 往后推 → 后面的时点重新武装（「即将结束」和「到点」要能再提醒一次）
        if (nextAbs > oldAbs) {
            if (ev.fired) {
                delete ev.fired.late;
                delete ev.fired.due;
            }
            ev.dueNotifiedTurn = null;
            ev.autoResolved = false;
            if (ev.status === 'due' && nextAbs > clockToAbs(this.state.clock)) ev.status = 'pending';
        } else {
            // 缩短 → 原本记录的预定终点（旧）锚点已经没有意义了，清掉还没到的那些
            const nowAbs = clockToAbs(this.state.clock);
            ev.dueHistory = (ev.dueHistory ?? []).filter((c) => clockToAbs(c) <= nowAbs);
        }

        this._pushHistory({
            type: 'event-rescheduled',
            id: ev.id,
            title: ev.title,
            by,
            clock: cloneClock(this.state.clock),
            dueClock: cloneClock(ev.dueClock),
            totalMinutes: ev.durationMinutes - ev.initialDurationMinutes,
        });
        this.refreshStatuses();
        return ev;
    }

    /**
     * 提醒历史摘要（从 notify 记账里推出来）。
     *
     * 用途：`lastInjection` 只存**最近一次**的原文，而且是新版本才开始记的。
     * 老存档里明明提醒过、却没有原文 —— 那时至少要把
     *「哪一轮、哪个时点、哪个事件」告诉用户，而不是显示成「从没提醒过」。
     */
    reminderHistory() {
        const out = [];
        for (const [id, info] of Object.entries(this.state.notify ?? {})) {
            if (!info || typeof info !== 'object') continue;
            const points = Object.keys(info.fired ?? {});
            // 定期检查点位不在 fired 里（它按绝对分钟逐个记），得单独看一眼
            if (Array.isArray(info.firedMids) && info.firedMids.length && !points.includes('mid')) {
                points.push('mid');
            }
            const originCount = Array.isArray(info.firedOrigins) ? info.firedOrigins.length : 0;
            if (!points.length && !originCount) continue;
            const ev = this.state.events.find((e) => e.id === id);
            out.push({
                id,
                title: ev?.title ?? '(已不在事件列表里)',
                turn: Number.isFinite(info.turn) ? info.turn : null,
                at: info.at ?? null,
                points,
                /** 顺延导致的「预定终点（旧）」提醒次数 */
                originCount,
                count: Number(info.count) || 0,
            });
        }
        return out.sort((a, b) => (b.turn ?? 0) - (a.turn ?? 0));
    }

    /** 事件时长的对外摘要：初始 / 调整 / 总 / 剩余 */
    describeDuration(ev) {
        const initial = Number.isFinite(Number(ev?.initialDurationMinutes))
            ? Number(ev.initialDurationMinutes)
            : Number(ev?.durationMinutes) || 0;
        const total = Number.isFinite(Number(ev?.durationMinutes))
            ? Number(ev.durationMinutes)
            : initial;
        const remaining = ev?.dueClock ? diffMinutes(ev.dueClock, this.state.clock) : total;
        const used = Math.max(0, total - Math.max(0, remaining));
        return {
            initial,
            total,
            remaining,
            used,
            /** 相对初始时长的累计调整 */
            delta: total - initial,
            /** 顺延次数 */
            reschedules: (ev?.dueHistory ?? []).length,
            percent: total > 0 ? clamp((used / total) * 100, 0, 100) : 0,
        };
    }

    /** 清掉某个事件的提醒计数（例如手动「重新提醒」） */
    resetReminder(idOrTitle) {
        const ev = this.findEvent(idOrTitle);
        if (!ev) return null;
        ev.notifyCount = 0;
        ev.lastNotifiedTurn = -1;
        ev.fired = {};
        ev.firedOrigins = [];
        ev.dueNotifiedTurn = null;
        delete this.state.notify[ev.id];
        this.emit('change', { reason: 'reminder-reset', event: ev });
        return ev;
    }

    /** 当前生效的提示词条目 */
    get activePrompt() {
        return getActivePrompt(this.config);
    }

    /**
     * 实际生效的注入文案。
     * 优先级：提示词库里的自定义文本 → 内置生成。
     *
     * 五个字段对应五个时点，都为 null 时用内置文案。
     */
    get promptTemplates() {
        const item = this.activePrompt ?? {};
        const pick = (v) => (typeof v === 'string' && v.trim() ? v : null);
        return {
            item,
            protocol: pick(item.protocol),
            mid: pick(item.mid),
            late: pick(item.late),
            origin: pick(item.origin),
            /** 老字段 reminder 作为 due 的别名（迁移期兼容） */
            due: pick(item.due) ?? pick(item.reminder),
        };
    }

    /** 自定义提示词里可用的占位符 */
    promptPlaceholders() {
        const tags = Array.isArray(this.config.tagNames) ? this.config.tagNames : ['timer'];
        const cal = this.formatter.calendar;
        return {
            tag: primaryTag(tags),
            tags: tags.join(', '),
            dayLabel: String(this.config.time.dayLabel ?? '第{day}天').replace('{day}', '3'),
            exampleClock: this.formatter.exampleClock(),
            // ⚠️ timeClock 是编辑器里宣传过、但一直没提供的占位符 —— 补上。
            // 提示词库里存模板时靠它，否则「当前剧情时间」会被冻成存下来的那一刻。
            timeClock: this.formatClock(),
            timeMode: this.formatter.isCalendar ? '日历制' : '计数制',
            era: cal?.era ?? '',
            monthCount: cal ? String(cal.months.length) : '',
            monthNames: cal?.hasCustomMonthNames ? cal.monthNames.join('、') : '',
            tooShort: protocolTooShort(this.config.reminder?.minEventMinutes),
            reminderHint: protocolReminderHint(),
            protocol: renderProtocolText({
                tagNames: tags,
                dayLabel: this.config.time.dayLabel,
                exampleClock: this.formatter.exampleClock(),
                // 当前剧情时间：既是参照，也顺便示范了格式
                nowClock: this.formatClock(),
                isCalendar: this.formatter.isCalendar,
                minEventMinutes: this.config.reminder?.minEventMinutes,
            }),
            header: `[${primaryTag(tags)}·剧情时间提醒]`,
        };
    }

    /**
     * 五个字段的**内置文案模板**（占位符版）。
     *
     * 提示词库里存这个，而不是存渲染好的文本 —— 否则「当前剧情时间」「标签名」
     * 「时长门槛」都会被冻在保存的那一刻，之后改设置它们不再跟着变。
     *
     * 代进占位符之后必须和内置渲染结果一字不差（有测试守着）。
     */
    builtinPromptTemplates() {
        const tag = '{{tag}}';
        const protocol = renderProtocolText({
            tagNames: [tag],
            dayLabel: '{{dayLabel}}',
            exampleClock: '{{exampleClock}}',
            nowClock: '{{timeClock}}',
            isCalendar: this.formatter.isCalendar,
            minEventMinutes: this.config.reminder?.minEventMinutes,
        })
            .replace(protocolTooShort(this.config.reminder?.minEventMinutes), '{{tooShort}}')
            .replace(/· 事件写完就不用管了[^\n]*/, '{{reminderHint}}');

        return {
            protocol,
            mid: builtinPointTemplate('mid', this.config, tag),
            late: builtinPointTemplate('late', this.config, tag),
            origin: builtinPointTemplate('origin', this.config, tag),
            due: builtinPointTemplate('due', this.config, tag),
        };
    }

    /**
     * 生成「记录格式」说明。
     *
     * 「每几轮注入一次」那个频率设置已经删掉了 —— 它早就失效了：只要提示词库里的
     * protocol 非空（`ensurePromptDefaults()` 保证它永远非空），下面那个提前返回就会
     * 直接走人，频率判断永远执行不到。删掉之后行为不变：**每轮都注入**。
     */
    renderProtocol(force = false) {
        const cfg = this.config.reminder;
        if (!cfg.includeProtocol && !force) return '';

        // 提示词库里写了自定义文案就直接用（支持 {{占位符}}）
        const custom = this.promptTemplates.protocol;
        if (typeof custom === 'string' && custom.trim()) {
            return applyPlaceholders(custom, this.promptPlaceholders());
        }
        return this.promptPlaceholders().protocol;
    }

    /**
     * 生成完整注入文本（提醒 + 协议说明），不修改状态。
     * @param {{ forceProtocol?: boolean, events?: any[] }} [opts]
     */
    buildInjectionText(opts = {}) {
        const events = opts.events ?? this.selectReminders();
        const protocolText = this.renderProtocol(!!opts.forceProtocol);
        if (!events.length && !protocolText) return '';

        const t = this.promptTemplates;
        return renderReminderText({
            clock: this.state.clock,
            events,
            config: this.config,
            protocolText: protocolText || null,
            formatClock: (clock) => this.formatClock(clock),
            templates: { mid: t.mid, late: t.late, origin: t.origin, due: t.due },
        });
    }

    /**
     * 用一组**还没保存**的文案渲染一份预览。
     *
     * 提示词编辑器要在保存前就让人看到效果，所以临时把这份文案换进提示词库，
     * 渲染完立刻换回来（finally 保证抛异常时也会还原）。
     *
     * @param {Record<string,string>} fields protocol / mid / late / origin / due
     * @param {any[]} events 用来示范的事件（每个时点放一个最好看）
     */
    previewPrompts(fields, events, { forceProtocol = true } = {}) {
        const items = this.config.prompts?.items;
        if (!Array.isArray(items) || !items.length) return '';
        const active = this.activePrompt;
        const idx = items.indexOf(active);
        if (idx < 0) return '';

        const saved = items[idx];
        items[idx] = { ...saved, ...fields };
        try {
            return this.buildInjectionText({ events, forceProtocol });
        } finally {
            items[idx] = saved;
        }
    }

    /** 一步到位：选出提醒、生成文本、记账。返回 { text, events } */
    buildAndCommitInjection(opts = {}) {
        const events = this.selectReminders();
        const text = this.buildInjectionText({ ...opts, events });
        if (!text) return { text: '', events: [] };
        if (events.length) this.commitReminder(events);

        /**
         * 记下「这一轮**实际注入出去**的文本」。
         *
         * ⚠️ 没有提醒时也要记。
         *
         * 协议说明（教 AI 用标签的那段）默认每轮都在发，所以「这一轮没有提醒」
         * 不等于「什么都没注入」。如果只在有提醒时才记，聊天记录里那些没有块的
         * 楼层就会被误读成「插件没工作」—— 而实际上模型每轮都收到了 300 多字符。
         *
         * 为什么必须单独留一份：提醒在交付时就 commit 掉了，之后
         * `selectReminders()` 再也选不出它，而宿主里的注入文本会被后续刷新覆盖。
         */
        this.state.lastInjection = {
            text,
            turn: this.state.turns,
            at: nowIso(),
            points: events.map((e) => e.reminderPoint ?? 'due'),
            titles: events.map((e) => e.title),
        };
        return { text, events };
    }

    // ───────────────────────────── 视图模型 ─────────────────────────────

    /**
     * 给 UI 用的单事件视图对象。
     * @param {any} ev
     */
    describeEvent(ev) {
        const now = this.state.clock;
        const total = Math.max(0, diffMinutes(ev.dueClock, ev.createdClock));
        const elapsed = diffMinutes(now, ev.createdClock);
        const remaining = diffMinutes(ev.dueClock, now);
        const derived = total > 0 ? clamp((elapsed / total) * 100, 0, 100) : (remaining <= 0 ? 100 : 0);
        const progress = ev.progress != null ? ev.progress : derived;
        return {
            ...ev,
            remainingMinutes: remaining,
            overdue: remaining < 0 && (ev.status === 'pending' || ev.status === 'due'),
            progress: Math.round(progress),
            progressIsEstimate: ev.progress == null,
            totalMinutes: total,
            elapsedMinutes: elapsed,
            // 展示文本统一走时间门面，计数制/日历制自动切换
            dueText: this.formatClock(ev.dueClock),
            createdText: this.formatClock(ev.createdClock),
            // 曾经这里还有个 dueShort（短格式）。它是死代码 —— 全项目没有任何地方读它，
            // 而设置里却摆着「短格式」让人以为能调。一起删掉了。
        };
    }

    /**
     * 一个事件的**提醒时刻表** —— 面板上「什么时候会提醒我」看这里。
     *
     * ⚠️ 时刻算法必须和真正排提醒的 `_pendingPoints` 一致，不能各写一份：
     *   · 定期检查 = 事件开始 + k × N 天（**固定日期**，延长只在尾部续，老点位不动）
     *   · 即将结束 = 事件开始 + **当前**总时长 × 百分比
     *   · 预定终点（旧）= 事件开始 + **最初**时长（只有被延长过才存在这个时点）
     *   · 预定终点（现）= 当前到期时间
     *
     * `passed` 是按**剧情时间**算的（那一刻已经过去了），`fired` 是**真的发过提醒**。
     * 两者可能不一致（比如提醒还没轮到就被删了档），面板上分开表达。
     *
     * @returns {Array<{ point: string, label: string, clock: any, text: string, fired: boolean, passed: boolean }>}
     */
    reminderSchedule(ev) {
        if (!ev) return [];
        if (ev.status !== 'pending' && ev.status !== 'due') return [];

        const cfg = this.config.reminder ?? {};
        const points = this._enabledPoints();
        const nowAbs = clockToAbs(this.state.clock);
        const total = diffMinutes(ev.dueClock, ev.createdClock);
        const ratioAt = (pct) => addMinutes(ev.createdClock, Math.round((total * (Number(pct) || 0)) / 100));

        const fired = ev.fired ?? {};
        const firedOrigins = new Set((ev.firedOrigins ?? []).map(Number));
        const firedDue = typeof ev.dueNotifiedTurn === 'number' && ev.dueNotifiedTurn >= 0;

        // 和 _pendingPoints 一样：太短的事件根本不走定期检查 / 即将结束
        const checkpointMin = Number(cfg.checkpointMinMinutes) || 0;
        const skipCheckpoints = checkpointMin > 0 && total < checkpointMin;

        const out = [];
        const push = (point, label, clock, isFired) => {
            if (!clock) return;
            out.push({
                point,
                label,
                clock,
                text: this.formatClock(clock),
                fired: !!isFired,
                passed: clockToAbs(clock) <= nowAbs,
            });
        };

        if (!skipCheckpoints && points.mid) {
            // 定期检查现在是一串点位（每 N 天一个），逐个列出来
            const firedMids = new Set((ev.firedMids ?? []).map(Number));
            for (const p of this._midPoints(ev)) {
                push('mid', '定期检查', p.clock, firedMids.has(p.abs));
            }
        }
        if (!skipCheckpoints && points.late) {
            push('late', '即将结束', ratioAt(cfg.lateAt ?? 85), fired.late != null);
        }
        if (points.origin
            && Number(ev.initialDurationMinutes) > 0
            && Number(ev.initialDurationMinutes) !== Number(ev.durationMinutes)) {
            const original = addMinutes(ev.createdClock, Number(ev.initialDurationMinutes));
            push('origin', '预定终点（旧）', original, firedOrigins.has(clockToAbs(original)));
        }
        if (points.due) push('due', '预定终点（现）', ev.dueClock, firedDue);

        return out.sort((a, b) => clockToAbs(a.clock) - clockToAbs(b.clock));
    }

    /** 面板用的整体快照 */
    snapshot() {
        const active = this.activeEvents.map((e) => this.describeEvent(e));
        const due = active.filter((e) => e.status === 'due');
        return {
            clock: cloneClock(this.state.clock),
            clockText: this.formatClock(this.state.clock),
            timeMode: this.timeMode,
            turns: this.state.turns,
            active,
            due,
            /** 最近一次「真的带提醒」的注入（持久化，刷新页面也还在） */
            lastInjection: this.state.lastInjection ?? null,
            /** 提醒历史摘要（老存档没有原文时至少能看出版记录） */
            reminderHistory: this.reminderHistory(),
            finished: this.state.events
                .filter((e) => e.status === 'resolved' || e.status === 'cancelled')
                .slice(-30)
                .map((e) => this.describeEvent(e)),
            nextDueMinutes: active.length
                ? Math.min(...active.map((e) => e.remainingMinutes))
                : null,
        };
    }

    // ───────────────────────────── 重放 / Overlay ─────────────────────────────

    _applyAdvancesForTurn(turn) {
        for (const entry of this.state.overlays.advances) {
            if (entry.atTurn === turn) {
                this.state.clock = addMinutes(this.state.clock, entry.minutes);
            }
        }
    }

    _applyAdvancesForTurnUpTo(turn) {
        for (const entry of this.state.overlays.advances) {
            if (entry.atTurn <= turn) {
                this.state.clock = addMinutes(this.state.clock, entry.minutes);
            }
        }
    }

    /** 重放结束后套用手动覆盖 */
    _applyOverlays() {
        const ov = this.state.overlays;

        // 1. 手动新增的事件（到期时间是绝对值，与重放无关）
        for (const added of ov.added) {
            if (this.state.events.some((e) => e.id === added.id)) continue;
            const ev = {
                ...createEmptyEvent(),
                ...added,
                createdClock: cloneClock(added.createdClock || this.state.clock),
                dueClock: cloneClock(added.dueClock || this.state.clock),
                manual: true,
                resolvedClock: added.resolvedClock ? cloneClock(added.resolvedClock) : null,
            };
            this.state.events.push(ev);
        }

        // 2. 手动删除
        if (ov.removed.length) {
            const removed = new Set(ov.removed);
            this.state.events = this.state.events.filter((e) => !removed.has(e.id));
        }

        // 3. 手动改字段
        for (const [id, patch] of Object.entries(ov.patches)) {
            const ev = this.state.events.find((e) => e.id === id);
            if (!ev) continue;
            this._applyPatch(ev, patch);
            if (patch.dueClock) {
                ev.dueClock = normalizeClock(patch.dueClock);
                ev.durationMinutes = Math.max(0, diffMinutes(ev.dueClock, ev.createdClock));
            }
        }

        // 4. 手动结算
        for (const [id, info] of Object.entries(ov.resolved)) {
            const ev = this.state.events.find((e) => e.id === id);
            if (!ev) continue;
            if (info.cancelled) this._cancel(ev, info.clock || this.state.clock);
            else this._resolve(ev, info.result || '', info.clock || this.state.clock);
        }

        // 5. 恢复提醒计数与已提醒过的时点（不属于重放派生量，按 id 贴回去）
        for (const [id, info] of Object.entries(this.state.notify || {})) {
            const ev = this.state.events.find((e) => e.id === id);
            if (!ev || !info) continue;
            ev.notifyCount = Number(info.count) || 0;
            ev.lastNotifiedTurn = Number.isFinite(info.turn) ? info.turn : -1;
            ev.lastNotifiedAt = info.at || null;
            if (info.fired && typeof info.fired === 'object') ev.fired = { ...info.fired };
            if (Array.isArray(info.firedOrigins)) ev.firedOrigins = info.firedOrigins.map(Number).filter(Number.isFinite);
            ev.dueNotifiedTurn = Number.isFinite(info.fired?.due) ? info.fired.due : null;
        }
    }

    /** 当前聊天记录的签名（用来判断时间线有没有被改写） */
    get signature() {
        return this._signature;
    }

    /**
     * 同步「当前聊天记录」的签名。
     *
     * 正常聊天时消息是一条条 `observeMessage` 进来的，签名要跟着更新；
     * 否则它永远停在最后一次 `rebuild` 的值上，等下次重建时就会
     * **误判成「内容变了」**，把好好的提醒记账冲掉。
     */
    setSignature(sig) {
        if (sig) this._signature = sig;
    }

    /**
     * 丢掉「不可能成立」的提醒记账。
     *
     * `fired` 里存的是**轮次**。如果它记的轮次比当前轮次还大，那这条记录一定来自
     * 一条更长的时间线（用户删过楼）—— 老版本在删楼时没作废它，于是它一直卡着，
     * 该提醒的时点**永远不再提醒**。存档里已经躺着的坏数据只能这样兜住。
     *
     * @returns {boolean} 有没有改动
     */
    pruneInvalidNotify() {
        const turns = this.state.turns;
        let changed = false;

        for (const [id, info] of Object.entries(this.state.notify ?? {})) {
            if (!info || typeof info !== 'object') { delete this.state.notify[id]; changed = true; continue; }
            const ev = this.state.events.find((e) => e.id === id);
            if (!ev) { delete this.state.notify[id]; changed = true; continue; }

            const stale = (Number.isFinite(info.turn) && info.turn > turns)
                || Object.values(info.fired ?? {}).some((t) => Number.isFinite(t) && t > turns)
                || (Array.isArray(info.firedOrigins) && info.firedOrigins.length > turns);

            if (stale) {
                delete this.state.notify[id];
                ev.fired = {};
                ev.firedOrigins = [];
                ev.notifyCount = 0;
                ev.lastNotifiedTurn = -1;
                ev.lastNotifiedAt = null;
                ev.dueNotifiedTurn = null;
                changed = true;
            }
        }

        const last = this.state.lastInjection;
        if (last && Number.isFinite(last.turn) && last.turn > turns) {
            this.state.lastInjection = null;
            changed = true;
        }
        return changed;
    }

    /**
     * 作废所有「提醒记账」。
     *
     * 聊天记录被改写（删楼 / 改楼 / 换消息）时调用 —— 那些记录指向的时间线已经不存在了。
     * 作废之后，落在当前时间点上的时点会重新提醒一次，这才是对的：
     * 在新时间线里用户确实还没被提醒过。
     */
    invalidateReminderState() {
        this.state.notify = {};
        this.state.lastInjection = null;
        this.state.injections = {};
        for (const ev of this.state.events) {
            ev.fired = {};
            ev.firedOrigins = [];
            ev.notifyCount = 0;
            ev.lastNotifiedTurn = -1;
            ev.lastNotifiedAt = null;
            ev.dueNotifiedTurn = null;
        }
    }

    /**
     * 记下「这一条 AI 消息的生成里注入了什么」。
     * 面板和消息块都靠它显示 —— 用户要的是「哪一回合注入了什么」。
     */
    recordInjection(messageIndex, rec) {
        if (messageIndex == null || !rec?.text) return;
        this.state.injections = this.state.injections ?? {};
        this.state.injections[String(messageIndex)] = {
            text: rec.text,
            points: rec.points ?? [],
            titles: rec.titles ?? [],
            at: nowIso(),
        };
        // 只保留最近若干条，别让存档无限涨
        const keys = Object.keys(this.state.injections);
        const limit = 80;
        if (keys.length > limit) {
            const sorted = keys.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
            for (const k of sorted.slice(0, keys.length - limit)) delete this.state.injections[String(k)];
        }
    }

    /** 某条消息对应的注入记录 */
    injectionFor(messageIndex) {
        return this.state.injections?.[String(messageIndex)] ?? null;
    }

    // ───────────────────────────── 序列化 ─────────────────────────────

    serialize() {
        return {
            version: STATE_VERSION,
            initialClock: cloneClock(this.state.initialClock),
            clock: cloneClock(this.state.clock),
            turns: this.state.turns,
            events: this.state.events.map((e) => ({ ...e })),
            history: this.state.history.slice(-50),
            overlays: JSON.parse(JSON.stringify(this.state.overlays)),
            notify: JSON.parse(JSON.stringify(this.state.notify || {})),
            /** 最近一次「真的带提醒」的注入原文 —— 必须持久化，否则刷新页面就查不到了 */
            lastInjection: this.state.lastInjection ? JSON.parse(JSON.stringify(this.state.lastInjection)) : null,
            /** 每条 AI 消息注入了什么：{ [消息下标]: { text, points, titles, at } } */
            injections: JSON.parse(JSON.stringify(this.state.injections ?? {})),
            signature: this._signature,
            updatedAt: this.state.updatedAt,
        };
    }

    /**
     * 恢复存档。`derived` 只用于立刻渲染 UI，真正的状态应由宿主重放校正。
     * @param {any} saved
     * @param {{ applyDerived?: boolean }} [opts]
     */
    restore(saved, opts = {}) {
        if (!saved || typeof saved !== 'object') return false;
        if (saved.initialClock) this.state.initialClock = normalizeClock(saved.initialClock);
        if (saved.overlays && typeof saved.overlays === 'object') {
            const ov = createEmptyOverlays();
            for (const key of Object.keys(ov)) {
                const value = saved.overlays[key];
                if (Array.isArray(ov[key])) ov[key] = Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : [];
                else if (ov[key] && typeof ov[key] === 'object') ov[key] = (value && typeof value === 'object') ? JSON.parse(JSON.stringify(value)) : {};
            }
            this.state.overlays = ov;
        }
        if (saved.notify && typeof saved.notify === 'object') {
            this.state.notify = JSON.parse(JSON.stringify(saved.notify));
        }
        if (saved.lastInjection && typeof saved.lastInjection === 'object' && saved.lastInjection.text) {
            this.state.lastInjection = JSON.parse(JSON.stringify(saved.lastInjection));
        }
        if (saved.injections && typeof saved.injections === 'object') {
            this.state.injections = JSON.parse(JSON.stringify(saved.injections));
        }
        if (opts.applyDerived !== false && Array.isArray(saved.events)) {
            this.state.events = saved.events.map((e) => {
                const ev = {
                    ...createEmptyEvent(),
                    ...e,
                    createdClock: normalizeClock(e.createdClock || saved.initialClock || this.defaultInitialClock()),
                    dueClock: normalizeClock(e.dueClock || saved.initialClock || this.defaultInitialClock()),
                };
                /**
                 * 一次性迁移：定期检查从「一个 `fired.mid` 轮次」改成「按绝对分钟记的 `firedMids`」。
                 *
                 * 老的那个只有一个标志，对应的是当时那个百分比点位（`midAt`，默认 50）。
                 * 它已经响过就把对应位置标上，免得同一个位置再响一次。
                 */
                if (ev.fired?.mid != null && !(Array.isArray(e.firedMids) && e.firedMids.length)) {
                    const initial = Number(ev.initialDurationMinutes) || 0;
                    if (initial > 0) {
                        const at = addMinutes(ev.createdClock, (initial * 50) / 100);
                        ev.firedMids = [clockToAbs(at)];
                    }
                }
                if (ev.fired) delete ev.fired.mid;
                return ev;
            });
            this.state.clock = normalizeClock(saved.clock || this.state.initialClock);
            this.state.turns = Number(saved.turns) || 0;
        }
        this._signature = saved.signature ?? null;
        // 存档里可能躺着「轮次比现在还大」的坏记账（老版本删楼没作废），兜一下
        this.pruneInvalidNotify();
        this.emit('change', { reason: 'restore' });
        return true;
    }

    /** 导出「手动干预」部分，方便跨聊天迁移或备份 */
    exportOverlays() {
        return JSON.parse(JSON.stringify(this.state.overlays));
    }

    importOverlays(overlays) {
        if (!overlays || typeof overlays !== 'object') return;
        const empty = createEmptyOverlays();
        for (const key of Object.keys(empty)) {
            if (overlays[key] != null) this.state.overlays[key] = JSON.parse(JSON.stringify(overlays[key]));
        }
        this.emit('change', { reason: 'overlays-imported' });
    }
}

/**
 * 把 `{{占位符}}` 替换成实际值。自定义提示词里可以用：
 * {{tag}} {{tags}} {{dayLabel}} {{exampleClock}} {{timeMode}} {{era}} {{monthCount}} {{monthNames}} {{protocol}} {{header}}
 */
function applyPlaceholders(template, values) {
    return String(template).replace(/\{\{\s*([\w]+)\s*\}\}/g, (whole, key) => (
        Object.hasOwn(values, key) ? String(values[key] ?? '') : whole
    ));
}

function createEmptyOverlays() {
    return {
        /** 被手动删除的事件 id */
        removed: [],
        /** 手动添加的事件 */
        added: [],
        /** 手动推进时间：{ atTurn, minutes, label } */
        advances: [],
        /** 手动修改：{ [id]: patch } */
        patches: {},
        /** 手动结算：{ [id]: { result, clock, cancelled? } } */
        resolved: {},
    };
}

function createEmptyEvent() {
    return {
        id: '',
        title: '',
        status: 'pending',
        createdClock: { day: 1, minute: 480 },
        dueClock: { day: 1, minute: 480 },
        /** 登记时写死的初始时长，永不改动 */
        initialDurationMinutes: 0,
        /** 当前总时长 */
        durationMinutes: 0,
        /** 历次调整 */
        adjustments: [],
        /** 被取代的旧到期时间 */
        dueHistory: [],
        /** 已提醒过的预定终点（旧）锚点（绝对分钟） */
        firedOrigins: [],
        /** 已提醒过的定期检查点位（绝对分钟） */
        firedMids: [],
        progress: null,
        expectation: '',
        variables: '',
        ledger: '',
        outline: '',
        reward: '',
        risk: '',
        loss: '',
        note: '',
        result: '',
        source: 'tag',
        manual: false,
        createdAt: null,
        createdTurn: 0,
        resolvedClock: null,
        notifyCount: 0,
        lastNotifiedTurn: -1,
        lastNotifiedAt: null,
        /** 已经提醒过的时点：{ mid?: turn, late?: turn, due?: turn } */
        fired: {},
        /** 「到点」提醒是在第几轮发出的（AI 回应后据此自动归档） */
        dueNotifiedTurn: null,
        /** 是否由插件自动归档（而不是 AI 或用户明确结束的） */
        autoResolved: false,
    };
}

function snapshotPatch(patch) {
    const out = {};
    for (const key of [
        'title', 'expectation', 'variables', 'ledger', 'outline',
        'reward', 'risk', 'loss', 'note', 'progress',
    ]) {
        if (patch[key] != null) out[key] = patch[key];
    }
    if (patch.dueClock) out.dueClock = cloneClock(patch.dueClock);
    return out;
}

export { absToClock, createDefaultConfig, mergeConfig, STATE_VERSION };
