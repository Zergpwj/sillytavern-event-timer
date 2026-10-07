/**
 * 提醒文本与「记录格式」说明的生成。
 *
 * 全部是纯字符串拼装，宿主无关，方便其它应用直接复用。
 *
 * ── 设计边界（很重要，改文案时别破坏它）──────────────────────────
 *
 * 事件参数的变化**只走「AI 的标签区块 ↔ 插件」这条暗道**。
 * 正文里只在四个时刻体现：
 *
 *   1. 正式开始            —— AI 自己写（登记事件那一轮）
 *   2. 结束（到点）        —— due 提醒
 *   3. 预定终点（旧）到了        —— origin 提醒（事情出了岔子、被拖长了）
 *   4. 玩家主动查询        —— 面板
 *
 * 所以：
 *   · mid  —— **静默**。只判断、只调参数。**绝不能要求 AI 在正文里写什么。**
 *   · late —— **静默**。产出的是「要点」清单（给插件看的），不是结局预告。
 *   · origin / due —— 这两个才写进正文。
 */

import { clockToAbs, diffMinutes, formatCountdown, formatDuration } from './story-time.js';

export const REMINDER_FOOTER = '[结束]';

/** 时点顺序（也是「谁更靠后」的排序依据） */
export const POINT_ORDER = ['mid', 'late', 'origin', 'due'];

/** 时点的人类可读名字 */
export const POINT_LABEL = {
    mid: '定期检查',
    late: '即将结束',
    origin: '预定终点（旧）',
    due: '预定终点（现）',
};

/** 时点的默认标题后缀 */
const POINT_TITLE = {
    mid: '定期检查',
    late: '初步结算',
    origin: '预定终点（旧）',
    due: '预定终点（现）',
};

/**
 * 标题。跟着标签名走（`[timer·定期检查]`）——
 * 标签切成 ASCII 之后标题也跟着切，保持两边一致。
 */
export function pointHeader(tag, point) {
    return `[${tag || 'timer'}·${POINT_TITLE[point] ?? point}]`;
}

/** 当前使用的主标签名 */
export function primaryTag(tagNames) {
    return (Array.isArray(tagNames) && tagNames[0]) || 'timer';
}

/**
 * 教 AI 输出标签的说明文本（精简版）。
 *
 * 刻意省掉的东西，以及为什么：
 *   · `流逝:` —— `时间:` 是必填的，引擎拿到绝对时间会直接覆盖时钟，它是纯冗余
 *   · `事件~` 的用法 —— 只有**收到提醒的轮次**才需要，已经写在定期检查提醒里了
 *
 * ⚠️ 「时间」那一行**不写死的示例值**，否则模型会直接照抄，时钟就永远卡住不动。
 *    改成占位符，并在上方给出当前时间作参照。
 *
 * @param {{ tagNames?: string[], dayLabel?: string, exampleClock?: string, nowClock?: string,
 *           isCalendar?: boolean, minEventMinutes?: number }} [opts]
 */
/** 「少于X的事不要写」这句话 —— 协议和它的模板都要用，所以单独拿出来 */
export function protocolTooShort(minEventMinutes) {
    const minEvent = Number(minEventMinutes) || 0;
    return minEvent >= 60
        ? `少于${formatDuration(minEvent, { maxUnits: 2 })}的事不要写`
        : '立刻见效的事不要写';
}

/**
 * 「事件+ 只写一次」那句。
 *
 * ⚠️ 两处是刻意这么写的，别顺手改回去：
 *
 * 1. **不列举具体时点。** 原来写的是「会在一半、快结束、预定终点（旧）到了和到点的时候
 *    提醒你」。把「预定终点（旧）到了」摆到 AI 面前，等于告诉它「超过期限」是一种正常
 *    走向，反而容易把剧情往逾期上引；AI 也根本不需要知道计时器内部有哪几个时点。
 *    不承诺任何具体时点，就永远不会承诺一个不存在的时点 —— 所以也不再需要按
 *    开没开定期检查/末段区分文案。
 *
 * 2. **说「向计时器汇报」，不说「不用管」。** 之前是「事件写完就不用管了」——
 *    「事件」在这个语境里是双关的（既是插件的字段名，也是剧情概念），
 *    「不用管」又没有宾语，模型可能读成「剧情里也别管这件事了」。
 *    改成「向计时器汇报」之后范围钉死在**标签**上：既没说剧情里要怎样，
 *    也没说不要怎样，不给模型任何往剧情上联想的抓手。
 */
export function protocolReminderHint() {
    return '· 「事件+」只在开始时写一次就够了，之后不用再向计时器汇报：不要写进度、也不要写结束标记。计时器会在后续时间点提醒你。';
}

