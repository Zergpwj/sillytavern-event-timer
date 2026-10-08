/**
 * 设置面板 —— 挂到酒馆的 `#extensions_settings2`（扩展设置区）。
 *
 * 用原生 DOM 拼装，不依赖 Handlebars 模板，也不占用任何全局变量。
 */

import { h, append, clear } from './dom.js';
import { openModal } from './modal.js';
import { localizeDom } from './i18n.js';
import { DEFAULT_UNITS } from '../core/time-lexer.js';
import { CALENDAR_PRESETS, normalizeDateFormat } from '../core/calendar.js';
import { renderProtocolText } from '../core/reminder.js';
import { GLOBAL_PROFILE_ID, describeProfile } from '../core/profiles.js';
import {
    openCalendarWizard,
    openDateFormatEditor,
    openMonthNameEditor,
    openPromptEditor,
    openPromptExport,
    openPromptImport,
} from './editors.js';

/**
 * 闰年的几种常见档位。
 *
 * 原来只给一个 `4/100/400/2` 的输入框，对"我这一年 360 天、没有闰年"的人来说
 * 那四个数字毫无意义还不得不填。改成选档位，只有「自定义」才展开细节。
 */
const LEAP_PRESETS = [
    ['none', '无闰年（一年长度固定）', { every: 0, skip: 0, unless: 0, month: 1 }],
    ['gregorian', '公历式：4 年一闰，百年不闰，四百年再闰', { every: 4, skip: 100, unless: 400, month: 2 }],
    ['simple', '简单式：每 4 年一闰', { every: 4, skip: 0, unless: 0, month: 2 }],
    ['custom', '自定义…', null],
];

/**
 * 当前的闰年设置属于哪一档。
 *
 * ⚠️「自定义」必须是个**记下来的状态**，不能靠数值反推 ——
 * 用户选「自定义…」时数值往往还没改（还是公历那套 4/100/400），
 * 只看数值的话它会被判回「公历式」，下面的细节永远展不开。
 */
function leapKind(cal) {
    if (cal?.leapMode === 'custom') return 'custom';
    const every = Number(cal?.leap?.every) || 0;
    const skip = Number(cal?.leap?.skip) || 0;
    const unless = Number(cal?.leap?.unless) || 0;
    if (!every) return 'none';
    if (every === 4 && skip === 100 && unless === 400) return 'gregorian';
    if (every === 4 && !skip && !unless) return 'simple';
    return 'custom';
}

/** 当前实际生效的每月天数（自定义优先，否则取预设） */
function effectiveMonths(cal) {
    if (Array.isArray(cal?.months) && cal.months.length) return cal.months.map(Number);
    const preset = CALENDAR_PRESETS[cal?.preset] ?? CALENDAR_PRESETS.gregorian;
    return (preset?.months ?? Array(12).fill(30)).map(Number);
}

/** 把每月天数调整到 n 个月：多了截断，少了按"最常见的那一个"补齐 */
function resizeMonths(months, n) {
    const src = months.length ? months : [30];
    const out = src.slice(0, n);
    const counts = new Map();
    for (const m of src) counts.set(m, (counts.get(m) ?? 0) + 1);
    let fill = src[src.length - 1];
    let best = 0;
    for (const [value, count] of counts) if (count > best) { best = count; fill = value; }
    while (out.length < n) out.push(fill);
    return out;
}

/** 月名数组跟着月份数走 */
function resizeNames(names, n) {
    const out = (Array.isArray(names) ? names : []).slice(0, n).map((x) => String(x ?? ''));
    while (out.length < n) out.push('');
    return out;
}

/**
 * 日期格式的常用写法。
 *
 * ⚠️ 这只是**快捷填空**，不是穷举。占位符一共十几个（年月日 + 月名 + 时辰 + 时分…），
 * 预设不可能覆盖所有组合，所以选完之后下面那个模板输入框**仍然可以改**。
 */
const DATE_FORMAT_PRESETS = [
    ['{era}{year}年{month}月{day}日', '中文年月日（1247年3月15日）'],
    ['{era}{year}年{month}月{day}日 {hour}:{minute}', '中文年月日 + 时间（1247年3月15日 14:30）'],
    ['{year}-{month}-{day}', '年月日（1247-3-15）'],
    ['{year}-{month}-{day} {hour}:{minute}', '年月日 + 时间（1247-3-15 14:30）'],
    ['{year}年{monthName}{day}日', '用月名（1247年春月15日）'],
    ['{month}/{day}/{year}', '西式（3/15/1247）'],
    ['{monthName}{day}日', '只要月日（春月15日）'],
];

const DEFAULT_DATE_FORMAT = '{era}{year}年{month}月{day}日';

/**
 * 门槛类时长输入用的单位表。
 *
 * ⚠️ **故意没有「月」** —— 这个插件的历法里一个月可能是 28/30/31 天，
 * 也可能是自定义的「600 天一年、每月 30 天」，说「1 个月」没有确定长度。
 * 想按月表达就自己在数字上换算成天。
 *
 * 顺序即「从大到小」，`pickThresholdUnit()` 依赖这个顺序挑最大能整除的单位。
 */
const THRESHOLD_UNITS = [
    ['week', '周', 7 * 1440],
    ['day', '天', 1440],
    ['hour', '小时', 60],
    ['minute', '分钟', 1],
];

/** 把分钟数拆成「数字 + 最合适的单位」；0 就用分钟 */
function pickThresholdUnit(minutes) {
    const m = Math.max(0, Number(minutes) || 0);
    if (m > 0) {
        for (const [key, , size] of THRESHOLD_UNITS) {
            if (m % size === 0) return [key, m / size];
        }
    }
    return ['minute', m];
}

/** 当前模板命中哪个预设；都不像就返回 'custom' */
function dateFormatKind(format) {
    const f = String(format ?? '');
    return DATE_FORMAT_PRESETS.some(([v]) => v === f) ? f : 'custom';
}

export class SettingsUI {
    /**
     * @param {import('../app.js').TimerApp} app
     */
    constructor(app) {
        this.app = app;
        this.root = null;
        this.collapsed = true;
        /**
         * 展开着的分节标题。默认只展开「总开关」。
         *
         * 记在内存里是**必须**的：render() 每次状态变化都会把整个 body 清空重建，
         * 不记的话在「高级」里改一个设置，它当场就自己合上了。
         */
        this._openSections = new Set(['总开关']);
        this._unsubscribe = null;
    }

