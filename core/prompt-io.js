/**
 * 提示词库的导入 / 导出。
 *
 * 目的：让玩家之间能交换提示词 —— 一个人调好的那几段文案，导出成一个文件，
 * 别人导入就能直接用。
 *
 * ⚠️ 所以这个 JSON 是**对外的契约**，不是内部实现细节：
 *   · `format` 必须写死成 `event-timer-prompt`，用来挡住「拖错文件」
 *   · `version` 从 1 开始，以后改格式时靠它兼容
 *   · **不带 `id`** —— id 是本地的（`prompt_1` 这种），带出去只会和别人库里的撞
 *   · 每个字段都有长度上限，免得导入一个几十 MB 的文件把设置撑爆
 *
 * 这里是纯函数，不碰 DOM、不碰配置 —— 界面层（`ui/editors.js`）负责读写和提示。
 */

export const PROMPT_FILE_FORMAT = 'event-timer-prompt';
export const PROMPT_FILE_VERSION = 1;

/**
 * 旧名字，导入时也认。
 *
 * 插件原来叫 `story-timer`，那次改名之前导出的文件里 `format` 写的是
 * `story-timer-prompt`。改名**不能把这个标识一起改掉** —— 那是别人手里
 * 文件和你自己的联系方式。所以：导出用新名字，导入新旧都收。
 */
export const PROMPT_FILE_FORMAT_ALIASES = ['story-timer-prompt'];

/** 参与导入导出的字段。`reminder` 是 `due` 的旧名，只在导入时当兜底认。 */
export const PROMPT_FIELD_KEYS = ['protocol', 'mid', 'late', 'origin', 'due'];

/** 单字段长度上限（字符）。正常文案几百到几千，两万足够宽松了。 */
export const PROMPT_FIELD_MAX = 20000;
/** 名字长度上限 */
export const PROMPT_NAME_MAX = 60;

function cleanName(name) {
    const clean = String(name ?? '').trim().slice(0, PROMPT_NAME_MAX);
    return clean || '导入的提示词';
}

/**
 * 把一条提示词打包成可导出的对象。
 * @param {any} prompt 提示词库里的条目（`app.activePrompt`）
 */
export function buildPromptFile(prompt) {
    const out = {
        format: PROMPT_FILE_FORMAT,
        version: PROMPT_FILE_VERSION,
        name: cleanName(prompt?.name),
    };
    for (const key of PROMPT_FIELD_KEYS) {
        const value = prompt?.[key];
        // 空值统一写成 null，而不是空字符串 —— 这样导入方能分清
        // 「作者故意留空」和「这个键不存在」，将来也好迁移。
        out[key] = typeof value === 'string' && value.trim() ? String(value) : null;
    }
    return out;
}

/** 打包成给人看的 JSON 文本（带缩进，方便手改） */
export function serializePromptFile(prompt) {
    return `${JSON.stringify(buildPromptFile(prompt), null, 2)}\n`;
}

/**
 * 解析一段导入文本。
 *
 * 刻意**宽容**：手写的 JSON、别人从聊天里粘过来的片段都能用，
 * 只要里面有能认出来的文案。真正会拒绝的只有三种情况：
 * 不是 JSON、`format` 对不上、一个字段都没有。
 *
 * @param {string} text
 * @returns {{ ok: boolean, name: string, fields: Record<string, string|null>, errors: string[], warnings: string[] }}
 */
export function parsePromptFile(text) {
    const errors = [];
    const warnings = [];
    const fail = () => ({ ok: false, name: '', fields: {}, errors, warnings });

    const raw = String(text ?? '').trim();
    if (!raw) {
        errors.push('内容为空');
        return fail();
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        errors.push('不是合法的 JSON，请确认粘的是完整的导出内容');
        return fail();
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        errors.push('顶层应该是一个 JSON 对象');
        return fail();
    }

    // format 对不上就拒 —— 这是防「拖错文件」的唯一一道闸门。
    // 旧名字（story-timer-prompt）也认：改插件名不该让老文件失效。
    const accepted = [PROMPT_FILE_FORMAT, ...PROMPT_FILE_FORMAT_ALIASES];
    if (data.format != null && !accepted.includes(data.format)) {
        errors.push(`不是事件计时器的提示词文件（format 是 ${JSON.stringify(data.format)}）`);
        return fail();
    }
    if (data.format == null) {
        // 没有 format：可能是在记事本里手敲的。放行，但说一声。
        warnings.push('文件里没有 format 标记，按提示词处理');
    }

    const version = Number(data.version);
    if (Number.isFinite(version) && version > PROMPT_FILE_VERSION) {
        errors.push(`这个文件来自更新的版本（v${version}），当前只认到 v${PROMPT_FILE_VERSION}`);
        return fail();
    }

    const fields = {};
    let filled = 0;
    for (const key of PROMPT_FIELD_KEYS) {
        // `due` 认老名字 reminder —— 老导出文件和手写文件都可能用它
        const source = key === 'due' ? (data.due ?? data.reminder) : data[key];
        if (source == null) {
            fields[key] = null;
            continue;
        }
        if (typeof source !== 'string') {
            warnings.push(`${key} 不是字符串，已忽略`);
            fields[key] = null;
            continue;
        }
        if (source.length > PROMPT_FIELD_MAX) {
            warnings.push(`${key} 超长，已截断到 ${PROMPT_FIELD_MAX} 字符`);
            fields[key] = source.slice(0, PROMPT_FIELD_MAX);
            filled += 1;
            continue;
        }
        fields[key] = source;
        if (source.trim()) filled += 1;
    }

    if (!filled) {
        errors.push('里面没有任何文案，导入进来也是个空的');
        return fail();
    }

    if (data.name != null && typeof data.name !== 'string') warnings.push('name 不是字符串，已忽略');

    return {
        ok: true,
        name: cleanName(typeof data.name === 'string' ? data.name : ''),
        fields,
        errors,
        warnings,
    };
}

/**
 * 文件名：`计时器提示词-<名字>.json`。
 * 把 Windows / macOS 都不认的字符换成下划线。
 */
export function promptFileName(name) {
    const safe = cleanName(name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, PROMPT_NAME_MAX);
    return `事件计时器提示词-${safe}.json`;
}
