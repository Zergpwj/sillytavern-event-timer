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
        ? `时长门槛 ${formatDuration(minEvent, { maxUnits: 2 })}`
        : '没有时长门槛';
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
    return [
        '· 「事件+」只在开始时写一次就够了，之后不用再向计时器汇报：不要写进度、也不要写结束标记。到了该提醒的时候，计时器会主动提醒。',
        // 为什么要求写主体：事件的身份就是**名字**（插件按名字认它，提醒里也只印名字）。
        // 名字不带主体时，「提莉静养疗伤」和「静养疗伤」在提醒里长得一模一样，
        // AI 得靠「资源：药材三份」这种线索猜是谁的事 —— 猜错就把伤养到别人身上了。
        // 而且插件匹配事件时有一层「子串回退」，两条名字互相包含时它会挑数组里第一条，
        // 从源头把主体写清楚，这层歧义就不存在了。
        //
        // ⚠️ 措辞压得很短，是有意的：`tests/calendar-tests.mjs` 守着
        // 「协议总长 < 360 字符」——这段每轮都注入，多一个字都是每轮多一个字。
        //
        // ⚠️⚠️ 更关键：**这句话是发给 AI 的，不能用「自己 / 你」来指代玩家角色。**
        //
        // 这套文案里**不出现人称代词**（「你 / 自己」都不用）—— 上面那条原来写着
        // 「计时器会在后续时间点提醒你」，后来也把「你」删掉了。所以早先那版
        // 「不是**自己的**事就加上主体」，AI 读到的意思是
        // 「不是 AI 自己的事」—— 而 AI 在剧情里根本不是任何一个角色，这个所指是空的。
        // 结果要么困惑、要么理解成「反正都不是我的事」→ 给每件都加主体。
        //
        // 现在的写法**完全不引入「自己」这个概念**：只说「牵扯到具体某个人就写名字」。
        // 玩家角色的事带不带名字都行 —— 带上了也不碍事，而不带的那件在提醒里
        // 依然能和别人的区分开（因为别人的都带名字）。少一层需要模型自己对齐的所指。
        '· 事件名要能看出是**谁**的事：牵扯到谁，就把谁的名字写进去（例「提莉静养疗伤」）。',
    ].join('\n');
}