    /**
     * @param {HTMLElement} container 一般是 #extensions_settings2
     */
    mount(container) {
        if (!container || this.root) return false;

        // 用酒馆**标准**的 inline-drawer 结构。
        //
        // 关键是头部那个 `inline-drawer-toggle`：酒馆有一条全局委托
        // （public/script.js:12131）会接管它的点击，做 slideToggle 动画、
        // 并自己切换图标的 down/up。我们之前漏了这个类，只能手写 toggle，
        // 于是展开是硬切、没有动画，图标也和别家的不一样 —— 整体看着就不像一路的。
        //
        // 图标也必须是**一个** `fa-circle-chevron-down`：酒馆的办法是给它换
        // down/up + fa-circle-chevron-down/up 两组类来旋转，放两个图标它那套就不成立了。
        const drawer = h('div.st-timer-settings.inline-drawer');
        const head = h('div.inline-drawer-toggle.inline-drawer-header.st-timer-settings__head', [
            h('b', '⏱ 事件计时器'),
            h('div.inline-drawer-icon.fa-solid.fa-circle-chevron-down.down'),
        ]);
        const body = h('div.inline-drawer-content.st-timer-settings__body');

        append(drawer, [head, body]);
        container.appendChild(drawer);

        this.root = drawer;
        this.body = body;
        // 初始那一帧也要走同一个方法 —— 图标和内容是两种状态，必须一起设，
        // 否则会出现「内容展开着、箭头还朝下」这种对不上的样子
        this.setCollapsed(this.collapsed);

        this.render();
        this._unsubscribe = this.app.subscribe(() => this.render());
        return true;
    }

    /**
     * 只用来设置**初始**折叠状态和程序化展开（面板上的 ⚙ 按钮）。
     *
     * 用户的点击**不经过这里** —— 那是酒馆的全局处理器在管。
     * 所以这里显示的写法要和它保持一致，否则图标会和内容对不上。
     */
    setCollapsed(collapsed) {
        this.collapsed = !!collapsed;
        if (!this.root || !this.body) return;
        this.body.style.display = this.collapsed ? 'none' : 'block';
        this.root.classList.toggle('is-collapsed', this.collapsed);
        const icon = this.root.querySelector?.('.inline-drawer-icon');
        if (icon) {
            icon.classList.toggle('down', this.collapsed);
            icon.classList.toggle('up', !this.collapsed);
            icon.classList.toggle('fa-circle-chevron-down', this.collapsed);
            icon.classList.toggle('fa-circle-chevron-up', !this.collapsed);
        }
    }

    unmount() {
        this._unsubscribe?.();
        this.root?.remove();
        this.root = null;
    }

    render() {
        if (!this.body) return;
        const app = this.app;
        const cfg = app.config;

        /**
         * ⚠️ 先在**游离的容器**里把整棵树建好，成功了再一次性换上去。
         *
         * 原来是一边 clear(this.body) 一边 append —— 中间任何一步抛错，面板就只剩一个
         * 空壳，看起来就是「整个扩展一起关闭了」。而 notify() 又把异常吞进 console
         * （它是 try / catch / console.error），所以界面上一点提示都没有，
         * 只有翻控制台才知道出了事。
         *
         * 现在：建树失败就**原样保留上一次的内容**，并把错误直接显示在面板上。
         */
        try {
            const next = h('div.st-timer-settings__render');
            // 分节顺序按「用的频率」排：常用的在上面，设一次就不动的收进「高级」。
            // 除了总开关，全部默认收起 —— 要哪一节点开哪一节。
            //
            // 每一节都拆成了独立方法，顺序看这一段就够了。
            append(next, [
                this.sectionMaster(),
                this.sectionTimeBase(cfg),
                this.sectionReminder(cfg),
                this.sectionAdvance(cfg),
                this.sectionPrompts(),
                this.sectionProfiles(),
                this.sectionUi(cfg),
                this.group('高级', [
                    this.sectionParsing(cfg),
                    this.sectionInjection(cfg),
                    this.sectionUnits(cfg),
                    this.sectionData(),
                ]),
            ].filter(Boolean));

            // 整棵树建好了才动真实的面板
            clear(this.body);
            while (next.firstChild) this.body.appendChild(next.firstChild);
            // 面板是每次改动都重建的，酒馆自己的 applyLocale 管不到，自己翻一遍
            localizeDom(this.body);
        } catch (err) {
            console.error('[event-timer] 界面刷新失败', err);
            this.showRenderError(err);
        }
    }

    /**
     * 渲染失败时把错误**显示在面板上**。
     *
     * 以前只有一行 console.error，界面上留个空白面板 —— 用户既不知道该干什么，
     * 也不知道该把什么发给作者。现在直接把消息和调用栈摆在最前面。
     */
    showRenderError(err) {
        for (const el of this.body.querySelectorAll?.('.st-timer-settings__error') ?? []) el.remove();
        const box = h('div.st-timer-settings__error', [
            h('b', '设置面板渲染失败（其它功能不受影响）'),
            h('div.st-timer-settings__error-msg', String(err?.message ?? err)),
            h('div', '请把这一整块发给作者。也可以先按 Ctrl + F5 强制刷新一次试试。'),
            h('pre.st-timer-settings__error-stack', String(err?.stack ?? '（没有调用栈）')),
        ]);
        this.body.prepend(box);
    }

    // ───────────────────────── 各分节 ─────────────────────────

    /** 总开关：唯一默认展开的一节 */
    sectionMaster() {
        const app = this.app;
        return this.section('总开关', [
            this.checkbox('启用事件计时器', app.config.enabled, (v) => {
                app.updateConfig({ enabled: v });
                app.refreshInjection({ commit: false });
            }),
        ]);
    }

    sectionTimeBase(cfg) {
        const app = this.app;
        return this.section('时间基准', [
            this.row('时间制式', this.select([
                ['counter', '计数制：第 N 天（适合不说日期的世界）'],
                ['calendar', '日历制：年月日（1247年3月15日，更常见）'],
            ], cfg.time.mode, (v) => {
                app.updateConfig({ time: { mode: v } });
                // 切换制式后，旧的天序号在新制式里没有意义 → 直接按新制式的起始值重置
                app.engine.resetInitialClockToBase();
                app.rebuild({ reason: 'time-mode' });
            }, '')),

            ...(cfg.time.mode === 'calendar'
                ? this.calendarRows(cfg)
                : this.counterRows(cfg)),

            // ── 日期与时间格式 ──
            // 原来单独一节。并进来的理由：它和「用哪种历法」是同一件事的两面 ——
            // 选历法决定年月日怎么算，格式决定它怎么写出来。分两节会让人来回找。
            ...this.formatRows(cfg),

            // ── AI 推断历法 ──
            // 原来也单独一节，还带四行说明。那几行全删了 —— 按钮名字自己就说清了
            // 它干什么，「当前后端」这类信息在向导里本来就有。
            h('div.st-timer-settings__buttons', [
                this.button('AI 推断历法', () => openCalendarWizard(app), 'st-timer-btn--primary'),
            ]),
        ]);
    }

