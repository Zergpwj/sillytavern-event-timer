/**
 * 宿主探测 —— 判断当前跑在哪个 AI 角色扮演应用里。
 *
 * 酒馆从 1.12 起把对外接口挂在 `globalThis.SillyTavern`（`{ libs, getContext }`），
 * 这是最稳的接入点：不依赖脆弱的相对导入路径，也不会因为目录层级变化而失效。
 * 拿不到就走通用宿主（浏览器 / 其它应用 / 用户脚本）。
 */

/** 酒馆 extension_prompt_types 的数值（源码 script.js 中定义，长期稳定） */
export const PROMPT_POSITION = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

/** 酒馆 extension_prompt_roles 的数值 */
export const PROMPT_ROLE = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

/**
 * 取酒馆 context。
 * 注意：`getContext()` 每次返回的是**当前**模块变量的快照，
 * `chat` / `chatMetadata` 在切换聊天时会被整体重新赋值，所以**绝不能缓存**。
 * @returns {any|null}
 */
export function getSTContext() {
    const st = globalThis.SillyTavern;
    if (!st || typeof st.getContext !== 'function') return null;
    try {
        const ctx = st.getContext();
        return ctx && typeof ctx === 'object' ? ctx : null;
    } catch (err) {
        console.warn('[event-timer] SillyTavern.getContext() 调用失败', err);
        return null;
    }
}

/** 是否运行在酒馆里（用真实存在的对象做能力探测，而不是猜版本号） */
export function isSillyTavern() {
    const ctx = getSTContext();
    return !!(ctx && Array.isArray(ctx.chat) && ctx.eventSource && typeof ctx.setExtensionPrompt === 'function');
}

/** 宿主能力清单，便于日志与降级提示 */
export function describeSTCapabilities() {
    const ctx = getSTContext();
    if (!ctx) return { available: false };
    return {
        available: true,
        chat: Array.isArray(ctx.chat),
        chatMetadata: !!ctx.chatMetadata,
        extensionSettings: !!ctx.extensionSettings,
        eventSource: !!ctx.eventSource,
        eventTypes: !!(ctx.eventTypes || ctx.event_types),
        setExtensionPrompt: typeof ctx.setExtensionPrompt === 'function',
        saveMetadataDebounced: typeof ctx.saveMetadataDebounced === 'function',
        saveSettingsDebounced: typeof ctx.saveSettingsDebounced === 'function',
        generateQuietPrompt: typeof ctx.generateQuietPrompt === 'function',
        slashCommands: !!ctx.SlashCommandParser,
        renderExtensionTemplateAsync: typeof ctx.renderExtensionTemplateAsync === 'function',
    };
}

/** 取事件名（兼容 camelCase 的 eventTypes 与旧的 event_types） */
export function stEventName(ctx, name) {
    const types = ctx?.eventTypes || ctx?.event_types;
    if (types && types[name]) return types[name];
    return LEGACY_EVENT_NAMES[name] ?? name;
}

/** 旧版事件字符串常量，作为兜底 */
export const LEGACY_EVENT_NAMES = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    CHAT_LOADED: 'chatLoaded',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_UPDATED: 'message_updated',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    GENERATION_STARTED: 'generation_started',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
    GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
    SETTINGS_LOADED: 'settings_loaded',
};
