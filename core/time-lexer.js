/**
 * 时间词法分析 —— 从自然语言片段里抽出「时长」和「绝对时刻」。
 * 纯逻辑，无宿主依赖。
 */

import { cnNumberToInt, normalizeClock, parseTimeOfDay } from './story-time.js';

/**
 * 默认单位表（分钟）。用户可在设置里覆盖。
 * value 为分钟数；`fuzzy` 表示「模糊时长」，没有明确数字时使用。
 */
export const DEFAULT_UNITS = {
    秒: 1 / 60,
    分钟: 1,
    分: 1,
    刻: 15,
    刻钟: 15,
    时辰: 120,
    小时: 60,
    钟头: 60,
    个时辰: 120,
    个小时: 60,
    天: 1440,
    日: 1440,
    周: 10080,
    星期: 10080,
    礼拜: 10080,
    个月: 43200,
    月: 43200,
    季度: 129600,
    年: 525600,
    载: 525600,
    炷香: 30,
    盏茶: 10,
    弹指: 1,
    瞬间: 1,
    须臾: 20,
    半晌: 240,
    一会儿: 10,
    片刻: 5,
};

/**
 * 未带数字但有时长含义的词。
 *
 * ⚠️ 这里**故意不再有**「模糊时长词」那一档（一会儿 / 稍后 / 不久 / 良久……）。
 *
 * 原来有一组 VAGUE_WORDS + 一个 `time.vagueMinutes` 配置项，给这类词硬塞一个
 * 默认分钟数。删掉的原因：
 *   · 12 个词里有 3 个（一会儿 / 片刻 / 半晌）在单位表里，那一档根本轮不到；
 *   · 默认「低于 6 小时不算事件」的门槛会把 10 分钟全部拦掉 —— 改它没有任何效果；
 *   · 正文兜底扫描也不会用这类词建事件；
 *   · 最根本的：「稍后」不是一个**可计时的承诺**。给它编个数字、过十分钟提醒 AI
 *     「到点了，交代结果」，是插件在替 AI 编时间。
 *
 * 想给某个词定值就走单位表（设置里的「自定义时长单位」），那里看得见也改得动。
 */
export const BARE_DURATION_WORDS = [
    '半天', '大半天', '一炷香', '一盏茶', '一炷香的功夫', '一盏茶的功夫', '一炷香时间',
];

/** 表示「未来」的标记词 */
const FUTURE_MARKERS = ['后', '之后', '以后', '过后', 'later', 'after', 'in '];

/** 句子开头的「时间跳跃」标记（这类通常表示叙事直接跳到未来，而不是一个待办事件） */
export const TIME_SKIP_LEADING = [
    /^[，,。.；;\s]*(?:就?这样|如此)?[，,]?\s*(?:又?过了|过了|转眼|一转眼|不知不觉|很快|随即|稍后|不久)/,
    /^[，,。.；;\s]*第[零〇一二两三四五六七八九十百\d]+[天日]/,
    /^[，,。.；;\s]*(?:次日|翌日|隔日|第二天|第三天|新的一天|当天晚上|当日晚间)/,
    /^[，,。.；;\s]*(?:[零〇一二两三四五六七八九十百\d]+|[a-z]+)\s*(?:天|日|周|个?月|年|小时|钟头|分钟|时辰)\s*(?:之?后|以?后|过?后)/i,
];

const NUMBER_PATTERN = String.raw`(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千卅廿]+)`;

/** 单位正则缓存（键为排序后的单位名列表，支持用户自定义单位） */
const UNIT_PATTERN_CACHE = new Map();