    /**
     * 「提前量」—— 单独一节，四个时点各一个。
     *
     * 为什么单独成节而不是塞进「提醒」：它是**一组对四个时点统一生效**的参数，
     * 语义上也不一样 —— 「提醒」那一节回答「什么时候打扰 AI」，
     * 这一节回答「怎么补插件天生的那一轮延迟」。塞在一起会让人以为
     * 提前量和 lateAt / checkEveryDays 是同一类东西。
     *
     * 四个格子都是「天 + 小时」，和「检查间隔」同一套控件；
     * 存进去的是**分钟**（advance 的单位），两者之间换算一下。
     */
    sectionAdvance(cfg) {
        const app = this.app;
        const adv = cfg.reminder.advance ?? {};
        const row = (key, label, hint) => this.row(label, this.dayHourInput((Number(adv[key]) || 0) / 1440, (days) => {
            const next = { ...(app.config.reminder.advance ?? {}) };
            next[key] = Math.max(0, Math.round((Number(days) || 0) * 1440));
            app.updateConfig({ reminder: { advance: next } });
        }), hint);

        return this.section('提前量', [
            this.row('说明', h('div.st-timer-settings__hint', '插件是看完上一轮的正文才知道现在几点的，所以每个时点天生慢一轮：这一轮正文写到了那个时间，下一轮才会提醒。下面填的提前量就是补这一轮，填 0 就是不提前（和以前一样）。填多少取决于你一轮通常推进多少剧情时间，靠手感调。'), ''),
            row('mid', '定期检查', '比原定位置早这么多就去看一眼（这个时点不产出正文，提前没有副作用）'),
            row('late', '即将结束', '比原定位置早这么多就开始列要点'),
            row('origin', '预定终点（旧）', '比原定的期限早这么多就提醒「马上就要超期了」（措辞会自动换成将来时）'),
            row('due', '预定终点（现）', '比到期早这么多就提醒「马上就要到期了」，好让结果落在预定的那一轮里'),
        ]);
    }

    /**
     * 「提醒」—— 把原来的「提醒时点」和「时长门槛」合成一节。
     *
     * 两者回答的是同一个问题：「什么时候、因为多长的事，去打扰 AI」。
     * 拆成两节会让人以为门槛是另一码事。
     */
    sectionReminder(cfg) {
        const app = this.app;
        const custom = (cfg.reminder.mode ?? 'checkpoints') === 'custom';
        const everyTurn = !!cfg.reminder.points?.everyTurn;

        return this.section('提醒', [
            this.info('以固定期限提醒 AI 关注事件，为事件的演化与按实结算提供驱动力。'),
            this.row('提醒方式', this.select([
                ['checkpoints', '定期检查 + 即将结束 + 预定终点（旧）+ 预定终点（现）（推荐）'],
                ['once', '只在预定终点（现）时提醒一次'],
                ['custom', '自定义时点'],
            ], cfg.reminder.mode ?? 'checkpoints', (v) => {
                app.updateConfig({ reminder: { mode: v } });
            })),

            ...(custom ? [
                this.checkbox('定期检查：世界有没有变化牵扯到它（静默，只调参数）', cfg.reminder.points?.mid === true, (v) => {
                    app.updateConfig({ reminder: { points: { mid: v } } });
                }),
                this.checkbox('即将结束：初步结算，列一份「要点」清单（静默）', cfg.reminder.points?.late === true, (v) => {
                    app.updateConfig({ reminder: { points: { late: v } } });
                }),
                this.checkbox('预定终点（旧）：事情拖长了，让正文体现出来', cfg.reminder.points?.origin === true, (v) => {
                    app.updateConfig({ reminder: { points: { origin: v } } });
                }),
                this.checkbox('预定终点（现）：在正文里交代结果', cfg.reminder.points?.due !== false, (v) => {
                    app.updateConfig({ reminder: { points: { due: v } } });
                }),
                this.checkbox('预定终点（现）之后每轮都提醒（会一直催到事件被收掉）', everyTurn, (v) => {
                    app.updateConfig({ reminder: { points: { everyTurn: v } } });
                }),
                // ⚠️ 这两项只在「每轮都提醒」打开时才有意义。
                // 以前无论开不开都摆在界面上 —— 在推荐档下它们是彻底失效的，
                // 改了什么都不发生，只会让人以为坏了。
                ...(everyTurn ? [
                    this.row('同一时点最多提醒几次', this.numberInput(cfg.reminder.maxReminders, (v) => {
                        app.updateConfig({ reminder: { maxReminders: Math.max(0, Number(v) || 0) } });
                    }, '默认 1 = 只提醒一次')),
                    this.row('重复间隔', this.numberInput(cfg.reminder.repeatEveryTurns, (v) => {
                        app.updateConfig({ reminder: { repeatEveryTurns: Math.max(1, Number(v) || 1) } });
                    }, '隔几轮催一次')),
                ] : []),
            ] : []),

            // 定期检查以前是「一个百分比位置」，后来改成「每 N 天一个点位」（见 checkEveryDays）。
            // 输入框现在是「天 + 小时」两格 —— 原来那个「7天」文本框只认单一单位，
            // 「1天12小时」会被静默忽略（详见 dayHourInput 的注释）。
            this.row('检查间隔', this.dayHourInput(cfg.reminder.checkEveryDays, (days) => {
                app.updateConfig({ reminder: { checkEveryDays: Math.max(0, Number(days) || 0) } });
            }), '每多久回头看一眼（从事件开始算起，固定不变）。两格都填 0 = 不要定期检查；事件比这个间隔还短，就只在正中间看一次'),
            this.row('即将结束位置', h('div.st-timer-threshold', [
                this.numberInput(cfg.reminder.lateAt, (v) => {
                    app.updateConfig({ reminder: { lateAt: Math.min(99, Math.max(2, Number(v) || 85)) } });
                }, '85'),
                h('span.st-timer-threshold__suffix', '%'),
            ]), '百分比，例如 85 = 走到 85% 时提醒'),
            // 「单轮最多提醒几个时点」（maxPerTurn）的输入框撤掉了。
            // 它是个**跨事件**的防洪阀：只有一轮里有 5 个以上事件各自有待发时点时才会触发，
            // 摆在常用区纯属噪音。机制留在引擎里（固定 4），免得 10 个事件同时到点时
            // 一次往注入里塞十条提醒、把上下文冲爆。

            this.row('事件认定最低阈值', this.thresholdInput(cfg.reminder.minEventMinutes, (minutes) => {
                app.updateConfig({ reminder: { minEventMinutes: minutes } });
            }), '默认 6 小时。AI 声明了但短于这个时长的事件会被忽略（记进历史，不弹提示）。你手动加的再短也算'),
            this.row('事件提醒最低阈值', this.thresholdInput(cfg.reminder.checkpointMinMinutes, (minutes) => {
                app.updateConfig({ reminder: { checkpointMinMinutes: minutes } });
            }), '默认 3 天。短于这个时长的事件不会收到定期检查 / 即将结束 / 预定终点（旧）提醒，只在预定终点（现）时提醒一次'),
            this.info('低于事件认定阈值则判定为非事件；低于事件提醒阈值则除了终点不会有提醒。设置为 0 就是关闭该阈值。'),

            // ── 提醒内容 ──
            // 原来单独一节。并进来的理由：它回答的还是同一个问题 ——
            // 「什么时候去打扰 AI、打扰时说些什么」。
            this.checkbox('提醒里回显事件的「预期 / 变数 / 资源 / 设定摘要」', cfg.reminder.includeEventDetails !== false, (v) => {
                app.updateConfig({ reminder: { includeEventDetails: v } });
            }),
            this.checkbox('对超时事件加重语气', cfg.reminder.emphasizeOverdue, (v) => {
                app.updateConfig({ reminder: { emphasizeOverdue: v } });
            }),
            this.checkbox('自动教 AI 使用标签协议', cfg.reminder.includeProtocol, (v) => {
                app.updateConfig({ reminder: { includeProtocol: v } });
            }),
        ]);
    }


