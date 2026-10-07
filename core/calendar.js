/**
 * 日历系统 —— 支持「1247年3月15日」这类真实年月日，与「第N天」计数制并存。
 *
 * 内部表示仍然是 `{ day, minute }`，其中 `day` 是**从纪元（默认 1年1月1日）起算的天序号**。
 * 这样：
 *   - 引擎、事件、overlay、提醒逻辑一行都不用改（它们只依赖绝对分钟运算）；
 *   - 日历只是「天序号 ↔ 年月日」的一层双向换算 + 格式化。
 *
 * 纯逻辑，无宿主依赖。
 */

import { cnNumberToInt, addMinutes, absToClock, parseTimeOfDay, formatClock } from './story-time.js';
import { parseAbsoluteClock } from './time-lexer.js';

/** 公历：每月天数 + 闰年规则 */
export const GREGORIAN_MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * 常见预设，设置界面里给用户选。
 *
 * 预设只负责「起点」：每月天数、闰年规则、日期格式。
 * 用户显式设过的字段优先；预设里没有的字段由 `createCalendar` 兜底。
 *
 * ⚠️ 原来还有个 `fantasy`（奇幻历）预设，已经删掉了：
 *   · 它的 months 和 simple365 **一模一样**（都是 12 × 30）；
 *   · 唯一实质差别是「每 8 年一闰」，而它的 `leap.month` 写的是 13 ——
 *     自己只有 12 个月，那个值越界，实际被夹成 12，等于本来就写坏了；
 *   · 界面上它的说明「每月天数自己填」和「完全自定义（用下面的字段）」
 *     说的是同一件事。
 * 现在想一键得到 12 × 30 就用 simple365，或者在「每月天数」里直接填 `30`。
 */
export const CALENDAR_PRESETS = {
    gregorian: {
        label: '公历（可推真实年月日，带闰年）',
        months: GREGORIAN_MONTHS,
        leap: { every: 4, skip: 100, unless: 400, month: 2 },
        format: '{era}{year}年{month}月{day}日',
    },
    simple365: {
        label: '简化历（12 个月，每月 30 天，无闰年）',
        months: Array.from({ length: 12 }, () => 30),
        leap: { every: 0, skip: 0, unless: 0, month: 1 },
        format: '{era}{year}年{month}月{day}日',
    },
};

const MONTH_NAMES_CN = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

/**
 * 规范化日历配置。
 * @param {any} raw
 * @returns {any} 可直接使用的日历对象（含 isCalendar 标记）
 */
/**
 * 日期模板里可用的占位符 —— **唯一真源**。
 *
 * 设置界面的「编辑日期格式」弹窗拿它渲染可点的插入按钮。
 * UI 不许再抄一份：下面 `TIME_PLACEHOLDER_ALIASES` 里还躺着 `hh` / `mm` / `i` / `ii`
 * 这些别名，日历这边一改，界面抄的那份就悄悄过期了。
 *
 * 只列**推荐写法**，不列别名 —— 别名是给解析器兼容用的，不该出现在按钮上。
 * `tests/calendar-tests.mjs` 里有一条测试盯着：这里列的每一个都必须是解析器认识的真占位符。
 */
export const DATE_PLACEHOLDER_GROUPS = [
    {
        title: '日期',
        items: [
            ['{era}', '纪元前缀（例如「帝国历」）'],
            ['{year}', '年份'],
            ['{month}', '月份数字'],
            ['{monthName}', '月名（没配月名时是数字）'],
            ['{day}', '日期'],
            ['{daySuffix}', '日期后缀（默认「日」）'],
        ],
    },
    {
        title: '时间',
        items: [
            ['{hour}', '小时'],
            ['{minute}', '分钟'],
            ['{time}', '24 小时制时分（14:30）'],
            ['{ampm}', '上午 / 下午'],
        ],
    },
    {
        title: '时辰',
        items: [
            ['{shichen}', '子时 / 丑时 …'],
            ['{shichenChar}', '子 / 丑 …'],
            ['{ke}', '本时辰内的第几刻（一到八）'],
            ['{keNum}', '同上的阿拉伯数字（1–8）'],
            ['{shichenTime}', '子时三刻'],
        ],
    },
];