export function renderProtocolText(opts = {}) {
    const tag = primaryTag(opts.tagNames);
    const isCalendar = !!opts.isCalendar;
    const now = opts.nowClock || opts.exampleClock
        || `${(opts.dayLabel || '第{day}天').replace('{day}', '3')} 14:30`;
    /**
     * ⚠️ 这里**故意不给具体时刻**，别顺手加回去。
     *
     * 原来写的是 `isCalendar ? '1247年4月1日 09:00' : '第5天 09:00'`，两个问题：
     *
     * 1. 「到期=」是一条**合法指令** —— 模型照抄过去会真的把事件改到那个时刻，
     *    这不是「格式写错」，是**状态被改**。而这段协议**每轮都注入**，
     *    反复曝光只会加强锚定。测试里本来就有一条原则：「不该有可照抄的具体时间」，
     *    只是原来的正则只守住了以「时间:」开头的行，从「· 时长写法：」这里漏了过去。
     * 2. 那个 1247 年是**写死的常量**，和用户历法的起点（可能正是 1年1月1日）
     *    差了一千多年，摆在同一个协议的「当前剧情时间」下面纯属噪声 ——
     *    模型只会把它当无关内容忽略，连示范格式的作用都起不到。
     *
     * 格式在上面那行「当前剧情时间」里已经示范过了，指过去就够。
     */
    const altExample = '写法同上面的「当前剧情时间」';
    void isCalendar;
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

    // 这一行原来是无条件写死的「原定的期限已经到了」—— 连时钟都没看。
    // 提前量会在这个时点还没真的到之前就触发它，所以必须按真实时钟分流。
    const { whenBlock } = pointStatePhrases('origin', [ev], clock);
    lines.push(`${index}. 《${ev.title}》 ${whenBlock}`);
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
    // 三档，不是两档：加了提前量之后「还没到」也会走到这里，
    // 原来只有「已超时」和「刚刚到点」两个分支 —— 差 6 小时也会说「刚刚到点」。
    const eta = overdue > 0
        ? `（已超时 ${dur(overdue)}）`
        : (overdue === 0 ? '（刚刚到期）' : `（还剩 ${dur(-overdue)}）`);
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
/**
 * 某个时点在**当前这一刻**该说的话 —— 按真实时钟算，**不是按配置算**。
 *
 * 为什么需要它：加了「提前量」之后，一个时点多出**第三种状态** ——
 * 「还没到，但马上就到」。而原来的文案只认识两种状态：
 * 「还没到（所以根本不触发）」和「已经过了（所以这么说）」。
 * 少了那一档，提前触发就只能借用「已经过了」的说法，那是在说假话：
 * AI 会照着在正文里把事件提前了结，倒计时被砍短。
 *
 * 所以这里按真实时钟分流：
 *   时钟 ≥ 时点   → 「已经…」      （一字不改，和没有提前量时完全一样）
 *   时钟 < 时点   → 「马上就要…」  （只可能因为提前量才会走到这里）
 *
 * ⚠️ 一组里混着「已经过」和「还没到」时，**只要有一个已经过就用「已经…」版**：
 * 宁可少说「马上」，也不能说「已经」而其实没到。每条事件自己的
 * 「还剩 X」/「已超时 X」会把精确信息补上。
 *
 * @returns {{when: string, whenBlock: string}} 前者填段首，后者填事件块
 */
function pointStatePhrases(point, group, clock) {
    const nowAbs = clockToAbs(clock);
    const list = Array.isArray(group) ? group : [];

    /** 某条事件的那个时点是不是**真的**已经到了 */
    const reached = (ev) => {
        if (point === 'due') return nowAbs >= clockToAbs(ev.dueClock);
        if (point === 'origin') {
            // 优先用这一轮提醒锚定的那个旧期限；没有就退回最早的那个
            const anchor = Number(ev.reminderOriginAbs);
            const histories = (ev.dueHistory ?? []).map((c) => clockToAbs(c)).filter((n) => Number.isFinite(n));
            const abs = Number.isFinite(anchor) && anchor > 0 ? anchor : Math.min(...histories);
            return Number.isFinite(abs) && nowAbs >= abs;
        }
        return true; // mid / late 没有这种断言，走哪个分支都一样
    };

    const passed = list.length === 0 || list.some(reached);

    if (point === 'origin') {
        return passed
            ? {
                when: '**过了原定的期限还没有结束**',
                whenBlock: '**原定的期限已经到了，但它还没有结束。**',
            }
            : {
                when: '**马上就要过原定的期限了**',
                whenBlock: '**这一轮结束时就会过原定期限，现在还没到。**',
            };
    }
    if (point === 'due') {
        return passed
            ? { when: '已经到达预定的完成时间', whenBlock: '' }
            : { when: '马上就要到达预定的完成时间了', whenBlock: '' };
    }
    return { when: '', whenBlock: '' };
}

function builtinPointParts(point, clock, config, formatClock, tag, { template = false, phrases = null } = {}) {
    const cfg = config?.reminder ?? {};
    const now = template ? '{{time}}' : (fmt(formatClock, clock) || '(未知)');
    // 模板形态留占位符（渲染时才知道该说"已经"还是"马上"）；
    // 渲染形态直接用算好的话。两者必须一字不差，有测试守着。
    const when = template ? '{{when}}' : (phrases?.when ?? '');
    const whenBlock = template ? '{{whenBlock}}' : (phrases?.whenBlock ?? '');
    const head = [pointHeader(tag, point), `当前剧情时间：${now}`];
    const tail = [];

    if (point === 'mid') {
        // 静默：不要求写正文，只要求判断 + 按需调参数
        //
        // ⚠️ 开头这句**不能断言事件还没结束**。
        //
        // 原来写的是「下列事件**仍在进行中**…判断它有没有受到影响」，把"还没完"
        // 写死了。可这一轮的事件有三种可能：还在跑、比预想**提前完成**了、
        // 或者**没结束但会比预定早完**。开头一断言，后两种就没了抓手。
        //
        // 所以改成中性的「由插件持续跟踪」（说的是**插件**在跟，不是事件在跑），
        // 并把关注点落到真正的杠杆上 —— **完成时间**。它变快变慢、或者已经完成，
        // 都落进下面那句「时长=<新的总时长>」里（总时长 = 已过 + 预计还要多久）。
        //
        // ⚠️ 这句话里有四个坑，都是踩过才改的，别顺手改回去：
        //
        // 1. **时间锚点必须是故事层面的。** 原来是「结合**这期间**正文里……」——
        //    「这期间」没有任何参照物，最坏会被读成「最近这一轮」，于是只扫最后
        //    一次对话，把更早发生的变化全漏了。而定期检查点位的排布本身就是
        //    **从事件开始算起**的（见 _midPoints），所以口径应该对齐成
        //    「这些事开始以来」。
        //    ⚠️ 不能写「从事件**登记**到现在」—— 隐藏标签那条正则显示和提示词两边
        //    都过滤，**AI 根本看不到自己写过的 <timer> 标签**，「登记」对它是空指。
        //
        // 2. **头词要盖得住列表。** 原来写「外部**环境**的变化」，可它自己举的例子
        //    里就有「别人的行动」—— 那根本不是"环境"。头词换成了「外部世界」。
        //
        // 3. **列举必须是举例，不能是封闭清单。** 原来那四项（战事、行情、局势、
        //    别人的行动）会锚定模型 —— 遇到「熬制解毒药」这种独处型事件，它把四项
        //    扫一遍发现都没有，就可能直接得出「没有外部变化」。加了「比如」，
        //    并补上原列表里真缺的一项：**天气**。
        //
        // 4. **「变数」要说清是新的。** 事件块里本来就有一行「变数：…」（登记时
        //    声明的），所以「它自身的变数」到底指已声明的那些、还是新冒出来的，
        //    是歧义的。定期检查的价值在后者，所以说成「新冒出来的变数」。
        //    条数也从「它」（单数）统一成了「它们」（底下可能列了好几条）。
        head.push('下列事件由插件持续跟踪。请结合这些事开始以来正文里发生的一切，不管是外部世界的变化（比如战事、行情、天气、别人的行动），还是它们自身新冒出来的变数，判断它们的完成时间有没有变化。');
        tail.push('');
        tail.push('如果参数需要改，用一行「事件~」写下来（**不需要改就什么都不用写，也不要在正文里特意交代它**）：');
        tail.push('  时间要变 → 事件~: <事件名> | 时长=<新的总时长>         （从事件开始算的总时长）');
        tail.push('            事件~: <事件名> | 到期=<新的绝对时间>');
        tail.push('  预期要变 → 事件~: <事件名> | 预期=… | 变数=… | 资源=…');
        // ⚠️ 这句原来是「**按现在的消耗速度，资源够撑到事件结束吗？**」——两个字都有问题：
        //
        // 1. 「撑」自带**匮乏 + 费力**两重意思，预设了这是一场靠资源硬顶的消耗战。
        //    可资源未必会被消耗（「安静的房间」「师父的指点」），事件也未必是苦熬
        //    （「等回信」「筹备婚礼」）。「房间够撑到药熬好吗」根本讲不通。
        // 2. 「按现在的消耗速度」把它写成了**前提**：等于先声明"你的资源正在被烧"。
        //    但那只是一部分事件的形态 —— 和「仍在进行中」「没回来」是同一族毛病：
        //    对事件形态的预设。
        //
        // 现在把「消耗」降级成**条件**：不会被消耗的资源自然走不到"消耗速度"那句。
        // 改的是措辞，问的东西没变（资源够不够）——「重点核对」这个强调留着，
        // 因为资源是最容易被漏掉的那一项。
        tail.push('重点核对：**资源够不够用到事件结束？**（资源栏有数值时；会被消耗的，按现在的消耗速度算）');
    } else if (point === 'late') {
        // ⚠️ 这里**别**顺手改成「到期时」—— 同一句开头已经有「快到期了」，
        // 一个词在一句里出现两次很别扭。「收尾时」说的是同一件事，也不撞。
        // （原来是「到点」，那是 due 时点的旧叫法，已经不用了。）
        head.push('下列事件快到期了。请先做一次**初步结算**：把收尾时要交代的几个方面列出来。');
        tail.push('');
        tail.push('用一行把它写下来（**写在标签区块里，不要写进正文**）。这一步只列「要回答哪几个方面」，不要定结果：');
        tail.push('  事件~: <事件名> | 要点=方面1 / 方面2 / 方面3');
        tail.push('如果此时发现时间也要改，可以一起写：事件~: <事件名> | 要点=… | 时长=<新的总时长>');
    } else if (point === 'origin') {
        head.push(`下列事件${when}。请在正文里体现这件事带来的影响：`);
        // ⚠️ 这行原来写的是「比如旁人的议论、局势的变化、要不要派人去找、要不要另想办法。」
        // —— 明明有「比如」，却还是把事件类型框死了，因为**四个例子全指向同一个方向**：
        //   旁的议论  → 得有围观者（社交/公开性的事件）
        //   局势的变化 → 得是大局/政治类的事件
        //   派人去找  → 得是「有人在外没回来」类的事件
        //   另想办法  → 得有决策者 + 替代方案的事件
        // 「比如」只有在例子**跨越**了空间时才有扩张作用；四个同口味的例子等于没加。
        // 反例一抓一把：「熬制解毒药」拖过期限后是伤没好、药材白费、得重新找药；
        // 「修葺祖宅」是漏得更厉害、工匠加钱、家里没法住 —— 四个例子一个都套不上。
        // 后果是 AI 要么硬套（给独处型事件写出「旁人开始议论」），要么判定「不适用」
        // 什么都不写 —— 而让玩家意识到出岔子正是 origin 唯一的用途。
        //
        // 所以从「四种具体情形」改成「三个维度」：别人 / 局势 / 当事人。
        // ⚠️ 用「当事人」而不是「你自己」—— 这套文案里「你」是称呼 **AI** 的，
        // 「对你自己」会被读成「对 AI 的影响」，是个空指（和「不是自己的事」同一个坑）。
        head.push('比如别人的反应、局势的变化，以及这件事拖下去对当事人的影响。');
        tail.push('');
        tail.push('如果这期间又有新变化，可以再调整：事件~: <事件名> | 时长=<新的总时长> | 预期=…');
    } else {
        head.push(`下列事件${when}，请在正文里交代它们的结果：`);
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
        /**
         * ⚠️ 这一行有四个坑，全踩过：
         *
         * 1. **原来是「计时器会自己收掉这件事」** —— 「收掉」不只是含糊，是**误导**：
         *    它偏「拿走 / 清掉」，而实际上归档之后事件**不删**，它进面板的
         *    「已结束（N）」折叠区、显示成「已完成 / 已取消」。现在用的
         *    「归到「已结束」里」就是面板上那个分区名，两边看到的是同一个词。
         *
         * 2. **「自己」不能用。** 这套文案里「自己 / 你」有专门指代 AI 的风险
         *    （「不是自己的事就加上主体」那次就是栽在这上面）。这里虽然没有歧义，
         *    但没必要冒这个险 —— 整个句子改成不带人称的写法。
         *
         * 3. **⚠️⚠️ 必须是条件句。** 上一句刚说「还可以现在改：事件~: 时长=…」，
         *    如果这句无条件地说「回应之后就会归到已结束」，两句话就打架了 ——
         *    而最可能的后果不是"AI 以为一定会结束"，是**它觉得延长没意义、于是不敢延长**。
         *    而延期恰恰是这条提醒给它的唯一出口（到点了要么交代结果、要么申请延期）。
         *    「如果不再延长」把这个出口保住了，反而是在提醒它还有一次选择。
         *
         * 4. **不用写「什么时候」。** 时机由上一句的「也可以**现在**改」兜住了 ——
         *    多描述一层就多一个歧义点（「本次之后」到底指本次什么？），所以直接不提。
         *
         * 机制是可验证的（有测试守着）：到点后延长 → 状态回到 pending、不被归档、
         * 之后还会按新的到期时间再提醒；不延长 → 回应之后 resolved。
         */
        tail.push('（交代完就够了，不需要写结束标记。如果不再延长，计时器就会把它归到「已结束」里。）');
    }

    tail.push(REMINDER_FOOTER);
    void cfg;
    return { head, tail };
}

/** 每个时点的内置文案（模板为空时用它） */
function builtinPointText(point, list, clock, config, formatClock, tag) {
    const cfg = config?.reminder ?? {};
    const phrases = pointStatePhrases(point, list, clock);
    const { head, tail } = builtinPointParts(point, clock, config, formatClock, tag, { phrases });
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
                // {{when}} / {{whenBlock}}：同样是**按真实时钟**算的时态短语 ——
                // 存档里的模板可能还是旧的（没有这两个占位符），那就保持原样，
                // 所以不指望用户一定迁移过。
                const phrases = pointStatePhrases(point, group, clock);
                parts.push(interpolate(custom, {
                    time,
                    events: blocks,
                    tag,
                    extra: { overdueHint, when: phrases.when, whenBlock: phrases.whenBlock },
                }));
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
