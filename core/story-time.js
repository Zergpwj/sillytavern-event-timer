/**
 * 虚构故事时间模型 —— 纯逻辑，不依赖任何宿主（酒馆 / 浏览器 / Node 均可运行）。
 *
 * 时间点统一表示为 `{ day, minute }`：
 *   - `day`    从 1 开始计数的「第几天」
 *   - `minute` 当天已过的分钟数，0..1439
 *
 * 所有时间运算都换算成「绝对分钟」`abs = (day - 1) * 1440 + minute` 再做加减，
 * 这样可以避免跨天时的借位错误。
 */

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;

/** 中文数字字符表 */
const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 两: 2, 贰: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 };
const CN_UNITS = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };

/**
 * 把中文数字（含「廿」「卅」这类简写）转成整数。
 * 支持的写法：三、十、十五、二十、二十三、一百零五、三百二十、廿三、卅。
 * @param {string} text
 * @returns {number|null} 无法解析时返回 null
 */
export function cnNumberToInt(text) {
    if (text == null) return null;
    const raw = String(text).trim();
    if (!raw) return null;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);

    let s = raw;
    // 廿 / 卅 简写
    s = s.replace(/廿/g, '二十').replace(/卅/g, '三十');

    // 纯小数写法：三点五
    const dotMatch = s.match(/^([^点]+)点([^点]+)$/);
    if (dotMatch) {
        const intPart = cnNumberToInt(dotMatch[1]);
        const fracPart = cnNumberToInt(dotMatch[2]);
        if (intPart != null && fracPart != null) {
            const fracLen = String(fracPart).length;
            return intPart + fracPart / Math.pow(10, fracLen);
        }
    }

    let total = 0;
    let section = 0;
    let number = 0;
    let sawAny = false;

    for (const ch of s) {
        if (Object.hasOwn(CN_DIGITS, ch)) {
            number = CN_DIGITS[ch];
            sawAny = true;
        } else if (Object.hasOwn(CN_UNITS, ch)) {
            const unit = CN_UNITS[ch];
            sawAny = true;
            if (number === 0 && unit === 10) number = 1; // 「十五」里的「十」
            section += number * unit;
            number = 0;
        } else if (ch === '万') {
            section = (section + number) * 10000;
            total += section;
            section = 0;
            number = 0;
            sawAny = true;
        } else if (/\s/.test(ch)) {
            continue;
        } else {
            return null; // 出现无法识别的字符
        }
    }

    if (!sawAny) return null;
    return total + section + number;
}

/** 把「三」「15」这类片段解析成数字 */
export function toInt(text) {
    return cnNumberToInt(text);
}

/**
 * @typedef {{ day: number, minute: number }} Clock
 */

/** 规范化时钟对象（修正越界的 minute） */
export function normalizeClock(clock) {
    const abs = clockToAbs(clock);
    return absToClock(abs);
}

/** 时钟 → 绝对分钟 */
export function clockToAbs(clock) {
    if (!clock || typeof clock !== 'object') return 0;
    const day = Number(clock.day);
    const minute = Number(clock.minute);
    const safeDay = Number.isFinite(day) ? Math.floor(day) : 1;
    const safeMinute = Number.isFinite(minute) ? Math.floor(minute) : 0;
    return (safeDay - 1) * MINUTES_PER_DAY + safeMinute;
}

/** 绝对分钟 → 时钟 */
export function absToClock(abs) {
    const total = Math.floor(Number(abs) || 0);
    const day = Math.floor(total / MINUTES_PER_DAY) + 1;
    let minute = total - (day - 1) * MINUTES_PER_DAY;
    if (minute < 0) minute += MINUTES_PER_DAY;
    return { day, minute };
}

/** 时钟加分钟数，返回新时钟 */
export function addMinutes(clock, minutes) {
    return absToClock(clockToAbs(clock) + Math.round(Number(minutes) || 0));
}

/** a - b 的分钟差（正数表示 a 晚于 b） */
export function diffMinutes(a, b) {
    return clockToAbs(a) - clockToAbs(b);
}

/** 比较两个时钟，返回 -1 / 0 / 1 */
export function compareClock(a, b) {
    const d = diffMinutes(a, b);
    return d === 0 ? 0 : d > 0 ? 1 : -1;
}

/** 把「14:30」「下午3点」「早上八点二十」这类片段解析成当天的分钟数 */
const PERIOD_WORDS = [
    { re: /凌晨/, base: 0 },
    { re: /清晨|早晨|早上|一早|天亮/, base: 6 },
    { re: /上午|午前/, base: 9 },
    { re: /正午|中午|晌午|午时/, base: 12 },
    { re: /午后|下午/, base: 13 },
    { re: /傍晚|黄昏|日落|日暮/, base: 17 },
    { re: /晚上|夜里|入夜|晚间|夜晚/, base: 19 },
    { re: /深夜|半夜|子夜|午夜/, base: 23 },
];

/**
 * 解析一个「当天的时刻」片段。
 * @param {string} text 例如 "下午3点20"、"14:30"、"早上八点"、"3:30 PM"
 * @returns {{ minute: number, explicitDay: null }|null}
 */