    sectionPrompts() {
        const app = this.app;
        return this.section('提示词库', [
            h('div.st-timer-settings__row.st-timer-settings__row--left', [this.select(
                app.prompts.map((p) => [p.id, p.name + (p.builtin ? '（内置）' : '')]),
                app.activePrompt.id,
                (v) => app.selectPrompt(v),
            )]),
            h('div.st-timer-settings__buttons', [
                this.button('编辑', () => openPromptEditor(app, app.activePrompt.id)),
                this.button('另存为…', () => {
                    const name = prompt('新提示词的名字：', `${app.activePrompt.name} 副本`);
                    if (name == null) return;
                    app.duplicatePrompt(name);
                }),
                this.button('重命名…', () => {
                    if (app.activePrompt.builtin) {
                        app.host.toast?.('内置那份不能改名', 'warning');
                        return;
                    }
                    const name = prompt('新的名字：', app.activePrompt.name);
                    if (name == null) return;
                    app.renamePrompt(app.activePrompt.id, name);
                }),
                this.button('删除', () => {
                    if (app.activePrompt.builtin) {
                        app.host.toast?.('内置那份不能删', 'warning');
                        return;
                    }
                    if (!confirm(`删除提示词「${app.activePrompt.name}」？`)) return;
                    app.removePrompt(app.activePrompt.id);
                }, 'st-timer-btn--tiny'),
                this.button('新建空白', () => openPromptEditor(app, null)),
                this.button('导出…', () => openPromptExport(app)),
                this.button('导入…', () => openPromptImport(app)),
            ]),
            // 「预览当前会注入的文案」删掉了：聊天记录里的折叠块已经如实显示每一轮注入了什么，
            // 提示词编辑器里也有实时预览 —— 这一份是第三处重复。
        ]);
    }

    sectionProfiles() {
        const app = this.app;
        const activeId = app.config.profiles?.activeId;
        return this.section('配置档案', [
            this.info(`当前角色：${app.host.getCharacterLabel?.() ?? '（未知）'}`),
            this.info(`当前生效：${this.profileName(app, activeId)}`),
            ...(activeId === GLOBAL_PROFILE_ID && app.currentProfileKey()
                ? [this.info('⚠ 你正在编辑「全局默认」设置，没有绑定档案的角色卡都会用它。想让这套设置只属于当前角色，点下面的「为当前角色新建一份…」。')]
                : []),
            this.checkbox('换到新角色卡时自动新建一份档案', app.config.profiles?.autoCreateForCharacter !== false, (v) => {
                app.updateConfig({ profiles: { autoCreateForCharacter: v } });
            }),
            this.row('当前配置', this.select(
                Object.values(app.config.profiles?.items ?? {}).map((p) => [p.id, p.name + (p.builtin ? '（内置）' : '')]),
                activeId,
                (v) => {
                    app.applyProfile(v === GLOBAL_PROFILE_ID ? null : v);
                },
            )),
            h('div.st-timer-settings__buttons', [
                this.button('绑定当前角色到本档案', () => {
                    if (app.bindProfileToCurrentChat(app.config.profiles?.activeId)) {
                        app.host.toast?.('已绑定', 'success');
                        app.notify();
                    }
                }),
                this.button('重命名…', () => {
                    const id = app.config.profiles?.activeId;
                    if (id === GLOBAL_PROFILE_ID) {
                        app.host.toast?.('「全局默认」不能改名', 'warning');
                        return;
                    }
                    const name = prompt('新的名字：', this.profileName(app, id));
                    if (name == null) return;
                    app.renameProfile(id, name);
                }),
                this.button('删除', () => {
                    const id = app.config.profiles?.activeId;
                    if (id === GLOBAL_PROFILE_ID) {
                        app.host.toast?.('「全局默认」不能删除', 'warning');
                        return;
                    }
                    if (!confirm(`删除档案「${this.profileName(app, id)}」？`)) return;
                    app.removeProfile(id);
                }, 'st-timer-btn--tiny'),
            ]),
            // 次要操作收起来 —— 自动新建之后，「手动新建」只剩特殊情况才用得上
            h('details.st-timer-settings__details', [
                h('summary', '次要操作'),
                h('div.st-timer-settings__buttons', [
                    this.button('为当前角色新建一份…', () => {
                        const name = prompt('新档案的名字：', app.host.getCharacterLabel?.() ?? '新档案');
                        if (name == null) return;
                        const profile = app.saveCurrentAsProfile(name);
                        app.bindProfileToCurrentChat(profile.id);
                        app.host.toast?.(`已创建「${profile.name}」并绑定到当前角色`, 'success');
                        app.notify();
                    }),
                    this.button('解绑当前角色', () => {
                        app.bindProfileToCurrentChat(null);
                        app.host.toast?.('已解绑', 'success');
                        app.notify();
                    }),
                ]),
            ]),
            h('details.st-timer-settings__details', [
                h('summary', '查看全部档案与绑定'),
                ...Object.values(app.config.profiles?.items ?? {}).map((p) => h('div.st-timer-settings__hint', [
                    h('strong', p.name),
                    p.builtin ? '（内置）' : '',
                    `　${describeProfile(p.config ?? {})}`,
                    app.profileBindings(p.id).length
                        ? `　绑定：${app.profileBindings(p.id).map((k) => this.friendlyKey(app, k)).join('、')}`
                        : '　未绑定任何角色',
                ])),
            ]),
        ]);
    }