export function createCalendar(raw) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const presetName = cfg.preset && CALENDAR_PRESETS[cfg.preset] ? cfg.preset : null;
    const preset = presetName ? CALENDAR_PRESETS[presetName] : null;

    let months = Array.isArray(cfg.months) && cfg.months.length
        ? cfg.months.map((n) => Math.max(1, Math.floor(Number(n) || 0)))
        : (preset?.months ?? GREGORIAN_MONTHS).slice();

    const leapRaw = cfg.leap ?? preset?.leap ?? { every: 4, skip: 100, unless: 400, month: 2 };
    const leap = {
        every: Math.max(0, Math.floor(Number(leapRaw.every) || 0)),
        skip: Math.max(0, Math.floor(Number(leapRaw.skip) || 0)),
        unless: Math.max(0, Math.floor(Number(leapRaw.unless) || 0)),
        month: Math.min(months.length, Math.max(1, Math.floor(Number(leapRaw.month) || 1))),
    };

    const rawNames = Array.isArray(cfg.monthNames) ? cfg.monthNames.map((s) => String(s ?? '').trim()) : [];
    const hasCustomMonthNames = rawNames.some((n) => n !== '');
    // 允许只填一部分：没填的月份回落到数字
    const monthNames = [];
    for (let i = 0; i < months.length; i++) {
        monthNames.push(rawNames[i] || String(i + 1));
    }

    const start = cfg.startDate && typeof cfg.startDate === 'object' ? cfg.startDate : {};
    const startDate = {
        year: Math.floor(Number(start.year) || 1),
        month: Math.min(months.length, Math.max(1, Math.floor(Number(start.month) || 1))),
        day: Math.max(1, Math.floor(Number(start.day) || 1)),
        hour: Math.min(23, Math.max(0, Math.floor(Number(start.hour) || 0))),
        minute: Math.min(59, Math.max(0, Math.floor(Number(start.minute) || 0))),
    };

    const calendar = {
        isCalendar: true,
        preset: presetName,
        era: String(cfg.era ?? ''),
        eraSuffix: String(cfg.eraSuffix ?? ''),
        months,
        monthNames,
        hasCustomMonthNames,
        leap,
        /**
         * 「闰年」下拉的手选档位；null = 按 leap 的数值反推。
         *
         * 必须由解析后的对象带出来：设置界面判断档位时要读**实际生效**的日历，
         * 而这个标记只存在于原始配置里，不带上就会永远判回「公历式」，
         * 选了「自定义…」下面的明细永远展不开。
         */
        leapMode: cfg.leapMode === 'custom' ? 'custom' : null,
        format: normalizeDateFormat(cfg.format || preset?.format || '{era}{year}年{month}月{day}日'),
        shortFormat: normalizeDateFormat(cfg.shortFormat || '{month}月{day}日'),
        daySuffix: String(cfg.daySuffix ?? '日'),
        padHour: cfg.padHour !== false,
        /** 模糊月名匹配：「霜月」也认「霜之月」 */
        fuzzyMonthNames: !!cfg.fuzzyMonthNames,
        startDate,
    };

    // 基础年天数（不含闰日）
    calendar.baseYearDays = months.reduce((a, b) => a + b, 0);
    calendar.hasLeap = leap.every > 0;

    // 起始日期对应的天序号，便于直接拿去当 initialClock
    calendar.startDayIndex = ymdToDayIndex(startDate, calendar);
    calendar.startMinute = startDate.hour * 60 + startDate.minute;

    return calendar;
}

/** 是否闰年 */
export function isLeapYear(year, cal) {
    const { every, skip, unless } = cal.leap;
    if (!every) return false;
    if (year % every !== 0) return false;
    if (skip && year % skip === 0) {
        return !!(unless && year % unless === 0);
    }
    return true;
}

/** 某年某月有多少天（month 从 1 开始） */
export function daysInMonth(year, month, cal) {
    const base = cal.months[month - 1] ?? 30;
    if (cal.hasLeap && month === cal.leap.month && isLeapYear(year, cal)) return base + 1;
    return base;
}

/** 某年多少天 */
export function daysInYear(year, cal) {
    return cal.baseYearDays + (cal.hasLeap && isLeapYear(year, cal) ? 1 : 0);
}

/** 从 1 年 1 月 1 日到 `year` 年 1 月 1 日经过的天数（O(1)） */
export function daysBeforeYear(year, cal) {
    const n = year - 1;
    if (!cal.hasLeap) return n * cal.baseYearDays;
    const { every, skip, unless } = cal.leap;
    const before = (x) => (x <= 0 ? 0 : Math.floor(x));
    let leaps = before(n / every);
    if (skip) leaps -= before(n / skip);
    if (unless) leaps += before(n / unless);
    return n * cal.baseYearDays + leaps;
}

