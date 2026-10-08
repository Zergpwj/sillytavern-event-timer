/**
 * 五个编辑器弹窗：
 *   1. 月名编辑器 —— 逐月填写 + 批量导入
 *   2. 日期格式编辑器 —— 模板 + 实时预览 + 可点的占位符按钮
 *   3. 提示词编辑器 —— 编辑 / 另存为 / 重命名「默认提示词」等
 *   4. 提示词的导出 / 导入 —— 玩家之间交换文案
 *   5. 历法推断向导 —— 收集线索 → 调 AI → 预览 → 套用
 *
 * 都基于 ui/modal.js，不依赖酒馆专属组件。
 */

import { h, append, clear } from './dom.js';
import { openModal, field, textInput, textArea, checkbox, select } from './modal.js';
import {
    DATE_PLACEHOLDER_GROUPS,
    findUnknownPlaceholders,
    formatCalendarClock,
    normalizeDateFormat,
} from '../core/calendar.js';
import { parsePromptFile, promptFileName, serializePromptFile } from '../core/prompt-io.js';

/** 中文数字，用来一键填充月名 */
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五',
    '十六', '十七', '十八', '十九', '二十', '二十一', '二十二', '二十三', '二十四', '二十五', '二十六'];

/** 把一段文本拆成月名列表（支持换行 / 逗号 / 顿号 / 竖线 / 斜杠 / 空白） */
export function splitMonthNames(text) {
    return String(text ?? '')
        .split(/[,，、\n|｜/／\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * 月名编辑器。
 * @param {import('../app.js').TimerApp} app
 */
export function openMonthNameEditor(app) {
    const monthCount = app.engine.formatter.calendar?.months?.length
        ?? app.config.time.calendar?.months?.length
        ?? 12;
    const current = Array.isArray(app.config.time.calendar?.monthNames)
        ? [...app.config.time.calendar.monthNames]
        : [];
    const values = Array.from({ length: monthCount }, (_, i) => current[i] ?? '');

    const inputs = [];
    const grid = h('div.st-timer-monthgrid');

    const rerenderGrid = () => {
        clear(grid);
        inputs.length = 0;
        for (let i = 0; i < monthCount; i++) {
            const input = h('input.st-timer-input', { type: 'text', placeholder: String(i + 1) });
            input.value = values[i] ?? '';
            input.addEventListener('input', () => { values[i] = input.value; });
            inputs.push(input);
            grid.appendChild(h('div.st-timer-monthgrid__cell', [
                h('span.st-timer-monthgrid__idx', `第 ${i + 1} 月`),
                input,
            ]));
        }
    };
    rerenderGrid();

    const bulk = textArea('', 3, '每行一个，或用逗号 / 顿号 / 空格分隔；按顺序覆盖上面的格子');

    const modal = openModal({
        title: '编辑月名',
        width: 'min(620px, 94vw)',
        build: () => [
            h('div.st-timer-settings__hint',
                `当前历法有 ${monthCount} 个月。给每个月起名字（例如「春月」「霜月」）；留空则该月用数字显示。`),
            grid,
            h('div.st-timer-settings__section-title', '批量导入'),
            bulk,
            h('div.st-timer-modal__actions', [
                h('button.st-timer-btn.st-timer-btn--tiny', {
                    type: 'button',
                    onclick: () => {
                        const names = splitMonthNames(bulk.value);
                        if (!names.length) {
                            modal.setStatus('没有解析到任何月名', 'warning');
                            return;
                        }
                        for (let i = 0; i < monthCount; i++) values[i] = names[i] ?? '';
                        rerenderGrid();
                        modal.setStatus(`已导入 ${Math.min(names.length, monthCount)} 个月名`, 'success');
                    },
                }, '导入到上面'),
                h('button.st-timer-btn.st-timer-btn--tiny', {
                    type: 'button',
                    onclick: () => {
                        for (let i = 0; i < monthCount; i++) values[i] = `${CN_NUM[i] ?? i + 1}月`;
                        rerenderGrid();
                    },
                }, '用「一月、二月…」填充'),
                h('button.st-timer-btn.st-timer-btn--tiny', {
                    type: 'button',
                    onclick: () => {
                        for (let i = 0; i < monthCount; i++) values[i] = '';
                        rerenderGrid();
                    },
                }, '全部清空'),
            ]),
            h('div.st-timer-settings__hint',
                '提示：填了月名之后，把「日期格式」里的 {month} 换成 {monthName} 才会显示月名。保存时如果发现还没换，会自动帮你换。'),
        ],
        buttons: [
            { label: '取消' },
            {
                label: '保存',
                primary: true,
                onClick: () => {
                    const monthNames = values.map((v) => String(v ?? '').trim());
                    app.updateConfig({ time: { calendar: { monthNames } } });

                    // 顺手把格式改成用月名（如果还没改）
                    const format = String(app.config.time.calendar?.format ?? '');
                    if (monthNames.some(Boolean) && format.includes('{month}') && !format.includes('{monthName}')) {
                        app.updateConfig({
                            time: {
                                calendar: {
                                    format: format.replace(/\{month\}\s*月/g, '{monthName}').replace(/\{month\}/g, '{monthName}'),
                                },
                            },
                        });
                    }
                    app.engine.resetInitialClockToBase();
                    app.rebuild({ reason: 'month-names' });
                    app.notify();
                },
            },
        ],
    });

    return modal;
}

/**
 * 提示词编辑器。
 * @param {import('../app.js').TimerApp} app
 * @param {string} id 要编辑的提示词 id（新建时传 null）
 */
/** 五个提醒时点的编辑区定义（顺序 = 事件生命周期顺序） */
const POINT_EDITORS = [
    { key: 'mid', label: '① 定期检查 · 静默调整参数', hint: '**每个检查点时**问：外面的变化牵扯到它了吗？**静默**，不要要求 AI 写进正文。' },
    { key: 'late', label: '② 即将结束 · 初步结算', hint: '让 AI 列一份「到预定终点要交代什么」的要点清单。**静默**，不预设结果。' },
    { key: 'origin', label: '③ 预定终点（旧）', hint: '事件被延后过、旧期限到了却还没结束。这是唯一让玩家意识到「出岔子了」的时点。' },
    { key: 'due', label: '④ 预定终点（现）· 最终结算', hint: '在正文里交代结果。' },
];

/**
 * 日期格式编辑器。
 *
 * 为什么要弹窗：这块东西堆在设置面板上太占地方 —— 一个模板输入框 + 四行占位符说明，
 * 而占位符说明本来是**只能读的死文字**。搬进弹窗之后：
 *   · 面板上只剩「格式预览 + 编辑模板…」一行
 *   · 占位符变成**可点的按钮**，点一下就插进模板
 *   · 多出来的地方放实时预览和「不认识的占位符」警告
 */
export function openDateFormatEditor(app) {
    const cal = app.engine.formatter?.calendar;
    const current = app.config.time.calendar?.format || cal?.format || '{era}{year}年{month}月{day}日';

    const tplInput = textInput(current);
    const preview = h('div.st-timer-datefmt__preview');
    const warn = h('div.st-timer-datefmt__warn', { hidden: true });

    /** 用**当前历法**把模板渲染一遍 —— 用户要看到的就是这个 */
    const renderWith = (template) => {
        if (!cal) return app.engine.formatClock(app.engine.clock);
        const normalized = normalizeDateFormat(String(template ?? '').trim() || current);
        return formatCalendarClock(app.engine.clock, { ...cal, format: normalized });
    };

    const refresh = () => {
        const raw = String(tplInput.value ?? '');
        preview.textContent = renderWith(raw) || '（渲染结果是空的）';
        const unknown = findUnknownPlaceholders(normalizeDateFormat(raw));
        warn.hidden = !unknown.length;
        warn.textContent = unknown.length
            ? `⚠ 这些占位符不认识，会被**原样输出**：${unknown.join('、')}`
            : '';
    };

    /**
     * 把占位符插到**光标处**。
     *
     * ⚠️ `selectionStart` / `setSelectionRange` 在测试垫片里没有，所以这里必须
     * 防御性读取：取不到就退化成「追加到末尾」。真实浏览器里光标插入是好的，
     * 但那个行为在无头环境测不到。
     */
    const insert = (token) => {
        const raw = String(tplInput.value ?? '');
        const start = Number.isInteger(tplInput.selectionStart) ? tplInput.selectionStart : null;
        const end = Number.isInteger(tplInput.selectionEnd) ? tplInput.selectionEnd : null;
        if (start == null || end == null) {
            tplInput.value = raw + token;
        } else {
            tplInput.value = raw.slice(0, start) + token + raw.slice(end);
            const caret = start + token.length;
            tplInput.setSelectionRange?.(caret, caret);
        }
        refresh();
    };

    const chips = DATE_PLACEHOLDER_GROUPS.map((group) => h('div.st-timer-datefmt__group', [
        h('div.st-timer-settings__label', group.title),
        h('div.st-timer-datefmt__chips', group.items.map(([token, desc]) => h(
            'button.st-timer-btn.st-timer-btn--tiny.st-timer-datefmt__chip',
            { type: 'button', title: desc, onclick: () => insert(token) },
            token,
        ))),
    ]));

    tplInput.addEventListener('input', refresh);
    tplInput.addEventListener('change', refresh);
    refresh();

    const modal = openModal({
        title: '编辑日期格式',
        width: 'min(680px, 94vw)',
        build: () => [
            h('div.st-timer-settings__hint',
                '这就是日期显示成什么样的模板。下面的按钮点一下就插到光标处；也可以直接手写。'),
            field('模板', tplInput),
            h('div.st-timer-settings__section-title', '预览'),
            preview,
            warn,
            h('div.st-timer-settings__section-title', '插入占位符'),
            ...chips,
            h('div.st-timer-settings__hint',
                '时辰约定：一个时辰 2 小时，子时从 23:00 起算；一个时辰 8 刻，每刻 15 分钟，{ke} 是本时辰内的第几刻（一到八）。'),
            h('div.st-timer-settings__hint',
                '模板里没写任何时间占位符时，插件会自动在末尾追加 24 小时制的时分。'),
        ],
        buttons: [
            { label: '取消' },
            {
                label: '恢复默认',
                onClick: () => {
                    tplInput.value = '{era}{year}年{month}月{day}日';
                    refresh();
                    return false;   // 不关弹窗，让用户先看预览
                },
            },
            {
                label: '保存',
                primary: true,
                onClick: () => {
                    const raw = String(tplInput.value ?? '').trim() || '{era}{year}年{month}月{day}日';
                    app.updateConfig({ time: { calendar: { format: normalizeDateFormat(raw) } } });
                },
            },
        ],
    });

    return modal;
}

/**
 * 导出提示词。
 *
 * 三条出路，按可靠性排序：
 *   1. 「下载文件」—— 浏览器允许时最省事
 *   2. 「复制到剪贴板」—— 现代浏览器都行，但需要 https / localhost
 *   3. 手动全选复制 —— 前两条都被挡住时的兜底，框里的文本一直摆着
 *
 * 前两条在无头测试环境里都没有（Blob、URL.createObjectURL、navigator.clipboard
 * 都可能缺），所以每一步都要 try 住，失败了退到下一条，而不是抛错。
 */
export function openPromptExport(app) {
    const prompt = app.activePrompt;
    const text = serializePromptFile(prompt);

    const area = textArea(text, 14);
    area.readOnly = true;

    const copy = async () => {
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                app.host.toast?.('已复制到剪贴板', 'success');
                return;
            }
            throw new Error('no clipboard api');
        } catch {
            // 退路：帮用户选中，让他自己按 Ctrl+C
            area.select?.();
            app.host.toast?.('浏览器不让自动复制，已帮你选中，按 Ctrl+C 即可', 'info');
        }
    };

    const download = () => {
        try {
            const blob = new Blob([text], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = h('a', { href: url, download: promptFileName(prompt.name) });
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL?.(url), 1000);
            app.host.toast?.('已开始下载', 'success');
        } catch {
            app.host.toast?.('浏览器不让下载，请手动复制上面那段', 'warning');
        }
    };

    return openModal({
        title: '导出提示词',
        width: 'min(720px, 94vw)',
        build: () => [
            h('div.st-timer-settings__hint',
                `把「${prompt.name}」导出成一份 JSON。别人拿到之后用「导入…」就能直接用。`),
            area,
            h('div.st-timer-modal__actions', [
                h('button.st-timer-btn.st-timer-btn--tiny', { type: 'button', onclick: copy }, '复制到剪贴板'),
                h('button.st-timer-btn.st-timer-btn--tiny', { type: 'button', onclick: download }, '下载文件'),
            ]),
            h('div.st-timer-settings__hint', '只想分享其中几段也行：导出的是整份，导入后可以再编辑。'),
        ],
        buttons: [{ label: '关闭' }],
    });
}

/**
 * 导入提示词。
 *
 * 两条入口：选文件（FileReader）和直接粘贴。选文件那条在无头环境里走不通，
 * 但粘贴是纯字符串处理，所以测试覆盖的是它。
 *
 * 校验交给 core/prompt-io.js 里的 parsePromptFile()（纯函数、单测覆盖），
 * 这里只负责把错误显示出来、以及在通过时调 app.importPrompt()。
 */
export function openPromptImport(app) {
    const area = textArea('', 12, '把别人给你的 JSON 粘在这里');
    const fileLabel = h('div.st-timer-settings__hint', '（还没有选文件）');
    const problem = h('div.st-timer-datefmt__warn', { hidden: true });

    const fileInput = h('input', { type: 'file', accept: '.json,application/json' });
    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        fileLabel.textContent = `已选择：${file.name}`;
        try {
            const reader = new FileReader();
            reader.onload = () => { area.value = String(reader.result ?? ''); };
            reader.onerror = () => app.host.toast?.('读这个文件失败了', 'warning');
            reader.readAsText(file);
        } catch {
            app.host.toast?.('这个环境不支持读文件，请把内容粘到下面的框里', 'warning');
        }
    });

    return openModal({
        title: '导入提示词',
        width: 'min(720px, 94vw)',
        build: () => [
            h('div.st-timer-settings__hint', '从文件选，或者把别人给你的 JSON 粘到下面的框里。'),
            field('文件', fileInput),
            fileLabel,
            field('内容', area),
            problem,
            h('div.st-timer-settings__hint',
                '导入会**新增一条**提示词并切过去用，不会覆盖你现有的任何一条。'),
        ],
        buttons: [
            { label: '取消' },
            {
                label: '导入',
                primary: true,
                onClick: () => {
                    const result = parsePromptFile(area.value);
                    if (!result.ok) {
                        problem.hidden = false;
                        problem.textContent = `⚠ ${result.errors.join('；')}`;
                        return false;   // 不关弹窗，让用户改
                    }
                    const item = app.importPrompt(result.name, result.fields);
                    const extra = result.warnings.length ? `（${result.warnings.join('；')}）` : '';
                    app.host.toast?.(`已导入「${item.name}」${extra}`, 'success');
                },
            },
        ],
    });
}

