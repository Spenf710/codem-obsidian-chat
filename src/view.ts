import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type CodeMChatPlugin from './main';
import { AcpClient } from './acp-client';
import { renderMarkdown } from './markdown';

export const VIEW_TYPE_CODEM_CHAT = 'codem-chat-view';

const STREAM_RENDER_INTERVAL = 150;
const TOOL_RESULT_MAX_LEN = 2000;

interface ToolCard {
	itemEl: HTMLElement;
	headEl: HTMLElement;
	title: string;
	status: string;
}

/** 一轮对话的渲染句柄（onUpdate 回调据此路由到当前消息块） */
interface RenderState {
	aiBlock: HTMLElement;
	thinking: HTMLDetailsElement;
	thinkingSummary: HTMLElement;
	thinkingBody: HTMLElement;
	toolsEl: HTMLDetailsElement;
	toolsSummary: HTMLElement;
	textEl: HTMLElement;
	cards: Map<string, ToolCard>;
}

/** 右侧边栏聊天视图（ACP 架构）：长驻 codem acp 双向连接，支持流式/工具/权限确认 */
export class CodeMChatView extends ItemView {
	plugin: CodeMChatPlugin;
	private client: AcpClient | null = null;
	private sessionId: string | null = null;
	private msgContainer!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private busy = false;
	private mdBuffer = '';
	private renderTimer: number | null = null;
	private current: RenderState | null = null;

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

	async onClose(): Promise<void> {
		this.client?.stop();
		this.client = null;
	}

	private renderEmpty(): void {
		this.msgContainer.createDiv({
			cls: 'codem-chat-empty',
			text: 'CodeM 已就绪（ACP 双向连接）。Vault 根目录即其工作目录。',
		});
	}

	private startNewSession(): void {
		if (this.busy) {
			new Notice('CodeM 执行中，等本轮结束后再开新会话');
			return;
		}
		this.sessionId = null;
		this.msgContainer.empty();
		this.renderEmpty();
	}

