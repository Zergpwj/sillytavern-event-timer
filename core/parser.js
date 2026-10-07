/**
 * 正文解析器 —— 从 AI 输出里抽取「剧情时间」与「需要耗时的事件」。
 *
 * 两级策略：
 *   1. 结构化标签协议（`<计时器>…</计时器>`），支持 JSON 或「键: 值」行格式，最可靠；
 *   2. 叙事正则兜底，扫「三天后」「第二天清晨」这类自然语言。
 *
 * 纯逻辑，无宿主依赖。
 */

import { absToClock, addMinutes, clockToAbs, normalizeClock, parseTimeOfDay } from './story-time.js';
import {
    DEFAULT_UNITS,
    findDurationExpressions,
    findExplicitDayClock,
    findTimeOfDayExpressions,
    parseAbsoluteClock,
    parseDuration,
    startsWithTimeSkip,
} from './time-lexer.js';

/** 默认识别的标签名 */
/**
 * 默认标签名。**第一个是教给 AI 用的那个**（写进协议说明）。
 *
 * `timer` 排在第一位：ASCII 标签在各类模型上生成更稳，不会被中文字符的
 * 全角/简繁/编码问题搞坏。中文标签仍然照常解析 —— 所有名字都认。
 */
export const DEFAULT_TAG_NAMES = ['timer', '计时器', 'story_timer', 'storytimer', 'STIMER'];

/** 键名别名 → 内部字段 */
const KEY_ALIASES = {
    time: ['时间', '时刻', '現在時間', '现在时间', '当前时间', 'time', 'clock', 'now'],
    advance: ['流逝', '经过', '推进', '耗时', '过去', 'advance', 'elapsed', 'advance_minutes', 'pass'],
    add: ['事件+', '事件＋', '新增', '新增事件', '开始', '开始事件', 'event+', 'events+', 'add', 'start', 'new'],
    update: ['事件~', '事件～', '更新', '更新事件', '进度', 'event~', 'update', 'progress'],
    resolve: ['事件-', '事件－', '完成', '结束', '完成事件', 'event-', 'done', 'resolve', 'finish'],
    cancel: ['事件!', '事件！', '取消', '取消事件', 'event!', 'cancel', 'abort'],
    note: ['备注', '注记', '旁注', 'note', 'remark', 'comment'],
};

/** 事件行内的字段别名 */
const FIELD_ALIASES = {
    id: ['id', '编号', '标识'],
    title: ['标题', '名称', '事件', 'title', 'name', 'event'],
    due: ['到期', '预定', '完成于', '截止', 'due', 'at', 'deadline', 'until'],
    in: ['时长', '需要', '预计', 'in', 'duration', 'takes', 'after', 'eta'],
    /**
     * 预期：这件事大致会长成什么样。成功 / 失败 / 条件都写在这一句里。
     *
     * 老字段（收益 / 风险 / 损失）**保持独立**，不并进来 ——
     * 它们都映射到同一个 canonical key 的话会互相覆盖（收益+风险+损失 只剩最后一个）。
     * 折叠成「预期 / 变数」这件事由引擎在补全时做。
     */
    expectation: [
        '预期', '预计结果', '期望', '目标', '想要',
        'expectation', 'expect', 'expected', 'goal', 'target',
    ],
    /** 变数：什么会让它偏离预期。不限内外、不限正负。 */
    variables: [
        '变数', '变量', '影响因素', '关注', '关注点',
        'variables', 'variable', 'factors',
    ],
    /**
     * 资源：持续性的资源收支（自由文本，插件不解析）。
     *
     * 教给 AI 的名字是「资源」；「账目」保留为别名，老聊天里的 `账目=` 照样能解析。
     * 内部键名仍然是 ledger（改它会破坏已存存档），只在显示和教学文案上用「资源」。
     */
    ledger: [
        '资源', '账目', '收支', '消耗', '开销', '物资', '资金',
        'resources', 'ledger', 'budget', 'expense', 'expenses',
    ],
    /** 要点：「即将结束」时列出的交代清单（不是结局预告） */
    outline: ['要点', '交代要点', '待交代', 'outline', 'checklist', 'points'],
    /** 老字段：仍然独立解析，引擎会把它们折叠进「预期 / 变数」 */
    reward: ['收益', '预期收益', '好处', '回报', 'reward', 'gain', 'benefit', 'upside'],
    risk: ['风险', '危险', 'risk', 'danger', 'threat', 'downside'],
    loss: ['损失', '代价', '惩罚', 'loss', 'penalty'],
    note: ['详情', '说明', '描述', '备注', 'note', 'detail', 'desc', 'description'],
    progress: ['进度', 'progress'],
    result: ['结果', '成果', 'result', 'outcome'],
    status: ['状态', 'status'],
};

