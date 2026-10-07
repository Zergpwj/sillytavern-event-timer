/**
 * 通用弹窗 —— 设置面板里的几个编辑器（月名、提示词、历法推断）都用它。
 *
 * 用原生 DOM 拼，不依赖酒馆的 Popup 组件，所以独立模式里也能用。
 */

import { h, append, clear } from './dom.js';
import { localizeDom } from './i18n.js';

/**
 * 挡住弹窗里的交互，别让它们冒到 document。
 *
 * ⚠️ 这一层是**必须**的，不是保险。酒馆在 document 上挂了一串全局委托：
 *
 *   public/script.js:12131  `$(document).on('click', '.inline-drawer-toggle', …)`
 *                            → 折叠 / 展开扩展抽屉（slideToggle）
 *   public/script.js:12156  `$(document).on('click', '.inline-drawer-maximize', …)`
 *   public/script.js:10893  doNavbarIconClick（顶层抽屉开关）
 *
 * 而弹窗是 `document.body.appendChild(overlay)`，所以**弹窗里每一次点击都会一路冒到
 * document**，交给上面这些委托去判断靶点。只要命中了什么，酒馆就会收起某个面板 ——
 * 「关掉月名面板，整个扩展跟着一起关」就是这么来的。
 *
 * 在 overlay 上截住之后，弹窗里的操作和酒馆的全局委托彻底隔开。
 * 用 stopPropagation 而不是 stopImmediatePropagation：**弹窗自己**挂在同一个
 * overlay 上的处理器（比如「点空白处关闭」）仍然照常运行。
 *
 * @param {HTMLElement} overlay
 * @param {() => void} [onEscape] 弹窗内部的 Esc 处理；给了就在这一层处理掉，不再外传
 */
export function shieldOverlay(overlay, onEscape) {
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
        overlay.addEventListener(type, (e) => e.stopPropagation());
    }
    if (typeof onEscape !== 'function') return;
    overlay.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onEscape();
    });
}

/**
 * @param {{
 *   title: string,
 *   build: (api: any) => any[],
 *   buttons?: Array<{ label: string, primary?: boolean, danger?: boolean, onClick?: (api:any)=>void|boolean }>,
 *   width?: string,
 *   onClose?: () => void,
 * }} options
 * @returns {{ close: () => void, setStatus: (text: string, kind?: string) => void, setBusy: (busy: boolean) => void, root: HTMLElement }}
 */
export function openModal(options) {
    const overlay = h('div.st-timer-modal');
    const body = h('div.st-timer-modal__body');
    const statusEl = h('div.st-timer-modal__status');
    const foot = h('div.st-timer-modal__foot');

    let closed = false;
    const api = {
        close,
        body,
        statusEl,
        setStatus(text, kind = 'info') {
            statusEl.textContent = String(text ?? '');
            statusEl.dataset.kind = kind;
            statusEl.hidden = !text;
        },
        setBusy(busy) {
            overlay.classList.toggle('is-busy', !!busy);
            for (const btn of foot.querySelectorAll('button')) btn.disabled = !!busy;
        },
    };

    function close() {
        if (closed) return;
        closed = true;
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        options.onClose?.();
    }

    function onKey(e) {
        if (e.key === 'Escape') close();
    }

    const box = h('div.st-timer-modal__box', {
        style: options.width ? { width: options.width } : undefined,
    });

    append(box, [
        h('div.st-timer-modal__head', [
            h('span', options.title ?? ''),
            h('button.st-timer-btn.st-timer-btn--ghost', { type: 'button', onclick: close, title: '关闭' }, '✕'),
        ]),
        body,
        statusEl,
        foot,
    ]);

    append(body, options.build(api) ?? []);

    for (const btn of options.buttons ?? [{ label: '关闭' }]) {
        foot.appendChild(h(
            `button.st-timer-btn${btn.primary ? '.st-timer-btn--primary' : ''}${btn.danger ? '.st-timer-btn--danger' : ''}`,
            {
                type: 'button',
                onclick: () => {
                    const keep = btn.onClick?.(api);
                    if (keep !== false) close();
                },
            },
            btn.label,
        ));
    }

    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    // 弹窗里的一切都不许冒到 document（见 shieldOverlay 的说明）
    shieldOverlay(overlay, close);
    document.body.appendChild(overlay);
    // 焦点不在弹窗里时（比如刚点过空白处）Esc 仍然要能关掉
    document.addEventListener('keydown', onKey);

    // 弹窗内容是动态建的，酒馆自己的 applyLocale 管不到，自己翻一遍
    localizeDom(box);

    return { ...api, root: box };
}

/** 一行「标签 + 控件」 */
export function field(label, control, hint) {
    return h('label.st-timer-field', [
        h('span.st-timer-field__label', label),
        control,
        hint ? h('span.st-timer-field__hint', hint) : null,
    ]);
}

/** 弹窗里的输入控件 */
export function textInput(value, placeholder = '', onInput = null) {
    // ⚠️ 必须带 .st-timer-input —— 宽度规则全都挂在这个 class 上。
    // 早先这里漏了，弹窗里的输入框没有任何宽度约束，
    // 替换元素又不会被 flex 的 align-items:stretch 撑开，就只能用浏览器默认宽度。
    const el = h('input.st-timer-input', { type: 'text', placeholder });
    el.value = value ?? '';
    if (onInput) el.addEventListener('input', () => onInput(el.value));
    return el;
}

export function textArea(value, rows = 6, placeholder = '') {
    const el = h('textarea.st-timer-input', { rows, placeholder });
    el.value = value ?? '';
    return el;
}

export function checkbox(label, checked) {
    const input = h('input', { type: 'checkbox' });
    input.checked = !!checked;
    const wrap = h('label.st-timer-settings__check', [input, h('span', label)]);
    wrap.input = input;
    return wrap;
}

export function select(options, value) {
    const el = h('select.st-timer-input');
    for (const [val, text] of options) {
        const opt = h('option', { value: val }, text);
        if (String(val) === String(value)) opt.selected = true;
        el.appendChild(opt);
    }
    return el;
}

export { clear, h, append };