/**
 * 年月日 → 天序号（1 年 1 月 1 日 = 1）。
 * @param {{year:number, month:number, day:number}} ymd
 * @param {any} cal
 */
export function ymdToDayIndex(ymd, cal) {
    const year = Math.floor(Number(ymd.year) || 1);
    const month = Math.min(cal.months.length, Math.max(1, Math.floor(Number(ymd.month) || 1)));
    const day = Math.max(1, Math.floor(Number(ymd.day) || 1));

    let index = daysBeforeYear(year, cal) + 1;
    for (let m = 1; m < month; m++) index += daysInMonth(year, m, cal);
    index += day - 1;
    return index;
}

/**
 * 天序号 → 年月日。
 * @param {number} index
 * @param {any} cal
 */
export function dayIndexToYmd(index, cal) {
    let remaining = Math.floor(Number(index) || 1);

    // 先粗估年份，再小幅修正（闰年规则让每年天数略有差异，但误差极小）
    let year = Math.max(1, Math.floor((remaining - 1) / cal.baseYearDays) + 1);
    let guard = 0;
    while (guard++ < 64) {
        const before = daysBeforeYear(year, cal);
        if (remaining <= before) { year -= 1; continue; }
        if (remaining > before + daysInYear(year, cal)) { year += 1; continue; }
        break;
    }
    if (year < 1) year = 1;

    remaining -= daysBeforeYear(year, cal);
    let month = 1;
    guard = 0;
    while (guard++ < 64) {
        const dim = daysInMonth(year, month, cal);
        if (remaining > dim && month < cal.months.length) { remaining -= dim; month += 1; continue; }
        break;
    }
    const day = Math.max(1, remaining);
    return { year, month, day };
}

/** 取某个月的名字（优先用户自定义） */
export function monthName(month, cal) {
    return cal.monthNames[month - 1] ?? String(month);
}

// ───────────────────────────── 格式模板 ─────────────────────────────

/**
 * 模板里允许出现的占位符。
 *
 * 时间占位符是后加的：模型经常会给出 `{year}-{month}-{day} {hour}:{minute}`
 * 这种带时间的格式。早先的版本只认日期占位符，于是 `{hour}:{minute}` 被原样输出，
 * 而后面又追加了一次时分，结果就是「2023-5-12 {hour}:{minute} 21:32」。
 */
const TIME_PLACEHOLDER_ALIASES = {
    hour: ['hour', 'hours', 'h', 'hh', 'H', 'HH'],
    minute: ['minute', 'minutes', 'min', 'm', 'mm', 'MM', 'i', 'ii'],
    time: ['time', 'clock', 'datetime'],
    ampm: ['ampm', 'a'],
    shichen: ['shichen', 'shíchen'],
    shichenChar: ['shichenChar', 'shichenchar'],
    shichenTime: ['shichenTime', 'shichentime'],
    ke: ['ke'],
    keNum: ['keNum', 'kenum'],
};

const TIME_PLACEHOLDER_SET = new Set(
    Object.values(TIME_PLACEHOLDER_ALIASES).flat(),
);

/** 模板里所有认识的占位符 */
const KNOWN_PLACEHOLDER_SET = new Set([
    ...TIME_PLACEHOLDER_SET,
    'era', 'year', 'month', 'monthName', 'day', 'daySuffix', 'weekday',
]);

/**
 * 十二时辰。
 *
 * 一个时辰 = 2 小时，**子时从 23:00 开始**（所以 00:30 属于子时，不是丑时）。
 */
const SHICHEN_NAMES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const CN_NUM_1_8 = ['一', '二', '三', '四', '五', '六', '七', '八'];

/**
 * 时辰 / 刻。
 *
 * 约定（写死在文档里，方便你对照）：
 *   · 一个时辰 = 2 小时，子时从 23:00 起算
 *   · 一个时辰 = **8 刻，每刻 15 分钟**
 *   · `{ke}` 是从本时辰开始算的第几个刻，1 起，所以范围是 一到八
 *
 * 注意历代「刻」的长度并不统一（有百刻制、也有每时辰四刻的），
 * 这里取的是最通行的「一刻十五分钟」，你要是用别的制式告诉我。
 */