export function renderProtocolText(opts = {}) {
    const tag = primaryTag(opts.tagNames);
    const isCalendar = !!opts.isCalendar;
    const now = opts.nowClock || opts.exampleClock
        || `${(opts.dayLabel || '第{day}天').replace('{day}', '3')} 14:30`;
    const altExample = isCalendar ? '1247年4月1日 09:00' : '第5天 09:00';
    const tooShort = protocolTooShort(opts.minEventMinutes);

    return [
        `[${tag}·记录格式]`,
        `当前剧情时间：${now}`,
        `请在每次回复末尾追加一个 <${tag}> 区块（正文里不要提到它）：`,
        '',
        `<${tag}>`,
        '时间: <本轮结束时的剧情时间>          ← 必填，格式同上',
        '事件+: 名字 | 时长 | 预期=… | 变数=… | 资源=…',
        `</${tag}>`,
        '',
        `· 「事件+」只在需要时间才有结果的事刚开始时写一次（${tooShort}）。`,
        protocolReminderHint(),
        `· 时长写法：3天 / 6小时 / 一炷香 / 到期: ${altExample}`,
        REMINDER_FOOTER,
    ].join('\n');
}

// ───────────────────────────── 事件块 ─────────────────────────────

/** 事件登记的「预期 / 变数 / 资源 / 设定摘要」回显 */
function pushDetails(lines, ev, cfg, { skipOutline = false } = {}) {
    if (!cfg?.reminder?.includeEventDetails) return;
    if (!skipOutline && ev.outline) lines.push(`   要点：${ev.outline}`);
    if (ev.expectation) lines.push(`   预期：${ev.expectation}`);
    if (ev.variables) lines.push(`   变数：${ev.variables}`);
    if (ev.ledger) lines.push(`   资源：${ev.ledger}`);
    if (ev.note) lines.push(`   设定摘要：${ev.note}`);
}

const fmt = (formatClock, clock) => (typeof formatClock === 'function' && clock ? formatClock(clock) : '');
const dur = (minutes) => formatDuration(Math.max(0, Math.round(minutes)), { maxUnits: 2 });

/** 定期检查：**静默**，只用来调参数 */
function renderMidBlock(ev, clock, cfg, formatClock, index) {
    const lines = [];
    const total = diffMinutes(ev.dueClock, ev.createdClock);
    const elapsed = diffMinutes(clock, ev.createdClock);
    const remaining = diffMinutes(ev.dueClock, clock);
    const pct = total > 0 ? Math.round((elapsed / total) * 100) : 0;

    lines.push(`${index}. 《${ev.title}》 预定完成时间：${fmt(formatClock, ev.dueClock)}（还有 ${dur(remaining)}，已进行约 ${pct}%）`);
    pushDetails(lines, ev, cfg);
    return lines.join('\n');
}

/** 即将结束：初步结算，列「要点」 */
function renderLateBlock(ev, clock, cfg, formatClock, index) {
    const lines = [];
    const remaining = diffMinutes(ev.dueClock, clock);
    lines.push(`${index}. 《${ev.title}》 预定完成时间：${fmt(formatClock, ev.dueClock)}（还剩 ${dur(remaining)}）`);
    pushDetails(lines, ev, cfg, { skipOutline: true });
    return lines.join('\n');
}

/** 预定终点（旧）：事情拖长了，让正文有机会体现出来 */
function renderOriginBlock(ev, clock, cfg, formatClock, index) {
    const lines = [];
    const initial = Number.isFinite(Number(ev.initialDurationMinutes))
        ? Number(ev.initialDurationMinutes)
        : Number(ev.durationMinutes) || 0;
    const total = Number(ev.durationMinutes) || initial;
    const delta = total - initial;
    const n = (ev.dueHistory ?? []).length;

    lines.push(`${index}. 《${ev.title}》 **原定的期限已经到了，但它还没有结束。**`);
    lines.push(`   最初登记：${dur(initial)}`);
    lines.push(`   现在预计：${dur(total)}${delta !== 0 ? `（第 ${n} 次顺延，${delta > 0 ? '+' : '−'}${dur(Math.abs(delta))}）` : ''}`);
    pushDetails(lines, ev, cfg);
    return lines.join('\n');
}

/** 到点：最终结算，写进正文 */
function renderDueBlock(ev, clock, cfg, formatClock, index) {
    const lines = [];
    const overdue = clockToAbs(clock) - clockToAbs(ev.dueClock);
    const dueText = fmt(formatClock, ev.dueClock);
    const eta = overdue > 0 ? `（已超时 ${dur(overdue)}）` : '（刚刚到点）';
    lines.push(`${index}. 《${ev.title}》 预定完成时间：${dueText}${eta}`);
    pushDetails(lines, ev, cfg);
    if (ev.createdClock) {
        const total = diffMinutes(ev.dueClock, ev.createdClock);
        if (total > 0) lines.push(`   总时长：${dur(total)}`);
    }
    return lines.join('\n');
}