export function parseTimeOfDay(text) {
    if (!text) return null;
    const src = String(text);
    let periodBase = null;
    for (const { re, base } of PERIOD_WORDS) {
        if (re.test(src)) { periodBase = base; break; }
    }
    const isPm = /(pm|p\.m\.|下午|傍晚|晚上|夜间)/i.test(src);
    const isAm = /(am|a\.m\.|早上|早晨|上午|凌晨)/i.test(src);

    // 形式一：14:30 / 14：30 / 14点30 / 14时30分
    let m = src.match(/(\d{1,2}|[零〇一二两三四五六七八九十百]{1,4})\s*[:：时点]\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,4})?\s*分?/);
    if (m) {
        let hour = toInt(m[1]);
        const minute = m[2] != null && m[2] !== '' ? toInt(m[2]) : 0;
        if (hour != null && minute != null) {
            if (isPm && hour < 12) hour += 12;
            if (isAm && hour === 12) hour = 0;
            if (periodBase != null && !isPm && !isAm && hour < 12) {
                // 「下午三点」这种由 periodBase 推出的小时
                if (periodBase >= 12 && hour <= 11) hour += 12;
            }
            if (hour >= 0 && hour <= 47 && minute >= 0 && minute < 60) {
                // 允许 hour > 24 表示跨天（例如「第二天凌晨1点」由 day 部分处理）
                return { minute: hour * 60 + minute, explicitDay: null };
            }
        }
    }

    // 形式二：只有时段词 + 小时，如「下午三点」
    m = src.match(/(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:点|时|点钟)/);
    if (m) {
        let hour = toInt(m[1]);
        if (hour != null) {
            if ((isPm || (periodBase != null && periodBase >= 12)) && hour < 12) hour += 12;
            if (hour >= 0 && hour <= 47) return { minute: hour * 60, explicitDay: null };
        }
    }

    // 形式三：只有时段词，如「清晨」「傍晚」
    if (periodBase != null) {
        let hour = periodBase;
        if (/深夜|午夜|子夜/.test(src)) hour = 23;
        return { minute: hour * 60, explicitDay: null };
    }

    return null;
}

/** 一天的分钟数 → "14:30" */
export function formatTimeOfDay(minute, { pad = true } = {}) {
    const total = ((Math.floor(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const h = Math.floor(total / 60);
    const mm = total % 60;
    const hh = pad ? String(h).padStart(2, '0') : String(h);
    return `${hh}:${String(mm).padStart(2, '0')}`;
}

/** 一天的分钟数 → "下午2:30"（中文习惯读法） */
export function formatTimeOfDayCn(minute) {
    const total = ((Math.floor(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    const h = Math.floor(total / 60);
    const mm = total % 60;
    const label =
        h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 13 ? '中午' :
            h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return mm === 0 ? `${label}${h12}点` : `${label}${h12}点${String(mm).padStart(2, '0')}分`;
}

/**
 * 格式化时钟。
 * @param {Clock} clock
 * @param {{ dayLabel?: string, style?: 'full'|'time'|'day'|'cn' }} [opts]
 *        dayLabel 支持 `{day}` 占位，例如 "第{day}天" / "Day {day}"
 */
export function formatClock(clock, opts = {}) {
    const { dayLabel = '第{day}天', style = 'full' } = opts;
    const c = normalizeClock(clock);
    const day = dayLabel.replace(/\{day\}/g, String(c.day));
    const time = formatTimeOfDay(c.minute);
    switch (style) {
        case 'time': return time;
        case 'day': return day;
        case 'cn': return `${day} ${formatTimeOfDayCn(c.minute)}`;
        default: return `${day} ${time}`;
    }
}

/**
 * 把分钟数格式化成人类可读的时长。
 * @param {number} minutes
 * @param {{ short?: boolean, maxUnits?: number }} [opts]
 */
export function formatDuration(minutes, opts = {}) {
    const { short = false, maxUnits = 2 } = opts;
    const sign = minutes < 0 ? '-' : '';
    let rest = Math.abs(Math.round(minutes));
    if (rest === 0) return short ? '0分钟' : '不到 1 分钟';

    const units = [
        { size: MINUTES_PER_DAY * 365, zh: '年', en: 'y' },
        { size: MINUTES_PER_DAY * 30, zh: '个月', en: 'mo' },
        { size: MINUTES_PER_DAY, zh: '天', en: 'd' },
        { size: 60, zh: '小时', en: 'h' },
        { size: 1, zh: '分钟', en: 'm' },
    ];

    const parts = [];
    for (const u of units) {
        if (parts.length >= maxUnits) break;
        const n = Math.floor(rest / u.size);
        if (n > 0) {
            parts.push(short ? `${n}${u.en}` : `${n}${u.zh}`);
            rest -= n * u.size;
        }
    }
    if (!parts.length) return short ? '0m' : '不到 1 分钟';
    return sign + parts.join(short ? ' ' : '');
}

/**
 * 倒计时文案：正数表示还剩多久，负数表示已超时多久。
 * @param {number} minutes 剩余分钟（负数为超时）
 */
export function formatCountdown(minutes, opts = {}) {
    const m = Math.round(minutes);
    if (m > 0) return `剩余 ${formatDuration(m, { ...opts, maxUnits: 2 })}`;
    if (m === 0) return '刚刚到期';
    return `已超时 ${formatDuration(-m, { ...opts, maxUnits: 2 })}`;
}

/** 深拷贝时钟 */
export function cloneClock(clock) {
    return { day: Number(clock?.day) || 1, minute: Number(clock?.minute) || 0 };
}