export function shichenValues(totalMinutes) {
    const total = (((Math.floor(totalMinutes) % 1440) + 1440) % 1440);
    const hour = Math.floor(total / 60);
    const index = Math.floor(((hour + 1) % 24) / 2);
    const name = SHICHEN_NAMES[index];
    const startMinute = ((index * 2 + 23) % 24) * 60;
    const elapsed = (total - startMinute + 1440) % 1440;
    const ke = Math.min(8, Math.floor(elapsed / 15) + 1);
    return {
        shichen: `${name}时`,
        shichenChar: name,
        ke: CN_NUM_1_8[ke - 1],
        keNum: String(ke),
        shichenTime: `${name}时${CN_NUM_1_8[ke - 1]}刻`,
    };
}

/** 模板里的占位符 token（含大小写） */
function placeholderTokens(template) {
    return String(template ?? '').match(/\{[A-Za-z_]+\}/g) ?? [];
}

/** 这个占位符是不是时间类 */
export function isTimePlaceholder(token) {
    const name = String(token ?? '').replace(/[{}]/g, '');
    return TIME_PLACEHOLDER_SET.has(name);
}

/** 找出模板里不认识的占位符（用来提醒用户 / 记录到「已套用」里） */
export function findUnknownPlaceholders(template) {
    const unknown = new Set();
    for (const token of placeholderTokens(template)) {
        const name = token.slice(1, -1);
        if (!KNOWN_PLACEHOLDER_SET.has(name)) unknown.add(token);
    }
    return [...unknown];
}

/** 模板里有没有时间占位符 */
export function hasTimePlaceholder(template) {
    return placeholderTokens(template).some(isTimePlaceholder);
}

/**
 * 把模型爱写的字面量时间写法换成占位符。
 * 例如 `2023-5-12 HH:mm` → `2023-5-12 {hour}:{minute}`。
 */
export function normalizeDateFormat(format) {
    let out = String(format ?? '');
    // HH:mm / HH:MM / hh:mm / H:i / HH时mm分
    out = out.replace(/\b(?:HH|H|hh|h)\s*[:：]\s*(?:mm|MM|m|i|ii|min)\b/g, '{hour}:{minute}');
    out = out.replace(/\b(?:HH|H|hh|h)\s*时\s*(?:mm|MM|m|i|min)\s*分?/g, '{hour}时{minute}分');
    out = out.replace(/\{(hour|hours|h|hh|H|HH)\}\s*[:：]\s*\{(minute|minutes|min|m|mm|MM|i|ii)\}/g, '{hour}:{minute}');
    return out;
}

/** 把时钟拆成模板可用的值 */
function momentValues(clock, cal) {
    const ymd = dayIndexToYmd(clock.day, cal);
    const total = (((Math.floor(clock.minute) % 1440) + 1440) % 1440);
    const h = Math.floor(total / 60);
    const mm = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return {
        era: cal.era + cal.eraSuffix,
        year: String(ymd.year),
        month: String(ymd.month),
        monthName: monthName(ymd.month, cal),
        day: String(ymd.day),
        daySuffix: cal.daySuffix,
        weekday: '',
        hour: pad(h),
        minute: pad(mm),
        time: `${pad(h)}:${pad(mm)}`,
        ampm: h < 12 ? 'AM' : 'PM',
        ...shichenValues(total),
    };
}

/** 按模板渲染（`{xxx}` 大小写不敏感地映射到同一个值） */
function renderMomentTemplate(template, values) {
    return String(template ?? '').replace(/\{([A-Za-z_]+)\}/g, (whole, name) => {
        if (Object.hasOwn(values, name)) return values[name];
        const lower = name.toLowerCase();
        if (Object.hasOwn(values, lower)) return values[lower];
        // 时间别名：h / hh / H / HH → hour；i / ii / min / MM → minute
        if (TIME_PLACEHOLDER_ALIASES.hour.includes(name)) return values.hour;
        if (TIME_PLACEHOLDER_ALIASES.minute.includes(name)) return values.minute;
        if (TIME_PLACEHOLDER_ALIASES.time.includes(name)) return values.time;
        return whole;   // 不认识的保持原样，让用户看得见
    });
}

/** 收尾：折叠重复空白、去掉首尾多余的空白与分隔符 */
function tidy(text) {
    return String(text)
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s\-/,·|:：]+/, '')
        .replace(/[\s\-/,·|:：]+$/, '')
        .trim();
}

/** 文本里是否已经包含一个具体时刻（用来防止重复追加） */
function alreadyHasTime(text) {
    return /\d{1,2}\s*[:：]\s*\d{2}/.test(String(text));
}

