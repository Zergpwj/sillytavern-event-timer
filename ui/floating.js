/**
 * 常驻悬浮按钮 + 展开面板。
 *
 * 设计目标：
 *   - 按钮一直可见，上面直接显示当前剧情时间与「到期事件数」角标；
 *   - 点开面板能看到进行中的事件、剩余时间、预期收益 / 风险 / 损失；
 *   - 面板可拖动、可折叠，位置与开关状态存进配置；
 *   - 不依赖酒馆的 DOM 结构，任何宿主都能挂。
 */

import { formatClock, formatDuration, formatCountdown, diffMinutes, addMinutes } from '../core/story-time.js';
import { parseDuration } from '../core/time-lexer.js';
import { parseAbsoluteClock } from '../core/parser.js';
import { h, append, clear, escapeHtml } from './dom.js';
import { openModal, shieldOverlay } from './modal.js';
import { localizeDom } from './i18n.js';

const ROOT_ID = 'st-timer-root';

export class FloatingUI {
    /**
     * @param {import('../app.js').TimerApp} app
     */
    constructor(app) {
        this.app = app;
        this.root = null;
        this.panel = null;
        this.fab = null;
        this.listEl = null;
        this.dueEl = null;
        this.clockEl = null;
        this.badgeEl = null;
        this._dragging = null;
        this._open = !!app.config.ui.panelOpen;
        this._flashUntil = 0;
        this._unsubscribe = null;
    }

    mount(container = document.body) {
        if (document.getElementById(ROOT_ID)) return;

        this.fab = h('button#st-timer-fab.st-timer-fab', {
            type: 'button',
            title: '事件计时器：点击查看进行中的事件',
            onclick: (e) => {
                if (this._suppressClick) { this._suppressClick = false; return; }
                void e;
                this.toggle();
            },
        }, [
            h('span.st-timer-fab__icon', '⏱'),
            h('span.st-timer-fab__body', [
                h('span.st-timer-fab__clock', '—'),
                h('span.st-timer-fab__sub', ''),
            ]),
            h('span.st-timer-fab__badge', { hidden: true }, '0'),
        ]);

        this.panel = h('div#st-timer-panel.st-timer-panel', { hidden: !this._open });

        this.root = h('div#st-timer-root.st-timer-root', [
            this.fab,
            this.panel,
        ]);

        container.appendChild(this.root);

        this.clockEl = this.fab.querySelector('.st-timer-fab__clock');
        this.badgeEl = this.fab.querySelector('.st-timer-fab__badge');

        this.buildPanel();
        this.bindDrag();
        this.applyPosition();
        this.applyVisibility();

        this._unsubscribe = this.app.subscribe(() => this.render());
        this.render();
    }

    unmount() {
        this._unsubscribe?.();
        clearTimeout(this._flashTimer);
        this.root?.remove();
        this.root = null;
        this.fab = null;
        this.panel = null;
    }

    // ───────────────────────────── 外观 ─────────────────────────────

    applyVisibility() {
        if (!this.root) return;
        this.root.classList.toggle('st-timer--hidden', !this.app.config.ui.showFab);
        this.root.dataset.theme = this.app.config.ui.theme || 'auto';
    }

    applyPosition() {
        if (!this.root) return;
        const { x, y } = this.app.config.ui.fabPos || { x: 0.88, y: 0.7 };
        this.root.style.left = `${Math.round(x * 100)}%`;
        this.root.style.top = `${Math.round(y * 100)}%`;
    }

    toggle(force) {
        this._open = force == null ? !this._open : !!force;
        this.panel.hidden = !this._open;
        this.app.config.ui.panelOpen = this._open;
        this.app.saveSettings();
        if (this._open) this.render();
    }

    flash() {
        this._flashUntil = Date.now() + 4000;
        this.fab?.classList.add('is-flashing');
        this.render();
        clearTimeout(this._flashTimer);
        this._flashTimer = setTimeout(() => {
            // 组件可能已经被卸载（换页 / 热重载），此时不要再去碰 DOM
            if (!this.root) return;
            this.fab?.classList.remove('is-flashing');
            this.render();
        }, 4000);
    }