	private async ensureClient(): Promise<AcpClient> {
		if (this.client) return this.client;
		this.client = new AcpClient(
			{
				cliPath: this.plugin.settings.codemCliPath,
				cwd: (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath(),
				nodePath: this.plugin.settings.nodePath,
				extraArgs: this.plugin.settings.extraArgs,
			},
			{
				onUpdate: (u) => this.handleUpdate(u),
				onPermissionRequest: (params, respond) => this.handlePermission(params, respond),
				onClose: (code) => {
					this.client = null;
					this.sessionId = null;
					if (this.busy) {
						new Notice(`CodeM 连接断开（退出码 ${code}），本轮中止`);
						this.busy = false;
						this.sendBtn.disabled = false;
					}
				},
			}
		);
		return this.client;
	}

	private async send(): Promise<void> {
		const rawPrompt = this.inputEl.value.trim();
		if (!rawPrompt || this.busy) return;

		this.busy = true;
		this.inputEl.value = '';
		this.sendBtn.disabled = true;
		this.msgContainer.querySelector('.codem-chat-empty')?.remove();

		// 用户消息
		const userBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-user' });
		userBlock.innerHTML = renderMarkdown(rawPrompt);

		// 助手消息骨架：thinking 折叠区 + 工具折叠区 + 正文
		const aiBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-assistant' });
		const thinking = aiBlock.createEl('details', { cls: 'codem-chat-thinking' });
		thinking.setAttribute('open', '');
		const thinkingSummary = thinking.createEl('summary', { text: '思考中…' });
		const thinkingBody = thinking.createDiv({ cls: 'codem-chat-thinking-body' });
		const toolsEl = aiBlock.createEl('details', { cls: 'codem-chat-tools' });
		const toolsSummary = toolsEl.createEl('summary', { text: '🔧 工具调用中…' });
		toolsEl.hide();
		const textEl = aiBlock.createDiv({ cls: 'codem-chat-text' });
		this.scrollBottom();

		const st: RenderState = {
			aiBlock,
			thinking,
			thinkingSummary,
			thinkingBody,
			toolsEl,
			toolsSummary,
			textEl,
			cards: new Map(),
		};
		this.current = st;
		this.mdBuffer = '';

		try {
			const client = await this.ensureClient();
			if (!this.sessionId) this.sessionId = await client.newSession();
			await client.prompt(this.sessionId, rawPrompt);

			// 一轮完成收尾
			this.clearRenderTimer();
			st.textEl.innerHTML = renderMarkdown(this.mdBuffer);
			if (st.thinkingBody.textContent) {
				st.thinkingSummary.setText('思考过程');
				st.thinking.removeAttribute('open');
			} else {
				st.thinking.hide();
			}
			if (st.cards.size > 0) {
				st.toolsSummary.setText(`🔧 工具调用 ${st.cards.size} 项`);
				st.toolsEl.removeAttribute('open');
			} else {
				st.toolsEl.hide();
			}
		} catch (e) {
			this.clearRenderTimer();
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
			this.current = null;
			this.busy = false;
			this.sendBtn.disabled = false;
			this.scrollBottom();
		}
	}

	private handleUpdate(update: Record<string, unknown>): void {
		const st = this.current;
		if (!st) return;
		const kind = update.sessionUpdate as string;
		const content = update.content as { text?: string } | undefined;

		if (kind === 'agent_message_chunk') {
			this.mdBuffer += content?.text ?? '';
			this.scheduleStreamRender(st.textEl);
		} else if (kind === 'agent_thought_chunk') {
			st.thinkingBody.textContent += content?.text ?? '';
			this.scrollBottom();
		} else if (kind === 'tool_call' || kind === 'tool_call_update') {
			const id = update.toolCallId as string;
			const title = (update.title as string) || (update.kind as string) || '工具';
			const status = (update.status as string) || '';
			let card = st.cards.get(id);
			if (!card) {
				const itemEl = st.toolsEl.createDiv({ cls: 'codem-chat-tool-item' });
				const headEl = itemEl.createDiv({ cls: 'codem-chat-tool-head' });
				card = { itemEl, headEl, title, status: '' };
				st.cards.set(id, card);
				st.toolsEl.show();
				st.toolsSummary.setText(`🔧 工具调用 ${st.cards.size} 项（执行中…）`);
			}
			if (title && title !== card.title) card.title = title;
			if (status !== card.status) {
				card.status = status;
				const mark = status === 'completed' ? '✅' : status === 'failed' ? '❌' : status === 'in_progress' ? '⏳' : '';
				card.headEl.setText(`${card.title}${mark ? ' ' + mark : ''}`);
			}
			const contents = (update.content as Array<{ type?: string; text?: string }>) ?? [];
			for (const c of contents) {
				if (c.text) {
					card.itemEl.createEl('pre', { cls: 'codem-chat-tool-result' }).setText(
						c.text.length > TOOL_RESULT_MAX_LEN
							? c.text.slice(0, TOOL_RESULT_MAX_LEN) + `…（截断，共 ${c.text.length} 字符）`
							: c.text
					);
				}
			}
			this.scrollBottom();
		}
		// plan 等其他 update 类型：P3 按需渲染
	}

	private handlePermission(
		params: Record<string, unknown>,
		respond: (result: unknown) => void
	): void {
		const st = this.current;
		if (!st) {
			respond({ outcome: { outcome: 'cancelled' } });
			return;
		}
		const tool = params.toolCall as { title?: string } | undefined;
		const options = (params.options as Array<{ optionId: string; name: string }>) ?? [];
		const bar = st.aiBlock.createDiv({ cls: 'codem-chat-perm' });
		bar.createSpan({ text: `🔒 ${tool?.title ?? '工具请求权限'}` });
		for (const opt of options) {
			bar.createEl('button', { text: opt.name }).onclick = () => {
				bar.remove();
				respond({ outcome: { outcome: 'selected', optionId: opt.optionId } });
			};
		}
		this.scrollBottom();
	}

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
