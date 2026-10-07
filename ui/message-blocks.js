/**
 * 在聊天记录里如实呈现「注入的东西」，折叠起来。
 *
 * 和模型的思考块一个道理 —— 对称的两半：
 *
 *   **用户消息** → 折叠显示「计时注入」（我们注入进提示词的提醒）
 *   **AI 消息**  → 折叠显示「计时输出」（它写的 <timer> 区块）
 *
 * 标签区块本来被酒馆正则从显示里藏掉了，这里把它补回来：
 * 藏起来是为了不碍眼，折叠起来是为了随时能查。
 */

import { h } from './dom.js';
import { localizeDom, t } from './i18n.js';

const CLS = 'st-timer-mes-block';

/** 注入里带了哪些时点 */
function pointLabel(point) {
    const map = {
        mid: '定期检查',
        late: '即将结束',
        origin: '预定终点（旧）',
        due: '预定终点（现）',
    };
    return t(map[point] ?? point);
}

export class MessageBlocks {
    /**
     * @param {import('../app.js').TimerApp} app
     */
    constructor(app) {
        this.app = app;
        this._unsubscribe = null;
        /** mesid → 已插入的节点，避免重复插入 */
        this._nodes = new Map();
    }

    start() {
        this.stop();
        this._unsubscribe = this.app.subscribe(() => this.refresh());
        this._observer = this._observeChat();
        this.refresh();
    }

    stop() {
        this._unsubscribe?.();
        this._unsubscribe = null;
        this._observer?.disconnect?.();
        this._observer = null;
        clearTimeout(this._timer);
        for (const node of this._nodes.values()) node.remove?.();
        this._nodes.clear();
    }

    /**
     * 盯着 #chat：酒馆随时可能自己重画消息（流式输出、编辑、重排……），
     * 一重画我们插的节点就没了。光靠 app 的事件不够 —— 流式期间
     * CHARACTER_MESSAGE_RENDERED 根本不发。
     */
    _observeChat() {
        const chat = this._chatRoot();
        const Observer = globalThis.MutationObserver;
        if (!chat || typeof Observer !== 'function') return null;
        const observer = new Observer(() => {
            // 重画往往是连续的，防抖一下
            clearTimeout(this._timer);
            this._timer = setTimeout(() => this.refresh(), 60);
        });
        observer.observe(chat, { childList: true, subtree: true });
        return observer;
    }

    /** 重新扫描消息列表，补齐 / 更新 / 清理折叠块 */
    refresh() {
        const chat = this._chatRoot();
        if (!chat) return;
        // #chat 可能被酒馆整个换掉（换聊天），换过就重新盯上
        if (!this._observer) this._observer = this._observeChat();

        const enabled = this.app.config.enabled && this.app.config.ui?.showMessageBlocks !== false;
        // 用 .mes 再自己筛 mesid，避免依赖属性选择器（不同宿主的实现差异大）
        const messageEls = [...(chat.querySelectorAll?.('.mes') ?? [])]
            .filter((el) => el.getAttribute?.('mesid') != null);

        if (!enabled) {
            for (const node of this._nodes.values()) node.remove?.();
            this._nodes.clear();
            return;
        }

        const seen = new Set();
        for (const mesEl of messageEls) {
            const mesid = mesEl.getAttribute?.('mesid');
            if (mesid == null) continue;
            seen.add(String(mesid));

            const block = this.app.messageBlockFor(Number(mesid));
            const existing = this._nodes.get(String(mesid));

            if (!block?.text) {
                // 这一楼没什么可显示的 —— 之前插过就撤掉（比如消息被改写了）
                if (existing) { existing.remove?.(); this._nodes.delete(String(mesid)); }
                continue;
            }

            if (existing && existing.parentNode) {
                this._fill(existing, block);
                continue;
            }

            const node = this._build(block);
            const host = mesEl.querySelector?.('.mes_block') ?? mesEl;
            const textEl = host.querySelector?.('.mes_text');
            if (textEl?.parentNode === host) host.insertBefore(node, textEl.nextSibling ?? null);
            else host.appendChild(node);

            this._nodes.set(String(mesid), node);
        }

        // 消息被删掉后，对应的折叠块也要清掉
        for (const [mesid, node] of [...this._nodes]) {
            if (!seen.has(mesid)) { node.remove?.(); this._nodes.delete(mesid); }
        }
    }

    _chatRoot() {
        if (typeof document === 'undefined') return null;
        return document.querySelector?.('#chat') ?? null;
    }

    _build(block) {
        const details = h(`details.${CLS}`, [
            h('summary', [h(`span.${CLS}__text`, '')]),
            h(`pre.${CLS}__body`, ''),
        ]);
        this._fill(details, block);
        return details;
    }

    _fill(details, block) {
        const isInjection = block.kind === 'injection';
        details.dataset.kind = block.kind;

        const summary = details.querySelector?.(`.${CLS}__text`);
        if (summary) {
            if (isInjection) {
                const points = [...new Set(block.points ?? [])].map(pointLabel).join(' / ');
                if (points) {
                    summary.textContent = `${t('计时注入')} · ×${block.points.length}（${points}）`;
                } else {
                    // 只有协议说明（教 AI 用标签的那段）—— 说清楚，否则
                    // 用户会以为「这一轮什么都没注入」。协议说明默认每轮都在发。
                    summary.textContent = `${t('计时注入')} · ${t('仅记录格式说明')}（${block.text.length} ${t('字符')}）`;
                }
            } else {
                summary.textContent = t('计时输出');
            }
        }
        const body = details.querySelector?.(`.${CLS}__body`);
        if (body) body.textContent = block.text ?? '';
        localizeDom(details);
    }
}