    // ───────────────────────────── 拖拽 ─────────────────────────────

    bindDrag() {
        const handle = this.fab;
        let startX = 0;
        let startY = 0;
        let originX = 0;
        let originY = 0;
        let moved = false;

        const onDown = (e) => {
            if (e.button != null && e.button !== 0) return;
            const point = e.touches ? e.touches[0] : e;
            startX = point.clientX;
            startY = point.clientY;
            const rect = this.root.getBoundingClientRect();
            originX = rect.left;
            originY = rect.top;
            moved = false;
            this._dragging = true;
            this.root.classList.add('is-dragging');
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        };

        const onMove = (e) => {
            if (!this._dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
            const maxX = window.innerWidth - 40;
            const maxY = window.innerHeight - 40;
            const left = Math.min(maxX, Math.max(0, originX + dx));
            const top = Math.min(maxY, Math.max(0, originY + dy));
            this.root.style.left = `${left}px`;
            this.root.style.top = `${top}px`;
        };

        const onUp = () => {
            if (!this._dragging) return;
            this._dragging = false;
            this._suppressClick = moved;
            this.root.classList.remove('is-dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            if (moved) {
                const rect = this.root.getBoundingClientRect();
                this.app.config.ui.fabPos = {
                    x: Math.min(1, Math.max(0, rect.left / window.innerWidth)),
                    y: Math.min(1, Math.max(0, rect.top / window.innerHeight)),
                };
                this.app.saveSettings();
                this.applyPosition();
            }
        };

        handle.addEventListener('pointerdown', onDown);
        // 阻止拖动时选中文字
        handle.addEventListener('dragstart', (e) => e.preventDefault());
    }

    // ───────────────────────────── 面板 ─────────────────────────────

    buildPanel() {
        const app = this.app;

        const header = h('div.st-timer-panel__head', [
            h('div.st-timer-panel__title', [
                h('span.st-timer-panel__icon', '⏱'),
                h('span', '事件计时器'),
            ]),
            h('div.st-timer-panel__actions', [
                h('button.st-timer-btn.st-timer-btn--ghost', {
                    type: 'button', title: '设置', onclick: () => app.ui?.openSettings?.(),
                }, '⚙'),
                h('button.st-timer-btn.st-timer-btn--ghost', {
                    type: 'button', title: '收起', onclick: () => this.toggle(false),
                }, '✕'),
            ]),
        ]);

        this.clockBox = h('div.st-timer-clock');
        this.dueEl = h('div.st-timer-due');
        this.listEl = h('div.st-timer-list');

        const footer = h('div.st-timer-panel__foot', [
            h('button.st-timer-btn', { type: 'button', onclick: () => this.quickAdvance(60) }, '+1时'),
            h('button.st-timer-btn', { type: 'button', onclick: () => this.quickAdvance(1440) }, '+1天'),
            h('button.st-timer-btn', { type: 'button', onclick: () => this.quickAdvance(-60) }, '-1时'),
            // 「重算」删掉了：设置 → 高级 → 数据里已经有「从聊天记录重算」，同一个动作
            // 不该在界面上摆两份。
            h('button.st-timer-btn.st-timer-btn--primary', { type: 'button', onclick: () => this.openAddDialog() }, '+ 新事件'),
        ]);

        append(this.panel, [header, this.clockBox, this.dueEl, this.listEl, footer]);
    }

    quickAdvance(minutes) {
        this.app.engine.advanceClock(minutes, minutes > 0 ? `面板快进 ${formatDuration(minutes)}` : `面板回拨 ${formatDuration(-minutes)}`);
        this.app.refreshInjection({ commit: false });
        this.app.saveState();
        this.app.notify();
    }

    // ───────────────────────────── 渲染 ─────────────────────────────

    render() {
        if (!this.root) return;
        this.applyVisibility();

        const app = this.app;
        const cfg = app.config;
        const clock = app.engine.clock;
        const snapshot = app.engine.snapshot();

        // 展示文本统一走引擎的时间门面：计数制显示「第3天 14:30」，日历制显示「1247年3月15日 14:30」
        const clockText = snapshot.clockText ?? app.engine.formatClock(clock);
        if (this.clockEl) this.clockEl.textContent = cfg.ui.fabContent === 'count' ? '' : clockText;

        const dueCount = snapshot.due.length;
        const activeCount = snapshot.active.length;
        if (this.badgeEl) {
            const show = cfg.ui.fabContent !== 'clock' && (dueCount || activeCount);
            this.badgeEl.hidden = !show;
            this.badgeEl.textContent = String(dueCount || activeCount);
            this.badgeEl.classList.toggle('is-due', dueCount > 0);
        }
        const sub = this.fab?.querySelector('.st-timer-fab__sub');
        if (sub) {
            if (dueCount) sub.textContent = `${dueCount} 项到期`;
            else if (activeCount) {
                const soonest = snapshot.nextDueMinutes;
                sub.textContent = soonest != null ? `最近 ${formatDuration(Math.max(0, soonest), { maxUnits: 1 })}` : `${activeCount} 项进行中`;
            } else {
                sub.textContent = cfg.enabled ? '暂无事件' : '已停用';
            }
        }
        this.fab?.classList.toggle('is-disabled', !cfg.enabled);
        this.fab?.classList.toggle('has-due', dueCount > 0);

        if (!this._open) return;

        // ── 时钟区 ──
        clear(this.clockBox);
        append(this.clockBox, [
            h('div.st-timer-clock__value', clockText),
            h('div.st-timer-clock__meta', [
                `第 ${app.engine.turns} 轮`,
                activeCount ? `· ${activeCount} 项进行中` : '· 无进行中事件',
                dueCount ? `· ${dueCount} 项到期` : '',
            ].filter(Boolean).join(' ')),
            h('div.st-timer-clock__edit', [
                h('button.st-timer-btn.st-timer-btn--tiny', {
                    type: 'button', title: '修改起始时间', onclick: () => this.openClockDialog(),
                }, '校时'),
            ]),
        ]);

        // ── 到期区 ──
        clear(this.dueEl);
        if (dueCount) {
            append(this.dueEl, [
                h('div.st-timer-due__title', `⚠ ${dueCount} 项事件已经到期`),
                h('div.st-timer-due__hint', '下一轮生成时，提醒会自动注入给 AI。'),
                ...snapshot.due.map((ev) => h('div.st-timer-due__item', `《${ev.title}》 ${formatCountdown(ev.remainingMinutes)}`)),
            ]);
            append(this.dueEl, [
                h('div.st-timer-due__actions', [
                    h('button.st-timer-btn.st-timer-btn--tiny', {
                        type: 'button', onclick: () => app.pushReminderToInput(),
                    }, '复制到输入框'),
                    h('button.st-timer-btn.st-timer-btn--tiny', {
                        type: 'button', onclick: () => app.refreshInjection({ commit: true, forceProtocol: false }),
                    }, '标记已提醒'),
                ]),
            ]);
        } else {
            append(this.dueEl, h('div.st-timer-due__empty', '没有到期的等待项'));
        }

        // ── 事件列表 ──
        clear(this.listEl);
        if (!snapshot.active.length) {
            append(this.listEl, h('div.st-timer-empty', '暂无进行中的事件。AI 在正文里声明耗时事件后会自动出现在这里。'));
        } else {
            for (const ev of snapshot.active) append(this.listEl, this.renderEventCard(ev));
        }

        if (snapshot.finished.length) {
            append(this.listEl, h('details.st-timer-finished', [
                h('summary', `已结束（${snapshot.finished.length}）`),
                ...snapshot.finished.map((ev) => h('div.st-timer-finished__item', [
                    h('span.st-timer-finished__title', `《${ev.title}》`),
                    h('span.st-timer-finished__result', ev.result || (ev.status === 'cancelled' ? '已取消' : '已完成')),
                ])),
            ]));
        }

        // 注入内容不在面板里显示了 —— 它现在如实折叠在聊天记录里
        // （用户消息 → 计时注入；AI 消息 → 计时输出），那里才对得上每一回合。

        // 面板每次刷新都重建，酒馆自己的 applyLocale 管不到，自己翻一遍
        localizeDom(this.root);
    }

    renderEventCard(ev) {
        const app = this.app;
        // 到点提醒已经发出去、还在等 AI 在正文里交代 → 说清楚现在在等什么
        const told = typeof ev.dueNotifiedTurn === 'number' && ev.dueNotifiedTurn >= 0;
        const statusText = ev.status === 'due'
            ? (told ? '已提醒·等正文交代' : '已到期')
            : (ev.overdue ? '已超时' : '进行中');
        const statusClass = ev.status === 'due' ? 'is-due' : 'is-pending';

        const rows = [];
        if (ev.expectation) rows.push(['预期', ev.expectation, 'reward']);
        if (ev.variables) rows.push(['变数', ev.variables, 'risk']);
        if (ev.ledger) rows.push(['资源', ev.ledger, 'note']);
        if (ev.outline) rows.push(['要点', ev.outline, 'note']);
        if (ev.note) rows.push(['详情', ev.note, 'note']);

        // 时长摘要：上面那行已经在显示「剩余 X」了，这里只留「共 Y」，
        // 被调整过时再补一行「原定 → 现」。原来这里重复印了一次「剩余」。
        const d = app.engine.describeDuration(ev);
        const durationLine = `共 ${formatDuration(d.total, { maxUnits: 2 })}`;
        const adjustLine = d.delta !== 0
            ? `原定 ${formatDuration(d.initial, { maxUnits: 2 })} → 现 ${formatDuration(d.total, { maxUnits: 2 })}（${d.delta > 0 ? '+' : '−'}${formatDuration(Math.abs(d.delta), { maxUnits: 2 })}，第 ${d.reschedules} 次顺延）`
            : null;

        // 提醒时刻表：全显示，已经过去的那几个淡化，发过的加个 ✓
        const schedule = app.engine.reminderSchedule(ev);
        const scheduleLine = schedule.length
            ? h('div.st-timer-card__schedule', schedule.map((slot) => h(
                `span.st-timer-card__slot${slot.passed ? '.is-past' : ''}${slot.fired ? '.is-fired' : ''}`,
                { title: `${slot.label}：${slot.text}${slot.fired ? '（已提醒）' : slot.passed ? '（已过）' : ''}` },
                `${slot.fired ? '✓ ' : ''}${slot.label} ${slot.text}`,
            )))
            : null;

        return h(`div.st-timer-card.${statusClass}`, [
            h('div.st-timer-card__head', [
                h('span.st-timer-card__title', `《${ev.title}》`),
                h('span.st-timer-card__status', statusText),
            ]),
            h('div.st-timer-card__timer', [
                h('span.st-timer-card__countdown', formatCountdown(ev.remainingMinutes)),
                h('span.st-timer-card__due', `预定 ${ev.dueText}`),
            ]),
            h('div.st-timer-card__duration', durationLine),
            adjustLine ? h('div.st-timer-card__adjust', adjustLine) : null,
            scheduleLine,
            h('div.st-timer-progress', [
                h('div.st-timer-progress__bar', { style: { width: `${ev.progress}%` } }),
                h('span.st-timer-progress__label', `${ev.progress}%${ev.progressIsEstimate ? '（估算）' : ''}`),
            ]),
            rows.length ? h('dl.st-timer-card__fields', rows.flatMap(([label, value, cls]) => [
                h(`dt.st-timer-card__label.is-${cls}`, label),
                h(`dd.st-timer-card__value.is-${cls}`, { title: value }, value),
            ])) : null,
            ev.manual ? h('div.st-timer-card__tag', '手动添加') : null,
            ev.source === 'regex' ? h('div.st-timer-card__tag', '正则识别') : null,
            h('div.st-timer-card__actions', [
                h('button.st-timer-btn.st-timer-btn--tiny', {
                    type: 'button',
                    onclick: () => {
                        const result = prompt(`《${ev.title}》的结果是？`, ev.result || '');
                        if (result == null) return;
                        app.engine.resolveEvent(ev.id, { result });
                        app.refreshInjection({ commit: false });
                        app.saveState();
                        app.notify();
                    },
                }, '完成'),
                h('button.st-timer-btn.st-timer-btn--tiny', {
                    type: 'button', onclick: () => this.openEditDialog(ev),
                }, '编辑'),
                h('button.st-timer-btn.st-timer-btn--tiny', {
                    type: 'button', onclick: () => this.openEventMenu(ev),
                }, '…'),
            ]),
        ]);
    }

    // ───────────────────────────── 简易对话框 ─────────────────────────────

    /** 用原生 UI 拼一个轻量表单弹窗（避免依赖酒馆的 popup 组件） */
    openForm({ title, fields, submitText = '保存', onSubmit }) {
        const overlay = h('div.st-timer-modal');
        const inputs = {};

        const body = fields.map((field) => {
            const id = `st-timer-field-${field.key}`;
            let control;
            if (field.type === 'textarea') {
                control = h('textarea', { id, rows: field.rows || 2, placeholder: field.placeholder || '' });
                control.value = field.value ?? '';
            } else if (field.type === 'number') {
                control = h('input', { id, type: 'number', placeholder: field.placeholder || '' });
                control.value = field.value ?? '';
            } else if (field.type === 'clock') {
                control = h('input', { id, type: 'text', placeholder: '第3天 14:30' });
                control.value = field.value ?? '';
            } else {
                control = h('input', { id, type: 'text', placeholder: field.placeholder || '' });
                control.value = field.value ?? '';
            }
            inputs[field.key] = control;
            return h('label.st-timer-field', [
                h('span.st-timer-field__label', field.label),
                control,
                field.hint ? h('span.st-timer-field__hint', field.hint) : null,
            ]);
        });

        const close = () => overlay.remove();

        const dialog = h('form.st-timer-modal__box', {
            onsubmit: (e) => {
                e.preventDefault();
                const values = {};
                for (const [key, el] of Object.entries(inputs)) values[key] = el.value;
                const ok = onSubmit(values);
                if (ok !== false) close();
            },
        }, [
            h('div.st-timer-modal__head', [
                h('span', title),
                h('button.st-timer-btn.st-timer-btn--ghost', { type: 'button', onclick: close }, '✕'),
            ]),
            h('div.st-timer-modal__body', body),
            h('div.st-timer-modal__foot', [
                h('button.st-timer-btn', { type: 'button', onclick: close }, '取消'),
                h('button.st-timer-btn.st-timer-btn--primary', { type: 'submit' }, submitText),
            ]),
        ]);

        overlay.appendChild(dialog);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        // 和 openModal 一样：弹窗里的操作不许冒到 document（酒馆在那儿挂了全局委托）
        shieldOverlay(overlay, close);
        document.body.appendChild(overlay);
        setTimeout(() => dialog.querySelector('input,textarea')?.focus(), 30);
        return { close, inputs };
    }

    openAddDialog() {
        const app = this.app;
        this.openForm({
            title: '添加一个耗时事件',
            fields: [
                { key: 'title', label: '事件名称', placeholder: '例如：熬制解毒药' },
                { key: 'duration', label: '需要多久', value: '2小时', hint: '支持 3天 / 6小时 / 一炷香 / 一个月；也可写「第5天 09:00」' },
                { key: 'reward', label: '预期收益', placeholder: '例如：伤势好转' },
                { key: 'risk', label: '风险', placeholder: '例如：被巡逻队发现' },
                { key: 'loss', label: '失败损失', placeholder: '例如：药材全部报废' },
                { key: 'note', label: '详情', type: 'textarea' },
            ],
            onSubmit: (values) => {
                if (!values.title.trim()) {
                    app.host.toast?.('请填写事件名称', 'warning');
                    return false;
                }
                const parsed = parseDurationInput(values.duration, app.engine.clock, app.engine.formatter);
                const input = {
                    title: values.title.trim(),
                    reward: values.reward,
                    risk: values.risk,
                    loss: values.loss,
                    note: values.note,
                    source: 'manual',
                };
                if (parsed.clock) {
                    input.dueClock = parsed.clock;
                } else if (!parsed.minutes) {
                    // 「需要多久」现在是**必填**的。
                    //
                    // 以前这里会兜底成 time.defaultEventMinutes（60 分钟），那个兜底已删除：
                    // 一个没有时长的事件根本没有到期时间，跟踪不了；替用户编一个
                    // 「1 小时」只会让他以为事件建好了。宁可当场说清楚。
                    app.host.toast?.('请填「需要多久」，或者直接填一个到期时间', 'warning');
                    return false;
                } else {
                    input.durationMinutes = parsed.minutes;
                    if (parsed.parts?.length) input.durationParts = parsed.parts;
                }

                const ev = app.engine.addEvent(input);
                if (ev) {
                    app.engine.refreshStatuses();
                    app.refreshInjection({ commit: false });
                    app.saveState();
                    app.notify();
                }
                return true;
            },
        });
    }

    openEditDialog(ev) {
        const app = this.app;
        this.openForm({
            title: `编辑《${ev.title}》`,
            fields: [
                { key: 'title', label: '事件名称', value: ev.title },
                { key: 'duration', label: '改为多久后完成', value: formatDuration(ev.durationMinutes, { maxUnits: 2 }), hint: '留空表示不改' },
                { key: 'reward', label: '预期收益', value: ev.reward },
                { key: 'risk', label: '风险', value: ev.risk },
                { key: 'loss', label: '失败损失', value: ev.loss },
                { key: 'progress', label: '进度（0-100）', value: ev.progress ?? '' },
                { key: 'note', label: '详情', type: 'textarea', value: ev.note },
            ],
            onSubmit: (values) => {
                const patch = {
                    title: values.title.trim() || ev.title,
                    reward: values.reward,
                    risk: values.risk,
                    loss: values.loss,
                    note: values.note,
                };
                if (String(values.progress).trim() !== '') patch.progress = Number(values.progress);
                if (values.duration.trim()) {
                    const engine = app.engine;
                    const parsed = parseDurationInput(values.duration, engine.clock, engine.formatter);
                    if (parsed.clock) patch.dueClock = parsed.clock;
                    else if (parsed.minutes != null) {
                        // 日历模式下走精确的年/月加法
                        patch.dueClock = engine.formatter.applyDuration(
                            engine.clock,
                            parsed.parts ?? [],
                            parsed.minutes,
                        );
                    }
                }
                app.engine.updateEvent(ev.id, patch);
                app.refreshInjection({ commit: false });
                app.saveState();
                app.notify();
                return true;
            },
        });
    }

    /**
     * 事件的「…」菜单。
     *
     * ⚠️ 原来这里是个**输入编号**的输入框（1=立即完成 2=取消事件 3=删除 4=重置提醒次数）。
     * 三个问题：
     *   · 有哪些操作得靠一行提示去读，认不出来；
     *   · 「1=立即完成」和卡片上已有的「完成」按钮是同一件事；
     *   · 删除这种不可逆操作**没有二次确认**，输错一个数字就没了。
     * 现在改成真正的按钮，删除带确认。
     */
    openEventMenu(ev) {
        const app = this.app;
        const run = (fn) => {
            fn();
            app.refreshInjection({ commit: false });
            app.saveState();
            app.notify();
        };

        const rows = [
            ['状态', ev.status],
            ['创建', ev.createdText],
            ['到期', `${ev.dueText}（${formatCountdown(ev.remainingMinutes)}）`],
            ['来源', ev.source],
            ['已提醒', `${ev.notifyCount} 次`],
        ];

        openModal({
            title: `《${ev.title}》`,
            width: 'min(420px, 94vw)',
            build: () => [
                h('dl.st-timer-card__fields', rows.flatMap(([label, value]) => [
                    h('dt.st-timer-card__label', label),
                    h('dd.st-timer-card__value', value),
                ])),
            ],
            buttons: [
                { label: '关闭' },
                {
                    label: '重置提醒次数',
                    onClick: () => run(() => app.engine.resetReminder(ev.id)),
                },
                {
                    label: '取消事件',
                    onClick: () => run(() => app.engine.cancelEvent(ev.id)),
                },
                {
                    label: '删除',
                    danger: true,
                    onClick: () => {
                        if (!confirm(`删除《${ev.title}》？这一步不能撤销。`)) return false;
                        run(() => app.engine.removeEvent(ev.id));
                    },
                },
            ],
        });
    }

    openClockDialog() {
        const app = this.app;
        const clock = app.engine.initialClock;
        const isCalendar = app.engine.formatter.isCalendar;
        this.openForm({
            title: '设置本场聊天的起始时间',
            fields: [
                {
                    key: 'clock',
                    label: '起始时间',
                    value: app.engine.formatClock(clock),
                    hint: isCalendar
                        ? '格式：1247年3月15日 14:30 / 1247-03-15 / 明天早上 / 下个月。改完会从聊天记录重新推演。'
                        : '格式：第3天 14:30 / Day 3, 14:30 / 三天后 / 明天早上。改完会从聊天记录重新推演。',
                },
                {
                    key: 'current',
                    label: '或直接设为当前时间',
                    value: '',
                    hint: `当前：${app.engine.formatClock(app.engine.clock)}。填了就以这里为准。`,
                },
            ],
            onSubmit: (values) => {
                const target = values.current.trim() || values.clock.trim();
                const clockValue = app.engine.formatter.parse(target, app.engine.clock);
                if (!clockValue) {
                    app.host.toast?.(
                        isCalendar ? '无法识别，试试「1247年3月15日 14:30」' : '无法识别，试试「第3天 14:30」',
                        'warning',
                    );
                    return false;
                }
                app.engine.setInitialClock(clockValue);
                app.rebuild({ reason: 'manual-clock' });
                return true;
            },
        });
    }
}

/**
 * 把用户输入解析成 { clock }（绝对时间）或 { minutes }（相对时长）。
 * @param {string} text
 * @param {{day:number,minute:number}} [reference] 参考时钟，用于补全缺失的日期
 * @param {any} [formatter] 时间门面（传了就支持日历制的「1247年3月15日」）
 */
export function parseDurationInput(text, reference, formatter) {
    const raw = String(text ?? '').trim();
    if (!raw) return {};
    const ref = reference || { day: 1, minute: 480 };

    // 日历模式：交给门面判断是不是日期
    if (formatter?.isCalendar) {
        const looksLikeDate = /\d{1,5}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}|大后天|后天|明天|次日|翌日|今天|当天|明年|去年|下个?月|这个月|本月|上个月|上月|\d{1,2}\s*[:：]\s*\d{1,2}/.test(raw);
        if (looksLikeDate) {
            const clock = formatter.parse(raw, ref);
            if (clock) return { clock };
        }
        const duration = parseDuration(raw);
        if (duration) return { minutes: duration.minutes, raw: duration.raw, parts: duration.parts };
        return {};
    }

    const looksAbsolute = /(?:第|Day\s*|D)\s*\d/i.test(raw)
        || /[明后次翌今当][天日]/.test(raw)
        || /\d{1,2}\s*[:：]\s*\d{1,2}/.test(raw)
        || /(?:凌晨|清晨|早晨|早上|上午|中午|正午|下午|傍晚|黄昏|晚上|深夜)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*[点时]/i.test(raw);

    if (looksAbsolute) {
        const clock = parseAbsoluteClock(raw, ref);
        if (clock) return { clock };
    }

    const duration = parseDuration(raw);
    if (duration) return { minutes: duration.minutes, raw: duration.raw, parts: duration.parts };

    if (looksAbsolute) {
        const clock = parseAbsoluteClock(raw, ref);
        if (clock) return { clock };
    }
    return {};
}

/** 纯展示用的时间文本（保留旧签名，方便外部调用） */
export function clockText(clock, dayLabel) {
    return formatClock(clock, { dayLabel });
}

/** 计算剩余文本（面板 / 外部调用） */
export function remainingText(ev, clock) {
    return formatCountdown(diffMinutes(ev.dueClock, clock));
}

export { escapeHtml, addMinutes };
