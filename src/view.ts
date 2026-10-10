import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type CodeMChatPlugin from './main';
import { runPromptStream, newSessionId, listSessions, CodemUsage, SessionSummary } from './codem-client';
import { SessionListModal } from './sessions-modal';
import { renderMarkdown } from './markdown';

export const VIEW_TYPE_CODEM_CHAT = 'codem-chat-view';

const STREAM_RENDER_INTERVAL = 150;
const TOOL_RESULT_MAX_LEN = 2000;
const NOTE_CONTEXT_MAX_LEN = 8000;

interface ToolCall {
	itemEl: HTMLElement;
}

/** 右侧边栏聊天视图，布局对标 Claudian：顶部会话栏 + 消息流 + 底部输入框 */
export class CodeMChatView extends ItemView {
	plugin: CodeMChatPlugin;
	/** 同一 id 反复传入 --session 即会话续接；"新会话"按钮换新 id */
	private sessionId = newSessionId();
	private msgContainer!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private busy = false;
	/** 流式期间累计正文 + 节流重渲染 */
	private mdBuffer = '';
	private renderTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: CodeMChatPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CODEM_CHAT;
	}

	getDisplayText(): string {
		return 'CodeM 聊天框';
	}

	getIcon(): string {
		return 'message-square';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('codem-chat-root');

		const topBar = root.createDiv({ cls: 'codem-chat-topbar' });
		const histBtn = topBar.createEl('button', { text: '历史会话' });
		histBtn.onclick = () => void this.openSessionList();
		const newBtn = topBar.createEl('button', { text: '新会话' });
		newBtn.onclick = () => this.startNewSession();

		this.msgContainer = root.createDiv({ cls: 'codem-chat-messages' });
		this.renderEmpty();

		const inputBar = root.createDiv({ cls: 'codem-chat-inputbar' });
		this.inputEl = inputBar.createEl('textarea', {
			cls: 'codem-chat-input',
			attr: { placeholder: '向 CodeM 提问…（Enter 发送，Shift+Enter 换行）', rows: 3 },
		});
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.send();
			}
		});
		this.sendBtn = inputBar.createEl('button', { text: '发送', cls: 'codem-chat-send' });
		this.sendBtn.onclick = () => void this.send();
	}

	async onClose(): Promise<void> {}

	private startNewSession(): void {
		if (this.busy) {
			new Notice('CodeM 执行中，等本轮结束后再开新会话');
			return;
		}
		this.sessionId = newSessionId();
		this.msgContainer.empty();
		this.renderEmpty();
	}

	private renderEmpty(): void {
		this.msgContainer.createDiv({
			cls: 'codem-chat-empty',
			text: 'CodeM 已就绪。Vault 根目录即其工作目录。',
		});
	}

	/** 打开历史会话列表（读 ~/.codem/sessions 本地落盘索引卡） */
	private async openSessionList(): Promise<void> {
		if (this.busy) {
			new Notice('CodeM 执行中，等本轮结束后再切换会话');
			return;
		}
		const vaultPath = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
		new SessionListModal(this.app, listSessions(vaultPath), (s) => this.loadSession(s)).open();
	}

	/** 切换到历史会话并回显 transcript */
	private loadSession(s: SessionSummary): void {
		this.sessionId = s.id;
		this.msgContainer.empty();
		let shown = 0;
		for (const m of s.transcript) {
			if (m.role !== 'user' && m.role !== 'assistant' || !m.content) continue;
			const block = this.msgContainer.createDiv({ cls: `codem-chat-msg codem-chat-${m.role}` });
			block.innerHTML = renderMarkdown(m.content);
			shown++;
		}
		if (shown === 0) this.renderEmpty();
		this.scrollBottom();
		new Notice(`已切换会话（${shown} 条历史消息）`);
	}

	/** 解析 prompt 中 [[笔记]] 引用，命中的笔记全文附到 prompt 尾部注入上下文 */
	private async resolveNoteContexts(prompt: string): Promise<string> {
		const linkRe = /\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g;
		const contexts = new Map<string, string>();
		let missed = false;
		for (const m of prompt.matchAll(linkRe)) {
			const linkpath = m[1].trim();
			if (contexts.has(linkpath)) continue;
			const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, '');
			if (file) {
				try {
					const content = await this.app.vault.cachedRead(file);
					contexts.set(linkpath, truncate(content, NOTE_CONTEXT_MAX_LEN));
				} catch {
					missed = true;
				}
			} else {
				missed = true;
			}
		}
		if (contexts.size === 0) return prompt;
		const parts = [...contexts.entries()].map(
			([p, c]) => `📎 附加笔记「${p}」的内容：\n---\n${c}\n---`
		);
		if (missed) new Notice('部分 [[引用]] 未解析到笔记，按原文发送');
		return `${prompt}\n\n${parts.join('\n\n')}`;
	}

	private async send(): Promise<void> {
		const rawPrompt = this.inputEl.value.trim();
		if (!rawPrompt || this.busy) return;

		this.busy = true;
		this.inputEl.value = '';
		this.sendBtn.disabled = true;
		this.msgContainer.querySelector('.codem-chat-empty')?.remove();

		// 用户消息（UI 显示原文）
		const userBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-user' });
		userBlock.innerHTML = renderMarkdown(rawPrompt);

		// [[笔记]] 引用注入
		const prompt = await this.resolveNoteContexts(rawPrompt);

		// 助手消息骨架：thinking 折叠区 + 工具折叠区 + 正文 + usage
		const aiBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-assistant' });
		const thinking = aiBlock.createEl('details', { cls: 'codem-chat-thinking' });
		thinking.setAttribute('open', '');
		const thinkingSummary = thinking.createEl('summary', { text: '思考中…' });
		const thinkingBody = thinking.createDiv({ cls: 'codem-chat-thinking-body' });

		const toolsEl = aiBlock.createEl('details', { cls: 'codem-chat-tools' });
		const toolsSummary = toolsEl.createEl('summary', { text: '🔧 工具调用中…' });
		toolsEl.hide();
		const toolCalls = new Map<string, ToolCall>();

		const textEl = aiBlock.createDiv({ cls: 'codem-chat-text' });
		const usageEl = aiBlock.createDiv({ cls: 'codem-chat-usage' });
		usageEl.hide();
		this.scrollBottom();

		this.mdBuffer = '';

		const opts = {
			cliPath: this.plugin.settings.codemCliPath,
			cwd: (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath(),
			timeoutMs: this.plugin.settings.timeoutMs,
			extraArgs: this.plugin.settings.extraArgs,
			sessionId: this.sessionId,
			nodePath: this.plugin.settings.nodePath,
		};

		try {
			const finalText = await runPromptStream(opts, prompt, {
				onThinking: (delta) => {
					thinkingBody.textContent += delta;
					this.scrollBottom();
				},
				onText: (delta) => {
					this.mdBuffer += delta;
					this.scheduleStreamRender(textEl);
				},
				onUsage: (u: CodemUsage) => {
					usageEl.setText(formatUsage(u));
					usageEl.show();
				},
				onEvent: (event, data) => {
					if (event === 'tool_start') {
						const d = data as { id?: string; name?: string; input?: Record<string, unknown> };
						const itemEl = toolsEl.createDiv({ cls: 'codem-chat-tool-item' });
						itemEl.createDiv({
							cls: 'codem-chat-tool-head',
							text: `${d.name ?? 'unknown'} · ${summarizeInput(d.input)}`,
						});
						if (d.id) toolCalls.set(d.id, { itemEl });
						toolsEl.show();
						toolsSummary.setText(`🔧 工具调用 ${toolCalls.size} 次（执行中…）`);
						this.scrollBottom();
					} else if (event === 'tool_result') {
						const d = data as { id?: string; content?: string; is_error?: boolean };
						const call = d.id ? toolCalls.get(d.id) : undefined;
						if (call) {
							const pre = call.itemEl.createEl('pre', { cls: 'codem-chat-tool-result' });
							if (d.is_error) pre.addClass('codem-chat-tool-error');
							pre.setText(truncate(d.content ?? '(无输出)', TOOL_RESULT_MAX_LEN));
						}
						this.scrollBottom();
					}
					// tool_guard_result：pass 无 UI 价值，blocked 场景 P3 处理
				},
			});
			this.clearRenderTimer();
			textEl.innerHTML = renderMarkdown(finalText || this.mdBuffer);
			if (thinkingBody.textContent) {
				thinkingSummary.setText('思考过程');
				thinking.removeAttribute('open');
			} else {
				thinking.hide();
			}
			if (toolCalls.size > 0) {
				toolsSummary.setText(`🔧 工具调用 ${toolCalls.size} 次`);
				toolsEl.removeAttribute('open');
			} else {
				toolsEl.hide();
			}
		} catch (e) {
			this.clearRenderTimer();
			// 完整错误落盘到插件目录 debug.log，供诊断
			const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
			try {
				const base = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
				fs.appendFileSync(
					path.join(base, this.plugin.manifest.dir ?? '', 'debug.log'),
					`[${new Date().toISOString()}] prompt=${rawPrompt.slice(0, 50)}\n${detail}\n\n`
				);
			} catch {
				// 日志失败不影响错误提示
			}
			aiBlock.remove();
			const errBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-error' });
			errBlock.setText(detail);
		} finally {
			this.busy = false;
			this.sendBtn.disabled = false;
			this.scrollBottom();
		}
	}

	/** 流式期间节流重渲染，避免每个 delta 都 parse */
	private scheduleStreamRender(el: HTMLElement): void {
		if (this.renderTimer !== null) return;
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			el.innerHTML = renderMarkdown(this.mdBuffer);
			this.scrollBottom();
		}, STREAM_RENDER_INTERVAL);
	}

	private clearRenderTimer(): void {
		if (this.renderTimer !== null) {
			window.clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
	}

	private scrollBottom(): void {
		this.msgContainer.scrollTop = this.msgContainer.scrollHeight;
	}
}

function formatUsage(u: CodemUsage): string {
	const k = (n?: number) => (n == null ? '-' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
	return `tokens · 输入 ${k(u.input_tokens)} / 输出 ${k(u.output_tokens)} / 缓存 ${k(u.cache_read)}`;
}

function summarizeInput(input?: Record<string, unknown>): string {
	if (!input) return '';
	const s = JSON.stringify(input) ?? '';
	return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + `…（截断，共 ${s.length} 字符）` : s;
}
