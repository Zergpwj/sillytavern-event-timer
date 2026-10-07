/**
 * 配置档案 + 提示词库 —— 纯逻辑，无宿主依赖。
 *
 * 两个概念：
 *   1. **配置档案（profile）**：一整套设置的命名快照。可以绑定到角色卡 / 群聊，
 *      切换对话时自动套用，避免「换个角色卡插件就失效」。
 *   2. **提示词库（prompt library）**：注入用的文案。内置那份叫「默认提示词」，
 *      可以编辑、另存为副本、重命名、删除（内置的不可删）。
 *
 * 设计约束：所有函数都是纯函数，返回新对象，方便单测与撤销。
 */

import { createDefaultConfig, mergeConfig } from './default-config.js';

export const BUILTIN_PROMPT_ID = 'builtin-default';
export const BUILTIN_PROMPT_NAME = '默认提示词';

/** 档案快照里**不**包含的字段（否则会自我嵌套 / 丢库） */
export const PROFILE_EXCLUDED_KEYS = ['profiles', 'prompts'];

// ───────────────────────────── 提示词库 ─────────────────────────────

/** 建一个内置的「默认提示词」条目 */
export function createBuiltinPrompt() {
    return {
        id: BUILTIN_PROMPT_ID,
        name: BUILTIN_PROMPT_NAME,
        builtin: true,
        protocol: null,
        mid: null,
        late: null,
        origin: null,
        due: null,
        reminder: null,
        createdAt: null,
        updatedAt: null,
    };
}

function nowIso() {
    return new Date().toISOString();
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * 规范化提示词库：补齐内置项、保证 active 指向存在的项。
 * @param {any} raw
 */
export function normalizePromptLibrary(raw) {
    const items = Array.isArray(raw?.items) ? raw.items : [];
    const cleaned = [];
    let hasBuiltin = false;

    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id ?? '').trim();
        if (!id) continue;
        if (id === BUILTIN_PROMPT_ID) hasBuiltin = true;
        cleaned.push({
            id,
            name: String(item.name ?? '').trim() || '未命名提示词',
            builtin: id === BUILTIN_PROMPT_ID,
            protocol: item.protocol == null ? null : String(item.protocol),
            mid: item.mid == null ? null : String(item.mid),
            late: item.late == null ? null : String(item.late),
            origin: item.origin == null ? null : String(item.origin),
            due: item.due == null ? null : String(item.due),
            /** 老字段：due 的别名，迁移期保留 */
            reminder: item.reminder == null ? null : String(item.reminder),
            createdAt: item.createdAt ?? null,
            updatedAt: item.updatedAt ?? null,
        });
    }

    if (!hasBuiltin) cleaned.unshift(createBuiltinPrompt());

    return { items: cleaned };
}

/** 取当前生效的提示词条目（拿不到就返回内置的） */
export function getActivePrompt(config) {
    const items = config?.prompts?.items ?? [];
    const id = config?.activePromptId ?? BUILTIN_PROMPT_ID;
    return items.find((p) => p.id === id)
        ?? items.find((p) => p.id === BUILTIN_PROMPT_ID)
        ?? createBuiltinPrompt();
}

/** 切换当前提示词，返回新的 config（纯函数） */
export function setActivePrompt(config, id) {
    const items = config?.prompts?.items ?? [];
    if (!items.some((p) => p.id === id)) return config;
    return { ...config, activePromptId: id };
}

/** 生成一个不会撞车的 id */
function makeId(prefix, existing) {
    let n = 1;
    let id = `${prefix}_${n}`;
    while (existing.includes(id)) {
        n += 1;
        id = `${prefix}_${n}`;
    }
    return id;
}

/**
 * 新增一条提示词。
 * @param {any} config
 * @param {{ name?: string, protocol?: string|null, reminder?: string|null }} input
 * @returns {{ config: any, item: any }}
 */
