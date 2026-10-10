import { ItemView, Notice, WorkspaceLeaf, setIcon, TFile, TFolder } from 'obsidian';
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
	type SkillInfo,
	type Turn,
} from './codem-sessions';
import { SessionPickerModal } from './pickers';

export const VIEW_TYPE_CODEM_CHAT = 'codem-chat-view';

const TYPE_INTERVAL = 30;
const TOOL_RESULT_MAX_LEN = 2000;
const FOLDER_INJECT_MAX = 12000;
const SUGGEST_MAX = 50;

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

/** 内联候选条目（/ 技能 与 @ 文件/文件夹共用） */
interface SuggestItem {
	label: string;
	desc: string;
	insert: string;
}

function statusMark(s: string): string {
	return s === 'completed' ? '✅' : s === 'failed' ? '❌' : s === 'in_progress' ? '⏳' : '';
}

/** 右侧边栏聊天视图（ACP 架构）：流式/思考/工具/权限确认/内联候选/轮次导航/历史续接 */
export class CodeMChatView extends ItemView {
	plugin: CodeMChatPlugin;
	private client: AcpClient | null = null;
	private sessionId: string | null = null;
	private msgContainer!: HTMLElement;
	private navContainer!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private yoloBtn!: HTMLButtonElement;
	private busy = false;
	private yolo = false;
	private mdBuffer = '';
	private displayLen = 0;
	private typeTimer: number | null = null;
	private current: RenderState | null = null;

	// 轮次导航（Claudian 圆形按钮组 + 目录浮层）
	private msgArea!: HTMLElement;
	private navGroup!: HTMLElement;
	private turnCount = 0;
	private turnPos = 0;
	private dirEl: HTMLElement | null = null;
	private dirOpen = false;

	// 内联候选（/ 技能、@ 文件/文件夹）
	private suggestEl: HTMLElement | null = null;
	private suggestItems: SuggestItem[] = [];
	private suggestIndex = 0;
	private suggestPrefix: '/' | '@' | null = null;
	private suggestStart = 0;
	private skillsCache: SkillInfo[] | null = null;
	private vaultEntries: SuggestItem[] | null = null;

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

		// 消息区（含悬浮导航按钮组）
		this.msgArea = root.createDiv({ cls: 'codem-chat-msgarea' });
		this.msgContainer = this.msgArea.createDiv({ cls: 'codem-chat-messages' });
		this.msgContainer.addEventListener('click', () => this.closeDir());
		this.renderEmpty();
		this.buildNavGroup();

		// 输入容器（圆角边框内：textarea + 底部状态行）
		const inputWrap = root.createDiv({ cls: 'codem-chat-inputwrap' });
		this.suggestEl = inputWrap.createDiv({ cls: 'codem-suggest' });
		this.suggestEl.hide();
		this.inputEl = inputWrap.createEl('textarea', {
			cls: 'codem-chat-input',
			attr: { placeholder: '询问 CodeM，/ 技能，@ 文件…（Enter 发送）', rows: 3 },
		});
		const bottomRow = inputWrap.createDiv({ cls: 'codem-chat-bottomrow' });
		bottomRow.createSpan({ cls: 'codem-chat-agent', text: '✳ CodeM · ACP' });
		const actions = bottomRow.createDiv({ cls: 'codem-chat-actions' });
		this.yoloBtn = actions.createEl('button', { text: '🤖 YOLO', cls: 'codem-chat-yolo' });
		this.yoloBtn.setAttribute('aria-label', 'yolo 模式：自动批准工具权限请求');
		this.yoloBtn.onclick = () => this.toggleYolo();
		const newBtn = actions.createEl('button', { cls: 'codem-chat-iconbtn' });
		newBtn.setAttribute('aria-label', '新会话');
		setIcon(newBtn, 'plus');
		newBtn.onclick = () => this.startNewSession();
		const histBtn = actions.createEl('button', { cls: 'codem-chat-iconbtn' });
		histBtn.setAttribute('aria-label', '历史会话');
		setIcon(histBtn, 'history');
		histBtn.onclick = () => void this.openSessionPicker();