function escapeUnit(unit) {
    return String(unit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 根据单位表生成正则源码片段 */
function getUnitSources(units) {
    const key = Object.keys(units).sort().join('\u0001');
    const cached = UNIT_PATTERN_CACHE.get(key);
    if (cached) return cached;

    const alt = Object.keys(units)
        .sort((a, b) => b.length - a.length)
        .map(escapeUnit)
        .join('|');
    const unitGroup = String.raw`(?:(?:个|整)?(?:${alt}))`;
    const sources = {
        unitGroup,
        /** 单个「数量+单位」 */
        part: String.raw`(?:(大半|半)\s*)?(${NUMBER_PATTERN})?\s*(${unitGroup})`,
        /** 一整串「数量+单位」 */
        expr: String.raw`((?:大半|半)?\s*(?:${NUMBER_PATTERN})?\s*${unitGroup}(?:\s*(?:${NUMBER_PATTERN})\s*${unitGroup})*)`,
    };
    if (UNIT_PATTERN_CACHE.size > 24) UNIT_PATTERN_CACHE.delete(UNIT_PATTERN_CACHE.keys().next().value);
    UNIT_PATTERN_CACHE.set(key, sources);
    return sources;
}

/**
 * 解析一个「时长」表达式，支持复合写法（"2天3小时"、"一炷香"、"半小时"）。
 * @param {string} text
 * @param {{ units?: Record<string, number> }} [opts]
 * @returns {{ minutes: number, raw: string, parts: Array<{n: number, unit: string}> }|null}
 */
export function parseDuration(text, opts = {}) {
    if (text == null) return null;
    const units = { ...DEFAULT_UNITS, ...(opts.units || {}) };
    const src = String(text).trim();
    if (!src) return null;

    const partRe = new RegExp(getUnitSources(units).part, 'g');

    const parts = [];
    let total = 0;
    let cursor = 0;
    let matchedRaw = '';
    let m;

    while ((m = partRe.exec(src)) !== null) {
        // 只接受连续相接的片段，避免把「3天后他又走了2小时」这种混在一段
        if (m.index > cursor + 2) break;
        const half = m[1];
        const numText = m[2];
        const unitText = m[3];
        const unitKey = unitText.replace(/^(个|整)/, '');
        const unitValue = units[unitKey] ?? units[unitText];
        if (unitValue == null) continue;

        let n;
        if (numText != null && numText !== '') {
            n = cnNumberToInt(numText);
            if (n == null) continue;
        } else if (half) {
            n = half === '大半' ? 0.75 : 0.5;
        } else {
            n = 1;
        }

        const minutes = n * unitValue;
        total += minutes;
        parts.push({ n, unit: unitKey, minutes });
        cursor = m.index + m[0].length;
        matchedRaw = src.slice(m.index, cursor);
    }

    if (parts.length && total > 0) {
        return { minutes: total, raw: matchedRaw, parts };
    }

    // 兜底：半小时 / 半天 / 一炷香 等无数字写法
    if (/半\s*(?:个)?\s*(?:小时|钟头|时辰)/.test(src)) return { minutes: 30, raw: '半小时', parts: [{ n: 0.5, unit: '小时', minutes: 30 }] };
    if (/大半天/.test(src)) return { minutes: 480, raw: '大半天', parts: [{ n: 0.75, unit: '天', minutes: 480 }] };
    if (/半天/.test(src)) return { minutes: 720, raw: '半天', parts: [{ n: 0.5, unit: '天', minutes: 720 }] };
    for (const w of BARE_DURATION_WORDS) {
        if (src.includes(w)) {
            const inner = parseDuration(w.replace(/^一(炷香|盏茶).*$/, '$1'), { ...opts, units });
            if (inner) return inner;
        }
    }

    // 模糊时长（「稍后」「不久」这类）**故意不解析** —— 见 BARE_DURATION_WORDS 上的说明。
    // 想给某个词定值就加进单位表。
    return null;
}

/**
 * 在一段文本中找出所有「N 时长(后)」型的表达。
 * @param {string} text
 * @param {{ units?: Record<string, number> }} [opts]
 * @returns {Array<{ minutes: number, raw: string, index: number, hasFutureMarker: boolean,
 *                   hasNeedMarker: boolean, looksPast: boolean }>}
 */
export function findDurationExpressions(text, opts = {}) {
    if (!text) return [];
    const out = [];
    const units = { ...DEFAULT_UNITS, ...(opts.units || {}) };
    const re = new RegExp(getUnitSources(units).expr, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
        const duration = parseDuration(m[1], opts);
        if (!duration) continue;
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 8);
        const before = text.slice(Math.max(0, m.index - 10), m.index);
        const hasFutureMarker = /^\s*(?:之?后|以?后|过?后|later|after)/i.test(after);
        const hasNeedMarker = /(需要|还需|得要|得|要|等待|等候|等|准备|耗时|花费|花上|花|再过|得花|will take|take[s]?|need[s]?|require[s]?)\s*$/.test(before);
        // 「花了三天才…」这类是已完成，不再当作待办事件
        const looksPast = /(花了|用了|耗了|费了|花去|用去|过去|已经)\s*$/.test(before) && /^\s*(?:时间)?\s*(?:才|就|便|终于)/.test(after);
        out.push({
            minutes: duration.minutes,
            raw: m[0].trim(),
            index: m.index,
            // parts 保留「几个月 / 几年」这种结构化信息，
            // 日历模式下要用它做精确的月份加法，而不是固定 30 天。
            parts: duration.parts,
            hasFutureMarker,
            hasNeedMarker,
            looksPast,
        });
    }
    return out;
}

/**
 * 提取文本里提到的绝对时刻（"14:30"、"下午三点"）。
 * @param {string} text
 * @returns {Array<{ minute: number, raw: string, index: number, dayHint: number|null }>}
 */
export function findTimeOfDayExpressions(text) {
    if (!text) return [];
    const out = [];
    const re = /(?:(?:第|Day\s*)([零〇一二两三四五六七八九十百\d]+)\s*[天日][的\s]*)?((?:凌晨|清晨|早晨|早上|上午|中午|正午|午后|下午|傍晚|黄昏|日落|日暮|晚上|夜里|夜晚|深夜|半夜)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*[:：时点]\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})?\s*分?)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const parsed = parseTimeOfDay(m[2]);
        if (!parsed) continue;
        let dayHint = null;
        if (m[1] != null) {
            const d = cnNumberToInt(m[1]);
            if (d != null && d > 0) dayHint = d;
        }
        out.push({ minute: parsed.minute, raw: m[0].trim(), index: m.index, dayHint });
    }
    return out;
}