/**
 * 格式化日期部分（只出日期，时间占位符会被剔除）。
 * @param {{year:number,month:number,day:number}} ymd
 * @param {any} cal
 * @param {string} [template]
 */
export function formatCalendarDate(ymd, cal, template) {
    const tpl = template || cal.format;
    // 借一个当天的时钟来取值，日期部分不受影响
    const values = momentValues({ day: ymdToDayIndex(ymd, cal), minute: 0 }, cal);
    const dateOnly = String(tpl).replace(/\{[A-Za-z_]+\}/g, (token) => (
        isTimePlaceholder(token) ? '' : token
    ));
    return tidy(renderMomentTemplate(dateOnly, values));
}

/**
 * 日历模式下的完整时间文本。
 *
 * 关键点：**如果模板本身已经表达了时间，就不再在后面追加时分**，
 * 否则会渲染成「… {hour}:{minute} 21:32」这种重复。
 */
export function formatCalendarClock(clock, cal, opts = {}) {
    const { style = 'full' } = opts;
    const values = momentValues(clock, cal);
    const tpl = cal.format;

    switch (style) {
        case 'time':
            return values.time;
        case 'date':
            return formatCalendarDate(dayIndexToYmd(clock.day, cal), cal);
        case 'short':
            return tidy(renderMomentTemplate(
                String(cal.shortFormat).replace(/\{[A-Za-z_]+\}/g, (t) => (isTimePlaceholder(t) ? '' : t)),
                values,
            ));
        case 'cn': {
            const h = Number(values.hour);
            const label = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : '晚上';
            const h12 = h % 12 === 0 ? 12 : h % 12;
            const mm = Number(values.minute);
            return `${formatCalendarDate(dayIndexToYmd(clock.day, cal), cal)} ${label}${h12}点${mm ? `${values.minute}分` : ''}`;
        }
        default: {
            const rendered = tidy(renderMomentTemplate(tpl, values));
            if (hasTimePlaceholder(tpl)) return rendered;
            // 模板里没写时间占位符，但渲染结果里已经有一个具体时刻（比如模型写了字面量 HH:mm）
            if (alreadyHasTime(rendered)) return rendered;
            return `${rendered} ${values.time}`;
        }
    }
}

// ───────────────────────────── 解析 ─────────────────────────────

const NUM = String.raw`(?:\d{1,4}|[零〇一二两三四五六七八九十百千]+)`;