		this.bindInputEvents();
	}

	private bindInputEvents(): void {
		this.inputEl.addEventListener('keydown', (e) => {
			// 内联候选开启时优先响应
			if (this.suggestPrefix !== null && this.suggestItems.length > 0) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					this.suggestIndex = (this.suggestIndex + 1) % this.suggestItems.length;
					this.renderSuggestList(this.suggestItems);
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					this.suggestIndex = (this.suggestIndex - 1 + this.suggestItems.length) % this.suggestItems.length;
					this.renderSuggestList(this.suggestItems);
					return;
				}
				if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault();
					this.applySuggest();
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					this.closeSuggest();
					return;
				}
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.send();
			}
		});
		this.inputEl.addEventListener('input', (e) => {
			if ((e as InputEvent).isComposing) return;
			this.updateSuggest();
		});
		this.inputEl.addEventListener('blur', () => {
			window.setTimeout(() => this.closeSuggest(), 120);
		});
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

	/** 右侧悬浮圆形导航按钮组（参考 Claudian）：⏫ ^ ☰ v ⏬ */
	private buildNavGroup(): void {
		this.navGroup = this.msgArea.createDiv({ cls: 'codem-chat-navgroup' });
		const mk = (icon: string, label: string, onclick: () => void): void => {
			const b = this.navGroup.createEl('button', { cls: 'codem-chat-navcircle' });
			b.setAttribute('aria-label', label);
			setIcon(b, icon);
			b.onclick = onclick;
		};
		mk('chevrons-up', '第一轮', () => this.goToTurn(1));
		mk('chevron-up', '上一轮', () => this.stepTurn(-1));
		mk('list', '会话目录', () => this.toggleDir());
		mk('chevron-down', '下一轮', () => this.stepTurn(1));
		mk('chevrons-down', '最新一轮', () => this.goToTurn(this.turnCount));
	}

	/** 跳转到第 n 轮用户消息（滚动定位 + 高亮闪烁） */
	private goToTurn(n: number): void {
		if (this.turnCount === 0) return;
		n = Math.min(this.turnCount, Math.max(1, n));
		const target = this.msgContainer.querySelector(`[data-codem-turn="${n}"]`);
		if (!target) return;
		this.turnPos = n;
		(target as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
		target.addClass('codem-chat-flash');
		window.setTimeout(() => target.removeClass('codem-chat-flash'), 1000);
	}

	private stepTurn(delta: number): void {
		if (this.turnCount === 0) return;
		this.goToTurn(this.turnPos === 0 ? (delta > 0 ? 1 : this.turnCount) : this.turnPos + delta);
	}

	private toggleDir(): void {
		if (this.dirOpen) this.closeDir();
		else this.openDir();
	}

	/** 会话目录浮层：列出全部用户轮次（编号 + 首行摘要），点击跳转 */
	private openDir(): void {
		if (this.turnCount === 0) {
			new Notice('当前会话还没有轮次');
			return;
		}
		if (!this.dirEl) this.dirEl = this.msgArea.createDiv({ cls: 'codem-chat-dir' });
		this.buildDirList();
		this.dirEl.style.display = 'block';
		this.dirOpen = true;
	}

	private buildDirList(): void {
		if (!this.dirEl) return;
		this.dirEl.empty();
		this.dirEl.createDiv({ cls: 'codem-chat-dir-title', text: '会话目录' });
		const list = this.dirEl.createDiv({ cls: 'codem-chat-dir-list' });
		for (let n = 1; n <= this.turnCount; n++) {
			const el = this.msgContainer.querySelector(`[data-codem-turn="${n}"]`);
			if (!el) continue;
			const snip = el.getAttribute('data-codem-snip') || `第 ${n} 轮`;
			const row = list.createDiv({ cls: 'codem-chat-dir-item' });
			row.createSpan({ cls: 'codem-chat-dir-n', text: `${n}.` });
			row.createSpan({ cls: 'codem-chat-dir-snip', text: snip });
			row.onclick = () => {
				this.goToTurn(n);
				this.closeDir();
			};
		}
	}

	private closeDir(): void {
		this.dirOpen = false;
		if (this.dirEl) this.dirEl.style.display = 'none';
	}

	private resetTurnNav(): void {
		this.turnCount = 0;
		this.turnPos = 0;
		this.closeDir();
	}

	private startNewSession(): void {
		if (this.busy) {
			new Notice('CodeM 执行中，等本轮结束后再开新会话');
			return;
		}
		this.sessionId = null;
		this.msgContainer.empty();
		this.resetTurnNav();
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
		this.closeSuggest();
		this.msgContainer.querySelector('.codem-chat-empty')?.remove();

		const userBlock = this.renderUserMessage(rawPrompt);
		this.addTurnAnchor(userBlock);
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

	private renderUserMessage(text: string): HTMLElement {
		const userBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-user' });
		const body = userBlock.createDiv({ cls: 'codem-chat-body markdown-rendered' });
		body.innerHTML = renderMarkdown(text);
		return userBlock;
	}

	/** 轮次锚点：记录序号与摘要供导航按钮组/目录浮层使用 */
	private addTurnAnchor(userBlock: HTMLElement): void {
		this.turnCount++;
		const n = this.turnCount;
		userBlock.setAttribute('data-codem-turn', String(n));
		userBlock.setAttribute('data-codem-snip', (userBlock.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60));
		if (this.dirOpen) this.buildDirList();
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

	/** [[笔记/文件夹]] 引用 → 注入内容（发送给 CodeM，UI 显示原文） */
	private async resolveNoteContexts(prompt: string): Promise<string> {
		const refs = [...prompt.matchAll(/\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g)];
		if (!refs.length) return prompt;
		const extras: string[] = [];
		for (const m of refs) {
			const ref = m[1].trim();
			const dest = this.app.metadataCache.getFirstLinkpathDest(ref, '');
			if (dest) {
				let content = await this.app.vault.cachedRead(dest);
				if (content.length > 8000) content = content.slice(0, 8000) + '\n…（已截断）';
				extras.push(`=== 笔记: ${dest.path} ===\n${content}`);
				continue;
			}
			// 文件夹引用：注入文件清单 + md 全文（总量截断）
			const af = this.app.vault.getAbstractFileByPath(ref);
			if (af instanceof TFolder) {
				extras.push(await this.buildFolderContext(af));
				continue;
			}
			new Notice(`未找到笔记或文件夹：${ref}`);
		}
		if (!extras.length) return prompt;
		return `${prompt}\n\n---\n📎 附加知识库内容：\n${extras.join('\n\n')}`;
	}

	private async buildFolderContext(folder: TFolder): Promise<string> {
		const mds = CodeMChatView.collectMd(folder).slice(0, 50);
		const parts: string[] = [`=== 文件夹: ${folder.path}（${mds.length} 个 md）===`];
		let total = 0;
		for (const f of mds) {
			if (total >= FOLDER_INJECT_MAX) {
				parts.push('…（其余文件未注入，已达上限）');
				break;
			}
			let c = await this.app.vault.cachedRead(f);
			if (total + c.length > FOLDER_INJECT_MAX) c = c.slice(0, Math.max(0, FOLDER_INJECT_MAX - total)) + '\n…（截断）';
			parts.push(`--- ${f.path} ---\n${c}`);
			total += c.length;
		}
		return parts.join('\n\n');
	}

	// ===== 打字机平滑（CodeM chunk 到达快且成块，逐字追赶输出） =====

	private startTypewriter(st: RenderState): void {
		this.stopTypewriter();
		this.typeTimer = window.setInterval(() => {
			const target = this.mdBuffer.length;
			if (this.displayLen >= target) return;
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
			st.thinkingBody.scrollTop = st.thinkingBody.scrollHeight;
			this.scrollBottom();
		} else if (kind === 'tool_call' || kind === 'tool_call_update') {
			this.handleToolEvent(st, update);
		}
	}

	private handleToolEvent(st: RenderState, update: Record<string, unknown>): void {
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
				itemEl.createDiv({ cls: 'codem-chat-tool-raw' }).setText(JSON.stringify(rawInput).slice(0, 300));
			}
			card = { itemEl, headEl, title, status };
			st.cards.set(id, card);
			st.toolsEl.show();
			st.toolsSummary.setText(`🔧 工具调用 ${st.cards.size} 项（执行中…）`);
		} else {
			const incomingTitle = update.title as string | undefined;
			if (incomingTitle) card.title = incomingTitle;
			if (status && status !== card.status) {
				card.status = status;
				card.headEl.setText(`${card.title} ${statusMark(status)}`.trimEnd());
			}
		}
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

	// ===== 内联候选（/ 技能、@ 文件/文件夹） =====

	/** 扫描光标前的 token，命中 / 或 @ 词首则展示候选 */
	private updateSuggest(): void {
		const el = this.inputEl;
		const pos = el.selectionStart ?? 0;
		const before = el.value.slice(0, pos);
		const m = before.match(/(^|\s)([\/@])([^\s]*)$/);
		if (!m) {
			this.closeSuggest();
			return;
		}
		const prefix = m[2] as '/' | '@';
		const query = m[3];
		this.suggestPrefix = prefix;
		this.suggestIndex = 0;
		this.suggestStart = pos - query.length - 1;
		if (prefix === '/') {
			void this.updateSkillSuggestions(query);
		} else {
			this.updateVaultSuggestions(query);
		}
	}

	private async updateSkillSuggestions(query: string): Promise<void> {
		if (!this.skillsCache) {
			this.skillsCache = await listCodemSkills();
		}
		// 异步加载期间输入可能已变化
		if (this.suggestPrefix !== '/') return;
		const q = query.toLowerCase();
		const items: SuggestItem[] = this.skillsCache
			.filter((s) => s.name.toLowerCase().includes(q))
			.slice(0, SUGGEST_MAX)
			.map((s) => ({ label: `/${s.name}`, desc: s.description, insert: `/${s.name} ` }));
		this.renderSuggestList(items);
	}

	private updateVaultSuggestions(query: string): void {
		if (!this.vaultEntries) {
			this.vaultEntries = [];
			for (const af of this.app.vault.getAllLoadedFiles()) {
				if (af.path.startsWith('.obsidian')) continue;
				if (af instanceof TFolder) {
					if (af.path) this.vaultEntries.push({ label: `📁 ${af.path}`, desc: '文件夹', insert: `[[${af.path}]] ` });
				}
			}
			for (const f of this.app.vault.getFiles()) {
				if (f.path.startsWith('.obsidian')) continue;
				this.vaultEntries.push({ label: f.path, desc: '', insert: `[[${f.path}]] ` });
			}
			// 文件夹优先，同组按路径排序
			this.vaultEntries.sort((a, b) => {
				const fa = a.desc === '文件夹' ? 0 : 1;
				const fb = b.desc === '文件夹' ? 0 : 1;
				return fa !== fb ? fa - fb : a.label.localeCompare(b.label);
			});
		}
		const q = query.toLowerCase();
		const items = this.vaultEntries.filter((it) => it.label.toLowerCase().includes(q)).slice(0, SUGGEST_MAX);
		this.renderSuggestList(items);
	}

	private renderSuggestList(items: SuggestItem[]): void {
		if (!this.suggestEl) return;
		if (!items.length) {
			this.closeSuggest();
			return;
		}
		this.suggestItems = items;
		this.suggestIndex = Math.min(this.suggestIndex, items.length - 1);
		this.suggestEl.empty();
		items.forEach((it, i) => {
			const row = this.suggestEl!.createDiv({ cls: 'codem-suggest-item' + (i === this.suggestIndex ? ' is-active' : '') });
			row.createSpan({ cls: 'codem-suggest-label', text: it.label });
			if (it.desc) row.createSpan({ cls: 'codem-suggest-desc', text: it.desc });
			row.addEventListener('mousedown', (e) => e.preventDefault()); // 防止抢走输入框焦点
			row.addEventListener('click', () => {
				this.suggestIndex = i;
				this.applySuggest();
			});
		});
		this.suggestEl.show();
		// 高亮行跟随键盘导航滚动进可视区
		const active = this.suggestEl.querySelector('.codem-suggest-item.is-active');
		active?.scrollIntoView({ block: 'nearest' });
	}

	private applySuggest(): void {
		const item = this.suggestItems[this.suggestIndex];
		if (!item) {
			this.closeSuggest();
			return;
		}
		const el = this.inputEl;
		const pos = el.selectionStart ?? 0;
		el.setRangeText(item.insert, this.suggestStart, pos, 'end');
		this.closeSuggest();
		el.focus();
	}

	private closeSuggest(): void {
		this.suggestPrefix = null;
		this.suggestItems = [];
		if (this.suggestEl) this.suggestEl.hide();
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
		this.msgContainer.empty();
		this.resetTurnNav();
		this.msgContainer.createDiv({ cls: 'codem-chat-empty', text: '载入历史会话…' });
		try {
			const turns = await readCodemSessionTurns(card.filePath);
			const client = await this.ensureClient();
			// cwd 必须传会话自己的原始 cwd（探针实测：会话按 cwd hash 隔离，传错目录报 does not exist）；
			// "active writer" 冲突多为会话被其他 CodeM 入口占用，延迟重试一次
			let loaded = false;
			let lastErr = '';
			for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
				try {
					await client.loadSession(card.sessionId, card.cwd || undefined);
					loaded = true;
				} catch (e) {
					lastErr = e instanceof Error ? e.message : String(e);
					if (attempt === 0) await new Promise((r) => window.setTimeout(r, 1500));
				}
			}
			if (loaded) {
				this.sessionId = card.sessionId;
			} else {
				this.sessionId = null;
				new Notice(
					/active writer/i.test(lastErr)
						? '该会话正被其他 CodeM 入口占用，关掉占用方后重试可续接（本次仅回显）'
						: '该会话无法续接，仅回显'
				);
			}
			this.msgContainer.empty();
			for (const t of turns) this.renderHistoryTurn(t);
			if (!turns.length) this.renderEmpty();
			const head = this.msgContainer.createDiv({ cls: 'codem-chat-history-head' });
			const src = card.source === 'bot' ? '飞书' : card.source === 'tui' ? '终端' : 'CLI';
			head.setText(
				`📜 ${card.firstPrompt.slice(0, 40)}（${src} · ${card.userTurns} 问）` +
					(this.sessionId ? ' · 已续接，可直接继续提问' : ' · 仅回显（续接失败）')
			);
			this.msgContainer.scrollTop = this.msgContainer.scrollHeight;
		} finally {
			this.busy = false;
		}
	}

	private renderHistoryTurn(t: Turn): void {
		if (t.role === 'user') {
			const userBlock = this.renderUserMessage(t.blocks.map((b) => b.content).join('\n\n'));
			this.addTurnAnchor(userBlock);
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

	/** 递归收集文件夹下全部 md（Obsidian typings 的 TFolder 无 getAllFiles） */
	private static collectMd(folder: TFolder): TFile[] {
		const out: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') out.push(child);
			else if (child instanceof TFolder) out.push(...CodeMChatView.collectMd(child));
		}
		return out;
	}
}
