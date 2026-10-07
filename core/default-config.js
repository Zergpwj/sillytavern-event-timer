/**
 * 默认配置。核心引擎与宿主共用一个普通对象，方便整体序列化 / 导入导出。
 */

import { DEFAULT_UNITS } from './time-lexer.js';
import { DEFAULT_TAG_NAMES } from './parser.js';

export const STATE_VERSION = 1;

/** 扩展在酒馆里的命名空间（extension_settings / chatMetadata 的键名） */
export const NAMESPACE = 'story_timer';

export function createDefaultConfig() {
    return {
        /** 总开关 */
        enabled: true,

        /** 识别的标签名 */
        tagNames: [...DEFAULT_TAG_NAMES],

        parse: {
            /** 解析 <计时器> 标签 */
            tags: true,
            /** 没有标签时用正则扫正文 */
            narrative: true,
            /** 即使本轮有标签，也用正则再扫一遍正文 */
            narrativeWhenTagged: false,
            /**
             * 「额外的 LLM 抽取」和「正文时间校正」都已删除。
             *
             * LLM 抽取：标签和正则都没抓到东西时，再发一次请求让模型从散文里猜时间和事件。
             * 正文时间校正：从正文读绝对日期来纠正时钟。
             *
             * 两条都是「插件替 AI 编时间」，而且时间校正还有个具体毛病 —— 它号称
             * 「只认明确日期」，但只要句子里有「今天 / 当天」这类叙述词，后面跟着的
             * 时刻就会被一起应用（「她今天早上就出门了」会把时钟往回推 4 小时）。
             *
             * 现在时间和事件只来自：标签协议、正文里的**时长**表达、用户手动快进。
             */
            /** 单条消息最多接受多少个事件 */
            maxEventsPerMessage: 12,
            /** 正则兜底单条消息最多生成多少个事件 */
            maxRegexEventsPerMessage: 4,
        },

        time: {
            /**
             * 时间基准：
             *   'counter'  —— 计数制，「第 N 天」
             *   'calendar' —— 日历制，「1247年3月15日」
             */
            mode: 'counter',

            /** ── 计数制 ── */
            startDay: 1,
            startMinute: 8 * 60,
            /** 日期标签模板，{day} 会自动替换 */
            dayLabel: '第{day}天',

            /** ── 日历制 ── */
            calendar: {
                /** 预设：gregorian（公历，带闰年）/ simple365（12月×30天，无闰年）；留空 = 完全自定义，用下面的字段 */
                preset: 'gregorian',
                /** 纪元前缀，例如 "帝国历" */
                era: '',
                /** 纪元后缀，一般留空 */
                eraSuffix: '',
                /** 每月天数；为 null 时用预设 */
                months: null,
                /** 可选的自定义月名，长度必须和 months 一致 */
                monthNames: [],
                /**
                 * 闰年规则：每 every 年一次，遇到 skip 的倍数跳过，但 unless 的倍数仍算。
                 *
                 * ⚠️ **这里必须是 null，不能写死公历那套。**
                 *
                 * 原来写的是 `{ every: 4, skip: 100, unless: 400, month: 2 }`，
                 * 于是 `mergeConfig(默认, 存档)` 之后 `cfg.leap` **永远存在**，
                 * `createCalendar` 里那句 `cfg.leap ?? preset?.leap` 就永远拿不到预设的值 ——
                 * 「简化历（无闰年）」实际跑的是公历闰年规则，一年 360 天却每 4 年变 361 天。
                 *
                 * 留 null 之后：预设说了算；没有预设时 `createCalendar` 有最终兜底。
                 */
                leap: null,
                /**
                 * 完整日期模板。同样留 null —— 理由和 leap 一样：
                 * 写死默认值会让预设里的 format 永远轮不到。
                 */
                format: null,
                /** 省略年份时的短模板 */
                shortFormat: '{month}月{day}日',
                daySuffix: '日',
                /**
                 * 模糊月名匹配：开启后「霜月」和「霜之月」互相认得。
                 * 默认关闭 —— 它会让短月名误匹配到长月名（「一月」命中「一月寒」），
                 * 只有当你的月名彼此差异够大时才值得开。
                 */
                fuzzyMonthNames: false,
                /** 本场聊天的起始日期 */
                startDate: { year: 1, month: 1, day: 1, hour: 8, minute: 0 },
            },

            /**
             * 「时间推进控制（试验）」已整个删除。
             *
             * 它是「AI 完全没写时间时，插件自己把时钟往前推一点」。删掉的理由和
             * 之前删掉的 `vagueMinutes`、`LLM 抽取`、`正文时间校正` 是同一条：
             * 插件在替 AI 编时间 —— 猜错了不会报错，只会让时钟以看似合理的速度
             * 偏移，比「时钟卡住」更难察觉。
             *
             * 想快进就用悬浮面板底部的 [+1时] [+1天]：那是显式的，你自己知道拨了多少。
             */

            /** 正则兜底允许的最大时间跳跃（防止误判跳飞剧情） */
            maxJumpMinutes: 7 * 1440,
            /** 任何来源单次允许的最大推进 */
            maxAdvanceMinutes: 3650 * 1440,
            /** 自定义单位（分钟），覆盖内置表 */
            units: {},
        },

        reminder: {
            /**
             * 提醒时点模式。插件在什么时机主动提醒 AI：
             *
             *   'once'        —— 只在「预定终点（现）」提醒一次
             *   'checkpoints' —— 定期检查 + 即将结束 + 预定终点（旧）+ 预定终点（现）（推荐）
             *   'custom'      —— 自己勾选下面 points 里的时点
             *
             * 设计意图：AI 不负责跟踪事件，只在被提醒时回应。什么时候问、问什么，由插件决定。
             */
            mode: 'checkpoints',

            /** mode === 'custom' 时，勾选要启用哪些时点 */
            points: {
                /** 定期检查：给世界一个伸手进来影响它的机会（静默，不写进正文） */
                mid: true,
                /** 即将结束：初步结算，列一份「到预定终点要交代什么」的清单（静默） */
                late: true,
                /**
                 * 预定终点（旧）：事件被延后过，旧的到期时间到了但它还没结束。
                 * 这是唯一一个「让玩家意识到事情出了岔子」的时点。
                 */
                origin: true,
                /** 预定终点（现）：最终结算，写进正文 */
                due: true,
                /** 预定终点（现）之后每轮都提醒（会一直催到事件被收掉） */
                everyTurn: false,
            },

            /**
             * 定期检查：每几天回头看一眼。
             *
             * 从**事件开始**算起固定间隔，所以事件被延长之后已有的点位日期一个都不动，
             * 只在尾部接着往下排。填 0 = 不要定期检查。
             *
             * 以前这里是 `midAt: 50`（一个百分比）。改掉的原因：百分比点位在事件延长后
             * 会整体往后滑，没法表达「每 7 天问一次」这种跟天数挂钩的规律；
             * 而且一个事件只能有一个定期检查，没法在一次事件里出现多次变数。
             */
            checkEveryDays: 7,
            /** 「即将结束」的位置：已用时长占总支出的百分比 */
            lateAt: 85,

            /**
             * 时长门槛（分钟）。
             *
             * 世界节奏差异很大：中世纪工业革命的一个月，和日常向的一下午，
             * 对「什么算值得跟踪的事件」的答案完全不同。所以两个门槛都开放给用户调。
             */
            /** 低于这个时长的事件：不登记，直接忽略（记进历史） */
            minEventMinutes: 6 * 60,
            /** 低于这个时长的事件：只在预定终点（现）提醒一次，不给定期检查 / 即将结束 / 预定终点（旧） */
            checkpointMinMinutes: 3 * 1440,

            /** everyTurn 模式下的重复间隔（轮） */
            repeatEveryTurns: 1,
            /** 同一个时点最多提醒几次（0 = 不限） */
            maxReminders: 1,
            /** 单轮最多提醒多少个时点 */
            maxPerTurn: 4,
            /** 提醒里是否回显事件登记的「预期 / 变数 / 资源 / 设定摘要」 */
            includeEventDetails: true,
            /** 是否把已超时事件按「已超时」语气强调 */
            emphasizeOverdue: true,

            /** 是否附加「记录格式」说明，教 AI 持续输出标签 */
            includeProtocol: true,
        },

        // ───────────────────────── 提示词库 ─────────────────────────
        /**
         * 注入用的提示词。`items` 是全局共享的库；
         * `activePromptId` 放在顶层，所以能被「配置档案」按角色覆盖。
         *
         * 五个字段对应五个提醒时点，`null` 表示「用内置生成的文案」：
         *   protocol —— 记录格式说明（教 AI 怎么写标签）
         *   mid      —— 定期检查（静默，只用来调参数）
         *   late     —— 即将结束的初步结算（静默，产出「要点」清单）
         *   origin   —— 预定终点（旧）（会写进正文）
         *   due      —— 到点最终结算（会写进正文）
         *
         * 可用占位符：{{time}} {{events}} {{count}} {{tag}}
         */
        prompts: {
            items: [
                {
                    id: 'builtin-default',
                    name: '默认提示词',
                    builtin: true,
                    protocol: null,
                    mid: null,
                    late: null,
                    origin: null,
                    due: null,
                    /** 老版本兼容字段，会被迁移进 due */
                    reminder: null,
                },
            ],
        },
        /** 当前生效的提示词 id */
        activePromptId: 'builtin-default',

        // ───────────────────────── 配置档案 ─────────────────────────
        /**
         * 一整套设置的命名快照。绑定到角色卡 / 群聊后，切换对话会自动套用。
         * `baseConfig` 是「没有命中任何绑定」时用的全局设置。
         */
        profiles: {
            activeId: null,
            items: {},
            /** { 'char:<avatar>': profileId, 'group:<id>': profileId } */
            bindings: {},
            baseConfig: null,
            /**
             * 换到没绑定过的角色卡时，自动新建一份档案（从「全局默认」复制）并绑上。
             *
             * 默认开。关掉的话，所有没绑定过的角色卡会**共用「全局默认」**——
             * 在 A 卡上改设置会把 B 卡的也一起改掉。
             *
             * 代价：聊过的卡越多档案越多，而且不会自动清理。
             */
            autoCreateForCharacter: true,
        },

        // ───────────────────────── AI 推断历法 ─────────────────────────
        infer: {
            /** 线索来源 */
            sources: { worldInfo: true, character: true, chat: true, persona: false },
            /** 用哪个后端：main = 酒馆主 API；custom = 下面自定义的 OpenAI 兼容接口 */
            backend: 'main',
            custom: {
                baseUrl: '',
                apiKey: '',
                model: '',
                temperature: 0.2,
                maxTokens: 1500,
            },
            /** 线索总字数上限 */
            maxClueChars: 6000,
            /** 推断结果是否直接套用（false 时先给预览） */
            autoApply: false,
            /** 覆盖哪些字段 */
            apply: { era: true, months: true, monthNames: true, leap: true, format: true, startDate: true },
        },

        injection: {
            /** hidden = 隐形扩展注入；prefill = 填进输入框；both = 两者都做 */
            mode: 'hidden',
            /** 0=IN_PROMPT 1=IN_CHAT 2=BEFORE_PROMPT */
            position: 1,
            /** 插入深度，0 = 最后一条消息之后 */
            depth: 0,
            /** 0=system 1=user 2=assistant */
            role: 0,
            /** 是否参与世界书扫描 */
            scan: false,
        },

        ui: {
            /** 常驻悬浮按钮 */
            showFab: true,
            /**
             * 把注入内容如实折叠进聊天记录里。
             *
             * 隐形注入本身看不见，而用户想确认的是「**每一回合**到底注入了什么」——
             * 那只能待在消息本身里，跟模型的思考块一个道理：
             *   用户消息 → 计时注入
             *   AI 消息  → 计时输出
             */
            showMessageBlocks: true,
            /** 悬浮按钮位置（视口比例 0~1） */
            fabPos: { x: 0.88, y: 0.7 },
            /** 悬浮按钮上显示什么：clock | clock+count | count */
            fabContent: 'clock+count',
            /** 面板默认展开 */
            panelOpen: false,
            /** 面板主题 */
            theme: 'auto',
        },

        advanced: {
            /** 重建时最多回放多少条消息 */
            maxReplayMessages: 4000,
            /** 存档里最多保留多少个事件 */
            maxEvents: 300,
            /** 历史记录条数上限 */
            historyLimit: 200,
            /** 调试日志 */
            debug: false,
        },
    };
}

/** 深合并：用 patch 覆盖 base，返回新对象 */
export function mergeConfig(base, patch) {
    if (!patch || typeof patch !== 'object') return clone(base);
    const out = clone(base);
    for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
            out[key] = mergeConfig(out[key], value);
        } else if (value !== undefined) {
            out[key] = Array.isArray(value) ? [...value] : value;
        }
    }
    return out;
}

function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = clone(v);
        return out;
    }
    return value;
}

export { DEFAULT_UNITS, DEFAULT_TAG_NAMES };
