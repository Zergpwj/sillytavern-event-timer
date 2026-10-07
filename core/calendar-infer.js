/**
 * 「用 AI 推断历法」—— 把世界书 / 角色卡 / 对话线索拼成提示词，
 * 再把模型返回的 JSON 解析成一份可套用的历法规格。
 *
 * 这里只做纯逻辑（拼提示词 + 解析回答），**不发请求**；
 * 真正发请求在 `../ai-client.js` 里，这样推理部分能脱离网络单测。
 */

import { CALENDAR_PRESETS, createCalendar, daysInMonth, findUnknownPlaceholders, normalizeDateFormat } from './calendar.js';

/** 把线索整理成一段有结构的文本 */
export function formatClues(clues, { maxChars = 6000 } = {}) {
    const sections = [];
    const push = (title, body) => {
        const text = String(body ?? '').trim();
        if (text) sections.push(`【${title}】\n${text}`);
    };

    if (clues?.chatName) push('当前对话', clues.chatName);

    if (clues?.character) {
        const c = clues.character;
        push('角色卡', [
            c.name ? `名字：${c.name}` : '',
            c.description ? `设定：${c.description}` : '',
            c.personality ? `性格：${c.personality}` : '',
            c.scenario ? `场景：${c.scenario}` : '',
            c.systemPrompt ? `系统提示：${c.systemPrompt}` : '',
        ].filter(Boolean).join('\n'));
    }

    if (clues?.persona) push('用户人设', clues.persona);

    if (Array.isArray(clues?.worldInfo) && clues.worldInfo.length) {
        const entries = clues.worldInfo
            .map((e) => {
                const name = e.comment || e.key || '';
                const body = String(e.content ?? '').trim();
                return body ? `· ${name ? `[${name}] ` : ''}${body}` : '';
            })
            .filter(Boolean);
        push('世界书条目', entries.join('\n'));
    }

    if (Array.isArray(clues?.recentMessages) && clues.recentMessages.length) {
        const lines = clues.recentMessages
            .map((m) => `${m.name || (m.isUser ? '用户' : '角色')}：${String(m.text ?? '').trim()}`)
            .filter((l) => l.length > 3);
        push('最近对话片段', lines.join('\n'));
    }

    let text = sections.join('\n\n');
    if (text.length > maxChars) {
        text = `${text.slice(0, maxChars)}\n…（线索过长已截断）`;
    }
    return text;
}

/** 请求模型输出的 JSON 形状说明 */
export const CALENDAR_JSON_SPEC = `{
  "era": "纪元前缀，例如 帝国历 / 第三纪；没有就填空字符串",
  "months": [每月天数，例如 31,28,31,30,31,30,31,31,30,31,30,31；不确定就留空数组],
  "monthNames": ["每个月叫什么，例如 春月,花月,…；没有专门叫法就留空数组"],
  "leap": { "every": 每几年一次闰年（没有闰年填 0）, "skip": 跳过哪些年的倍数（不确定填 0）, "unless": 哪些年的倍数仍然算（不确定填 0）, "month": 闰日加在第几个月 },
  "format": "日期显示模板，可用 {era}{year}{month}{monthName}{day}{daySuffix}",
  "startDate": { "year": 当前年份, "month": 当前月份, "day": 当前日期, "hour": 当前小时, "minute": 当前分钟 },
  "confident": true 或 false（线索够不够支撑这个结论）,
  "reason": "一句话说明你的依据"
}`;

/**
 * 拼推断用的提示词。
 * @param {any} clues
 * @param {{ maxChars?: number, presetHint?: string }} [opts]
 */
export function buildCalendarPrompt(clues, opts = {}) {
    const clueText = formatClues(clues, { maxChars: opts.maxChars ?? 6000 });
    return [
        '你是一个跑团 / 角色扮演辅助工具。请根据下面提供的世界观线索，判断这个世界用的是什么样的历法，并给出「当前剧情时间」。',
        '',
        '要求：',
        '1. 只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。',
        '2. 线索里没有依据的字段就填最保守的值（空字符串 / 空数组 / 0），**不要编造**。',
        '3. 如果线索里明确出现了「某年某月某日」「几月叫什么」这类信息，优先采用它。',
        '4. 如果完全看不出历法，就把 months / monthNames 留空，只在 startDate 里给出你从对话推测的当前日期。',
        '5. 月份名只有在线索里真的有专门叫法时才填（例如「春月」「霜月」）；否则留空让程序用数字月份。',
        '',
        'JSON 形状：',
        CALENDAR_JSON_SPEC,
        '',
        '--- 线索开始 ---',
        clueText || '（没有任何线索）',
        '--- 线索结束 ---',
    ].join('\n');
}