/**
 * 「提前量」的独立设置面板。
 *
 * 形态是用户定的：设置面板上只放一行「勾选框 + 设置… 按钮」，
 * 点按钮才打开这里。不塞在「提醒」那一节里，是因为它一次管四个时点，
 * 摊开会把那一节拉得很长，而它只在调手感的时候才用得上。
 *
 * ⚠️ 「定期检查」那一格在**「按剧情时间」关掉**时禁用：
 * 回合制下的定期检查由回合触发，提前量（分钟）对它无从施加。
 * 另外三个时点仍然锚在剧情时间上，所以照常可用 —— 这也是为什么
 * 禁用的是**这一格**，而不是整个提前量开关。
 */
export function openAdvanceEditor(app) {
    const read = () => app.config.reminder.advance ?? {};
    const timeRuleOff = !(Number(app.config.reminder.checkEveryDays) > 0);

    const dayHour = (key, disabled) => {
        const total = Math.max(0, Number(read()[key]) || 0);
        const d0 = Math.floor(total);
        const h0 = Math.round((total - d0) * 24);
        const make = (val) => {
            const el = h('input.st-timer-input.st-timer-input--num', { type: 'number', min: '0' });
            el.value = String(val);
            if (disabled) el.disabled = true;
            return el;
        };
        const dIn = make(d0);
        const hIn = make(h0);
        const push = () => {
            const next = { ...read() };
            next[key] = Math.max(0, Number(dIn.value) || 0) * 1440 + Math.max(0, Number(hIn.value) || 0) * 60;
            app.updateConfig({ reminder: { advance: next } });
        };
        dIn.addEventListener('change', push);
        hIn.addEventListener('change', push);
        return h('div.st-timer-threshold', [
            dIn, h('span.st-timer-threshold__suffix', '天'),
            hIn, h('span.st-timer-threshold__suffix', '小时'),
        ]);
    };

    const row = (label, key, hint) => {
        const disabled = key === 'mid' && timeRuleOff;
        const control = dayHour(key, disabled);
        // 每行只留「标签 + 输入框」两个元素。以前这里还有第三个元素（说明文字），
        // 而 .st-timer-settings__row 是 flex + space-between —— 说明文字一长一短，
        // 就把输入框挤到不同的位置，四排看着完全没对齐。说明搬到 title 上（悬停可见），
        // 既不占位又能保留信息。
        if (hint) control.title = hint;
        if (disabled) control.title = '已停用：你关掉了「按剧情时间」的检查间隔，定期检查现在由回合触发，提前量（分钟）对它没有意义。另外三个时点不受影响。';
        return h('div.st-timer-settings__row', [
            h('div.st-timer-settings__label', label),
            control,
        ]);
    };

    return openModal({
        title: '提前量',
        width: 'min(680px, 94vw)',
        build: () => [
            h('div.st-timer-settings__hint',
                '基于本插件的机制，插件必须在一轮正文后才能知道当前时间，这样会不可避免的造成一轮的滞后，而本功能的作用就是通过一个固定的时间提前量来对抗这个滞后，数值框内填多少就是相应的时间点提前多久提醒，填0就是不提前。'),
            row('定期检查（与回合制检查间隔冲突）', 'mid', '比原定位置早这么多就去看一眼（这个时点不产出正文，提前没有副作用）'),
            row('即将结束', 'late', '比原定位置早这么多就开始列要点'),
            row('预定终点（旧）', 'origin', '比原定的期限早这么多就提醒「马上就要超期了」（措辞会自动换成将来时）'),
            row('预定终点（现）', 'due', '比到期早这么多就提醒「马上就要到期了」，好让结果落在预定的那一轮里'),
        ],
    });
}

