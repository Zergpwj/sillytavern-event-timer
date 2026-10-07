/**
 * 极简 DOM 辅助函数。不引第三方库，避免和其它扩展抢全局变量。
 */

/**
 * 创建元素。
 * @param {string} tag 支持 `div.class#id` 简写
 * @param {object|string|null} [props] 属性对象，或直接给文本
 * @param {Array<Node|string>} [children]
 */
export function h(tag, props = null, children = []) {
    const m = String(tag).match(/^([a-zA-Z0-9-]+)((?:[.#][\w-]+)*)$/);
    const name = m ? m[1] : 'div';
    const el = document.createElement(name);

    if (m && m[2]) {
        for (const token of m[2].match(/[.#][\w-]+/g) || []) {
            if (token[0] === '.') el.classList.add(token.slice(1));
            else el.id = token.slice(1);
        }
    }

    // 第二个参数允许是：props 对象 / 纯文本 / 直接给子节点数组。
    // 注意数组也是 `typeof === 'object'`，必须先判掉，否则会被当成 props 逐项 setAttribute，
    // 子节点就永远挂不上去（这是个很容易踩的坑）。
    if (Array.isArray(props) || (typeof Node !== 'undefined' && props instanceof Node)) {
        children = props;
        props = null;
    } else if (typeof props === 'string' || typeof props === 'number') {
        el.textContent = String(props);
        props = null;
    }

    if (props && typeof props === 'object') {
        for (const [key, value] of Object.entries(props)) {
            if (value == null || value === false) continue;
            if (key === 'class' || key === 'className') {
                for (const c of String(value).split(/\s+/).filter(Boolean)) el.classList.add(c);
            } else if (key === 'style' && typeof value === 'object') {
                Object.assign(el.style, value);
            } else if (key === 'dataset' && typeof value === 'object') {
                Object.assign(el.dataset, value);
            } else if (key === 'text') {
                el.textContent = String(value);
            } else if (key === 'html') {
                el.innerHTML = String(value);
            } else if (key.startsWith('on') && typeof value === 'function') {
                el.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (key === 'value') {
                el.value = value;
            } else if (key === 'checked' || key === 'disabled' || key === 'hidden') {
                el[key] = !!value;
            } else {
                el.setAttribute(key, String(value));
            }
        }
    }

    append(el, children);
    return el;
}

/** 追加子节点（自动跳过 null / false） */
export function append(parent, children) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
        if (child == null || child === false) continue;
        if (Array.isArray(child)) append(parent, child);
        else if (child instanceof Node) parent.appendChild(child);
        else parent.appendChild(document.createTextNode(String(child)));
    }
    return parent;
}

/** 清空子节点 */
export function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

/** 转义 HTML */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 轻量 toast（不依赖酒馆的 toastr，但优先用它）
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type]
 */
export function toast(message, type = 'info') {
    const g = globalThis;
    try {
        if (g.toastr && typeof g.toastr[type] === 'function') {
            g.toastr[type](String(message), '事件计时器');
            return;
        }
    } catch { /* 忽略 */ }

    let host = document.getElementById('st-timer-toasts');
    if (!host) {
        host = h('div#st-timer-toasts.st-timer-toasts');
        document.body.appendChild(host);
    }
    const item = h(`div.st-timer-toast.st-timer-toast--${type}`, String(message));
    host.appendChild(item);
    setTimeout(() => {
        item.classList.add('is-leaving');
        setTimeout(() => item.remove(), 300);
    }, 3200);
}

/**
 * 复制文本到剪贴板。
 *
 * 注意：`navigator.clipboard` 在**非安全上下文**里根本不存在
 * （例如用 http://192.168.x.x:8000 从手机访问酒馆时）。
 * 所以必须做能力探测 + 老式 execCommand 兜底，
 * 不能写 `navigator.clipboard?.writeText(x).then(...)` ——
 * clipboard 为 undefined 时那会对 undefined 调 .then 直接抛错。
 *
 * @param {string} text
 * @returns {Promise<boolean>} 是否成功
 */
export async function copyText(text) {
    const value = String(text ?? '');

    try {
        if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch { /* 落到下面的兜底 */ }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select?.();
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        textarea.remove();
        return !!ok;
    } catch {
        return false;
    }
}

/** 简易事件总线 */
export class Emitter {
    constructor() { this._map = new Map(); }
    on(type, fn) {
        if (!this._map.has(type)) this._map.set(type, new Set());
        this._map.get(type).add(fn);
        return () => this.off(type, fn);
    }
    off(type, fn) { this._map.get(type)?.delete(fn); }
    emit(type, payload) {
        for (const fn of [...(this._map.get(type) ?? [])]) {
            try { fn(payload); } catch (err) { console.error('[event-timer]', err); }
        }
    }
}
