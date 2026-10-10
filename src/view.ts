import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type CodeMChatPlugin from './main';
import { AcpClient } from './acp-client';
import { renderMarkdown } from './markdown';
import {
	listCodemSessions,
	readCodemSessionTurns,
	listCodemSkills,
	type SessionCard,
	type Turn,
} from './codem-sessions';
import { SkillPickerModal, FilePickerModal, SessionPickerModal } from './pickers';

export const VIEW_TYPE_CODEM_CHAT = 'codem-chat-view';

const TYPE_INTERVAL = 30;
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

function statusMark(s: string): string {
	return s === 'completed' ? '✅' : s === 'failed' ? '❌' : s === 'in_progress' ? '⏳' : '';
}

/** 右侧边栏聊天视图（ACP 架构）：流式/思考/工具/权限确认/技能/文件引用/历史续接 */
export class CodeMChatView extends ItemView {
	plugin: CodeMChatPlugin;
	private client: AcpClient | null = null;
	private sessionId: string | null = null;
	private msgContainer!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private yoloBtn!: HTMLButtonElement;
	private busy = false;
	private yolo = false;
	private mdBuffer = '';
	private displayLen = 0;
	private typeTimer: number | null = null;
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
		const histBtn = topBar.createEl('button', { text: '历史' });
		histBtn.onclick = () => void this.openSessionPicker();
		this.yoloBtn = topBar.createEl('button', { text: '🤖 yolo', cls: 'codem-chat-yolo' });
		this.yoloBtn.setAttribute('aria-label', 'yolo 模式：自动批准工具权限请求');
		this.yoloBtn.onclick = () => this.toggleYolo();

		this.msgContainer = root.createDiv({ cls: 'codem-chat-messages' });
		this.renderEmpty();