export function openPromptEditor(app, id) {
    const isNew = !id;
    const existing = isNew ? null : app.prompts.find((p) => p.id === id);
    if (!isNew && !existing) return null;

    const engine = app.engine;
    // 内置文案的**模板形态**（带占位符）。
    // 不存渲染好的文本 —— 那会把「当前剧情时间」冻在保存的那一刻，
    // 模型会一直看到旧时间甚至照着它写，时钟就卡住了。
    const templates = engine.builtinPromptTemplates();

    const nameInput = textInput(existing?.name ?? '新提示词');
    const protocolArea = textArea(existing?.protocol ?? '', 10, '');
    const areas = {};
    for (const spec of POINT_EDITORS) {
        // 老字段 reminder 作为 due 的别名
        const initial = existing?.[spec.key] ?? (spec.key === 'due' ? existing?.reminder : null) ?? '';
        areas[spec.key] = textArea(initial, 6, '');
    }

    const previewBox = h('pre.st-timer-prompt-preview', '');
    const refreshPreview = () => {
        const fields = { protocol: protocolArea.value };
        for (const spec of POINT_EDITORS) fields[spec.key] = areas[spec.key].value;
        previewBox.textContent = engine.previewPrompts(fields, previewEvents(engine.clock)) || '（没有可预览的内容）';
    };

    /**
     * ⚠️ 占位符分**两个家族**，**不能混用** —— 写错家族的占位符不会被替换，
     * 会原样发给模型。而且它**不报错**，所以很难发现（实测：把 {{timeClock}}
     * 写进四个时点模板、或把 {{when}} 写进协议，都会原样留着）。
     * 所以两处各给各的清单，别合并成一份。
     */
    const protocolPlaceholders = [
        '这一栏里可用：{{tag}} 标签名 · {{tags}} 全部标签名 · {{timeClock}} 当前剧情时间',
        '{{dayLabel}} 天标签的写法 · {{exampleClock}} 时间示例 · {{timeMode}} 计数制 / 日历制',
        '{{era}} 纪元名 · {{monthCount}} 一年几个月 · {{monthNames}} 自定义月名',
        '{{tooShort}} 时长门槛那句话 · {{reminderHint}} 「事件+ 只写一次」那两条规则',
    ].join('；');
    const pointPlaceholders = [
        '这一栏里可用：{{tag}} 标签名 · {{time}} 或 {{clock}}（等价）当前剧情时间',
        '{{events}} 事件清单 · {{count}} 事件条数',
        '{{when}} 这个时点的时态短语（按真实时钟变）· {{whenBlock}} 预定终点（旧）事件块里那句',
        '{{overdueHint}} 超时提醒（没有超时事件时**整行会被删掉**）',
    ].join('；');

    const modal = openModal({
        title: isNew ? '新建提示词' : `编辑提示词：${existing.name}`,
        width: 'min(820px, 94vw)',
        build: () => [
            field('名称', nameInput),
            h('div.st-timer-settings__section-title', '记录格式说明（教 AI 输出标签）'),
            h('div.st-timer-settings__hint',
                '这里是**模板**，可以直接改。{{...}} 会在真正发出去的时候被替换成当前的值，所以改了设置它也跟着变。'),
            h('div.st-timer-settings__hint', protocolPlaceholders),
            protocolArea,
            h('div.st-timer-modal__actions', [
                h('button.st-timer-btn.st-timer-btn--tiny', {
                    type: 'button',
                    onclick: () => { protocolArea.value = templates.protocol; refreshPreview(); },
                }, '恢复内置文案'),
                h('button.st-timer-btn.st-timer-btn--tiny', {
                    type: 'button',
                    onclick: () => { protocolArea.value = ''; refreshPreview(); },
                }, '清空（仍会自动套用内置）'),
            ]),

            h('div.st-timer-settings__section-title', '四个提醒时点的文案'),
            h('div.st-timer-settings__hint', pointPlaceholders),
            ...POINT_EDITORS.map((spec) => h('div.st-timer-point-editor', [
                h('div.st-timer-settings__label', spec.label),
                h('div.st-timer-settings__hint', spec.hint),
                areas[spec.key],
                h('div.st-timer-modal__actions', [
                    h('button.st-timer-btn.st-timer-btn--tiny', {
                        type: 'button',
                        onclick: () => { areas[spec.key].value = templates[spec.key]; refreshPreview(); },
                    }, '恢复内置文案'),
                    h('button.st-timer-btn.st-timer-btn--tiny', {
                        type: 'button',
                        onclick: () => { areas[spec.key].value = ''; refreshPreview(); },
                    }, '清空（仍会自动套用内置）'),
                ]),
            ])),

            h('div.st-timer-settings__section-title', '预览'),
            h('div.st-timer-settings__hint', '下面是当前这些文字**真正发出去**的样子（用示例事件演示，四个时点各一段）。'),
            h('div.st-timer-modal__actions', [
                h('button.st-timer-btn.st-timer-btn--tiny', {
                    type: 'button',
                    onclick: () => refreshPreview(),
                }, '刷新预览'),
            ]),
            previewBox,
        ],
        buttons: [
            { label: '取消' },
            {
                label: isNew ? '创建' : '保存',
                primary: true,
                onClick: () => {
                    const name = nameInput.value.trim();
                    const dict = { name, protocol: protocolArea.value.trim() ? protocolArea.value : null };
                    for (const spec of POINT_EDITORS) {
                        dict[spec.key] = areas[spec.key].value.trim() ? areas[spec.key].value : null;
                    }
                    if (isNew) app.addPrompt(dict);
                    else app.updatePrompt(id, dict);
                    app.host.toast?.(isNew ? '提示词已创建' : '提示词已保存', 'success');
                },
            },
        ],
    });

    refreshPreview();
    return modal;
}