/** 反向索引：别名 → 字段名 */
const REVERSE_KEY = buildReverse(KEY_ALIASES);
const REVERSE_FIELD = buildReverse(FIELD_ALIASES);

function buildReverse(map) {
    /** @type {Record<string,string>} */
    const out = {};
    for (const [canonical, aliases] of Object.entries(map)) {
        for (const alias of aliases) out[normalizeKey(alias)] = canonical;
        out[normalizeKey(canonical)] = canonical;
    }
    return out;
}

/** 归一化键名：去空白、去末尾标点、小写 */
function normalizeKey(key) {
    return String(key ?? '')
        .replace(/[\s\u3000]+/g, '')
        .replace(/[:：=＝]+$/, '')
        .toLowerCase();
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 抽出所有计时器标签块。
 * @param {string} text
 * @param {string[]} [tagNames]
 * @returns {Array<{ tag: string, body: string, raw: string, index: number, closed: boolean }>}
 */
export function extractTagBlocks(text, tagNames = DEFAULT_TAG_NAMES) {
    const blocks = [];
    if (!text) return blocks;
    const src = String(text);
    const names = (Array.isArray(tagNames) ? tagNames : [tagNames])
        .map((n) => String(n || '').trim())
        .filter(Boolean);
    if (!names.length) return blocks;

    const alt = names.map(escapeRegExp).join('|');
    const occupied = [];

    // 1) ```timer ... ``` 代码块
    const fenceRe = new RegExp('```[ \\t]*(' + alt + ')[ \\t]*\\r?\\n([\\s\\S]*?)```', 'gi');
    let m;
    while ((m = fenceRe.exec(src)) !== null) {
        blocks.push({ tag: m[1], body: m[2], raw: m[0], index: m.index, closed: true });
        occupied.push([m.index, m.index + m[0].length]);
    }

    // 2) <计时器> ... </计时器>
    const openRe = new RegExp('<\\s*(' + alt + ')\\s*(?:[^>]*?)>', 'gi');
    while ((m = openRe.exec(src)) !== null) {
        const start = m.index;
        if (occupied.some(([a, b]) => start >= a && start < b)) continue;
        const tag = m[1];
        const bodyStart = m.index + m[0].length;
        const sameOpen = new RegExp('<\\s*' + escapeRegExp(tag) + '\\s*(?:[^>]*?)>', 'gi');
        sameOpen.lastIndex = bodyStart;
        const closeRe = new RegExp('<\\s*/\\s*' + escapeRegExp(tag) + '\\s*>', 'i');
        const rest = src.slice(bodyStart);
        const closeMatch = rest.match(closeRe);
        const nextOpen = sameOpen.exec(src);
        let body;
        let end;
        let closed = false;
        if (closeMatch && (!nextOpen || bodyStart + closeMatch.index < nextOpen.index)) {
            body = rest.slice(0, closeMatch.index);
            end = bodyStart + closeMatch.index + closeMatch[0].length;
            closed = true;
        } else if (nextOpen) {
            body = src.slice(bodyStart, nextOpen.index);
            end = nextOpen.index;
        } else {
            body = rest;
            end = src.length;
        }
        blocks.push({ tag, body, raw: src.slice(start, end), index: start, closed });
        occupied.push([start, end]);
        openRe.lastIndex = end;
    }

    // 3) [[计时器]] ... [[/计时器]]
    const wikiRe = new RegExp('\\[\\[\\s*(' + alt + ')\\s*\\]\\]([\\s\\S]*?)\\[\\[\\s*/\\s*\\1\\s*\\]\\]', 'gi');
    while ((m = wikiRe.exec(src)) !== null) {
        if (occupied.some(([a, b]) => m.index >= a && m.index < b)) continue;
        blocks.push({ tag: m[1], body: m[2], raw: m[0], index: m.index, closed: true });
        occupied.push([m.index, m.index + m[0].length]);
    }

    // 4) <!-- 计时器 ... -->
    const htmlRe = new RegExp('<!--\\s*(' + alt + ')\\s*([\\s\\S]*?)-->', 'gi');
    while ((m = htmlRe.exec(src)) !== null) {
        if (occupied.some(([a, b]) => m.index >= a && m.index < b)) continue;
        blocks.push({ tag: m[1], body: m[2], raw: m[0], index: m.index, closed: true });
        occupied.push([m.index, m.index + m[0].length]);
    }

    blocks.sort((a, b) => a.index - b.index);
    return blocks;
}

/**
 * 去掉正文里的计时器标签块（送给 LLM 抽取器或展示时使用）。
 * @param {string} text
 * @param {string[]} [tagNames]
 */
export function stripTagBlocks(text, tagNames = DEFAULT_TAG_NAMES) {
    let out = String(text ?? '');
    const blocks = extractTagBlocks(out, tagNames).sort((a, b) => b.index - a.index);
    for (const b of blocks) {
        out = out.slice(0, b.index) + out.slice(b.index + b.raw.length);
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** 把一行「标题 | 时长 | 收益=…」拆成字段对象 */
function parseEventLine(line) {
    const fields = {};
    const segments = String(line)
        .split(/\s*[|｜]\s*/)
        .map((s) => s.trim())
        .filter((s) => s !== '');

    let positionalIndex = 0;
    for (const seg of segments) {
        const kv = seg.match(/^([^=＝:：]{1,12})\s*[=＝:：]\s*([\s\S]*)$/);
        if (kv && REVERSE_FIELD[normalizeKey(kv[1])]) {
            fields[REVERSE_FIELD[normalizeKey(kv[1])]] = kv[2].trim();
            continue;
        }
        // 位置参数：第 1 个是标题，第 2 个是时长
        if (positionalIndex === 0) fields.title = seg;
        else if (positionalIndex === 1) fields.in = seg;
        else fields.note = fields.note ? `${fields.note} ${seg}` : seg;
        positionalIndex += 1;
    }
    return fields;
}

/**
 * 把标签体解析成结构化结果。
 * @param {string} body
 * @param {{ clock: import('./story-time.js').Clock, units?: Record<string, number>, maxEventsPerMessage?: number }} ctx
 */
export function parseTagBody(body, ctx) {
    const clock = normalizeClock(ctx?.clock ?? { day: 1, minute: 480 });
    const result = {
        clock: null,
        advanceMinutes: null,
        /** 结构化的时长分量，日历模式下用它做精确的「几个月/几年」加法 */
        advanceParts: [],
        events: [],
        note: null,
        format: 'unknown',
        errors: [],
    };
    if (!body || !String(body).trim()) return result;

    const text = String(body).trim();

    // ---------- 1) JSON ----------
    const jsonText = extractJson(text);
    if (jsonText) {
        try {
            const data = JSON.parse(jsonText);
            result.format = 'json';
            applyJsonPayload(data, result, ctx, clock);
            return result;
        } catch (err) {
            result.errors.push(`JSON 解析失败：${err.message}`);
        }
    }

    // ---------- 2) 键值行 ----------
    result.format = 'kv';
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim().replace(/^[-*•]\s*/, '');
        if (!line || /^[#/\-—=]+$/.test(line)) continue;
        const kv = line.match(/^([^=＝:：]{1,16})\s*[:：=＝]\s*([\s\S]*)$/);
        if (!kv) {
            // 没有冒号的行，尝试当作事件行（"事件+ 标题 | 6小时"）
            const loose = line.match(/^(事件\+|事件~|事件-|事件!|新增|更新|完成|结束|取消)\s+(.+)$/);
            if (loose) {
                const op = REVERSE_KEY[normalizeKey(loose[1])] || 'add';
                pushEventLine(result, op, loose[2], ctx, clock);
            }
            continue;
        }
        const canonical = REVERSE_KEY[normalizeKey(kv[1])];
        const value = kv[2].trim();
        if (!canonical) continue;

        switch (canonical) {
            case 'time': {
                const c = parseClockValue(value, clock, ctx);
                if (c) result.clock = c;
                break;
            }
            case 'advance': {
                const detail = parseAdvanceDetail(value, ctx);
                if (detail) {
                    result.advanceMinutes = (result.advanceMinutes ?? 0) + detail.minutes;
                    if (detail.parts) result.advanceParts.push(...detail.parts);
                }
                break;
            }
            case 'add':
            case 'update':
            case 'resolve':
            case 'cancel':
                pushEventLine(result, canonical, value, ctx, clock);
                break;
            case 'note':
                result.note = value;
                break;
            default:
                break;
        }
    }
    return result;
}

function pushEventLine(result, op, value, ctx, clock) {
    if (!value) return;
    const fields = parseEventLine(value);
    const limit = Number.isFinite(ctx?.maxEventsPerMessage) ? ctx.maxEventsPerMessage : 12;
    if (result.events.length >= limit) return;
    const ev = { op, ...fields, raw: value };
    // 「时长」优先按相对时长解析（"6小时" / "6小时后" / "一炷香"），
    // 解析不出来再当成绝对时刻（"第3天20:00" / "明天早上"）。
    // 注意：这里只记录 durationMinutes，真正的到期时间在引擎里以「本轮结束时间」为基准换算。
    const timeText = fields.in ?? fields.due ?? '';
    if (timeText) {
        // 先判断形态：像绝对时间就绝对时间优先，别让「1247年」被当成时长
        const absoluteFirst = looksLikeAbsoluteTime(timeText, ctx?.formatter);
        if (absoluteFirst) {
            const c = parseClockValue(timeText, clock, ctx);
            if (c) ev.dueClock = c;
        }
        if (!ev.dueClock) {
            const detail = parseAdvanceDetail(timeText, ctx);
            if (detail) {
                ev.durationMinutes = detail.minutes;
                if (detail.parts) ev.durationParts = detail.parts;
            } else {
                const c = parseClockValue(timeText, clock, ctx);
                if (c) ev.dueClock = c;
            }
        }
    }
    if (fields.progress != null) {
        const p = parseProgress(fields.progress);
        if (p != null) ev.progress = p;
    }
    result.events.push(ev);
}

function parseProgress(value) {
    const m = String(value).match(/(\d+(?:\.\d+)?)\s*%?/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(100, n));
}

/** 从文本里抠出第一个 JSON 对象/数组 */
function extractJson(text) {
    const trimmed = text.trim();
    if (/^[[{]/.test(trimmed)) {
        // 去掉可能包裹的代码块围栏
        return trimmed.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    }
    const start = trimmed.search(/[[{]/);
    if (start < 0) return null;
    const open = trimmed[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) {
            depth--;
            if (depth === 0) return trimmed.slice(start, i + 1);
        }
    }
    return null;
}

/** 解析绝对时间字段：字符串 / {day,minute} / 分钟数。日历模式下走 formatter。 */
function parseClockValue(value, clock, ctx) {
    if (value == null) return null;
    if (typeof value === 'object') {
        if (Number.isFinite(value.day) || Number.isFinite(value.minute)) {
            return normalizeClock({ day: value.day ?? clock.day, minute: value.minute ?? 0 });
        }
        if (Number.isFinite(value.abs)) return absToClock(value.abs);
        // 也允许 { year, month, day } 这种日历写法
        if (ctx?.formatter?.isCalendar && (Number.isFinite(value.year) || Number.isFinite(value.month))) {
            const parsed = ctx.formatter.parse(
                `${value.year ?? ''}年${value.month ?? 1}月${value.day ?? 1}日`,
                clock,
            );
            if (parsed) return parsed;
        }
        return null;
    }
    const text = String(value).trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) {
        // 纯数字按「当天分钟数」理解会很反直觉，这里按分钟偏移理解
        return addMinutes(clock, Number(text));
    }
    // 日历模式优先用日历解析（能认「1247年3月15日」）
    if (ctx?.formatter?.isCalendar) {
        const viaCalendar = ctx.formatter.parse(text, clock);
        if (viaCalendar && calendarScore(text) > 0) return viaCalendar;
    }
    const abs = parseAbsoluteClock(text, clock);
    if (abs) return abs;
    const minutes = parseDuration(text, ctx);
    if (minutes) return addMinutes(clock, minutes.minutes);
    // 兜底：日历模式下再试一次
    if (ctx?.formatter?.isCalendar) {
        const viaCalendar = ctx.formatter.parse(text, clock);
        if (viaCalendar) return viaCalendar;
    }
    return null;
}

/** 文本里「像日历日期」的程度，用来决定优先级 */
function calendarScore(text) {
    let score = 0;
    if (/\d{1,5}\s*年/.test(text)) score += 2;
    if (/\d{1,2}\s*月/.test(text)) score += 1;
    if (/\d{1,4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}/.test(text)) score += 2;
    return score;
}

/**
 * 判断一段文本看起来像不像「绝对时间」而不是「时长」。
 *
 * 为什么需要它：`parseDuration` 会把 `1247年3月25日 09:00` 里的
 * 「1247年」当成时长（1247 年 ≈ 6.5 亿分钟），日期一下子飞到几百年后。
 * 所以先做一次形态判断，像绝对时间就优先走绝对时间解析。
 */
export function looksLikeAbsoluteTime(text, formatter) {
    const s = String(text ?? '');
    if (!s.trim()) return false;

    if (/\d{1,5}\s*年/.test(s)) return true;                                  // 1247年
    if (/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/.test(s)) return true;              // 3月25日
    if (/\d{1,4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}/.test(s)) return true;  // 1247-03-25
    if (/(?:第|Day\s*)\s*\d+\s*[天日]/i.test(s)) return true;                 // 第3天
    if (/[明后次翌今当][天日]/.test(s)) return true;                          // 明天 / 次日
    if (/\d{1,2}\s*[:：]\s*\d{1,2}/.test(s)) return true;                     // 09:00
    if (/\d{1,2}\s*[点时]/.test(s)) return true;                              // 9点

    // 自定义月名（春月 / 霜月…）
    const names = formatter?.calendar?.monthNames;
    if (Array.isArray(names) && names.some((n) => n && !/^\d+$/.test(n) && s.includes(n))) return true;

    return false;
}

/** 超过这个长度的「时长」基本可以确定是把日期误读成了时长 */
const MAX_SANE_DURATION_MINUTES = 100 * 365 * 1440;

/** 解析时长字段：字符串 / 分钟数 */
function parseAdvanceValue(value, ctx) {
    const detail = parseAdvanceDetail(value, ctx);
    return detail ? detail.minutes : null;
}

/**
 * 解析时长字段，保留结构化的 parts（日历模式下要用）。
 * @returns {{ minutes: number, parts: Array<{n:number,unit:string}>|null }|null}
 */
function parseAdvanceDetail(value, ctx) {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? { minutes: value, parts: null } : null;
    const text = String(value).trim();
    if (!text) return null;
    if (/^[+-]?\d+(\.\d+)?$/.test(text)) return { minutes: Number(text), parts: null };
    if (looksLikeAbsoluteTime(text, ctx?.formatter)) return null;
    const duration = parseDuration(text, ctx);
    if (!duration) return null;
    // 兜底：数值离谱就当没解析出来（宁可不改，也别把时间轴甩飞）
    if (Math.abs(duration.minutes) > MAX_SANE_DURATION_MINUTES) return null;
    return { minutes: duration.minutes, parts: duration.parts ?? null };
}

/**
 * 解析「第3天 14:30」「Day 3, 14:30」「14:30」「下午三点」这类绝对时间（计数制）。
 *
 * 实现已挪到 `time-lexer.js`（那里本来就有类似的日期匹配），
 * 这里保留再导出，避免破坏既有调用方（slash.js / ui/floating.js / 测试）。
 */
export { parseAbsoluteClock } from './time-lexer.js';

/**
 * 应用 JSON 载荷。
 * @param {any} data
 * @param {ReturnType<typeof parseTagBody>} result
 */
function applyJsonPayload(data, result, ctx, clock) {
    /** @type {any[]} */
    let entries = [];
    if (Array.isArray(data)) entries = data.map((d) => ({ op: 'add', data: d }));
    else if (data && typeof data === 'object') {
        const advance = data.advance ?? data.elapsed ?? data.流逝 ?? data.经过;
        if (advance != null) {
            const detail = parseAdvanceDetail(advance, ctx);
            if (detail) {
                result.advanceMinutes = (result.advanceMinutes ?? 0) + detail.minutes;
                if (detail.parts) result.advanceParts.push(...detail.parts);
            }
        }
        const time = data.time ?? data.clock ?? data.now ?? data.时间;
        if (time != null) {
            const c = parseClockValue(time, clock, ctx);
            if (c) result.clock = c;
        }
        const note = data.note ?? data.remark ?? data.备注;
        if (note != null) result.note = String(note);

        const buckets = [
            ['add', data.events ?? data.事件 ?? data.add ?? data.new],
            ['update', data.updates ?? data.更新],
            ['resolve', data.resolved ?? data.done ?? data.完成 ?? data.resolve],
            ['cancel', data.cancelled ?? data.canceled ?? data.取消],
        ];
        for (const [op, list] of buckets) {
            if (!list) continue;
            const arr = Array.isArray(list) ? list : [list];
            for (const item of arr) entries.push({ op, data: item });
        }
    }

    const limit = Number.isFinite(ctx?.maxEventsPerMessage) ? ctx.maxEventsPerMessage : 12;
    for (const { op, data: item } of entries) {
        if (result.events.length >= limit) break;
        if (typeof item === 'string') {
            pushEventLine(result, op, item, ctx, clock);
            continue;
        }
        if (!item || typeof item !== 'object') continue;
        const itemOp = ['add', 'update', 'resolve', 'cancel'].includes(item.op) ? item.op : op;
        const ev = { op: itemOp, raw: JSON.stringify(item) };
        const title = item.title ?? item.name ?? item.标题 ?? item.名称 ?? item.event ?? item.事件;
        if (title != null) ev.title = String(title);
        const id = item.id ?? item.编号 ?? item.标识;
        if (id != null) ev.id = String(id);
        const dueRaw = item.due ?? item.at ?? item.deadline ?? item.到期 ?? item.预定;
        const inRaw = item.in ?? item.duration ?? item.after ?? item.eta ?? item.时长 ?? item.需要;
        // 同样先按时长解析，再按绝对时刻
        const timeText = inRaw ?? dueRaw;
        if (timeText != null) {
            const absoluteFirst = looksLikeAbsoluteTime(timeText, ctx?.formatter);
            if (absoluteFirst) {
                const c = parseClockValue(timeText, clock, ctx);
                if (c) ev.dueClock = c;
            }
            if (!ev.dueClock) {
                const detail = parseAdvanceDetail(timeText, ctx);
                if (detail) {
                    ev.durationMinutes = detail.minutes;
                    if (detail.parts) ev.durationParts = detail.parts;
                } else {
                    const c = parseClockValue(timeText, clock, ctx);
                    if (c) ev.dueClock = c;
                }
            }
        }
        for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
            if (key === 'title' || key === 'due' || key === 'in') continue;
            for (const alias of aliases) {
                if (item[alias] != null) { ev[key] = String(item[alias]); break; }
            }
        }
        if (item.progress != null) {
            const p = parseProgress(item.progress);
            if (p != null) ev.progress = p;
        } else if (ev.progress != null) {
            const p = parseProgress(ev.progress);
            if (p != null) ev.progress = p;
        }
        result.events.push(ev);
    }
}

/**
 * 叙事文本兜底扫描。
 * @param {string} text
 * @param {{ clock: import('./story-time.js').Clock, units?: Record<string, number>,
 *           clockFromTimeOfDay?: 'off'|'dayhint'|'forward', maxEventsPerMessage?: number }} ctx
 */
export function scanNarrative(text, ctx) {
    const clock = normalizeClock(ctx?.clock ?? { day: 1, minute: 480 });
    const formatter = ctx?.formatter ?? null;
    const out = { clock: null, advanceMinutes: 0, advanceParts: [], events: [], matches: [] };
    if (!text) return out;

    const src = String(text);
    const leadingSkip = startsWithTimeSkip(src);
    const limit = Number.isFinite(ctx?.maxEventsPerMessage) ? ctx.maxEventsPerMessage : 8;

    // ---- 时长表达 ----
    const durations = findDurationExpressions(src, ctx);
    for (const d of durations) {
        if (out.events.length >= limit && !(leadingSkip && d.index < 8)) continue;
        const clause = extractClause(src, d.index);
        if (leadingSkip && d.index <= 8) {
            // 开头的时间跳跃 → 推进时间轴
            out.advanceMinutes += d.minutes;
            out.advanceParts.push(...(d.parts ?? []));
            out.matches.push({ type: 'skip', raw: d.raw, clause, minutes: d.minutes });
            continue;
        }
        if (d.looksPast) continue;
        if (!d.hasFutureMarker && !d.hasNeedMarker) continue;
        const title = cleanClause(clause, d.raw);
        if (!title || title.length < 2) continue;
        out.events.push({
            op: 'add',
            title,
            durationMinutes: d.minutes,
            durationParts: d.parts ?? null,
            note: clause.trim(),
            source: 'regex',
            raw: d.raw,
        });
        out.matches.push({ type: 'event', raw: d.raw, clause, minutes: d.minutes });
    }

    // 「正文时间校正」（从正文读绝对日期来纠正时钟）整个功能已删除。
    //
    // 删掉的原因：它号称「只认明确日期」，但实际上只要句子里有「今天 / 当天」
    // 这类叙述词，后面跟着的时刻就会被一起解析并应用 ——
    //   「她今天早上就出门了。」  →  往回推 240 分钟
    //   「他今天凌晨才睡着。」    →  往回推 600 分钟
    //   「今天晚上有雨。」        →  往前推 540 分钟
    // 时间被正文推着倒流显然不对，而「今天」这种词在叙述里极其常见。
    //
    // 现在时钟只来自：标签里的时间/流逝、正文里的**时长**表达（上面那段）、
    // 以及用户手动快进。跨天的信息由标签协议负责。

    return out;
}


/** 取包含指定位置的句子 / 分句 */
function extractClause(text, index) {
    const sentences = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if ('。！？!?；;\n'.includes(ch)) {
            sentences.push([start, i + 1]);
            start = i + 1;
        }
    }
    if (start < text.length) sentences.push([start, text.length]);

    let hit = sentences.find(([a, b]) => index >= a && index < b);
    if (!hit) hit = [0, Math.min(text.length, index + 40)];
    let [a, b] = hit;

    // 再按逗号细分，让标题更聚焦
    const slice = text.slice(a, b);
    const rel = index - a;
    const parts = [];
    let p = 0;
    for (let i = 0; i < slice.length; i++) {
        if ('，,、'.includes(slice[i])) {
            parts.push([p, i + 1]);
            p = i + 1;
        }
    }
    parts.push([p, slice.length]);
    const sub = parts.find(([x, y]) => rel >= x && rel < y);
    if (sub) { a += sub[0]; b = a + (sub[1] - sub[0]); }
    return text.slice(a, b).trim();
}

/** 把分句整理成事件标题 */
function cleanClause(clause, rawDuration) {
    let t = String(clause || '').trim();
    t = t.replace(/^[\s"'“”「」【】*_>\-—]+/, '').replace(/[\s"'“”「」【】*_]+$/, '');
    // 去掉纯时间前缀
    t = t.replace(new RegExp('^[^，,]{0,6}?' + escapeRegExp(rawDuration)), '').trim();
    t = t.replace(/^[，,、]/, '').trim();
    if (t.length > 60) t = t.slice(0, 60) + '…';
    return t;
}