const BLOCK_RENDERERS = {
    mid: renderMidBlock,
    late: renderLateBlock,
    origin: renderOriginBlock,
    due: renderDueBlock,
};

// ───────────────────────────── 组装 ─────────────────────────────

/**
 * 每个时点内置文案的「事件清单之前 / 之后」两半。
 *
 * 拆开是为了能同时产出两种东西：
 *   · 真正发出去的文本（事件清单插在中间）
 *   · **模板**（`{{events}}` 插在中间）—— 提示词库里存的就是这个
 *
 * 为什么模板必须存在：内置文案里有**活的值**（当前剧情时间、标签名）。
 * 如果提示词库里直接存渲染好的文本，「当前剧情时间」就被冻住了 ——
 * 模型会一直看到那个旧时间，甚至照着它写，时钟就卡住了。
 *
 * @param {boolean} [opts.template] true 时把活的值换成占位符
 */
function builtinPointParts(point, clock, config, formatClock, tag, { template = false } = {}) {
    const cfg = config?.reminder ?? {};
    const now = template ? '{{time}}' : (fmt(formatClock, clock) || '(未知)');
    const head = [pointHeader(tag, point), `当前剧情时间：${now}`];
    const tail = [];

    if (point === 'mid') {
        // 静默：不要求写正文，只要求判断 + 按需调参数
        head.push('下列事件仍在进行中。请结合这期间正文里已经发生的一切，包括外部环境的变化（战事、行情、局势、别人的行动）和它自身的变数，判断它有没有受到影响。');
        tail.push('');
        tail.push('如果参数需要改，用一行「事件~」写下来（**不需要改就什么都不用写，也不要在正文里特意交代它**）：');
        tail.push('  时间要变 → 事件~: <事件名> | 时长=<新的总时长>         （从事件开始算的总时长）');
        tail.push('            事件~: <事件名> | 到期=<新的绝对时间>');
        tail.push('  预期要变 → 事件~: <事件名> | 预期=… | 变数=… | 资源=…');
        tail.push('重点核对：**按现在的消耗速度，资源够撑到事件结束吗？**（资源栏有数值时）');
    } else if (point === 'late') {
        head.push('下列事件快到期了。请先做一次**初步结算**：把到点时要交代的几个方面列出来。');
        tail.push('');
        tail.push('用一行把它写下来（**写在标签区块里，不要写进正文**）。这一步只列「要回答哪几个方面」，不要定结果：');
        tail.push('  事件~: <事件名> | 要点=方面1 / 方面2 / 方面3');
        tail.push('如果此时发现时间也要改，可以一起写：事件~: <事件名> | 要点=… | 时长=<新的总时长>');
    } else if (point === 'origin') {
        head.push('下列事件**过了原定的期限还没有结束**。请在正文里体现这件事带来的影响：');
        head.push('比如旁人的议论、局势的变化、要不要派人去找、要不要另想办法。');
        tail.push('');
        tail.push('如果这期间又有新变化，可以再调整：事件~: <事件名> | 时长=<新的总时长> | 预期=…');
    } else {
        head.push('下列事件已经到达预定的完成时间，请在正文里交代它们的结果：');
        if (template) {
            // 超时提醒只在真的有事件超时时才出现，所以模板里留个占位符
            tail.push('{{overdueHint}}');
        }
        // ⚠️ 这句话**不能假设事件是「某人离开又回来」** —— 那只是事件的一种。
        // 事件也可以是「熬好这炉药」「三天内送到」「养好伤」，说「没回来 / 逾期未归」
        // 在那几种身上根本讲不通。所以用「没有结果 / 悬而未决」，对任何事件都成立。
        //
        // ⚠️ 而且「悬而未决本身就是剧情」太绝对。这段提醒通篇是祈使句，中间夹一句
        // 陈述句，模型很容易读成**指令** —— 以为「不写结果」才是正解，那就和这句的
        // 初衷反了（这句是给**许可**，不是给方向）。加「可能」降级成一种可能性。
        tail.push('如果结果和「要点」有出入，或者压根没有结果（悬而未决本身也可能是剧情），照实写就行。');
        tail.push('如果发现还需要再拖一段，也可以现在改：事件~: <事件名> | 时长=<新的总时长>');
        tail.push('（交代完就够了，不需要写结束标记，计时器会自己收掉这件事。）');
    }

    tail.push(REMINDER_FOOTER);
    void cfg;
    return { head, tail };
}

