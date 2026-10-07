/**
 * 计时器 —— 酒馆扩展入口。
 *
 * 这一层只做三件事：
 *   1. 探测宿主（酒馆 / 通用浏览器）；
 *   2. 组装 App、悬浮按钮、设置面板；
 *   3. 注册斜杠命令，并暴露 `window.StoryTimer` 给其它扩展 / 脚本调用。
 *
 * 真正的逻辑全在 core/（纯算法）与 app.js（装配）里，方便移植到别的应用。
 */

import { isSillyTavern, describeSTCapabilities, getSTContext } from './host/bridge.js';
import { createSillyTavernHost } from './host/sillytavern.js';
import { createGenericHost } from './host/generic.js';
import { TimerApp } from './app.js';
import { FloatingUI } from './ui/floating.js';
import { SettingsUI } from './ui/settings.js';
import { withSlashCommands } from './slash.js';
import { loadLocale } from './ui/i18n.js';
import { MessageBlocks } from './ui/message-blocks.js';

const LOG_PREFIX = '[事件计时器]';

/** 生成宿主实例 */
function pickHost() {
    if (isSillyTavern()) {
        console.log(LOG_PREFIX, '检测到 SillyTavern 宿主', describeSTCapabilities());
        return createSillyTavernHost();
    }
    console.warn(LOG_PREFIX, '没有检测到酒馆接口，改用通用宿主（仅界面 + window.StoryTimer API）');
    return createGenericHost();
}

/** 等某个 DOM 节点出现（酒馆的扩展设置区可能比扩展本身晚加载） */
function waitForElement(selector, timeout = 15000, interval = 250) {
    return new Promise((resolve) => {
        const found = document.querySelector(selector);
        if (found) return resolve(found);
        const started = Date.now();
        const timer = setInterval(() => {
            const el = document.querySelector(selector);
            if (el || Date.now() - started > timeout) {
                clearInterval(timer);
                resolve(el ?? null);
            }
        }, interval);
    });
}

let instance = null;

export async function boot() {
    if (instance) return instance;

    // 界面语言：先把词典拉下来（拉不到就当中文，不影响功能），
    // 再建 UI —— 否则第一帧会是中文。
    await loadLocale().catch(() => false);

    const host = pickHost();
    const app = new TimerApp({ host });
    await app.init();

    // ── 常驻悬浮按钮 + 面板 ──
    const floating = new FloatingUI(app);
    floating.mount(document.body);

    // ── 设置抽屉 ──
    const settings = new SettingsUI(app);
    const container = host.getSettingsContainer?.() ?? await waitForElement('#extensions_settings2', 15000);
    if (container) settings.mount(container);
    else console.warn(LOG_PREFIX, '找不到扩展设置容器，设置面板只能在悬浮面板里打开');

    // ── 聊天记录里的注入块 ──
    // 隐形注入是看不见的（走 setExtensionPrompt，不进聊天记录）。
    // 把它如实折叠进消息里：用户消息 → 计时注入；AI 消息 → 计时输出。
    // 跟模型的思考块一个道理。
    const blocks = new MessageBlocks(app);
    blocks.start();

    // 让面板里的 ⚙ 按钮能滚到设置区
    app.ui = {
        floating,
        settings,
        blocks,
        openSettings() {
            const el = settings.root;
            if (!el) return;
            // 用统一的方法展开，保证图标和内容一致（点击本身归酒馆管）
            settings.setCollapsed?.(false);
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('is-highlight');
            setTimeout(() => el.classList.remove('is-highlight'), 1600);
        },
        flash: (events) => floating.flash(events),
    };

    // ── 斜杠命令 ──
    withSlashCommands(app);

    // ── 对外 API ──
    //
    // 两个名字都挂着：
    //   · `window.EventTimer` —— 新名字，改名之后写的脚本用这个
    //   · `window.StoryTimer` —— 老名字，保留着，因为已经有人（包括独立模式
    //     的 example 和别的应用）照它接进来了。改插件名不该把他们的接入点弄断。
    try {
        const api = app.getApi();
        globalThis.EventTimer = api;
        globalThis.StoryTimer = api;
    } catch (err) {
        console.warn(LOG_PREFIX, '暴露 window.EventTimer 失败', err);
    }

    instance = { app, host, floating, settings, blocks };
    console.log(LOG_PREFIX, '已就绪。可用 window.EventTimer（旧名 window.StoryTimer 也还在）调用 API，或输入 /timer 查看状态。');
    return instance;
}

// 酒馆以 <script type="module"> 加载本文件，DOM 此时通常已经就绪；
// 但仍然用 readyState 兜一下，避免极端情况下挂载失败。
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        boot().catch((err) => console.error(LOG_PREFIX, '启动失败', err));
    }, { once: true });
} else {
    boot().catch((err) => console.error(LOG_PREFIX, '启动失败', err));
}

// 卸载时清理（酒馆热重载 / 页面切换）
globalThis.addEventListener?.('pagehide', () => {
    instance?.floating?.unmount?.();
    instance?.settings?.unmount?.();
    instance?.blocks?.stop?.();
    instance = null;
});

export { getSTContext };