    /**
     * AI 推断历法。
     *
     * ⚠️ 原来这一节里还摆着「用哪个后端 / 接口地址 / 模型名 / API Key / 三个线索开关」——
     * 那些和推断向导里的是**同一批 config 键**（向导那边 `editors.js:385` 也在写
     * `infer.backend` / `infer.custom.*` / `infer.sources.*`），而向导是完整超集
     * （还多一个「用户人设」和「自动套用」）。两处并排只会让人不知道该改哪边。
     */
    sectionUi(cfg) {
        const app = this.app;
        return this.section('界面', [
            this.checkbox('显示常驻悬浮按钮', cfg.ui.showFab, (v) => {
                app.updateConfig({ ui: { showFab: v } });
            }),
            this.checkbox('在聊天记录里显示注入内容（折叠）', cfg.ui.showMessageBlocks !== false, (v) => {
                app.updateConfig({ ui: { showMessageBlocks: v } });
            }),
            this.row('按钮显示内容', this.select([
                ['clock+count', '时间 + 事件数'],
                ['clock', '只显示时间'],
                ['count', '只显示事件数'],
            ], cfg.ui.fabContent, (v) => app.updateConfig({ ui: { fabContent: v } }))),
            this.row('主题', this.select([
                ['auto', '跟随酒馆'],
                ['light', '浅色'],
                ['dark', '深色'],
            ], cfg.ui.theme, (v) => app.updateConfig({ ui: { theme: v } }))),
            this.button('把悬浮按钮复位到右下角', () => {
                app.updateConfig({ ui: { fabPos: { x: 0.88, y: 0.7 } } });
                app.ui?.floating?.applyPosition();
            }),
        ]);
    }

    sectionParsing(cfg) {
        const app = this.app;
        return this.section('解析方式', [
            this.checkbox(`解析 <${(cfg.tagNames || ['timer'])[0]}> 标签协议`, cfg.parse.tags, (v) => {
                app.updateConfig({ parse: { tags: v } });
            }),
            this.checkbox('没有标签时用正则扫正文兜底', cfg.parse.narrative, (v) => {
                app.updateConfig({ parse: { narrative: v } });
            }),
            this.checkbox('即使有标签也用正则再扫一遍', cfg.parse.narrativeWhenTagged, (v) => {
                app.updateConfig({ parse: { narrativeWhenTagged: v } });
            }),
            this.row('标签名', this.textInput((cfg.tagNames || []).join(', '), (v) => {
                const names = v.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
                if (names.length) app.updateConfig({ tagNames: names });
            }, '多个用逗号分隔')),
        ]);
    }

    sectionInjection(cfg) {
        const app = this.app;
        return this.section('注入方式', [
            this.row('写入模式', this.select([
                ['hidden', '隐形注入（聊天记录里看不到，推荐）'],
                ['prefill', '可见：填进输入框，你自己确认后发送'],
                ['both', '两者都做'],
            ], cfg.injection.mode, (v) => app.updateConfig({ injection: { mode: v } }))),
            this.row('插入位置', this.select([
                ['1', '对话内（按深度插入，推荐）'],
                ['0', '故事字符串之后'],
                ['2', '故事字符串之前'],
            ], String(cfg.injection.position), (v) => app.updateConfig({ injection: { position: Number(v) } }))),
            this.row('插入深度', this.numberInput(cfg.injection.depth, (v) => {
                app.updateConfig({ injection: { depth: Math.max(0, Number(v) || 0) } });
            }, '0 = 最后一条消息之后')),
            this.row('以谁的身份', this.select([
                ['0', 'system（旁白，最不干扰角色）'],
                ['1', 'user'],
                ['2', 'assistant'],
            ], String(cfg.injection.role), (v) => app.updateConfig({ injection: { role: Number(v) } }))),
            this.checkbox('让注入内容参与世界书扫描（scan）', cfg.injection.scan, (v) => {
                app.updateConfig({ injection: { scan: v } });
            }),
        ]);
    }

    sectionUnits(cfg) {
        const app = this.app;
        const builtin = Object.entries(DEFAULT_UNITS)
            .map(([k, v]) => `${k}=${v}`)
            .join('　');
        return this.section('自定义时长单位', [
            this.info('同名会覆盖内置值。下面只列你改过或新增的。'),
            ...this.unitRows(),
            this.row('新增单位', this.textInput('', (v) => {
                const m = v.match(/^\s*(\S+)\s*[=＝:：]\s*(\d+(?:\.\d+)?)\s*$/);
                if (!m) return;
                const units = { ...cfg.time.units, [m[1]]: Number(m[2]) };
                app.updateConfig({ time: { units } });
            }, '写法：单位=分钟，回车生效')),
            // 内置单位原来是看不见的 —— 用户不知道「刻」「一炷香」是不是已经有了，会重复添加
            h('details.st-timer-settings__details', [
                h('summary', `查看 ${Object.keys(DEFAULT_UNITS).length} 个内置单位`),
                h('div.st-timer-settings__hint', builtin),
            ]),
        ]);
    }

    sectionData() {
        const app = this.app;
        return this.section('数据', [
            this.info(`当前剧情时间 ${app.engine.formatClock()} · 第 ${app.engine.turns} 轮 · ${app.engine.events.length} 个事件`),
            h('div.st-timer-settings__buttons', [
                this.button('从聊天记录重算', () => app.rebuild({ reason: 'settings' })),
                this.button('自检：检查注入状态', () => this.openDiagnostics()),
                this.button('清空本场聊天数据', () => {
                    if (!confirm('清空后本场聊天的时间线与事件会重新从聊天记录推演，手动添加的事件会丢失。继续？')) return;
                    app.resetAll();
                }),
                this.button('导出设置', () => this.exportJson(app.config, 'event-timer-settings.json')),
                this.button('导出本场数据', () => this.exportJson(app.engine.serialize(), 'event-timer-chat.json')),
            ]),
            h('div.st-timer-settings__hint', `宿主：${app.host.label}（${app.host.kind}）`),
        ]);
    }

    /** 计数制的设置项 */
    counterRows(cfg) {
        return [
            this.row('初始天数', this.numberInput(cfg.time.startDay, (v) => {
                this.app.updateConfig({ time: { startDay: Number(v) || 1 } });
            })),
            this.row('初始时刻', this.textInput(minutesToHhmm(cfg.time.startMinute), (v) => {
                const m = hhmmToMinutes(v);
                if (m != null) this.app.updateConfig({ time: { startMinute: m } });
            }, '例如 08:00')),
            this.row('日期标签', this.textInput(cfg.time.dayLabel, (v) => {
                this.app.updateConfig({ time: { dayLabel: v || '第{day}天' } });
            }, '用 {day} 代表天数')),
        ];
    }