/**
 * 预览用的示例事件：四个时点各一个，一眼看全。
 *
 * ⚠️ 两个坑，都踩过：
 *
 *   1. **不能拿一个 base 铺开四条。** 原来就是 `{...base, title: '熬制解毒药'}`
 *      这么写的，结果只有标题不同，预期 / 变数 / 资源全是同一份 ——
 *      而且「熬制解毒药」配上「本金 500 两、商队 30 人」明显乱套。
 *      四条各自写一套，才看得出模板在真实事件上的效果。
 *
 *   2. **时钟必须相对「当前剧情时间」算。** 预览用的是你此刻的真实时钟，
 *      原来写死「第 1~3 天」，在一个已经跑到第 1213826 天的存档里会显示
 *      「已超时 1213823 天」。所以统一按 now ± 偏移生成。
 *
 * 每条都刻意配成**自洽**的一组：商队的事、修房子的事、等信的事、熬药的事，
 * 各自有各自的预期 / 变数 / 资源。
 */
function previewEvents(now) {
    const base = now ?? { day: 1, minute: 8 * 60 };
    // 「第 N 天」是绝对天数、minute 是当天内的分钟，所以要自己算一次
    const shift = (minutes) => {
        const abs = base.day * 1440 + base.minute + minutes;
        return { day: Math.floor(abs / 1440), minute: ((abs % 1440) + 1440) % 1440 };
    };

    /** @type {any[]} */
    const out = [
        {
            // 定期检查：走了大约一半
            id: '__preview_mid__',
            title: '派商队收粮',
            createdClock: shift(-1 * 1440),
            dueClock: shift(1 * 1440),
            initialDurationMinutes: 2 * 1440,
            durationMinutes: 2 * 1440,
            dueHistory: [],
            expectation: '带回过冬的粮食，若粮价大涨则数量减半',
            variables: '粮价、敌对领主是否封路、返程路况',
            ledger: '本金 500 两，商队 30 人',
            fired: {},
            reminderPoint: 'mid',
            reminderOriginAbs: 0,
        },
        {
            // 即将结束：还剩几个时辰
            id: '__preview_late__',
            title: '修葺祖宅',
            createdClock: shift(-3 * 1440),
            dueClock: shift(5 * 60),
            initialDurationMinutes: 4 * 1440,
            durationMinutes: 4 * 1440,
            dueHistory: [],
            expectation: '赶在入冬前把屋顶和东厢修好',
            variables: '木料够不够、工匠会不会被别家挖走、雨季是否提前',
            ledger: '木料 40 根，工匠 6 人，银子 120 两',
            fired: {},
            reminderPoint: 'late',
            reminderOriginAbs: 0,
        },
        {
            // 预定终点（旧）：原定期限已过，顺延过两次
            id: '__preview_origin__',
            title: '等师父回信',
            createdClock: shift(-10 * 1440),
            dueClock: shift(-1 * 1440),
            initialDurationMinutes: 5 * 1440,
            durationMinutes: 9 * 1440,
            dueHistory: [shift(-6 * 1440), shift(-1 * 1440)],
            expectation: '师父回信说明下一步该往哪走',
            variables: '驿站是否还通、师父是否已经离开原处',
            ledger: '信鸽 2 只，盘缠 30 两',
            fired: {},
            reminderPoint: 'origin',
            reminderOriginAbs: 0,
        },
        {
            // 到点：刚超时一个时辰
            id: '__preview_due__',
            title: '熬制解毒药',
            createdClock: shift(-7 * 60),
            dueClock: shift(-1 * 60),
            initialDurationMinutes: 6 * 60,
            durationMinutes: 6 * 60,
            dueHistory: [],
            expectation: '解掉同伴身上的蛇毒',
            variables: '火候、药材年份、毒性深浅',
            ledger: '七叶草 3 株，炭火 1 炉',
            fired: {},
            reminderPoint: 'due',
            reminderOriginAbs: 0,
        },
    ];
    return out;
}