		const inputBar = root.createDiv({ cls: 'codem-chat-inputbar' });
		this.inputEl = inputBar.createEl('textarea', {
			cls: 'codem-chat-input',
			attr: { placeholder: '向 CodeM 提问…（Enter 发送 / Shift+Enter 换行 / / 技能 / @ 文件）', rows: 3 },
		});
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.send();
				return;
			}
			if ((e.key === '/' || e.key === '@') && !e.isComposing && !e.ctrlKey && !e.altKey && !e.metaKey) {
				const el = this.inputEl;
				const pos = el.selectionStart ?? 0;
				const before = el.value.slice(0, pos);
				// 词首触发（行首/空格/换行之后）
				if (before === '' || before.endsWith('\n') || before.endsWith(' ')) {
					e.preventDefault();
					if (e.key === '/') void this.openSkillPicker();
					else this.openFilePicker();
				}
			}
		});
		this.sendBtn = inputBar.createEl('button', { text: '发送', cls: 'codem-chat-send' });
		this.sendBtn.onclick = () => void this.send();
	}

	async onClose(): Promise<void> {
		this.stopTypewriter();
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

	private toggleYolo(): void {
		this.yolo = !this.yolo;
		this.yoloBtn.toggleClass('is-active', this.yolo);
		new Notice(this.yolo ? 'yolo 已开启：工具权限自动批准' : 'yolo 已关闭：工具权限逐次确认');
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

	// ===== 发送与流式渲染 =====

	private async send(): Promise<void> {
		const rawPrompt = this.inputEl.value.trim();
		if (!rawPrompt || this.busy) return;

		this.busy = true;
		this.inputEl.value = '';
		this.sendBtn.disabled = true;
		this.msgContainer.querySelector('.codem-chat-empty')?.remove();

		this.renderUserMessage(rawPrompt);
		const st = this.renderAssistantSkeleton();
		this.current = st;
		this.mdBuffer = '';
		this.displayLen = 0;

		try {
			const client = await this.ensureClient();
			if (!this.sessionId) this.sessionId = await client.newSession();
			const injected = await this.resolveNoteContexts(rawPrompt);
			this.startTypewriter(st);
			await client.prompt(this.sessionId, injected);
			this.finishTurn(st);
		} catch (e) {
			this.stopTypewriter();
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
			st.aiBlock.remove();
			const errBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-error' });
			errBlock.setText(detail);
		} finally {
			this.current = null;
			this.busy = false;
			this.sendBtn.disabled = false;
			this.scrollBottom();
		}
	}

	/** 一轮完成收尾：停打字机、渲染全文、折叠思考/工具区 */
	private finishTurn(st: RenderState): void {
		this.stopTypewriter();
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
	}

	private renderUserMessage(text: string): void {
		const userBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-user' });
		const label = userBlock.createDiv({ cls: 'codem-chat-role', text: '你' });
		void label;
		const body = userBlock.createDiv({ cls: 'codem-chat-body markdown-rendered' });
		body.innerHTML = renderMarkdown(text);
	}

	private renderAssistantSkeleton(): RenderState {
		const aiBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-assistant' });
		const thinking = aiBlock.createEl('details', { cls: 'codem-chat-thinking' });
		thinking.setAttribute('open', '');
		const thinkingSummary = thinking.createEl('summary', { text: '思考中…' });
		const thinkingBody = thinking.createDiv({ cls: 'codem-chat-thinking-body' });
		const toolsEl = aiBlock.createEl('details', { cls: 'codem-chat-tools' });
		const toolsSummary = toolsEl.createEl('summary', { text: '🔧 工具调用中…' });
		toolsEl.hide();
		const textEl = aiBlock.createDiv({ cls: 'codem-chat-text markdown-rendered' });
		this.scrollBottom();
		return { aiBlock, thinking, thinkingSummary, thinkingBody, toolsEl, toolsSummary, textEl, cards: new Map() };
	}

	/** [[笔记]] 引用 → 注入笔记全文（发送给 CodeM，UI 显示原文） */
	private async resolveNoteContexts(prompt: string): Promise<string> {
		const refs = [...prompt.matchAll(/\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g)];
		if (!refs.length) return prompt;
		const extras: string[] = [];
		for (const m of refs) {
			const dest = this.app.metadataCache.getFirstLinkpathDest(m[1].trim(), '');
			if (dest) {
				let content = await this.app.vault.cachedRead(dest);
				if (content.length > 8000) content = content.slice(0, 8000) + '\n…（已截断）';
				extras.push(`=== 笔记: ${dest.path} ===\n${content}`);
			} else {
				new Notice(`未找到笔记：${m[1]}`);
			}
		}
		if (!extras.length) return prompt;
		return `${prompt}\n\n---\n📎 附加笔记内容：\n${extras.join('\n\n')}`;
	}

	// ===== 打字机平滑（CodeM chunk 到达快且成块，逐字追赶输出） =====

	private startTypewriter(st: RenderState): void {
		this.stopTypewriter();
		this.typeTimer = window.setInterval(() => {
			const target = this.mdBuffer.length;
			if (this.displayLen >= target) return;
			// 自适应速度：积压越多追越快，保证长回复不拖沓
			const step = Math.max(1, Math.ceil((target - this.displayLen) / 15));
			this.displayLen = Math.min(target, this.displayLen + step);
			st.textEl.innerHTML = renderMarkdown(this.mdBuffer.slice(0, this.displayLen));
			this.scrollBottom();
		}, TYPE_INTERVAL);
	}

	private stopTypewriter(): void {
		if (this.typeTimer !== null) {
			window.clearInterval(this.typeTimer);
			this.typeTimer = null;
		}
	}

	// ===== ACP 通知分发 =====

	private handleUpdate(update: Record<string, unknown>): void {
		const st = this.current;
		if (!st) return; // 历史载入的重放通知也走这里，current 为空即忽略
		const kind = update.sessionUpdate as string;
		const content = update.content as { text?: string } | undefined;

		if (kind === 'agent_message_chunk') {
			this.mdBuffer += content?.text ?? '';
		} else if (kind === 'agent_thought_chunk') {
			st.thinkingBody.textContent += content?.text ?? '';
			st.thinkingBody.scrollTop = st.thinkingBody.scrollHeight; // 内部视口跟随
			this.scrollBottom();
		} else if (kind === 'tool_call' || kind === 'tool_call_update') {
			this.handleToolEvent(st, update, kind);
		}
	}

	private handleToolEvent(st: RenderState, update: Record<string, unknown>, kind: string): void {
		const id = update.toolCallId as string;
		const status = (update.status as string) || '';
		let card = st.cards.get(id);
		if (!card) {
			const title = (update.title as string) || (update.kind as string) || '工具';
			const itemEl = st.toolsEl.createDiv({ cls: 'codem-chat-tool-item' });
			const headEl = itemEl.createDiv({ cls: 'codem-chat-tool-head' });
			headEl.setText(`${title} ${statusMark(status)}`.trimEnd());
			const rawInput = update.rawInput;
			if (rawInput && Object.keys(rawInput as object).length > 0) {
				itemEl.createDiv({ cls: 'codem-chat-tool-raw' }).setText(
					JSON.stringify(rawInput).slice(0, 300)
				);
			}
			card = { itemEl, headEl, title, status };
			st.cards.set(id, card);
			st.toolsEl.show();
			st.toolsSummary.setText(`🔧 工具调用 ${st.cards.size} 项（执行中…）`);
		} else {
			// title 仅在事件显式携带时更新（tool_call_update 常不带 title，不能让 fallback 值覆盖真实标题）
			const incomingTitle = update.title as string | undefined;
			if (incomingTitle) card.title = incomingTitle;
			if (status && status !== card.status) {
				card.status = status;
				card.headEl.setText(`${card.title} ${statusMark(status)}`.trimEnd());
			}
		}
		// 结果内容：CodeM 实测为双层嵌套 content[].content.text，兼容单层
		const contents = (update.content as Array<{ text?: string; content?: { text?: string } }>) ?? [];
		for (const c of contents) {
			const text = c?.content?.text ?? c?.text;
			if (text) {
				card.itemEl.createEl('pre', { cls: 'codem-chat-tool-result' }).setText(
					text.length > TOOL_RESULT_MAX_LEN
						? text.slice(0, TOOL_RESULT_MAX_LEN) + `…（截断，共 ${text.length} 字符）`
						: text
				);
			}
		}
		this.scrollBottom();
	}

	private handlePermission(
		params: Record<string, unknown>,
		respond: (result: unknown) => void
	): void {
		const st = this.current;
		const tool = params.toolCall as { title?: string } | undefined;
		const label = tool?.title ?? '工具请求权限';
		const options = (params.options as Array<{ optionId: string; name: string; kind?: string }>) ?? [];
		const allow = options.find((o) => String(o.kind).startsWith('allow'));

		if (!st) {
			respond({ outcome: { outcome: 'cancelled' } });
			return;
		}
		// yolo 模式：自动批准（选第一个 allow 类选项）
		if (this.yolo && allow) {
			respond({ outcome: { outcome: 'selected', optionId: allow.optionId } });
			const note = st.aiBlock.createDiv({ cls: 'codem-chat-perm codem-chat-perm-auto' });
			note.setText(`🤖 yolo 自动批准：${label}`);
			this.scrollBottom();
			return;
		}
		const bar = st.aiBlock.createDiv({ cls: 'codem-chat-perm' });
		bar.createSpan({ text: `🔒 ${label}` });
		for (const opt of options) {
			bar.createEl('button', { text: opt.name }).onclick = () => {
				bar.remove();
				respond({ outcome: { outcome: 'selected', optionId: opt.optionId } });
			};
		}
		this.scrollBottom();
	}

	// ===== / 技能与 @ 文件 =====

	private async openSkillPicker(): Promise<void> {
		const skills = await listCodemSkills();
		if (!skills.length) {
			new Notice('未扫描到技能（~/.claude/skills、~/.codem/skills、managed 均为空）');
			return;
		}
		new SkillPickerModal(this.app, skills, (s) => this.insertAtCursor(`/${s.name} `)).open();
	}

	private openFilePicker(): void {
		new FilePickerModal(this.app, (f) => this.insertAtCursor(`[[${f.path}]]`)).open();
	}

	private insertAtCursor(text: string): void {
		const el = this.inputEl;
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? start;
		el.setRangeText(text, start, end, 'end');
		el.focus();
	}

	// ===== 历史会话追溯 =====

	private async openSessionPicker(): Promise<void> {
		if (this.busy) {
			new Notice('CodeM 执行中，稍后再切换会话');
			return;
		}
		new Notice('扫描 ~/.codem/sessions …');
		const cards = await listCodemSessions();
		if (!cards.length) {
			new Notice('未找到任何 CodeM 会话记录');
			return;
		}
		new SessionPickerModal(this.app, cards, (c) => void this.loadHistory(c)).open();
	}

	/** 载入历史会话：jsonl 回显 + ACP session/load 续接 */
	private async loadHistory(card: SessionCard): Promise<void> {
		this.busy = true;
		this.sendBtn.disabled = true;
		this.msgContainer.empty();
		const statusEl = this.msgContainer.createDiv({ cls: 'codem-chat-empty', text: '载入历史会话…' });
		try {
			const turns = await readCodemSessionTurns(card.filePath);
			const client = await this.ensureClient();
			try {
				await client.loadSession(card.sessionId);
				this.sessionId = card.sessionId;
			} catch {
				// load 失败（如会话属其他入口）：仅回显，发送时自动开新会话
				this.sessionId = null;
				new Notice('该会话无法续接（可能为飞书/旧入口会话），仅回显');
			}
			this.msgContainer.empty();
			for (const t of turns) this.renderHistoryTurn(t);
			if (!turns.length) this.renderEmpty();
			const head = this.msgContainer.createDiv({ cls: 'codem-chat-history-head' });
			const src = card.source === 'bot' ? '飞书' : card.source === 'tui' ? '终端' : 'CLI';
			head.setText(`📜 ${card.firstPrompt.slice(0, 40)}（${src} · ${card.userTurns} 问）${this.sessionId ? ' · 已续接，可直接继续提问' : ''}`);
			this.msgContainer.scrollTop = this.msgContainer.scrollHeight;
		} finally {
			this.busy = false;
			this.sendBtn.disabled = false;
			void statusEl;
		}
	}

	private renderHistoryTurn(t: Turn): void {
		if (t.role === 'user') {
			const userBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-user' });
			const body = userBlock.createDiv({ cls: 'codem-chat-body markdown-rendered' });
			body.innerHTML = renderMarkdown(t.blocks.map((b) => b.content).join('\n\n'));
		} else if (t.role === 'assistant') {
			const aiBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-assistant' });
			const thinks = t.blocks.filter((b) => b.kind === 'thinking');
			if (thinks.length) {
				const d = aiBlock.createEl('details', { cls: 'codem-chat-thinking' });
				d.createEl('summary', { text: '思考过程' });
				d.createDiv({ cls: 'codem-chat-thinking-body' }).setText(thinks.map((b) => b.content).join('\n\n'));
			}
			for (const b of t.blocks) {
				if (b.kind === 'text') {
					aiBlock.createDiv({ cls: 'codem-chat-text markdown-rendered' }).innerHTML = renderMarkdown(b.content);
				}
			}
			const tools = t.blocks.filter((b) => b.kind === 'tool_use');
			if (tools.length) {
				const d = aiBlock.createEl('details', { cls: 'codem-chat-tools' });
				d.createEl('summary', { text: `🔧 工具调用 ${tools.length} 项` });
				for (const b of tools) {
					const item = d.createDiv({ cls: 'codem-chat-tool-item' });
					item.createDiv({ cls: 'codem-chat-tool-head' }).setText(b.label ?? '工具');
					item.createEl('pre', { cls: 'codem-chat-tool-result' }).setText(b.content);
				}
			}
		} else {
			const d = this.msgContainer.createEl('details', { cls: 'codem-chat-toolitem-standalone' });
			for (const b of t.blocks) {
				d.createEl('summary', { text: b.label ?? (b.kind === 'tool_result' ? '工具结果' : '工具') });
				d.createEl('pre', { cls: 'codem-chat-tool-result' }).setText(b.content);
			}
		}
	}

	private scrollBottom(): void {
		this.msgContainer.scrollTop = this.msgContainer.scrollHeight;
	}
}