    /** 日历制的设置项 */
    calendarRows(cfg) {
        const app = this.app;
        const cal = cfg.time.calendar || {};
        /**
         * **实际生效**的日历。
         *
         * 不能只看 cfg.time.calendar —— 闰年和日期格式这两项现在是 null，
         * 真正的值由「历法预设」提供（createCalendar 里是 `cfg.leap ?? preset.leap`）。
         * 拿原始配置去判断，选了「简化历」也会显示成公历式的闰年。
         */
        const live = app.engine.formatter?.calendar ?? cal;
        const leap = live.leap ?? { every: 0, skip: 0, unless: 0, month: 1 };
        const start = cal.startDate || { year: 1, month: 1, day: 1, hour: 8, minute: 0 };

        return [
            this.row('历法预设', this.select([
                ['gregorian', '公历（可推真实年月日，带闰年）'],
                ['simple365', '简化历（12 个月 × 30 天，无闰年）'],
                ['', '完全自定义（在下面自己填）'],
            ], cal.preset ?? 'gregorian', (v) => {
                if (!v) {
                    // 「完全自定义」= 就停在**现在这套**上，往下自己改。
                    //
                    // ⚠️ 必须把当前实际生效的值落成显式配置。只把 preset 置空是不够的：
                    // preset 一旦为空，每月天数和闰年会掉回 createCalendar 的公历兜底值 ——
                    // 从「简化历」切过来会当场变成公历（12 × 30 → 31/28/31…）。
                    const live = app.engine.formatter.calendar;
                    app.updateConfig({
                        time: {
                            calendar: {
                                preset: null,
                                months: [...live.months],
                                leap: { ...live.leap },
                                format: live.format,
                                // 月名一个字都不动 —— 那是用户手填的资产
                            },
                        },
                    });
                } else {
                    // 选某个预设 = 要它那一整套：每月天数、闰年都跟着预设走
                    // （置 null 让 createCalendar 回落到预设的值）。
                    // 月名和日期格式保留。
                    app.updateConfig({
                        time: { calendar: { preset: v, months: null, leap: null, leapMode: null } },
                    });
                }
                app.engine.resetInitialClockToBase();
                app.rebuild({ reason: 'calendar-preset' });
            })),
            this.row('起始日期', this.textInput(formatDateInput(start), (v) => {
                const parsed = parseDateInput(v);
                if (!parsed) return;
                app.updateConfig({ time: { calendar: { startDate: { ...start, ...parsed } } } });
                app.engine.resetInitialClockToBase();
                app.rebuild({ reason: 'start-date' });
            }, '例如 1247-03-15 或 1247年3月15日')),
            this.row('纪元前缀', this.textInput(cal.era ?? '', (v) => {
                app.updateConfig({ time: { calendar: { era: v } } });
            }, '例如「帝国历」，会拼在年份前')),
            this.row('每年月数', this.textInput(
                String(effectiveMonths(cal).length),
                (v) => {
                    const n = Math.max(1, Math.min(60, Math.floor(Number(v) || 0)));
                    if (!n) return;
                    app.updateConfig({
                        time: {
                            calendar: {
                                months: resizeMonths(effectiveMonths(cal), n),
                                monthNames: resizeNames(cal.monthNames, n),
                            },
                        },
                    });
                    app.engine.resetInitialClockToBase();
                    app.rebuild({ reason: 'months-per-year' });
                },
                '有的世界观一年不是 12 个月。改了之后「每月天数」和「月名」都会跟着变成这么多格',
            )),
            this.row('每月天数', this.textInput(
                Array.isArray(cal.months) && cal.months.length ? cal.months.join(', ') : '',
                (v) => {
                    const parsed = String(v).split(/[,，\s]+/)
                        .map((x) => Number(x))
                        .filter((n) => Number.isFinite(n) && n > 0);
                    if (!parsed.length) return;
                    const count = effectiveMonths(cal).length;
                    // 只填一个数 = 每个月都一样；填够 N 个 = 逐月指定
                    const months = parsed.length === 1
                        ? Array(count).fill(parsed[0])
                        : resizeMonths(parsed, count);
                    app.updateConfig({ time: { calendar: { months } } });
                    app.engine.resetInitialClockToBase();
                    app.rebuild({ reason: 'months' });
                },
                '留空用预设。填一个数就是每月都一样（例：30）；也可以逐月写（例：31,28,31,30,…）',
            )),
            this.row('闰年', this.select(
                LEAP_PRESETS.map(([key, label]) => [key, label]),
                leapKind(live),
                (v) => {
                    if (v === 'custom') {
                        // 只是要把下面的细节展开，闰年数值本身不动
                        app.updateConfig({ time: { calendar: { leapMode: 'custom' } } });
                        return;
                    }
                    const def = LEAP_PRESETS.find(([key]) => key === v)?.[2];
                    if (!def) return;
                    app.updateConfig({
                        time: {
                            calendar: {
                                leap: { ...def, month: Math.min(effectiveMonths(cal).length, def.month) },
                                leapMode: null,
                            },
                        },
                    });
                    app.rebuild({ reason: 'leap' });
                },
            ), '「闰年」就是某一年多出一天。你的世界没有这个概念就选「无闰年」'),
            ...(leapKind(live) === 'custom' ? [
                this.row('闰年 · 每 N 年一闰', this.textInput(String(leap.every), (v) => {
                    const n = Math.max(0, Math.floor(Number(v) || 0));
                    app.updateConfig({ time: { calendar: { leap: { ...leap, every: n } } } });
                    app.rebuild({ reason: 'leap' });
                }), '填 0 = 没有闰年'),
                this.row('闰年 · 跳过 N 的倍数年', this.textInput(String(leap.skip), (v) => {
                    app.updateConfig({ time: { calendar: { leap: { ...leap, skip: Math.max(0, Math.floor(Number(v) || 0)) } } } });
                    app.rebuild({ reason: 'leap' });
                }), '公历里是 100：能被 100 整除的年份不闰。没有这条就填 0'),
                this.row('闰年 · 但 N 的倍数年仍算', this.textInput(String(leap.unless), (v) => {
                    app.updateConfig({ time: { calendar: { leap: { ...leap, unless: Math.max(0, Math.floor(Number(v) || 0)) } } } });
                    app.rebuild({ reason: 'leap' });
                }), '公历里是 400：能被 400 整除的年份还是闰年。没有这条就填 0'),
                this.row('闰年 · 多出的那天加在第几月', this.textInput(String(leap.month), (v) => {
                    const n = Math.max(1, Math.min(effectiveMonths(cal).length, Math.floor(Number(v) || 1)));
                    app.updateConfig({ time: { calendar: { leap: { ...leap, month: n } } } });
                    app.rebuild({ reason: 'leap' });
                }), `公历里是 2（二月 29 日）。你的历法有几个月就填 1 到 ${effectiveMonths(cal).length}`),
                this.info('举个例子：公历的「4 / 100 / 400 / 2」= 每 4 年多一天；但能被 100 整除的年份不多；不过能被 400 整除的年份还是多，多的那天加在 2 月。'),
            ] : []),
            this.row('自定义月名', h('div.st-timer-settings__unitrow', [
                h('span.st-timer-settings__value',
                    (cal.monthNames ?? []).filter(Boolean).length
                        ? `已设置 ${(cal.monthNames ?? []).filter(Boolean).length} 个 / 共 ${effectiveMonths(cal).length} 个月`
                        : '未设置（用数字月份）'),
                this.button('编辑月名…', () => openMonthNameEditor(app)),
            ]), '填了月名之后 AI 就可以直接写「春月」而不是数字月份'),
            this.checkbox('模糊月名匹配（默认关闭）', !!cal.fuzzyMonthNames, (v) => {
                app.updateConfig({ time: { calendar: { fuzzyMonthNames: v } } });
            }),
        ];
    }