/**
 * 历法推断向导。
 * @param {import('../app.js').TimerApp} app
 */
export function openCalendarWizard(app) {
    const infer = app.config.infer ?? {};
    const sources = { ...(infer.sources ?? {}) };
    const applyFlags = { ...(infer.apply ?? {}) };

    const status = app.inferenceBackendStatus();

    const sourceBoxes = [
        checkbox('世界书条目', sources.worldInfo),
        checkbox('角色卡设定', sources.character),
        checkbox('最近对话', sources.chat),
        checkbox('用户人设', sources.persona),
    ];
    const backendSelect = select([
        ['main', '酒馆主 API（generateQuietPrompt）'],
        ['custom', '自定义 API（OpenAI 兼容）'],
    ], infer.backend ?? 'main');

    const baseUrlInput = textInput(infer.custom?.baseUrl ?? '', 'https://api.example.com/v1');
    const apiKeyInput = h('input', { type: 'password', placeholder: 'sk-…' });
    apiKeyInput.value = infer.custom?.apiKey ?? '';
    const modelInput = textInput(infer.custom?.model ?? '', '例如 gpt-4o-mini / qwen2.5-14b');
    const autoApplyBox = checkbox('推断成功后直接套用（不勾选则先预览）', infer.autoApply);

    const customBox = h('div.st-timer-settings__subsection');
    const resultBox = h('pre.st-timer-preview__body.st-timer-wizard__result', '还没有推断结果');

    const applyBoxes = [
        ['era', '纪元前缀', applyFlags.era],
        ['months', '每月天数', applyFlags.months],
        ['monthNames', '月名', applyFlags.monthNames],
        ['leap', '闰年', applyFlags.leap],
        ['format', '日期格式', applyFlags.format],
        ['startDate', '起始日期 / 当前时间', applyFlags.startDate],
    ].map(([key, label, checked]) => {
        const box = checkbox(label, checked !== false);
        box.dataset.key = key;
        return box;
    });

    let lastSpec = null;

    const modal = openModal({
        title: '用 AI 推断当前聊天的历法',
        width: 'min(720px, 94vw)',
        build: () => [
            h('div.st-timer-settings__hint',
                '按世界书 / 角色卡 / 对话里的线索，让模型判断这个世界用什么历法，并给出当前剧情时间。'),
            h('div.st-timer-settings__section-title', '① 线索来源'),
            h('div.st-timer-sources', sourceBoxes),
            h('div.st-timer-settings__section-title', '② 推断 API'),
            backendSelect,
            customBox,
            h('div.st-timer-settings__section-title', '③ 结果'),
            resultBox,
            h('details.st-timer-settings__details', [
                h('summary', '选择要套用的字段'),
                h('div.st-timer-sources', applyBoxes),
            ]),
            autoApplyBox,
        ],
        buttons: [
            { label: '关闭' },
            {
                label: '开始推断',
                primary: true,
                onClick: (api) => {
                    void runInference(api);
                    return false;   // 不关弹窗
                },
            },
            {
                label: '套用结果',
                onClick: () => {
                    if (!lastSpec) {
                        modal.setStatus('还没有推断结果', 'warning');
                        return false;
                    }
                    applySpec();
                    return true;
                },
            },
        ],
    });

    function syncCustomVisibility() {
        clear(customBox);
        if (backendSelect.value === 'custom') {
            append(customBox, [
                field('接口地址', baseUrlInput, '会自动补 /v1/chat/completions'),
                field('API Key', apiKeyInput, '只存在本地设置里，不会上传到别处'),
                field('模型名', modelInput),
            ]);
        }
    }
    syncCustomVisibility();
    backendSelect.addEventListener('change', syncCustomVisibility);

    function collectFlags() {
        const flags = {};
        for (const box of applyBoxes) flags[box.dataset.key] = box.input.checked;
        return flags;
    }

    function applySpec() {
        const flags = collectFlags();
        app.updateConfig({ infer: { apply: flags } });
        const applied = app.applyInferredCalendar(lastSpec);
        modal.setStatus(`已套用：\n${applied.join('\n') || '（模型没有给出可套用的字段）'}`, 'success');
    }

    async function runInference(api) {
        api.setBusy(true);
        try {
            app.updateConfig({
                infer: {
                    sources: {
                        worldInfo: sourceBoxes[0].input.checked,
                        character: sourceBoxes[1].input.checked,
                        chat: sourceBoxes[2].input.checked,
                        persona: sourceBoxes[3].input.checked,
                    },
                    backend: backendSelect.value,
                    autoApply: autoApplyBox.input.checked,
                    custom: {
                        baseUrl: baseUrlInput.value.trim(),
                        apiKey: apiKeyInput.value,
                        model: modelInput.value.trim(),
                    },
                },
            });

            const result = await app.inferCalendar({ onProgress: (m) => api.setStatus(m) });
            lastSpec = result.spec;
            resultBox.textContent = JSON.stringify(result.spec, null, 2);
            api.setStatus(
                result.spec.confident === false
                    ? `推断完成，但模型认为线索不足：${result.spec.reason || '（没有说明）'}`
                    : `推断完成：${result.spec.reason || '模型没有给出依据说明'}`,
                result.spec.confident === false ? 'warning' : 'success',
            );

            if (autoApplyBox.input.checked) applySpec();
        } catch (err) {
            console.error('[事件计时器] 推断失败', err);
            api.setStatus(`推断失败：${err?.message || err}`, 'error');
        } finally {
            api.setBusy(false);
        }
    }

    return modal;
}