/** 从模型输出里抠出 JSON */
export function extractJsonObject(text) {
    if (text == null) return null;
    let s = String(text).trim();
    // 去掉 markdown 代码块围栏
    s = s.replace(/^```(?:json|JSON)?\s*/m, '').replace(/```\s*$/m, '').trim();

    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(s.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

function toInt(value, fallback = null) {
    if (value == null || value === '') return fallback;
    const n = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function toStrArray(value) {
    if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim());
    if (typeof value === 'string') {
        return value.split(/[,，、\n|]+/).map((v) => v.trim()).filter(Boolean);
    }
    return [];
}

/**
 * 把模型输出解析成规范的历法规格。
 * @param {any} raw 模型返回的文本或已经解析好的对象
 * @returns {any|null}
 */
export function parseCalendarAnswer(raw) {
    const data = typeof raw === 'string' ? extractJsonObject(raw) : raw;
    if (!data || typeof data !== 'object') return null;

    const months = toStrArray(data.months).map((n) => toInt(n, 0)).filter((n) => n > 0);
    const monthNames = toStrArray(data.monthNames);

    const leapRaw = data.leap && typeof data.leap === 'object' ? data.leap : {};
    const leap = {
        every: toInt(leapRaw.every, 0) ?? 0,
        skip: toInt(leapRaw.skip, 0) ?? 0,
        unless: toInt(leapRaw.unless, 0) ?? 0,
        month: toInt(leapRaw.month, 1) ?? 1,
    };

    const startRaw = data.startDate && typeof data.startDate === 'object' ? data.startDate
        : (data.currentDate && typeof data.currentDate === 'object' ? data.currentDate : {});

    const startDate = {};
    const y = toInt(startRaw.year);
    const mo = toInt(startRaw.month);
    const d = toInt(startRaw.day);
    const h = toInt(startRaw.hour);
    const mi = toInt(startRaw.minute);
    if (y != null) startDate.year = y;
    if (mo != null) startDate.month = mo;
    if (d != null) startDate.day = d;
    if (h != null) startDate.hour = h;
    if (mi != null) startDate.minute = mi;

    const spec = {
        era: String(data.era ?? '').trim(),
        months,
        monthNames,
        leap,
        format: String(data.format ?? '').trim(),
        startDate,
        confident: data.confident !== false,
        reason: String(data.reason ?? '').trim(),
    };

    const hasAnything = spec.era || months.length || monthNames.length
        || Object.keys(startDate).length || spec.format;
    return hasAnything ? spec : null;
}

/**
 * 把规格套用到配置上。
 * @param {any} config 当前 config
 * @param {any} spec parseCalendarAnswer 的结果
 * @param {{ era?: boolean, months?: boolean, monthNames?: boolean, leap?: boolean, format?: boolean, startDate?: boolean }} [apply]
 * @returns {{ config: any, applied: string[] }}
 */
export function applyCalendarSpec(config, spec, apply = {}) {
    if (!spec) return { config, applied: [] };

    const calendar = { ...(config?.time?.calendar ?? {}) };
    const applied = [];

    if (apply.era !== false && spec.era) {
        calendar.era = spec.era;
        applied.push(`纪元前缀：${spec.era}`);
    }

    if (apply.months !== false && Array.isArray(spec.months) && spec.months.length) {
        calendar.months = spec.months.slice();
        calendar.preset = null;
        applied.push(`每月天数：${spec.months.join(', ')}`);
    }

    if (apply.monthNames !== false && Array.isArray(spec.monthNames) && spec.monthNames.length) {
        calendar.monthNames = spec.monthNames.slice();
        applied.push(`月名：${spec.monthNames.join('、')}`);
        // 光配了月名但显示模板还在用 {month} 的话，月名根本看不到 —— 顺手把 {month}月 换成 {monthName}。
        // 只在用户/AI 没明确给格式时做，避免覆盖用户的自定义模板。
        if (!spec.format) {
            // ⚠️ 必须先求出**实际生效**的格式。默认配置不再写死 format（改由预设提供），
            // 所以 calendar.format 可能是 null —— 直接 String(null ?? '') 会得到空串，
            // 「配了月名但模板还在用 {month}」这件事就检测不到，月名填了也看不见。
            const preset = calendar.preset ? CALENDAR_PRESETS[calendar.preset] : null;
            const current = String(calendar.format || preset?.format || '{era}{year}年{month}月{day}日');
            if (current.includes('{month}') && !current.includes('{monthName}')) {
                calendar.format = current
                    .replace(/\{month\}\s*月/g, '{monthName}')
                    .replace(/\{month\}/g, '{monthName}');
                applied.push(`日期格式自动改为：${calendar.format}`);
            }
        }
    }

    if (apply.leap !== false && spec.leap && (spec.leap.every || spec.leap.skip || spec.leap.unless)) {
        calendar.leap = { ...spec.leap };
        // 覆盖了闰年数值，那「自定义」这个手选状态就不成立了 —— 清掉，
        // 让设置界面按新数值重新判断档位（否则会一直停在「自定义…」）
        calendar.leapMode = null;
        applied.push(`闰年：每 ${spec.leap.every} 年`);
    }

    if (apply.format !== false && spec.format) {
        // 模型常写成 `2023-5-12 HH:mm` 这种字面量，先换成占位符
        const normalized = normalizeDateFormat(spec.format);
        calendar.format = normalized;
        applied.push(`日期格式：${normalized}`);
        if (normalized !== spec.format) {
            applied.push('（已把格式里的字面量时间写法规范化为占位符）');
        }
    }

    // 提示还不认识的占位符，免得又出现「{xxx} 被原样输出」
    const unknown = findUnknownPlaceholders(calendar.format ?? '');
    if (unknown.length) {
        applied.push(`⚠ 日期格式里有不认识的占位符会被原样输出：${unknown.join('、')}（可用：{era} {year} {month} {monthName} {day} {daySuffix} {hour} {minute} {time}）`);
    }

    // 月数与月名数量不匹配时，按月份数截断/补齐
    if (Array.isArray(calendar.months) && calendar.months.length && Array.isArray(calendar.monthNames)) {
        calendar.monthNames = Array.from({ length: calendar.months.length }, (_, i) => calendar.monthNames[i] ?? '');
    }

    // 起始日期要落在合法范围内
    if (apply.startDate !== false && spec.startDate && Object.keys(spec.startDate).length) {
        const base = { ...(calendar.startDate ?? { year: 1, month: 1, day: 1, hour: 8, minute: 0 }), ...spec.startDate };
        const monthsCount = Array.isArray(calendar.months) && calendar.months.length
            ? calendar.months.length
            : (CALENDAR_PRESETS[calendar.preset ?? 'gregorian']?.months.length ?? 12);
        base.month = Math.min(monthsCount, Math.max(1, toInt(base.month, 1)));
        base.day = Math.max(1, toInt(base.day, 1));
        calendar.startDate = base;
        applied.push(`起始日期：${base.year}年${base.month}月${base.day}日 ${String(base.hour ?? 0).padStart(2, '0')}:${String(base.minute ?? 0).padStart(2, '0')}`);
    }

    // 兜底校验：日期不能超过当月天数
    try {
        const probe = createCalendar({ ...calendar, preset: calendar.preset });
        const sd = probe.startDate;
        const maxDay = daysInMonth(sd.year, sd.month, probe);
        if (sd.day > maxDay) {
            calendar.startDate = { ...sd, day: maxDay };
        }
    } catch { /* 校验失败就原样保留 */ }

    return {
        config: {
            ...config,
            time: { ...(config.time ?? {}), mode: 'calendar', calendar },
        },
        applied,
    };
}

export { CALENDAR_PRESETS };
