/**
 * AI 调用层 —— 「用 AI 推断历法」的后端路由。
 *
 * 两条路：
 *   1. `main`   —— 走酒馆主 API（`host.quietPrompt`，即 `generateQuietPrompt`），
 *                   不写聊天记录、不触发世界书扫描，最省事；
 *   2. `custom` —— 走用户自己填的 OpenAI 兼容接口（`/chat/completions`），
 *                   适合想用便宜模型 / 本地模型专门干这活的人，也适用于非酒馆宿主。
 *
 * 这一层只负责「把提示词发出去、把文本收回来」，解析在 core/calendar-infer.js。
 */

/** 把 baseUrl 规范化成 chat/completions 的完整地址 */
export function resolveEndpoint(baseUrl) {
    const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/\/chat\/completions$/.test(base)) return base;
    if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
}

/**
 * 调自定义的 OpenAI 兼容接口。
 * @param {{ baseUrl: string, apiKey?: string, model: string, temperature?: number, maxTokens?: number }} cfg
 * @param {string} prompt
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function callCustomApi(cfg, prompt, opts = {}) {
    const endpoint = resolveEndpoint(cfg?.baseUrl);
    if (!endpoint) throw new Error('还没有填自定义 API 的地址');
    if (!cfg?.model) throw new Error('还没有填自定义 API 的模型名');

    const doFetch = opts.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') throw new Error('当前环境不支持 fetch');

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 60000) : null;

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

        const response = await doFetch(endpoint, {
            method: 'POST',
            headers,
            signal: controller?.signal,
            body: JSON.stringify({
                model: cfg.model,
                messages: [{ role: 'user', content: String(prompt) }],
                temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : 0.2,
                max_tokens: Number.isFinite(Number(cfg.maxTokens)) ? Number(cfg.maxTokens) : 1500,
                stream: false,
            }),
        });

        if (!response.ok) {
            const detail = await safeText(response);
            throw new Error(`接口返回 ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content
            ?? data?.choices?.[0]?.text
            ?? data?.content?.[0]?.text
            ?? '';
        if (!content) throw new Error('接口没有返回内容');
        return String(content);
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error('接口请求超时');
        throw err;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function safeText(response) {
    try {
        return await response.text();
    } catch {
        return '';
    }
}

/**
 * 按配置选后端，把提示词发出去。
 * @param {{ host: any, config: any }} ctx
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export async function runInference(ctx, prompt) {
    const infer = ctx?.config?.infer ?? {};
    if (infer.backend === 'custom') {
        return callCustomApi(infer.custom ?? {}, prompt);
    }

    const host = ctx?.host;
    if (typeof host?.quietPrompt !== 'function') {
        throw new Error('当前宿主不支持走主 API（不是酒馆，或该版本没有 generateQuietPrompt）。请改用「自定义 API」。');
    }
    const maxTokens = Number(infer.custom?.maxTokens);
    return host.quietPrompt(prompt, {
        responseLength: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1500,
    });
}

/** 后端是否可用（界面用来提示） */
export function describeBackend(host, config) {
    const infer = config?.infer ?? {};
    if (infer.backend === 'custom') {
        const endpoint = resolveEndpoint(infer.custom?.baseUrl);
        if (!endpoint) return { ok: false, text: '自定义 API：还没填地址' };
        if (!infer.custom?.model) return { ok: false, text: '自定义 API：还没填模型名' };
        return { ok: true, text: `自定义 API：${endpoint}（${infer.custom.model}）` };
    }
    if (typeof host?.quietPrompt === 'function') {
        return { ok: true, text: '酒馆主 API（generateQuietPrompt）' };
    }
    return { ok: false, text: '当前宿主没有主 API，请改用自定义 API' };
}