/** 每个时点的内置文案（模板为空时用它） */
function builtinPointText(point, list, clock, config, formatClock, tag) {
    const cfg = config?.reminder ?? {};
    const { head, tail } = builtinPointParts(point, clock, config, formatClock, tag);
    const render = BLOCK_RENDERERS[point] ?? renderDueBlock;
    const blocks = list.map((ev, i) => render(ev, clock, config, formatClock, i + 1));

    const extra = [];
    if (point === 'due' && cfg.emphasizeOverdue && list.some((e) => clockToAbs(clock) > clockToAbs(e.dueClock))) {
        extra.push('注意：上面标注「已超时」的事件已经拖过了预定时间，请优先处理。');
    }
    return [...head, ...blocks, ...extra, ...tail].join('\n');
}

/**
 * 某个时点内置文案的**模板形态**（占位符版）。
 *
 * 用来填进提示词库 —— 存它而不是存渲染结果，才不会把当前时间冻住。
 * 代进 {{tag}} / {{time}} / {{events}} / {{overdueHint}} 之后，
 * 必须和 `builtinPointText` 一字不差（有测试守着）。
 */
export function builtinPointTemplate(point, config, tag = '{{tag}}') {
    const { head, tail } = builtinPointParts(point, null, config, null, tag, { template: true });
    return [...head, '{{events}}', ...tail].join('\n');
}

/**
 * 简易模板插值：{{time}} {{events}} {{count}} {{tag}}，外加调用方给的 extra。
 *
 * extra 里值为空的占位符会把**整行**去掉 —— 只替换成空串会留下一个空行，
 * 和内置文案就对不上了（{{overdueHint}} 就是这种情况：没有超时事件时它不该占一行）。
 */
function interpolate(template, { time, events, tag, extra = null }) {
    // ⚠️ 不要在这里再编一次号 —— `events` 传进来的已经是渲染好的事件块，
    // 每块自带「1. 」「2. 」前缀。再编一次会变成「1. 1. 《…》」。
    const list = events.join('\n');
    let out = String(template)
        .replace(/\{\{\s*time\s*\}\}/g, time)
        .replace(/\{\{\s*clock\s*\}\}/g, time)
        .replace(/\{\{\s*events\s*\}\}/g, list)
        .replace(/\{\{\s*count\s*\}\}/g, String(events.length))
        .replace(/\{\{\s*tag\s*\}\}/g, tag);
    for (const [key, value] of Object.entries(extra ?? {})) {
        const eaten = new RegExp(`^[^\\S\\n]*\\{\\{\\s*${key}\\s*\\}\\}[^\\S\\n]*\\n?`, 'gm');
        if (value === '' || value == null) out = out.replace(eaten, '');
        else out = out.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), String(value));
    }
    return out;
}

/**
 * 生成注入用的提醒文本。
 *
 * `events` 里每一项都带 `reminderPoint`（'mid' / 'late' / 'origin' / 'due'），
 * 按四种时点分别成段 —— 每种时点对 AI 的要求完全不同。
 *
 * @param {{
 *   clock: any,
 *   events: any[],
 *   config: any,
 *   protocolText?: string|null,
 *   formatClock?: (clock: any) => string,
 *   templates?: Record<string, string|null>,
 * }} input
 * @returns {string} 没有事件且不需要协议说明时返回空串
 */
export function renderReminderText(input) {
    const { clock, events, config, protocolText, formatClock, templates } = input;
    const tag = primaryTag(config?.tagNames);
    const parts = [];

    const list = Array.isArray(events) ? events : [];
    if (list.length) {
        const groups = { mid: [], late: [], origin: [], due: [] };
        for (const ev of list) {
            const point = groups[ev.reminderPoint] ? ev.reminderPoint : 'due';
            groups[point].push(ev);
        }

        const time = fmt(formatClock, clock) || '';
        for (const point of POINT_ORDER) {
            const group = groups[point];
            if (!group.length) continue;

            const custom = templates?.[point];
            if (typeof custom === 'string' && custom.trim()) {
                const render = BLOCK_RENDERERS[point] ?? renderDueBlock;
                const blocks = group.map((ev, i) => render(ev, clock, config, formatClock, i + 1));
                // 超时提醒只在真的有事件超时时才出来
                let overdueHint = '';
                if (point === 'due' && config?.reminder?.emphasizeOverdue
                    && group.some((e) => clockToAbs(clock) > clockToAbs(e.dueClock))) {
                    overdueHint = '注意：上面标注「已超时」的事件已经拖过了预定时间，请优先处理。';
                }
                parts.push(interpolate(custom, { time, events: blocks, tag, extra: { overdueHint } }));
            } else {
                parts.push(builtinPointText(point, group, clock, config, formatClock, tag));
            }
        }
    }

    if (protocolText) parts.push(protocolText);
    return parts.join('\n\n');
}

/** 供面板展示的一句话倒计时 */
export function eventCountdown(ev, clock) {
    return formatCountdown(diffMinutes(ev.dueClock, clock));
}