/**
 * 解析「第3天 14:30」「Day 3, 14:30」「14:30」「明天早上」「三天后」这类绝对时间（**计数制**）。
 *
 * 日历制（年月日）由 `calendar.js` 的 `parseCalendarClock` 负责；
 * 两者通过 `calendar.js` 的 `createTimeFormatter()` 统一成一个入口给上层用。
 *
 * @param {string} text
 * @param {import('./story-time.js').Clock} reference 参考时钟（用于补全缺失的日期）
 * @returns {import('./story-time.js').Clock|null}
 */
export function parseAbsoluteClock(text, reference = { day: 1, minute: 480 }) {
    if (!text) return null;
    const src = String(text).trim();
    const ref = normalizeClock(reference);

    // 相对日：今天/明天/后天/次日（注意「大后天」要先于「后天」判断）
    let dayOffset = null;
    if (/明[天日]|次[日天]|翌[日天]/.test(src) && !/今[天日]/.test(src)) dayOffset = 1;
    else if (/大后[天日]/.test(src)) dayOffset = 3;
    else if (/后[天日]/.test(src)) dayOffset = 2;
    else if (/今[天日]|当[天日]/.test(src)) dayOffset = 0;

    // 显式「第 N 天 / Day N」
    let day = null;
    let m = src.match(/(?:第|Day\s*|D)\s*(\d+|[零〇一二两三四五六七八九十百]+)\s*[天日]/i);
    if (m) {
        const d = cnNumberToInt(m[1]);
        if (d != null && d > 0) day = d;
    }
    if (day == null) {
        const en = src.match(/\b(?:day|d)\s*[.:]?\s*(\d+)/i);
        if (en) day = Number(en[1]);
    }
    if (day == null) {
        m = src.match(/(\d+|[零〇一二两三四五六七八九十百]+)\s*[天日]\s*(?:之?后|以?后|过?后)/);
        if (m) {
            const d = cnNumberToInt(m[1]);
            if (d != null) day = ref.day + d;
        }
    }
    if (day == null && /(下[个]?周|下星期|下礼拜)/.test(src)) day = ref.day + 7;
    if (day == null && /(明[年]|下一?年)/.test(src)) day = ref.day + 365;
    if (day == null && dayOffset != null) day = ref.day + dayOffset;

    const tod = parseTimeOfDay(src);
    if (day == null && !tod) return null;
    // 没有明说时刻时，沿用参考时钟的时刻（"三天后" = 三天后的同一时间）
    const minute = tod ? tod.minute : ref.minute;
    return normalizeClock({ day: day ?? ref.day, minute });
}

