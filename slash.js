/**
 * 斜杠命令注册（可选功能，失败不影响核心）。
 *
 * 使用酒馆当前的 `SlashCommandParser.addCommandObject(SlashCommand.fromProps({...}))`。
 * 所有构造器都从 `getContext()` 现取，拿不到就静默跳过。
 */

import { getSTContext } from './host/bridge.js';
import { formatClock, formatDuration, formatCountdown } from './core/story-time.js';
import { parseDuration } from './core/time-lexer.js';
import { parseAbsoluteClock } from './core/parser.js';

/** 尽量复用酒馆的类型定义，拿不到就用 null（表示不声明参数类型） */
function argFactories() {
    const ctx = getSTContext();
    if (!ctx?.SlashCommandArgument?.fromProps) return null;
    return {
        SlashCommandArgument: ctx.SlashCommandArgument,
        ARGUMENT_TYPE: ctx.ARGUMENT_TYPE ?? { STRING: 'string' },
    };
}

function stringArg(description, required = false) {
    const f = argFactories();
    if (!f) return null;
    try {
        return f.SlashCommandArgument.fromProps({
            description,
            typeList: [f.ARGUMENT_TYPE.STRING],
            isRequired: required,
        });
    } catch {
        return null;
    }
}

/** 把可能带引号的裸参数合并成一段文本 */
function joinUnnamed(unnamedArguments) {
    if (unnamedArguments == null) return '';
    if (typeof unnamedArguments === 'string') return unnamedArguments;
    if (Array.isArray(unnamedArguments)) return unnamedArguments.filter(Boolean).join(' ');
    if (typeof unnamedArguments === 'object') {
        const values = Object.values(unnamedArguments).filter((v) => v != null);
        return values.map((v) => (typeof v === 'string' ? v : '')).join(' ').trim();
    }
    return String(unnamedArguments);
}