/** 去掉日期前面的纪元词，比如「公元」「帝国历」「第三纪」 */
function stripEraPrefix(text, cal) {
    let s = String(text);
    if (cal?.era) {
        s = s.replace(new RegExp(`^\\s*${cal.era.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '');
    }
    s = s.replace(/^\s*(?:公元|西元|纪元|历元)\s*/, '');
    s = s.replace(/^\s*第[零〇一二两三四五六七八九十百\d]+(?:纪|纪元|年|朝|世代)\s*/, '');
    return s;
}

/**
 * 解析一个年月日。
 * 支持：1247年3月15日 / 1247年3月15号 / 1247-03-15 / 1247/3/15 / 1247.3.15
 *       3月15日（年份取参考值）/ 1247年3月（日=1）/ 1247年（月=日=1）
 *       中文数字：一二四七年三月十五日
 * @param {string} text
 * @param {any} cal
 * @param {{year:number,month:number,day:number}} [reference]
 * @returns {{year:number,month:number,day:number,raw:string,partial:boolean}|null}
 */
export function parseCalendarDate(text, cal, reference) {
    if (text == null) return null;
    const src = stripEraPrefix(text, cal).trim();
    if (!src) return null;
    const ref = reference ?? { year: 1, month: 1, day: 1 };

    // ── 0) 自定义月名优先 ──
    // 「1247年春月7日」「春月7日」「春月」
    // 必须放在数字月前面：否则「1247年春月7日」会被数字规则吃成「1247年」+ 默认 1 月 1 日。
    if (cal.hasCustomMonthNames) {
        const names = cal.monthNames
            .map((n, i) => ({ name: n, index: i }))
            .filter((x) => x.name && !/^\d+$/.test(x.name))
            // 长名字优先，免得「霜月」抢在「霜之月」前面
            .sort((a, b) => b.name.length - a.name.length);

        const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // 精确匹配
        const exactAlt = names.map((x) => escape(x.name)).join('|');
        // 模糊匹配：「霜之月」↔「霜月」—— 去掉「之 / 的 / ·」这类连接字再比
        const loose = (s) => String(s).replace(/[之的·・\s]/g, '');
        const looseAlt = cal.fuzzyMonthNames
            ? [...new Set(names.map((x) => escape(loose(x.name))))].join('|')
            : '';
        const alt = [exactAlt, looseAlt].filter(Boolean).join('|');

        if (alt) {
            const re = new RegExp(
                `(?:(\\d{1,5}|[零〇一二两三四五六七八九十百千]+)\\s*年\\s*[的]?)?(${alt})\\s*(\\d{1,3}|[零〇一二两三四五六七八九十]{1,3})?\\s*[日号]?`,
            );
            const m0 = src.match(re);
            if (m0) {
                const matched = m0[2];
                let monthIndex = cal.monthNames.indexOf(matched);
                if (monthIndex < 0 && cal.fuzzyMonthNames) {
                    // 精确没命中 → 退到「去掉连接字」的比较。
                    // 注意用 .index（原始月份序号），不是 findIndex（那是在**排过序**的数组里的位次）。
                    const hit = names.find((x) => loose(x.name) === loose(matched));
                    if (hit) monthIndex = hit.index;
                }
                if (monthIndex >= 0) {
                    const year = m0[1] != null ? cnNumberToInt(m0[1]) : null;
                    const day = m0[3] != null ? cnNumberToInt(m0[3]) : null;
                    return {
                        year: year ?? ref.year,
                        month: monthIndex + 1,
                        day: day ?? 1,
                        raw: m0[0],
                        partial: day == null,
                        viaMonthName: true,
                        fuzzyMonthName: monthIndex >= 0 && matched !== cal.monthNames[monthIndex],
                    };
                }
            }
        }
    }

    // 1247年3月15日 / 1247年3月15号 / 1247年3月
    let m = src.match(new RegExp(`(${NUM})\\s*年\\s*(?:(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\\s*月)?\\s*(?:(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\\s*[日号])?`));
    if (m) {
        const year = cnNumberToInt(m[1]);
        const month = m[2] != null ? cnNumberToInt(m[2]) : null;
        const day = m[3] != null ? cnNumberToInt(m[3]) : null;
        if (year != null) {
            return {
                year,
                month: month ?? 1,
                day: day ?? 1,
                raw: m[0],
                partial: month == null || day == null,
            };
        }
    }

    // 1247-03-15 / 1247/3/15 / 1247.3.15
    m = src.match(/(-?\d{1,5})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/);
    if (m) {
        return {
            year: Number(m[1]),
            month: Number(m[2]),
            day: Number(m[3]),
            raw: m[0],
            partial: false,
        };
    }

    // 3月15日（不带年）
    m = src.match(new RegExp(`(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\\s*月\\s*(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})?\\s*[日号]?`));
    if (m) {
        const month = cnNumberToInt(m[1]);
        const day = m[2] != null ? cnNumberToInt(m[2]) : null;
        if (month != null && month >= 1 && month <= cal.months.length) {
            return { year: ref.year, month, day: day ?? 1, raw: m[0], partial: day == null };
        }
    }

    return null;
}

/**
 * 解析相对日期词：明天 / 后天 / 次日 / 翌日 / 大后天 / 今天 / 明年 / 去年 / 下个月 / 这个月
 * @returns {{year:number,month:number,day:number,raw:string}|null}
 */
export function parseRelativeDate(text, cal, reference) {
    if (text == null) return null;
    const src = stripEraPrefix(text, cal);
    const ref = reference ?? { year: 1, month: 1, day: 1 };

    const dayShiftMatch = src.match(/(大后天|大后日|后天|后日|明天|明日|次日|翌日|第二天|明天|今天|今日|当天|当日|昨天|昨日|前天)/);
    if (dayShiftMatch) {
        const word = dayShiftMatch[1];
        const shift = /大后/.test(word) ? 3
            : /^(后天|后日)$/.test(word) ? 2
                : /^(明天|明日|次日|翌日|第二天)$/.test(word) ? 1
                    : /^(昨天|昨日)$/.test(word) ? -1
                        : /^前天$/.test(word) ? -2
                            : 0;
        const base = dayIndexToYmd(ymdToDayIndex(ref, cal) + shift, cal);
        return { ...base, raw: word };
    }

    if (/明年|明载|下一年/.test(src)) return { year: ref.year + 1, month: ref.month, day: ref.day, raw: '明年' };
    if (/去年|上一?年/.test(src)) return { year: ref.year - 1, month: ref.month, day: ref.day, raw: '去年' };

    const monthShift = src.match(/(下下个?月|下个?月|这个月|本月|上个月|上月)/);
    if (monthShift) {
        const shift = /^下下/.test(monthShift[1]) ? 2
            : /^下/.test(monthShift[1]) ? 1
                : /^上/.test(monthShift[1]) ? -1
                    : 0;
        const total = ref.year * 12 + (ref.month - 1) + shift;
        const year = Math.floor(total / 12);
        const month = (total % 12) + 1;
        const day = Math.min(ref.day, daysInMonth(year, month, cal));
        return { year, month, day, raw: monthShift[1] };
    }

    return null;
}

/**
 * 一口价：从一段文本里解析出「日历时间点」。
 * 会依次尝试绝对日期 → 相对日期 → 只有时刻（沿用参考日）。
 * @returns {{clock: {day:number,minute:number}, raw: string, kind: string}|null}
 */
export function parseCalendarClock(text, cal, refClock, timeParser) {
    if (text == null) return null;
    const refYmd = dayIndexToYmd(refClock?.day ?? cal.startDayIndex, cal);
    const minute = refClock?.minute ?? 0;

    const absolute = parseCalendarDate(text, cal, refYmd);
    if (absolute) {
        const ymd = {
            year: absolute.year,
            month: Math.min(cal.months.length, Math.max(1, absolute.month)),
            day: Math.max(1, Math.min(absolute.day, daysInMonth(absolute.year, Math.min(cal.months.length, Math.max(1, absolute.month)), cal))),
        };
        const tod = timeParser ? timeParser(text) : null;
        return {
            clock: { day: ymdToDayIndex(ymd, cal), minute: tod ? tod.minute : (text.match(/[日号]\s*$/) ? 0 : minute) },
            raw: absolute.raw,
            kind: 'absolute',
        };
    }

    const relative = parseRelativeDate(text, cal, refYmd);
    if (relative) {
        const tod = timeParser ? timeParser(text) : null;
        const ymd = {
            year: relative.year,
            month: Math.min(cal.months.length, Math.max(1, relative.month)),
            day: Math.max(1, Math.min(relative.day, daysInMonth(relative.year, Math.min(cal.months.length, Math.max(1, relative.month)), cal))),
        };
        return {
            clock: { day: ymdToDayIndex(ymd, cal), minute: tod ? tod.minute : minute },
            raw: relative.raw,
            kind: 'relative',
        };
    }

    return null;
}

/**
 * 日历精确的时长推进：年/月按日历加（会自动把 31 日夹到 30 日这类），
 * 天/周按天序号加，时/分按分钟加。
 *
 * 为什么不能一律换算成分钟：「一个月后」在 28/30/31 天的月份里长度不同，
 * 换算成固定 43200 分钟会越走越偏。
 *
 * @param {{day:number,minute:number}} clock
 * @param {Array<{n:number,unit:string,minutes?:number}>} parts parseDuration 出来的 parts
 * @param {any} cal
 */
export function applyCalendarDuration(clock, parts, cal) {
    let totalMonths = 0;
    let totalDays = 0;
    let totalMinutes = 0;

    // 一年几个月由历法说了算 —— 不能写死 12。
    // 13 个月的历法（或「四季各 3 月」这类自定义）靠这个才走得对：
    // 1年1月1日 + 13个月 应该是 2年1月1日，不是 2年2月1日。
    const monthsPerYear = Math.max(1, cal?.months?.length || 12);

    for (const part of parts ?? []) {
        const n = Number(part?.n);
        const unit = String(part?.unit ?? '');
        if (!Number.isFinite(n)) continue;
        switch (unit) {
            case '年':
            case '载':
                totalMonths += n * monthsPerYear;
                break;
            case '季度':
                // 季度 = 一年四等分；不是 12 个月的历法就按 monthsPerYear/4 算
                totalMonths += n * Math.max(1, Math.round(monthsPerYear / 4));
                break;
            case '个月':
            case '月':
                totalMonths += n;
                break;
            case '周':
            case '星期':
            case '礼拜':
                totalDays += n * 7;
                break;
            case '天':
            case '日':
                totalDays += n;
                break;
            default:
                // 小时 / 分钟 / 时辰 / 刻 … 这些是固定长度，直接用 minutes
                totalMinutes += Number(part?.minutes) || 0;
                break;
        }
    }

    // 先把「整月」加到日历上
    const wholeMonths = Math.trunc(totalMonths);
    const fracMonths = totalMonths - wholeMonths;

    let ymd = dayIndexToYmd(clock.day, cal);
    if (wholeMonths) {
        const total = ymd.year * monthsPerYear + (ymd.month - 1) + wholeMonths;
        const year = Math.floor(total / monthsPerYear);
        const month = ((total % monthsPerYear) + monthsPerYear) % monthsPerYear + 1;
        ymd = { year, month, day: Math.min(ymd.day, daysInMonth(year, month, cal)) };
    }

    let dayIndex = ymdToDayIndex(ymd, cal);
    // 不足一个月的部分按**当月实际长度**折算，而不是写死 30 天
    const monthLength = daysInMonth(ymd.year, ymd.month, cal);
    dayIndex += Math.round(totalDays + fracMonths * monthLength);

    return absToClock((dayIndex - 1) * 1440 + clock.minute + Math.round(totalMinutes));
}

/** 把日历时间点转成起始时钟 */
export function calendarStartClock(cal) {
    return { day: cal.startDayIndex, minute: cal.startMinute };
}

/**
 * 时间格式化 / 解析门面 —— 把「计数制（第N天）」和「日历制（年月日）」统一成一个接口，
 * 上层（引擎、界面、提醒文本）只需要调 `formatter.format(clock)`，不用关心当前是哪种模式。
 *
 * @param {any} timeConfig config.time
 */
export function createTimeFormatter(timeConfig) {
    const cfg = timeConfig && typeof timeConfig === 'object' ? timeConfig : {};
    const isCalendar = cfg.mode === 'calendar';
    const cal = isCalendar ? createCalendar(cfg.calendar) : null;
    const dayLabel = String(cfg.dayLabel || '第{day}天');

    const formatter = {
        mode: isCalendar ? 'calendar' : 'counter',
        isCalendar,
        calendar: cal,
        dayLabel,

        /** 本场聊天的起始时钟 */
        startClock() {
            if (isCalendar) return calendarStartClock(cal);
            return {
                day: Math.max(1, Math.floor(Number(cfg.startDay) || 1)),
                minute: Math.max(0, Math.min(1439, Math.floor(Number(cfg.startMinute) || 0))),
            };
        },

        /** 格式化时钟：full / date / time / short / cn */
        format(clock, style = 'full') {
            if (!clock) return '';
            if (isCalendar) return formatCalendarClock(clock, cal, { style });
            return formatClock(clock, { dayLabel, style });
        },

        /** 只要日期部分 */
        formatDate(clock) {
            if (!clock) return '';
            if (isCalendar) return formatCalendarClock(clock, cal, { style: 'date' });
            return formatClock(clock, { dayLabel, style: 'day' });
        },

        /** 解析「绝对时间点」，两种模式都支持；解析不出返回 null */
        parse(text, refClock) {
            if (text == null || String(text).trim() === '') return null;
            const ref = refClock ?? formatter.startClock();
            if (isCalendar) {
                const parsed = parseCalendarClock(text, cal, ref, parseTimeOfDay);
                return parsed ? parsed.clock : null;
            }
            return parseAbsoluteClock(String(text), ref);
        },

        /**
         * 推进时间。
         * 日历模式下 年/月 走日历精确加法；计数模式下直接按分钟加。
         * @param {{day:number,minute:number}} clock
         * @param {Array<{n:number,unit:string,minutes?:number}>} parts
         * @param {number} fallbackMinutes
         */
        applyDuration(clock, parts, fallbackMinutes) {
            if (isCalendar && Array.isArray(parts) && parts.length) {
                return applyCalendarDuration(clock, parts, cal);
            }
            return addMinutes(clock, Number(fallbackMinutes) || 0);
        },

        /** 给 AI 看的「现在几点」示例，用于协议说明文案 */
        exampleClock() {
            if (isCalendar) {
                // 用样例时间跑一遍完整格式化，这样模板里带了 {hour}/{minute} 也不会重复
                return formatCalendarClock({ day: cal.startDayIndex, minute: 14 * 60 + 30 }, cal);
            }
            return `${dayLabel.replace('{day}', '3')} 14:30`;
        },
    };

    return formatter;
}

export { MONTH_NAMES_CN };