/**
 * 找出文本里对「哪一天」的明确说明（计数制）。
 * @param {string} text
 * @param {import('./story-time.js').Clock} reference
 * @returns {{ day: number, minute: number|null, raw: string, index: number }|null}
 */
export function findExplicitDayClock(text, reference) {
    if (!text) return null;
    const src = String(text);

    /** 只看日期标记附近的文字，避免被正文里无关的时刻带偏 */
    const todNear = (index, length) => {
        const from = Math.max(0, index - 4);
        const to = Math.min(src.length, index + length + 12);
        return parseTimeOfDay(src.slice(from, to));
    };

    // 第 N 天 / Day N
    let m = src.match(/(?:第|Day\s*|D)\s*(\d+|[零〇一二两三四五六七八九十百]+)\s*[天日]/i);
    if (m) {
        const d = cnNumberToInt(m[1]);
        if (d != null && d > 0) {
            const tod = todNear(m.index, m[0].length);
            return { day: d, minute: tod ? tod.minute : null, raw: m[0], index: m.index };
        }
    }

    // Day 5, 18:00 这类英文写法
    m = src.match(/\b(?:day|d)\s*[.:]?\s*(\d+)/i);
    if (m) {
        const tod = todNear(m.index, m[0].length);
        return { day: Number(m[1]), minute: tod ? tod.minute : null, raw: m[0], index: m.index };
    }

    // 明天 / 次日 / 翌日 / 后天 / 大后天 / 今天
    m = src.match(/(大后天|大后日|后天|后日|明天|明日|次日|翌日|第二天|第三天|今天|今日|当天|当日|今晨|明晨)/);
    if (m) {
        const offset = /大后/.test(m[1]) ? 3
            : /^(后天|后日)$/.test(m[1]) ? 2
                : /^(明天|明日|次日|翌日|第二天|明晨)$/.test(m[1]) ? 1
                    : /^第三天$/.test(m[1]) ? 2
                        : 0;
        const tod = todNear(m.index, m[0].length);
        return { day: reference.day + offset, minute: tod ? tod.minute : null, raw: m[0], index: m.index };
    }

    // N 天后 / N 日后
    m = src.match(/(\d+|[零〇一二两三四五六七八九十百]+)\s*[天日]\s*(?:之?后|以?后|过?后)/);
    if (m) {
        const d = cnNumberToInt(m[1]);
        if (d != null) {
            const tod = todNear(m.index, m[0].length);
            return { day: reference.day + d, minute: tod ? tod.minute : null, raw: m[0], index: m.index };
        }
    }

    return null;
}

/**
 * 判断文本是否以「时间跳跃」开头（"三天后，……"、"次日清晨，……"）。
 * @param {string} text
 * @returns {boolean}
 */
export function startsWithTimeSkip(text) {
    if (!text) return false;
    const head = String(text).replace(/^[\s"'“”「」【】*_>-]+/, '').slice(0, 24);
    return TIME_SKIP_LEADING.some((re) => re.test(head));
}