export function withSlashCommands(app) {
    const ctx = getSTContext();
    const parser = ctx?.SlashCommandParser;
    const SlashCommand = ctx?.SlashCommand;
    if (!parser?.addCommandObject || !SlashCommand?.fromProps) {
        console.debug('[事件计时器] 当前酒馆版本不支持斜杠命令注册，跳过');
        return false;
    }

    const register = (props) => {
        try {
            const command = SlashCommand.fromProps({ isExtension: true, ...props });
            parser.addCommandObject(command);
            return true;
        } catch (err) {
            console.warn('[事件计时器] 注册斜杠命令失败', props.name, err);
            return false;
        }
    };

    const dayLabel = () => app.config.time.dayLabel;
    const nowText = () => formatClock(app.engine.clock, { dayLabel: dayLabel() });

    register({
        name: 'timer',
        helpString: '显示当前剧情时间与所有进行中的事件。',
        returns: '剧情时间与事件清单',
        callback: () => {
            const snap = app.engine.snapshot();
            const lines = [`当前剧情时间：${nowText()}（第 ${app.engine.turns} 轮）`];
            if (!snap.active.length) {
                lines.push('暂无进行中的事件。');
            } else {
                for (const ev of snap.active) {
                    lines.push(`· 《${ev.title}》 ${formatCountdown(ev.remainingMinutes)}（预定 ${ev.dueText}）` +
                        (ev.status === 'due' ? ' ⚠已到期' : ''));
                    if (ev.reward) lines.push(`    收益：${ev.reward}`);
                    if (ev.risk) lines.push(`    风险：${ev.risk}`);
                    if (ev.loss) lines.push(`    损失：${ev.loss}`);
                }
            }
            return lines.join('\n');
        },
    });

    register({
        name: 'timer-advance',
        aliases: ['timer-+'],
        helpString: '推进剧情时间。例如 /timer-advance 3天',
        returns: '推进后的剧情时间',
        unnamedArgumentList: [stringArg('时长，例如 3天 / 6小时 / 一炷香', true)].filter(Boolean),
        callback: (_named, unnamed) => {
            const text = joinUnnamed(unnamed);
            const duration = parseDuration(text);
            if (!duration) return `无法识别时长：${text}`;
            app.engine.advanceClock(duration.minutes, `斜杠命令：${text}`);
            app.refreshInjection({ commit: true });
            app.saveState();
            app.notify();
            return `已推进 ${formatDuration(duration.minutes)}，当前：${nowText()}`;
        },
    });

    register({
        name: 'timer-add',
        helpString: '添加一个耗时事件。格式：/timer-add 事件名 | 时长 | 收益=… | 风险=… | 损失=…',
        returns: '新事件的到期时间',
        unnamedArgumentList: [stringArg('事件定义', true)].filter(Boolean),
        callback: (_named, unnamed) => {
            const text = joinUnnamed(unnamed);
            const segments = text.split(/\s*[|｜]\s*/).filter(Boolean);
            const title = (segments.shift() ?? '').trim();
            if (!title) return '请至少给出事件名称，例如：/timer-add 熬制解毒药 | 6小时';
            const input = { title, source: 'manual' };
            for (const segment of segments) {
                const kv = segment.match(/^([^=＝:：]{1,12})\s*[=＝:：]\s*([\s\S]*)$/);
                if (kv) {
                    const key = kv[1].trim();
                    const value = kv[2].trim();
                    if (/收益|reward/i.test(key)) input.reward = value;
                    else if (/风险|risk/i.test(key)) input.risk = value;
                    else if (/损失|代价|loss|cost/i.test(key)) input.loss = value;
                    else if (/详情|说明|note|desc/i.test(key)) input.note = value;
                    continue;
                }
                const absolute = parseAbsoluteClock(segment, app.engine.clock);
                const duration = parseDuration(segment);
                if (absolute && /第|Day|[明后次翌今当][天日]|\d\s*[:：]\s*\d/i.test(segment)) input.dueClock = absolute;
                else if (duration) input.durationMinutes = duration.minutes;
            }
            // 「时长」现在是必填的。以前这里会兜底成 time.defaultEventMinutes（60 分钟），
            // 那个兜底已删除 —— 没有时长就没有到期时间，事件跟踪不了。
            // 与其编一个假时长，不如当场告诉用户该怎么写。
            if (!input.dueClock && input.durationMinutes == null) {
                throw new Error('要给出时长或到期时间，例如：/timer add 熬药 6小时');
            }
            const ev = app.engine.addEvent(input);
            app.refreshInjection({ commit: false });
            app.saveState();
            app.notify();
            return `已记录《${ev.title}》，预定 ${ev.dueClock.day}日 ${String(Math.floor(ev.dueClock.minute / 60)).padStart(2, '0')}:${String(ev.dueClock.minute % 60).padStart(2, '0')}`;
        },
    });

    register({
        name: 'timer-due',
        helpString: '列出已经到期、等待正文交代的事件。',
        returns: '到期事件清单',
        callback: () => {
            const due = app.engine.snapshot().due;
            if (!due.length) return '当前没有到期事件。';
            return due.map((ev) => `《${ev.title}》 ${formatCountdown(ev.remainingMinutes)}`).join('\n');
        },
    });

    register({
        name: 'timer-inject',
        helpString: '返回本轮将要注入给 AI 的提醒文本（不实际注入）。',
        returns: '提醒文本',
        callback: () => app.previewInjection().text || '（当前无需注入）',
    });

    register({
        name: 'timer-rebuild',
        helpString: '从聊天记录重新推演时间线与事件。',
        returns: '重算结果',
        callback: () => {
            app.rebuild({ reason: 'slash' });
            return `已重算：${nowText()}，共 ${app.engine.events.length} 个事件。`;
        },
    });

    register({
        name: 'timer-reset',
        helpString: '清空事件计时器在本场聊天的所有数据。',
        returns: '结果',
        callback: () => {
            app.resetAll();
            return '事件计时器已重置。';
        },
    });

    return true;
}
