/**
 * 极简的界面本地化。
 *
 * 为什么不用酒馆自己的 i18n：
 *   酒馆是靠 `applyLocale(document)` 遍历 `[data-i18n]` 属性来翻译的，
 *   只在启动和切换语言那一刻跑一次。而本插件的面板是**按需重建**的
 *   （改个设置就重渲染），新建出来的节点不会被它翻译。
 *
 * 所以这里自己做一份：中文原文 → 译文的扁平字典 + 一次 DOM 遍历。
 * 好处是**不用把几百条界面文案抽成 key** —— 直接对着现有中文字符串翻译即可。
 *
 * 语言来源（按优先级）：
 *   1. localStorage('language')  —— 酒馆写在这里
 *   2. navigator.language
 *   3. 默认中文（不翻译）
 */

const ZH = 'zh-cn';

let locale = ZH;
let dict = null;
let loadPromise = null;

/** 目前生效的语言 id */
export function currentLocale() {
    return locale;
}

/** 是不是非中文界面（需要翻译） */
export function isTranslated() {
    return !!dict && Object.keys(dict).length > 0;
}

/** 把 'en-us' / 'en' / 'zh-cn' 归一化成我们支持的两个桶 */
function normalizeLocale(raw) {
    const s = String(raw ?? '').toLowerCase().trim();
    if (!s) return ZH;
    if (s.startsWith('zh')) return ZH;
    if (s.startsWith('en')) return 'en';
    return ZH;
}

/** 探测当前界面语言 */
export function detectLocale() {
    try {
        const fromStorage = globalThis.localStorage?.getItem?.('language');
        if (fromStorage) return normalizeLocale(fromStorage);
    } catch { /* 隐私模式等，忽略 */ }
    return normalizeLocale(globalThis.navigator?.language);
}

/** 直接塞一份字典（测试和独立模式用） */
export function setDictionary(map, id = 'en') {
    dict = map && typeof map === 'object' ? { ...map } : null;
    locale = dict && Object.keys(dict).length ? id : ZH;
}

/**
 * 按当前语言加载字典。失败就保持不翻译（永远不抛错）。
 * @param {string} [baseUrl] i18n 目录的 URL；默认按本模块位置推导
 */
export function loadLocale(baseUrl) {
    if (loadPromise) return loadPromise;
    const id = detectLocale();
    if (id === ZH) {
        locale = ZH;
        loadPromise = Promise.resolve(false);
        return loadPromise;
    }

    let url;
    try {
        url = baseUrl
            ? new URL(baseUrl, import.meta.url)
            : new URL('../i18n/', import.meta.url);
        url = new URL(`${id}.json`, url);
    } catch {
        loadPromise = Promise.resolve(false);
        return loadPromise;
    }

    loadPromise = (async () => {
        try {
            const res = await fetch(url.href);
            if (!res?.ok) return false;
            const data = await res.json();
            setDictionary(data, id);
            return true;
        } catch {
            // 加载不到就当没有 —— 界面保持中文，不影响功能
            return false;
        }
    })();
    return loadPromise;
}

/** 查一条译文；没有就返回原文 */
export function t(text) {
    if (!dict) return text;
    const key = String(text);
    return Object.hasOwn(dict, key) ? dict[key] : text;
}

const ATTRS = ['title', 'placeholder', 'aria-label'];

/**
 * 就地翻译一棵 DOM 子树。
 *
 * 只替换**整段文本恰好等于某个键**的文本节点 —— 不做子串替换，
 * 免得把「剩余 3 小时」这种拼接出来的句子翻坏。
 * 前后空白会保留。
 */
export function localizeDom(root) {
    if (!dict || !root) return root;
    visit(root);
    return root;
}

function visit(node) {
    if (!node) return;

    if (node.nodeType === 1) {
        for (const attr of ATTRS) {
            const value = node.getAttribute?.(attr);
            if (value && Object.hasOwn(dict, value)) node.setAttribute(attr, dict[value]);
        }
    }

    const children = node.childNodes ? [...node.childNodes] : [];
    for (const child of children) {
        if (child.nodeType === 3) {
            const raw = child.nodeValue ?? '';
            const trimmed = raw.trim();
            if (trimmed && Object.hasOwn(dict, trimmed)) {
                const lead = raw.slice(0, raw.indexOf(trimmed));
                const tail = raw.slice(raw.indexOf(trimmed) + trimmed.length);
                child.nodeValue = lead + dict[trimmed] + tail;
            }
        } else {
            visit(child);
        }
    }
}

/** 仅供测试：清掉已加载的字典 */
export function resetLocale() {
    dict = null;
    locale = ZH;
    loadPromise = null;
}