export function addPrompt(config, input = {}) {
    const base = { ...createDefaultConfig(), ...config };
    const library = normalizePromptLibrary(base.prompts);
    const ids = library.items.map((p) => p.id);
    const item = {
        id: makeId('prompt', ids),
        name: String(input.name ?? '').trim() || '新提示词',
        builtin: false,
        protocol: input.protocol == null ? null : String(input.protocol),
        mid: input.mid == null ? null : String(input.mid),
        late: input.late == null ? null : String(input.late),
        origin: input.origin == null ? null : String(input.origin),
        due: input.due == null ? null : String(input.due),
        reminder: input.reminder == null ? null : String(input.reminder),
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
    library.items.push(item);
    return { config: { ...base, prompts: library }, item };
}

/** 编辑一条提示词（内置项也能改内容，但不能改名成「默认提示词」以外的东西？——允许改名，保持简单） */
export function updatePrompt(config, id, patch = {}) {
    const base = { ...createDefaultConfig(), ...config };
    const library = normalizePromptLibrary(base.prompts);
    const index = library.items.findIndex((p) => p.id === id);
    if (index < 0) return base;

    const current = library.items[index];
    const next = {
        ...current,
        name: patch.name != null ? (String(patch.name).trim() || current.name) : current.name,
        protocol: 'protocol' in patch ? (patch.protocol == null ? null : String(patch.protocol)) : current.protocol,
        mid: 'mid' in patch ? (patch.mid == null ? null : String(patch.mid)) : current.mid,
        late: 'late' in patch ? (patch.late == null ? null : String(patch.late)) : current.late,
        origin: 'origin' in patch ? (patch.origin == null ? null : String(patch.origin)) : current.origin,
        due: 'due' in patch ? (patch.due == null ? null : String(patch.due)) : current.due,
        reminder: 'reminder' in patch ? (patch.reminder == null ? null : String(patch.reminder)) : current.reminder,
        updatedAt: nowIso(),
    };
    library.items[index] = next;
    return { ...base, prompts: library };
}

/** 重命名 */
export function renamePrompt(config, id, name) {
    const clean = String(name ?? '').trim();
    if (!clean) return config;
    return updatePrompt(config, id, { name: clean });
}

/**
 * 另存为副本。
 * @returns {{ config: any, item: any }}
 */
export function duplicatePrompt(config, id, name) {
    const source = getActivePrompt({ ...config, activePromptId: id });
    return addPrompt(config, {
        name: name ?? `${source.name} 副本`,
        protocol: source.protocol,
        mid: source.mid,
        late: source.late,
        origin: source.origin,
        due: source.due,
        reminder: source.reminder,
    });
}

/** 删除（内置项不可删，返回原 config） */
export function deletePrompt(config, id) {
    if (id === BUILTIN_PROMPT_ID) return config;
    const base = { ...createDefaultConfig(), ...config };
    const library = normalizePromptLibrary(base.prompts);
    library.items = library.items.filter((p) => p.id !== id);
    const activePromptId = base.activePromptId === id ? BUILTIN_PROMPT_ID : base.activePromptId;
    return { ...base, prompts: library, activePromptId };
}

/**
 * 把老配置里的 `reminder.protocolTemplate` / `reminder.template` 迁移成一条提示词。
 * 只在还没有任何自定义提示词、且老字段有值时执行一次。
 * @returns {{ config: any, migrated: boolean }}
 */
export function migrateLegacyPrompt(config) {
    const base = { ...createDefaultConfig(), ...config };
    const library = normalizePromptLibrary(base.prompts);
    const hasCustom = library.items.some((p) => !p.builtin);
    const protocol = base.reminder?.protocolTemplate ?? null;
    const reminder = base.reminder?.template ?? null;

    if (hasCustom || (!protocol && !reminder)) return { config: base, migrated: false };

    const item = {
        id: 'prompt_legacy',
        name: '我的提示词（从旧设置迁移）',
        builtin: false,
        protocol: protocol ? String(protocol) : null,
        mid: null,
        late: null,
        origin: null,
        due: null,
        /** 老的 template 就是「到点提醒」 */
        reminder: reminder ? String(reminder) : null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
    library.items.push(item);

    const reminderCfg = { ...base.reminder, protocolTemplate: null, template: null };
    return {
        config: { ...base, prompts: library, activePromptId: item.id, reminder: reminderCfg },
        migrated: true,
    };
}

// ───────────────────────────── 配置档案 ─────────────────────────────

/**
 * 「全局默认」也是一个普通档案，只是不可删除、且是所有未绑定角色的兜底。
 *
 * 为什么不用单独的 baseConfig 字段：那样会有两种「当前设置存在哪」的语义，
 * 用户搞不清「我现在改的是全局还是某个档案」。统一成档案列表后，
 * 当前生效的是哪一份，在界面上永远一目了然。
 */
export const GLOBAL_PROFILE_ID = 'builtin-global';
export const GLOBAL_PROFILE_NAME = '全局默认';

function createGlobalProfile(baseConfig = null) {
    return {
        id: GLOBAL_PROFILE_ID,
        name: GLOBAL_PROFILE_NAME,
        builtin: true,
        config: baseConfig ? clone(baseConfig) : null,
        createdAt: null,
        updatedAt: null,
    };
}

/** 建一个空的档案库（已含「全局默认」） */
export function createProfileStore(baseConfig = null) {
    return {
        activeId: GLOBAL_PROFILE_ID,
        items: { [GLOBAL_PROFILE_ID]: createGlobalProfile(baseConfig) },
        bindings: {},
        autoCreateForCharacter: true,
    };
}

/** 从完整 config 里截出「可放进档案」的那部分 */
export function captureProfileConfig(config) {
    const snapshot = {};
    for (const [key, value] of Object.entries(config ?? {})) {
        if (PROFILE_EXCLUDED_KEYS.includes(key)) continue;
        snapshot[key] = clone(value);
    }
    return snapshot;
}

/** 规范化档案库，丢弃坏数据 */
export function normalizeProfileStore(raw, fallbackConfig = null) {
    const store = createProfileStore(fallbackConfig);
    if (!raw || typeof raw !== 'object') return store;

    if (raw.items && typeof raw.items === 'object') {
        for (const [id, item] of Object.entries(raw.items)) {
            if (!item || typeof item !== 'object') continue;
            if (!item.config || typeof item.config !== 'object') continue;
            store.items[id] = {
                id,
                name: String(item.name ?? '').trim() || '未命名档案',
                builtin: id === GLOBAL_PROFILE_ID,
                config: item.config,
                createdAt: item.createdAt ?? null,
                updatedAt: item.updatedAt ?? null,
            };
        }
    }

    // 老版本存的是 profiles.baseConfig，迁移进「全局默认」
    if (raw.baseConfig && typeof raw.baseConfig === 'object' && !store.items[GLOBAL_PROFILE_ID]?.config) {
        store.items[GLOBAL_PROFILE_ID] = createGlobalProfile(raw.baseConfig);
    }
    if (!store.items[GLOBAL_PROFILE_ID]) store.items[GLOBAL_PROFILE_ID] = createGlobalProfile();

    if (raw.bindings && typeof raw.bindings === 'object') {
        for (const [key, id] of Object.entries(raw.bindings)) {
            if (typeof id === 'string' && store.items[id]) store.bindings[key] = id;
        }
    }

    store.activeId = raw.activeId && store.items[raw.activeId] ? raw.activeId : GLOBAL_PROFILE_ID;
    // ⚠️ 别漏掉这个开关 —— 这个函数是把 store 整个重建的，
    // 没显式搬过来的字段会被悄悄丢掉。
    store.autoCreateForCharacter = raw.autoCreateForCharacter !== false;
    return store;
}

/** 给档案起个不撞车的 id */
function profileId(existing) {
    let n = 1;
    let id = `profile_${n}`;
    while (existing.includes(id)) {
        n += 1;
        id = `profile_${n}`;
    }
    return id;
}

/**
 * 把「当前设置」存成一个命名档案。
 * @param {any} config
 * @param {{ name?: string, id?: string }} [input] 传 id 就是覆盖已有档案
 * @returns {{ config: any, profile: any }}
 */
export function saveProfile(config, input = {}) {
    const store = normalizeProfileStore(config?.profiles);
    // 不允许把新内容写进「全局默认」这个 id，除非用户明确就是要覆盖它
    const overwrite = input.id && store.items[input.id] ? input.id : null;
    const id = overwrite ?? profileId(Object.keys(store.items));
    const name = String(input.name ?? '').trim()
        || store.items[id]?.name
        || `档案 ${Object.keys(store.items).length}`;

    store.items[id] = {
        id,
        name,
        builtin: id === GLOBAL_PROFILE_ID,
        config: captureProfileConfig(config),
        createdAt: store.items[id]?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
    };
    store.activeId = id;

    return { config: { ...config, profiles: store }, profile: store.items[id] };
}

export function renameProfile(config, id, name) {
    const store = normalizeProfileStore(config?.profiles);
    const clean = String(name ?? '').trim();
    if (!store.items[id] || !clean || id === GLOBAL_PROFILE_ID) return config;
    store.items[id] = { ...store.items[id], name: clean, updatedAt: nowIso() };
    return { ...config, profiles: store };
}

export function deleteProfile(config, id) {
    const store = normalizeProfileStore(config?.profiles);
    if (!store.items[id] || id === GLOBAL_PROFILE_ID) return config;
    delete store.items[id];
    for (const [key, value] of Object.entries(store.bindings)) {
        if (value === id) delete store.bindings[key];
    }
    if (store.activeId === id) store.activeId = GLOBAL_PROFILE_ID;
    return { ...config, profiles: store };
}

/** 绑定：让某个角色卡 / 群聊自动使用这个档案 */
export function bindProfile(config, targetKey, profileId) {
    const store = normalizeProfileStore(config?.profiles);
    const key = String(targetKey ?? '').trim();
    if (!key) return config;
    if (!profileId) delete store.bindings[key];
    else if (store.items[profileId]) store.bindings[key] = profileId;
    return { ...config, profiles: store };
}

export function listProfileBindings(config, profileId) {
    const store = normalizeProfileStore(config?.profiles);
    return Object.entries(store.bindings)
        .filter(([, id]) => id === profileId)
        .map(([key]) => key);
}

/** 把当前设置写回「生效中的那一份」 */
export function writeBackActiveConfig(config) {
    const store = normalizeProfileStore(config?.profiles);
    const id = store.activeId;
    const snapshot = captureProfileConfig(config);
    const existing = store.items[id];
    store.items[id] = {
        ...(existing ?? { id, name: GLOBAL_PROFILE_NAME, builtin: id === GLOBAL_PROFILE_ID }),
        config: snapshot,
        updatedAt: nowIso(),
    };
    return { ...config, profiles: store };
}

/**
 * 解析：当前对话该用哪个档案（没绑定就落到「全局默认」）。
 * @returns {string} 一定会返回一个存在的档案 id
 */
export function resolveProfileId(config, targetKey) {
    const store = normalizeProfileStore(config?.profiles);
    if (targetKey) {
        const bound = store.bindings[targetKey];
        if (bound && store.items[bound]) return bound;
    }
    return GLOBAL_PROFILE_ID;
}

/**
 * 给某张角色卡**新建**一份档案并绑定上去。
 *
 * 内容从「全局默认」复制（**不是**从当前正在用的那份）—— 这样每张新卡都从
 * 干净、一致的基线开始，不会把上一张卡的临时调整带过去。
 *
 * @param {any} config
 * @param {string} key getCharacterKey() 拿到的稳定标识
 * @param {string} [name] 档案名（一般传角色卡名）
 * @returns {{ config: any, profile: any }|null} 已经有绑定、或没有 key 时返回 null
 */
export function createBoundProfile(config, key, name) {
    const store = normalizeProfileStore(config?.profiles);
    if (!key || store.bindings[key]) return null;

    const globalItem = store.items[GLOBAL_PROFILE_ID];
    const source = globalItem?.config
        ? mergeConfig(createDefaultConfig(), globalItem.config)
        : createDefaultConfig();

    const id = profileId(Object.keys(store.items));
    const clean = String(name ?? '').trim() || `档案 ${Object.keys(store.items).length}`;

    store.items[id] = {
        id,
        name: clean,
        builtin: false,
        config: captureProfileConfig(source),
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
    store.bindings[key] = id;
    store.activeId = id;

    return { config: { ...config, profiles: store }, profile: store.items[id] };
}

/**
 * 切换到目标对话对应的档案。
 *
 * @param {any} config
 * @param {string|null} targetKey
 * @param {{ force?: boolean, autoCreate?: boolean, name?: string }} [opts]
 *        autoCreate=true 时，遇到没绑定过的角色卡会**自动新建一份**并绑上；
 *        否则会掉回「全局默认」（多张卡共用一套配置，改一处全变）
 * @returns {{ config: any, activeId: string, changed: boolean, reason: string }}
 */
export function activateProfileFor(config, targetKey, opts = {}) {
    const store0 = normalizeProfileStore(config?.profiles);
    const wanted0 = resolveProfileId({ ...config, profiles: store0 }, targetKey);
    const needsCreate = !!(opts.autoCreate && targetKey && !store0.bindings[targetKey]);

    if (!opts.force && !needsCreate && wanted0 === store0.activeId) {
        return { config, activeId: store0.activeId, changed: false, reason: 'unchanged' };
    }

    // 先把当前改动落盘到「正在用的那一份」，再换过去。
    // ⚠️ 这一步必须在「新建」之前 —— 否则新建出来的那份会被当前设置覆盖掉。
    const persisted = writeBackActiveConfig(config);
    let store = normalizeProfileStore(persisted.profiles);

    // 没绑定过的角色卡 → 自动新建一份（内容从「全局默认」复制）并绑上
    let createdId = null;
    if (needsCreate) {
        const created = createBoundProfile({ ...persisted, profiles: store }, targetKey, opts.name);
        if (created) {
            store = normalizeProfileStore(created.config.profiles);
            createdId = created.profile.id;
        }
    }

    const wanted = resolveProfileId({ ...persisted, profiles: store }, targetKey);

    const source = store.items[wanted]?.config;
    const fresh = createDefaultConfig();
    const next = source ? mergeConfig(fresh, source) : mergeConfig(fresh, captureProfileConfig(config));

    // 库和档案表本身是全局的，不能被快照覆盖
    next.prompts = persisted.prompts;
    next.profiles = { ...store, activeId: wanted };

    return {
        config: next,
        activeId: wanted,
        changed: true,
        reason: createdId ? 'created' : (wanted === GLOBAL_PROFILE_ID ? 'global' : 'profile'),
    };
}

/** 从当前 config 生成一个人类可读的摘要（界面展示用） */
export function describeProfile(config) {
    const time = config?.time ?? {};
    const mode = time.mode === 'calendar' ? '日历制' : '计数制';
    const cal = time.calendar ?? {};
    const dateText = time.mode === 'calendar'
        ? `${cal.era ?? ''}${cal.startDate?.year ?? 1}年${cal.startDate?.month ?? 1}月${cal.startDate?.day ?? 1}日`
        : `第${time.startDay ?? 1}天`;
    const months = cal.hasCustomMonthNames || (Array.isArray(cal.monthNames) && cal.monthNames.some(Boolean))
        ? `${cal.monthNames.filter(Boolean).length} 个月名`
        : '数字月份';
    return `${mode} · ${dateText} · ${months}`;
}