    /** 日期 / 时间格式单独成节 —— 它和「用哪种历法」是两件事 */
    /**
     * 日期 / 时间格式。
     *
     * 上面是**预设下拉**：常用写法一键填好，最后一档「自定义…」表示
     * "现在这个模板不属于任何预设"（它是算出来的，不是选出来的）。
     * 下面的模板输入框**始终可编辑** —— 预设覆盖不全，选完还能接着改。
     */
    formatRows(cfg) {
        const app = this.app;
        const cal = cfg.time.calendar || {};
        const isCalendar = cfg.time.mode === 'calendar';
        // 实际生效的格式可能来自预设（cfg.format 现在是 null）
        const live = app.engine.formatter?.calendar ?? cal;

        const rows = [];
        if (isCalendar) {
            const current = live.format || DEFAULT_DATE_FORMAT;
            rows.push(this.row('日期格式', this.select(
                [...DATE_FORMAT_PRESETS.map(([v, label]) => [v, label]), ['custom', '自定义（用下面的模板）']],
                dateFormatKind(current),
                (v) => {
                    // 选「自定义」不改任何东西 —— 模板由下面的输入框决定，重绘一次让它停在这一档
                    if (v === 'custom') {
                        app.notify();
                        return;
                    }
                    app.updateConfig({ time: { calendar: { format: v } } });
                    app.engine.resetInitialClockToBase();
                    app.rebuild({ reason: 'date-format' });
                },
            )));
            // 模板本身不在这儿摊开 —— 点「编辑模板…」进弹窗（和「自定义月名」一个形态）。
            // 这里只显示**渲染后的样子**：比原始模板短得多，而且一眼就懂。
            rows.push(this.row('格式预览', h('div.st-timer-settings__unitrow', [
                h('span.st-timer-settings__value', app.engine.formatClock(app.engine.clock) || '（空）'),
                this.button('编辑模板…', () => openDateFormatEditor(app)),
            ]), '点「编辑模板…」可以改模板，里面带实时预览和可点的占位符'));
        } else {
            rows.push(this.info('计数制下日期由上面的「日期标签」决定，这里只影响时间的写法。'));
        }

        return rows;
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    /**
     * 自检弹窗：「看不到注入」时先看这里。
     * 关键是「宿主里实际存着」那一行 —— 它回读的是宿主真正保存的注入内容，
     * 而不是我们以为写进去的东西。
     */
    openDiagnostics() {
        const app = this.app;
        const report = h('pre.st-timer-preview__body', app.diagnoseInjection());
        const status = h('div.st-timer-modal__status', { hidden: true });

        openModal({
            title: '注入自检',
            width: 'min(640px, 94vw)',
            build: () => [
                h('div.st-timer-settings__hint',
                    '如果「宿主里实际存着」是空的，说明注入被清掉了（常见于刚切过角色卡或聊天）。点下面的「重新注入」即可。'),
                report,
                status,
            ],
            buttons: [
                { label: '关闭' },
                {
                    label: '重新注入',
                    primary: true,
                    onClick: () => {
                        app.refreshInjection({ commit: false });
                        report.textContent = app.diagnoseInjection();
                        status.hidden = false;
                        status.dataset.kind = 'success';
                        status.textContent = '已重新写入注入。现在再发一轮看看。';
                    },
                },
            ],
        });
    }

    /** 档案名（拿不到 id 就显示「全局默认」） */
    profileName(app, id) {
        if (!id) return '全局默认';
        return app.config.profiles?.items?.[id]?.name ?? id;
    }

    /** 把 'char:alice.png' / 'group:123' 变成好读的文字 */
    friendlyKey(app, key) {
        const current = app.currentProfileKey?.();
        if (key === current) return `${app.host.getCharacterLabel?.() ?? key}（当前）`;
        if (String(key).startsWith('char:')) return String(key).slice(5);
        if (String(key).startsWith('group:')) return `群聊 ${String(key).slice(6)}`;
        if (String(key).startsWith('chat:')) return `对话 ${String(key).slice(5)}`;
        return String(key);
    }

    unitRows() {
        const units = this.app.config.time.units || {};
        const rows = [];
        for (const [unit, value] of Object.entries(units)) {
            rows.push(this.row(unit, h('div.st-timer-settings__unitrow', [
                this.numberInput(value, (v) => {
                    const next = { ...this.app.config.time.units, [unit]: Number(v) || 0 };
                    this.app.updateConfig({ time: { units: next } });
                }),
                this.button('删除', () => {
                    const next = { ...this.app.config.time.units };
                    delete next[unit];
                    this.app.updateConfig({ time: { units: next } });
                }, 'st-timer-btn--tiny'),
            ])));
        }
        return rows;
    }

    // ───────────────────────────── 小部件 ─────────────────────────────

    /** 一个**可折叠**的分节。除了「总开关」，全部默认收起 */
    section(title, children) {
        return this._collapsible(
            'details.st-timer-settings__section',
            title,
            'st-timer-settings__section-title',
            children,
        );
    }

    /** 一组分节（「高级」那种），本身也能折叠 */
    group(title, children) {
        return this._collapsible(
            'details.st-timer-settings__group',
            title,
            'st-timer-settings__group-title',
            children,
        );
    }

    /**
     * 折叠状态为什么存在内存里（_openSections）：
     * render() 每次状态变化都会把整个 body 清空重建，光靠 details 元素自己的
     * open 属性会被重置 —— 你在「高级」里改一个设置，它当场就自己合上了。
     */
    _collapsible(tag, title, titleClass, children) {
        const node = h(tag, { open: this._openSections.has(title) }, [
            h(`summary.${titleClass}`, title),
            h('div.st-timer-settings__body-inner', children.filter(Boolean)),
        ]);
        node.addEventListener('toggle', () => {
            if (node.open) this._openSections.add(title);
            else this._openSections.delete(title);
        });
        return node;
    }

    info(text) {
        return h('div.st-timer-settings__hint', text);
    }

    row(label, control) {
        return h('div.st-timer-settings__row', [
            h('span.st-timer-settings__label', label),
            h('span.st-timer-settings__control', control),
        ]);
    }

    checkbox(label, checked, onChange) {
        const input = h('input', { type: 'checkbox' });
        input.checked = !!checked;
        input.addEventListener('change', () => onChange(input.checked));
        return h('label.st-timer-settings__check', [input, h('span', label)]);
    }

    textInput(value, onChange, placeholder = '') {
        const input = h('input.st-timer-input', { type: 'text', placeholder });
        input.value = value ?? '';
        input.addEventListener('change', () => onChange(input.value));
        return input;
    }

    textarea(value, onChange, rows = 6) {
        const input = h('textarea.st-timer-input', { rows });
        input.value = value ?? '';
        input.addEventListener('change', () => onChange(input.value));
        return input;
    }

    numberInput(value, onChange, placeholder = '') {
        const input = h('input.st-timer-input.st-timer-input--num', { type: 'number', placeholder });
        input.value = value ?? '';
        input.addEventListener('change', () => onChange(input.value));
        return input;
    }

    durationInput(minutes, onChange, placeholder = '') {
        const input = h('input.st-timer-input', { type: 'text', placeholder });
        input.value = formatMinutesToText(minutes);
        input.addEventListener('change', () => {
            const parsed = parseMinutesText(input.value);
            if (parsed == null) return;
            onChange(parsed);
            input.value = formatMinutesToText(parsed);
        });
        return input;
    }

    /**
     * 「数字 + 单位」的时长输入 —— 两个门槛用它。
     *
     * 为什么不用 `durationInput`（一个「7天」文本框）：门槛是拿来**横向比较**的
     *（6 小时 vs 3 天），拆成两个控件之后数值一眼可比，也不会因为单位写错而算错。
     *
     * 单位和数字任一变化都会重新算出分钟数交给 onChange，然后由外层重绘面板 ——
     * 重绘时会用 `pickThresholdUnit()` 挑最合适的单位显示（360 分显示成「6 小时」，
     * 4320 分显示成「3 天」）。
     */
    thresholdInput(minutes, onChange) {
        const [unit, value] = pickThresholdUnit(minutes);
        const num = h('input.st-timer-input.st-timer-input--num', { type: 'number', min: '0' });
        num.value = String(value);
        const sel = this.select(
            THRESHOLD_UNITS.map(([key, label]) => [key, label]),
            unit,
            () => push(),
        );

        const push = () => {
            const size = THRESHOLD_UNITS.find(([key]) => key === sel.value)?.[2] ?? 1;
            const n = Math.max(0, Number(num.value) || 0);
            const next = n * size;
            if (next !== (Number(minutes) || 0)) onChange(next);
        };
        num.addEventListener('change', push);

        return h('div.st-timer-threshold', [num, sel]);
    }

    /**
     * 「天 + 小时」两个输入框 —— 检查间隔用它。
     *
     * 为什么换掉原来那个「7天」文本框：
     *   1. 它的解析器**只认「一个数字 + 一个单位」**（`/^(数字)(单位)$/`），
     *      所以「1天12小时」这种**复合写法会被静默忽略** —— 配置没变，
     *      框里却还留着你打的字，你以为存上了。
     *   2. 三个数字框不可能格式错，这个问题从构造上就没有了。
     *
     * ⚠️ **故意不放「月」**：这个插件的历法里一个月可能是 28/30/31 天，也可能是
     * 自定义的「600 天一年、每月 30 天」—— 说「1 个月」没有确定长度。
     * （底层解析器里 `月` 是被写死成 43200 分钟 = 30 天的，用在这里会骗人。）
     * 要按月表达就自己换算成天填进来。
     *
     * 存进去的仍然是**天数**（可以带小数 ✗ `checkEveryDays`），所以配置格式没变、
     * 不需要迁移 ✓。天和小时都填 0 = 关掉定期检查。
     */
    dayHourInput(days, onChange) {
        const total = Math.max(0, Number(days) || 0);
        const d = Math.floor(total);
        // 用四舍五入到整小时：这个值本来就不需要分钟级精度，
        // 而且界面上只给「天 / 小时」两个框，留小数反而让人以为能填分钟。
        const hr = Math.round((total - d) * 24);

        const makeNum = (value) => {
            const el = h('input.st-timer-input.st-timer-input--num', { type: 'number', min: '0' });
            el.value = String(value);
            return el;
        };
        const dInput = makeNum(d);
        const hInput = makeNum(hr);

        const push = () => {
            const nextDays = Math.max(0, Number(dInput.value) || 0);
            const nextHours = Math.max(0, Number(hInput.value) || 0);
            const next = nextDays + nextHours / 24;
            if (next !== total) onChange(next);
        };
        dInput.addEventListener('change', push);
        hInput.addEventListener('change', push);

        return h('div.st-timer-threshold', [
            dInput,
            h('span.st-timer-threshold__suffix', '天'),
            hInput,
            h('span.st-timer-threshold__suffix', '小时'),
        ]);
    }

    select(options, value, onChange) {
        const el = h('select.st-timer-input');
        for (const [val, label] of options) {
            const opt = h('option', { value: val }, label);
            if (String(val) === String(value)) opt.selected = true;
            el.appendChild(opt);
        }
        el.addEventListener('change', () => onChange(el.value));
        return el;
    }

    button(label, onClick, extraClass = '') {
        return h(`button.st-timer-btn${extraClass ? '.' + extraClass : ''}`, { type: 'button', onclick: onClick }, label);
    }

    exportJson(data, filename) {
        try {
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = h('a', { href: url, download: filename });
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (err) {
            console.error('[event-timer] 导出失败', err);
            this.app.host.toast?.('导出失败', 'error');
        }
    }
}

/** 起始日期的输入框文本 */
function formatDateInput(start) {
    if (!start) return '';
    return `${start.year}-${String(start.month).padStart(2, '0')}-${String(start.day).padStart(2, '0')} ${String(start.hour ?? 0).padStart(2, '0')}:${String(start.minute ?? 0).padStart(2, '0')}`;
}

/** 解析起始日期输入：支持 1247-03-15 14:30 / 1247年3月15日 14:30 */
function parseDateInput(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;

    let m = raw.match(/(-?\d{1,5})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (![year, month, day].every(Number.isFinite)) return null;

    const tod = raw.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
    return {
        year,
        month,
        day,
        hour: tod ? Number(tod[1]) : 0,
        minute: tod ? Number(tod[2]) : 0,
    };
}

function minutesToHhmm(minutes) {
    const total = ((Math.floor(minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function hhmmToMinutes(text) {
    const m = String(text ?? '').match(/(\d{1,2})\s*[:：]\s*(\d{1,2})?/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    return Math.max(0, Math.min(1439, h * 60 + min));
}

function formatMinutesToText(minutes) {
    const value = Number(minutes) || 0;
    if (value === 0) return '0分钟';
    if (value % 1440 === 0) return `${value / 1440}天`;
    if (value % 60 === 0) return `${value / 60}小时`;
    return `${value}分钟`;
}

function parseMinutesText(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return Number(raw);
    const m = raw.match(/^(\d+(?:\.\d+)?)\s*(天|日|小时|钟头|分钟|分|周|个月|月)$/);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2];
    const factor = { 天: 1440, 日: 1440, 周: 10080, 个月: 43200, 月: 43200, 小时: 60, 钟头: 60, 分钟: 1, 分: 1 }[unit];
    return factor ? Math.round(n * factor) : null;
}

export { DEFAULT_UNITS };
