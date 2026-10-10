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
import { formatTime } from './pickers';

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

/** 待发送图片（粘贴直接进内存，base64 无 data: 前缀） */
interface PendingImage {
	data: string;
	mime: string;
}

/** 视图内会话 tab：独立会话/消息 DOM/流式状态，可并行执行（三色灯） */
interface ChatTab {
	id: number;
	light: 'idle' | 'running' | 'done';
	sessionId: string | null;
	pendingContext: string | null;
	busy: boolean;
	current: RenderState | null;
	mdBuffer: string;
	displayLen: number;
	typeTimer: number | null;
	turnCount: number;
	turnPos: number;
	images: PendingImage[];
	scrollEl: HTMLElement;
}

/** 内联候选条目（/ 技能 与 @ 文件/文件夹共用） */
interface SuggestItem {
	label: string;
	desc: string;
	insert: string;
	/** vault 路径（@ 钻取：文件夹条目 → 键下钻用） */
	vaultPath?: string;
	isFolder?: boolean;
}

function statusMark(s: string): string {
	return s === 'completed' ? '✅' : s === 'failed' ? '❌' : s === 'in_progress' ? '⏳' : '';
}

/** 右侧边栏聊天视图（ACP 架构）：流式/思考/工具/权限确认/内联候选/轮次导航/历史续接 */
export class CodeMChatView extends ItemView {
	plugin: CodeMChatPlugin;
	private client: AcpClient | null = null;
	private inputEl!: HTMLTextAreaElement;
	private yoloBtn!: HTMLButtonElement;
	private yolo = false;

	// 多会话 tab（视图内并行，参考 Claudian 数字 tab）
	private tabs: ChatTab[] = [];
	private activeTab!: ChatTab;
	private tabCounter = 0;
	private tabsEl!: HTMLElement;
	private previewEl!: HTMLElement;

	// 轮次导航（Claudian 圆形按钮组 + 目录浮层，切 tab 关闭）
	private msgArea!: HTMLElement;
	private navGroup!: HTMLElement;
	private dirEl: HTMLElement | null = null;
	private dirOpen = false;

	// 历史会话内联浮层（与 @ / 的候选浮层同款式）+ 软续接快照
	private inputWrapEl!: HTMLElement;
	private histEl: HTMLElement | null = null;
	private histOpen = false;
	private allCards: SessionCard[] = [];
	private histItems: SessionCard[] = [];
	private histIndex = 0;

	// 内联候选（/ 技能、@ 文件夹钻取）
	private suggestEl: HTMLElement | null = null;
	private suggestItems: SuggestItem[] = [];
	private suggestIndex = 0;
	private suggestPrefix: '/' | '@' | null = null;
	private suggestStart = 0;
	private skillsCache: SkillInfo[] | null = null;
	private suggestDirPath = '';
	private lightEl: HTMLElement | null = null;

	// ===== 会话状态代理（getter/setter 指向 activeTab，既有逻辑零改动） =====

	private get sessionId(): string | null {
		return this.activeTab.sessionId;
	}
	private set sessionId(v: string | null) {
		this.activeTab.sessionId = v;
	}
	private get busy(): boolean {
		return this.activeTab.busy;
	}
	private set busy(v: boolean) {
		this.activeTab.busy = v;
	}
	private get current(): RenderState | null {
		return this.activeTab.current;
	}
	private set current(v: RenderState | null) {
		this.activeTab.current = v;
	}
	private get mdBuffer(): string {
		return this.activeTab.mdBuffer;
	}
	private set mdBuffer(v: string) {
		this.activeTab.mdBuffer = v;
	}
	private get displayLen(): number {
		return this.activeTab.displayLen;
	}
	private set displayLen(v: number) {
		this.activeTab.displayLen = v;
	}
	private get typeTimer(): number | null {
		return this.activeTab.typeTimer;
	}
	private set typeTimer(v: number | null) {
		this.activeTab.typeTimer = v;
	}
	private get turnCount(): number {
		return this.activeTab.turnCount;
	}
	private set turnCount(v: number) {
		this.activeTab.turnCount = v;
	}
	private get turnPos(): number {
		return this.activeTab.turnPos;
	}
	private set turnPos(v: number) {
		this.activeTab.turnPos = v;
	}
	private get pendingContext(): string | null {
		return this.activeTab.pendingContext;
	}
	private set pendingContext(v: string | null) {
		this.activeTab.pendingContext = v;
	}
	private get msgContainer(): HTMLElement {
		return this.activeTab.scrollEl;
	}

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

		// 消息区（含悬浮导航按钮组）：每个 tab 一个消息容器，切换显隐
		this.msgArea = root.createDiv({ cls: 'codem-chat-msgarea' });

		// tab 行在输入框外面（上方）：左 tab 组，右 +/历史图标（参考 Claudian UI）
		const tabRow = root.createDiv({ cls: 'codem-chat-tabrow' });
		this.tabsEl = tabRow.createDiv({ cls: 'codem-chat-tabs' });
		const tabActions = tabRow.createDiv({ cls: 'codem-chat-actions' });
		const newBtn = tabActions.createEl('button', { cls: 'codem-chat-iconbtn' });
		newBtn.setAttribute('aria-label', '新会话');
		setIcon(newBtn, 'plus');
		newBtn.onclick = () => void this.startNewSession();
		const histBtn = tabActions.createEl('button', { cls: 'codem-chat-iconbtn' });
		histBtn.setAttribute('aria-label', '历史会话');
		setIcon(histBtn, 'history');
		// mousedown preventDefault：保持输入框焦点，防 blur 处理器把刚打开的历史浮层关掉（"闪退"）
		histBtn.addEventListener('mousedown', (e) => e.preventDefault());
		histBtn.onclick = () => void this.toggleHistoryPanel();

		// 输入容器（圆角边框内：图片预览行 + textarea + 底部状态行）
		this.inputWrapEl = root.createDiv({ cls: 'codem-chat-inputwrap' });
		const inputWrap = this.inputWrapEl;
		this.previewEl = inputWrap.createDiv({ cls: 'codem-chat-previews' });
		this.previewEl.hide();
		this.suggestEl = inputWrap.createDiv({ cls: 'codem-suggest' });
		this.suggestEl.hide();

		this.activeTab = this.createTab();
		this.renderEmpty();
		this.buildNavGroup();
		this.renderTabs();
		this.inputEl = inputWrap.createEl('textarea', {
			cls: 'codem-chat-input',
			attr: { placeholder: '询问 CodeM，/ 技能，@ 文件…（Enter 发送）', rows: 3 },
		});
		const bottomRow = inputWrap.createDiv({ cls: 'codem-chat-bottomrow' });
		this.lightEl = bottomRow.createSpan({ cls: 'codem-chat-light is-idle' });
		bottomRow.createSpan({ cls: 'codem-chat-agent', text: '✳ CodeM · ACP' });
		const actions = bottomRow.createDiv({ cls: 'codem-chat-actions' });
		this.yoloBtn = actions.createEl('button', { text: '🤖 YOLO', cls: 'codem-chat-yolo' });
		this.yoloBtn.setAttribute('aria-label', 'yolo 模式：自动批准工具权限请求');
		this.yoloBtn.onclick = () => this.toggleYolo();

		this.bindInputEvents();
		this.bindPaste();
		this.setStatusLight('idle');
	}

	private bindInputEvents(): void {
		this.inputEl.addEventListener('keydown', (e) => {
			const suggestActive = this.suggestPrefix !== null && this.suggestItems.length > 0;
			const histActive = this.histOpen && this.histItems.length > 0;
			// 内联浮层（候选/历史）开启时优先响应；composing 中不抢键（IME 选字需要 Enter/数字键）
			if ((suggestActive || histActive) && !e.isComposing) {
				const count = histActive ? this.histItems.length : this.suggestItems.length;
				const move = (delta: number): void => {
					e.preventDefault();
					if (histActive) {
						this.histIndex = (this.histIndex + delta + count) % count;
						this.renderHistoryPanel();
					} else {
						this.suggestIndex = (this.suggestIndex + delta + count) % count;
						this.renderSuggestList(this.suggestItems);
					}
				};
				if (e.key === 'ArrowDown') return move(1);
				if (e.key === 'ArrowUp') return move(-1);
				// @ 钻取：→ 进入高亮文件夹，← 回退上一级
				if (e.key === 'ArrowRight' && !histActive && this.suggestPrefix === '@') {
					const it = this.suggestItems[this.suggestIndex];
					if (it?.isFolder) {
						e.preventDefault();
						this.drillVaultFolder(it);
						return;
					}
				}
				if (e.key === 'ArrowLeft' && !histActive && this.suggestPrefix === '@' && this.suggestDirPath) {
					e.preventDefault();
					this.backVaultFolder();
					return;
				}
				if (e.key === 'Enter' || e.key === 'Tab') {
					e.preventDefault();
					if (histActive) {
						const card = this.histItems[this.histIndex];
						this.closeHistory();
						if (card) void this.loadHistory(card);
					} else {
						this.applySuggest();
					}
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					if (histActive) this.closeHistory();
					else this.closeSuggest();
					return;
				}
			}
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.send();
			}
		});
		// 不跳过 composing 的 input：中文输入法敲 @ 或 / 也能立刻激活浮层
		this.inputEl.addEventListener('input', () => {
			this.updateSuggest();
			if (this.histOpen) this.filterHistory();
		});
		this.inputEl.addEventListener('blur', () => {
			window.setTimeout(() => {
				this.closeSuggest();
				this.closeHistory();
			}, 120);
		});
	}

	async onClose(): Promise<void> {
		// 先释放全部会话再杀进程：不清 writer 会导致下次打开视图 load 同会话报 active writer
		for (const t of this.tabs) this.releaseSession(t);
		await new Promise((r) => window.setTimeout(r, 120));
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
		this.dirEl.style.display = 'flex';
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

	// ===== 多会话 tab 管理 =====

	private createTab(): ChatTab {
		const tab: ChatTab = {
			id: ++this.tabCounter,
			light: 'idle',
			sessionId: null,
			pendingContext: null,
			busy: false,
			current: null,
			mdBuffer: '',
			displayLen: 0,
			typeTimer: null,
			turnCount: 0,
			turnPos: 0,
			images: [],
			scrollEl: null as unknown as HTMLElement,
		};
		tab.scrollEl = this.msgArea.createDiv({ cls: 'codem-chat-messages' });
		tab.scrollEl.addEventListener('click', () => this.closeDir());
		this.tabs.push(tab);
		return tab;
	}

	/** tab 行渲染：编号 + 三色灯 dot + 悬停 × 关闭，active 高亮 */
	private renderTabs(): void {
		const el = this.tabsEl;
		el.empty();
		this.tabs.forEach((tab, i) => {
			const b = el.createEl('button', { cls: 'codem-chat-tab' + (tab === this.activeTab ? ' is-active' : '') });
			const dot = b.createSpan({ cls: 'codem-chat-light' });
			dot.addClass('is-' + tab.light);
			b.createSpan({ text: String(i + 1) });
			b.setAttribute('aria-label', `会话 ${i + 1}`);
			b.onclick = () => this.switchTab(tab);
			if (this.tabs.length > 1) {
				const x = b.createSpan({ cls: 'codem-chat-tab-close', text: '×' });
				x.onclick = (e) => {
					e.stopPropagation();
					this.removeTab(tab);
				};
			}
		});
	}

	private switchTab(tab: ChatTab): void {
		if (tab === this.activeTab) return;
		this.closeDir();
		this.closeSuggest();
		this.closeHistory();
		for (const t of this.tabs) t.scrollEl.style.display = t === tab ? '' : 'none';
		this.activeTab = tab;
		this.renderTabs();
		this.renderPreviews();
		this.setStatusLight(tab.light);
		this.inputEl.focus();
	}

	/** 关闭 tab：释放其会话；关的是当前 tab 则切到相邻（无相邻则新建空 tab） */
	private removeTab(tab: ChatTab): void {
		if (tab.busy) {
			new Notice('该会话执行中，等本轮结束再关');
			return;
		}
		this.releaseSession(tab);
		const idx = this.tabs.indexOf(tab);
		if (idx < 0) return;
		this.tabs.splice(idx, 1);
		tab.scrollEl.remove();
		if (tab === this.activeTab) {
			const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
			if (next) {
				this.switchTab(next);
			} else {
				this.activeTab = this.createTab();
				this.renderEmpty();
				this.setStatusLight('idle');
			}
		}
		this.renderTabs();
	}

	/** 重置当前 tab 为空会话（不占 tab 槽位） */
	private resetActiveTab(): void {
		const tab = this.activeTab;
		this.releaseSession(tab);
		tab.pendingContext = null;
		tab.mdBuffer = '';
		tab.displayLen = 0;
		if (tab.typeTimer !== null) {
			window.clearInterval(tab.typeTimer);
			tab.typeTimer = null;
		}
		tab.images = [];
		tab.turnCount = 0;
		tab.turnPos = 0;
		tab.current = null;
		tab.light = 'idle';
		this.closeDir();
		this.renderPreviews();
		this.msgContainer.empty();
		this.renderEmpty();
		this.setStatusLight('idle');
	}

	private async startNewSession(): Promise<void> {
		const tab = this.activeTab;
		if (tab.busy) {
			new Notice('CodeM 执行中，等本轮结束后再开新会话');
			return;
		}
		// 当前 tab 还没开始过对话 → 就地重置，不占 tab 额度
		if (!tab.sessionId && tab.turnCount === 0 && !tab.pendingContext) {
			this.resetActiveTab();
			return;
		}
		const max = Math.max(1, this.plugin.settings.maxWindows || 3);
		if (this.tabs.length >= max) {
			new Notice(`已达会话上限（${max} 个），可关闭 tab 或在设置中调整`);
			return;
		}
		this.closeDir();
		for (const t of this.tabs) t.scrollEl.style.display = 'none';
		this.activeTab = this.createTab();
		this.renderEmpty();
		this.renderTabs();
		this.setStatusLight('idle');
		this.inputEl.focus();
	}

	/**
	 * 三色灯：灰=静默 / 黄=执行中 / 绿=执行结束。
	 * 同步两处：底部状态行 dot + tab 行（tab 行即状态面板）
	 */
	private setStatusLight(state: 'idle' | 'running' | 'done'): void {
		this.activeTab.light = state;
		if (this.lightEl) {
			this.lightEl.removeClass('is-idle', 'is-running', 'is-done');
			this.lightEl.addClass('is-' + state);
		}
		this.renderTabs();
	}

	// ===== 图片粘贴（CodeM 识图） =====

	private renderPreviews(): void {
		const el = this.previewEl;
		el.empty();
		const imgs = this.activeTab.images;
		if (!imgs.length) {
			el.hide();
			return;
		}
		el.show();
		imgs.forEach((img, i) => {
			const chip = el.createDiv({ cls: 'codem-chat-preview' });
			chip.createEl('img', { attr: { src: `data:${img.mime};base64,${img.data}` } });
			const x = chip.createSpan({ cls: 'codem-chat-preview-x', text: '×' });
			x.onclick = () => {
				imgs.splice(i, 1);
				this.renderPreviews();
			};
		});
	}

	private bindPaste(): void {
		this.inputEl.addEventListener('paste', (e) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (const it of Array.from(items)) {
				if (!it.type.startsWith('image/')) continue;
				const file = it.getAsFile();
				if (!file) continue;
				e.preventDefault();
				const reader = new FileReader();
				reader.onload = () => {
					const m = String(reader.result).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
					if (m) {
						this.activeTab.images.push({ mime: m[1], data: m[2] });
						this.renderPreviews();
					}
				};
				reader.readAsDataURL(file);
			}
		});
	}

	/** 释放指定 tab 持有的会话（session/close），防 daemon 层 writer 占位堵死后续 load */
	private releaseSession(tab?: ChatTab): void {
		const t = tab ?? this.activeTab;
		const sid = t.sessionId;
		t.sessionId = null;
		if (sid && this.client) {
			this.client.closeSession(sid).catch(() => {
				// 已被占用/未知会话等场景忽略
			});
		}
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
				onUpdate: (sid, u) => this.handleUpdate(sid, u),
				onPermissionRequest: (params, respond) => this.handlePermission(params, respond),
				onClose: (code) => {
					// 连接是全部 tab 共享的，断连复位所有 tab 的执行状态
					this.client = null;
					for (const t of this.tabs) {
						t.sessionId = null;
						if (t.busy) {
							t.busy = false;
							t.current = null;
							t.light = 'idle';
						}
					}
					new Notice(`CodeM 连接断开（退出码 ${code}）`);
					this.renderTabs();
					this.setStatusLight(this.activeTab.light);
				},
			}
		);
		return this.client;
	}

	// ===== 发送与流式渲染 =====

	private async send(): Promise<void> {
		const rawPrompt = this.inputEl.value.trim();
		const tab = this.activeTab;
		if ((!rawPrompt && !tab.images.length) || tab.busy) return;

		tab.busy = true;
		this.setStatusLight('running');
		this.inputEl.value = '';
		this.closeSuggest();
		tab.scrollEl.querySelector('.codem-chat-empty')?.remove();

		const userBlock = this.renderUserMessage(rawPrompt, tab.images);
		tab.images = [];
		this.renderPreviews();
		this.addTurnAnchor(userBlock);
		const st = this.renderAssistantSkeleton();
		tab.current = st;
		tab.mdBuffer = '';
		tab.displayLen = 0;

		try {
			const client = await this.ensureClient();
			if (!tab.sessionId) tab.sessionId = await client.newSession();
			const injected = await this.resolveNoteContexts(rawPrompt);
			// 软续接：历史快照作为背景随本轮 prompt 附带
			const finalPrompt = tab.pendingContext
				? `[背景] 以下是此前一次对话的快照（用户/助手交替），请据此理解本次问题：\n${tab.pendingContext}\n\n[本次问题]\n${injected}`
				: injected;
			tab.pendingContext = null;
			// content blocks：文本 + 粘贴的图片（CodeM 识图）
			const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: finalPrompt }];
			for (const img of tab.images) blocks.push({ type: 'image', data: img.data, mimeType: img.mime });
			this.startTypewriter(st, tab);
			await client.prompt(tab.sessionId, blocks);
			this.finishTurn(st, tab);
		} catch (e) {
			this.stopTypewriter(tab);
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
			const errBlock = tab.scrollEl.createDiv({ cls: 'codem-chat-msg codem-chat-error' });
			errBlock.setText(detail);
		} finally {
			tab.current = null;
			tab.busy = false;
			tab.light = 'done';
			this.renderTabs();
			if (this.lightEl) {
				this.lightEl.removeClass('is-idle', 'is-running', 'is-done');
				this.lightEl.addClass('is-' + (tab === this.activeTab ? 'done' : tab.light));
			}
			this.scrollBottom(tab.scrollEl);
		}
	}

	/** 一轮完成收尾：停打字机、渲染全文、折叠思考/工具区 */
	private finishTurn(st: RenderState, tab: ChatTab): void {
		if (tab.typeTimer !== null) {
			window.clearInterval(tab.typeTimer);
			tab.typeTimer = null;
		}
		st.textEl.innerHTML = renderMarkdown(tab.mdBuffer);
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

	private renderUserMessage(text: string, images: PendingImage[]): HTMLElement {
		const userBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-user' });
		if (text) {
			const body = userBlock.createDiv({ cls: 'codem-chat-body markdown-rendered' });
			body.innerHTML = renderMarkdown(text);
		}
		for (const img of images) {
			userBlock.createEl('img', { cls: 'codem-chat-img', attr: { src: `data:${img.mime};base64,${img.data}` } });
		}
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

	private startTypewriter(st: RenderState, tab: ChatTab): void {
		this.stopTypewriter(tab);
		tab.typeTimer = window.setInterval(() => {
			const target = tab.mdBuffer.length;
			if (tab.displayLen >= target) return;
			const step = Math.max(1, Math.ceil((target - tab.displayLen) / 15));
			tab.displayLen = Math.min(target, tab.displayLen + step);
			st.textEl.innerHTML = renderMarkdown(tab.mdBuffer.slice(0, tab.displayLen));
			this.scrollBottom(tab.scrollEl);
		}, TYPE_INTERVAL);
	}

	/** 停指定 tab（默认当前 tab）的打字机 */
	private stopTypewriter(tab?: ChatTab): void {
		const t = tab ?? this.activeTab;
		if (t.typeTimer !== null) {
			window.clearInterval(t.typeTimer);
			t.typeTimer = null;
		}
	}

	// ===== ACP 通知分发 =====

	/** 按 sessionId 路由到对应 tab（多 tab 并行执行的基础） */
	private handleUpdate(sessionId: string, update: Record<string, unknown>): void {
		const tab = this.tabs.find((t) => t.sessionId === sessionId);
		if (!tab) return; // 无归属（如历史载入重放）即忽略
		const st = tab.current;
		if (!st) return;
		const kind = update.sessionUpdate as string;
		const content = update.content as { text?: string } | undefined;

		if (kind === 'agent_message_chunk') {
			tab.mdBuffer += content?.text ?? '';
		} else if (kind === 'agent_thought_chunk') {
			st.thinkingBody.textContent += content?.text ?? '';
			st.thinkingBody.scrollTop = st.thinkingBody.scrollHeight;
			this.scrollBottom(tab.scrollEl);
		} else if (kind === 'tool_call' || kind === 'tool_call_update') {
			this.handleToolEvent(st, update, tab.scrollEl);
		}
	}

	private handleToolEvent(st: RenderState, update: Record<string, unknown>, scrollEl?: HTMLElement): void {
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
		this.scrollBottom(scrollEl);
	}

	private handlePermission(
		params: Record<string, unknown>,
		respond: (result: unknown) => void
	): void {
		// 按 sessionId 路由到发起 tab；协议未带时退回当前 tab
		const tab = this.tabs.find((t) => t.sessionId === params.sessionId) ?? this.activeTab;
		const st = tab.current;
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
			this.scrollBottom(tab.scrollEl);
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
		this.scrollBottom(tab.scrollEl);
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
		// 名称与中文描述都参与检索（如搜「周报」命中 weekly-report）
		const items: SuggestItem[] = this.skillsCache
			.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
			.slice(0, SUGGEST_MAX)
			.map((s) => ({ label: `/${s.name}`, desc: s.description, insert: `/${s.name} ` }));
		this.renderSuggestList(items);
	}

	/**
	 * @ 候选：目录钻取式。token '@a/b/过滤词' 按路径段逐级下钻到当前目录，
	 * 列出该目录下的子文件夹（→ 下钻）与文件；回车选中插入引用。
	 */
	private updateVaultSuggestions(query: string): void {
		const segs = query.split('/');
		const filter = (segs.pop() ?? '').toLowerCase();
		let dir: TFolder = this.app.vault.getRoot();
		for (const seg of segs) {
			if (!seg) continue;
			const next = dir.children.find((c) => c instanceof TFolder && c.name.toLowerCase() === seg.toLowerCase());
			if (!(next instanceof TFolder)) {
				this.closeSuggest();
				return;
			}
			dir = next;
		}
		this.suggestDirPath = dir.path;
		const folders = dir.children
			.filter((c): c is TFolder => c instanceof TFolder)
			.filter((c) => c.name.toLowerCase().includes(filter))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((c) => ({ label: `📁 ${c.name}`, desc: '', insert: `[[${c.path}]] `, vaultPath: c.path, isFolder: true }));
		const files = this.app.vault
			.getFiles()
			.filter((f) => f.parent?.path === dir.path && !f.path.startsWith('.obsidian'))
			.filter((f) => f.name.toLowerCase().includes(filter))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((f) => ({ label: f.name, desc: f.extension, insert: `[[${f.path}]] ` }));
		const items = [...folders, ...files].slice(0, SUGGEST_MAX);
		// 空目录/无匹配保留占位行：浮层不关，← 回退才能继续用
		if (!items.length) items.push({ label: '（空）', desc: '← 回退上一级', insert: '' });
		this.renderSuggestList(items);
	}

	/** → 键钻入高亮文件夹：token 替换为 '@目录/' 后重扫 */
	private drillVaultFolder(item: SuggestItem): void {
		const el = this.inputEl;
		const pos = el.selectionStart ?? 0;
		el.setRangeText('@' + (item.vaultPath ?? '') + '/', this.suggestStart, pos, 'end');
		this.suggestIndex = 0;
		this.updateSuggest();
	}

	/** ← 键回退上一级：去掉 token 最后一段（过滤词或目录段）后重扫 */
	private backVaultFolder(): void {
		const el = this.inputEl;
		const pos = el.selectionStart ?? 0;
		const token = el.value.slice(this.suggestStart + 1, pos);
		const back = token.replace(/\/[^/]*$/, '');
		el.setRangeText('@' + back + (back ? '/' : ''), this.suggestStart, pos, 'end');
		this.suggestIndex = 0;
		this.updateSuggest();
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
		// @ 钻取：顶部显示当前目录面包屑（不占候选索引）
		if (this.suggestPrefix === '@') {
			this.suggestEl.createDiv({ cls: 'codem-suggest-head', text: `📁 ${this.suggestDirPath || 'Vault 根'}` });
		}
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

	// ===== 历史会话追溯（内联浮层 + 软续接兜底） =====

	private async toggleHistoryPanel(): Promise<void> {
		if (this.histOpen) {
			this.closeHistory();
			return;
		}
		if (this.busy) {
			new Notice('CodeM 执行中，稍后再切换会话');
			return;
		}
		this.closeSuggest();
		if (!this.histEl) this.histEl = this.inputWrapEl.createDiv({ cls: 'codem-suggest codem-hist-panel' });
		this.histEl.empty();
		this.histEl.createDiv({ cls: 'codem-hist-loading', text: '扫描 ~/.codem/sessions …' });
		this.histEl.style.display = 'block';
		this.histOpen = true;
		try {
			this.allCards = await listCodemSessions();
		} catch (e) {
			new Notice(`扫描历史会话失败：${e instanceof Error ? e.message : String(e)}`);
			this.closeHistory();
			return;
		}
		if (!this.histOpen) return; // 异步期间已关闭
		this.histIndex = 0;
		this.filterHistory();
		this.inputEl.focus();
	}

	/** 输入内容实时过滤历史会话（按首问子串） */
	private filterHistory(): void {
		const q = this.inputEl.value.trim().toLowerCase();
		this.histItems = q ? this.allCards.filter((c) => c.firstPrompt.toLowerCase().includes(q)) : this.allCards;
		this.histIndex = 0;
		this.renderHistoryPanel();
	}

	private renderHistoryPanel(): void {
		if (!this.histEl) return;
		this.histEl.empty();
		if (!this.histItems.length) {
			this.histEl.createDiv({ cls: 'codem-hist-loading', text: '没有匹配的历史会话' });
			return;
		}
		this.histIndex = Math.min(this.histIndex, this.histItems.length - 1);
		this.histItems.forEach((c, i) => {
			const src = c.source === 'bot' ? '飞书' : c.source === 'tui' ? '终端' : 'CLI';
			const turnTxt = c.userTurns > 0 ? ` · ${c.userTurns}问` : '';
			const row = this.histEl!.createDiv({ cls: 'codem-suggest-item' + (i === this.histIndex ? ' is-active' : '') });
			row.createSpan({ cls: 'codem-suggest-label', text: `${formatTime(c.lastTime)} · ${src}${turnTxt}` });
			row.createSpan({ cls: 'codem-suggest-desc', text: c.firstPrompt });
			row.addEventListener('mousedown', (e) => e.preventDefault());
			row.addEventListener('click', () => {
				this.closeHistory();
				void this.loadHistory(c);
			});
		});
		const active = this.histEl.querySelector('.codem-suggest-item.is-active');
		active?.scrollIntoView({ block: 'nearest' });
	}

	private closeHistory(): void {
		this.histOpen = false;
		if (this.histEl) this.histEl.style.display = 'none';
	}

	/** 载入历史会话：jsonl 回显 + ACP session/load 原生续接；失败自动转软续接（快照上下文） */
	private async loadHistory(card: SessionCard): Promise<void> {
		this.busy = true;
		this.msgContainer.empty();
		this.resetTurnNav();
		this.msgContainer.createDiv({ cls: 'codem-chat-empty', text: '载入历史会话…' });
		try {
			const turns = await readCodemSessionTurns(card.filePath);
			const client = await this.ensureClient();
			// cwd 必须传会话自己的原始 cwd（探针实测：会话按 cwd hash 隔离，传错目录报 does not exist）；
			// 换会话前先释放本连接持有的旧会话（daemon 层 writer 占位会堵死旧会话下次 load）
			if (this.sessionId && this.sessionId !== card.sessionId) {
				this.releaseSession();
			}
			let loaded = false;
			let lastErr = '';
			if (this.sessionId === card.sessionId) {
				// 同一会话且当前连接仍持有 → 无需重新 load，秒开
				loaded = true;
			}
			for (let attempt = 0; attempt < 2 && !loaded; attempt++) {
				try {
					await client.loadSession(card.sessionId, card.cwd || undefined);
					loaded = true;
				} catch (e) {
					lastErr = e instanceof Error ? e.message : String(e);
					// 探针实测两类占用：
					// ① "already active in this ACP connection"（本连接 prompt/新会话过）→ close 释放后立即可 load
					// ② "Session already has an active writer"（外部进程占用）→ 等待无用，直接转快照
					if (/already active in this ACP connection/i.test(lastErr)) {
						try {
							await client.closeSession(card.sessionId);
						} catch {
							// close 失败则重试也无意义
							break;
						}
					} else {
						break;
					}
				}
			}
			if (loaded) {
				this.sessionId = card.sessionId;
				this.pendingContext = null;
			} else {
				// 软续接兜底：原生 load 失败（被占用/不可载入）时，把历史轮次做成快照，
				// 随下一条用户消息注入新会话，保证任何会话都能接着聊
				this.sessionId = null;
				this.pendingContext = this.buildContextSnapshot(turns);
				new Notice(
					(/active writer/i.test(lastErr) ? '该会话正被其他 CodeM 入口占用，' : '无法原生续接，') +
						'已转为快照续聊：历史对话将作为上下文随你下一条消息附带'
				);
			}
			this.msgContainer.empty();
			for (const t of turns) this.renderHistoryTurn(t);
			if (!turns.length) this.renderEmpty();
			const head = this.msgContainer.createDiv({ cls: 'codem-chat-history-head' });
			const src = card.source === 'bot' ? '飞书' : card.source === 'tui' ? '终端' : 'CLI';
			head.setText(
				`📜 ${card.firstPrompt.slice(0, 40)}（${src} · ${card.userTurns} 问）` +
					(this.sessionId ? ' · 已续接，可直接继续提问' : ' · 快照续聊：历史将随下一条消息附带')
			);
			this.msgContainer.scrollTop = this.msgContainer.scrollHeight;
			this.setStatusLight('idle');
		} finally {
			this.busy = false;
		}
	}

	/** 历史轮次 → 快照文本（软续接用）：取最近 10 轮，6000 字上限 */
	private buildContextSnapshot(turns: Turn[]): string {
		const recent = turns.slice(-10);
		const lines: string[] = [];
		let total = 0;
		for (const t of recent) {
			const role = t.role === 'user' ? '用户' : t.role === 'assistant' ? '助手' : '工具';
			for (const b of t.blocks) {
				if (b.kind === 'tool_result') continue;
				const text = `[${role}] ${b.kind === 'tool_use' ? `(${b.label}) ` : ''}${b.content}`;
				if (total + text.length > 6000) break;
				lines.push(text);
				total += text.length;
			}
			if (total > 6000) break;
		}
		return lines.join('\n');
	}

	private renderHistoryTurn(t: Turn): void {
		if (t.role === 'user') {
			const userBlock = this.renderUserMessage(t.blocks.map((b) => b.content).join('\n\n'), []);
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

	private scrollBottom(el?: HTMLElement): void {
		const t = el ?? this.msgContainer;
		t.scrollTop = t.scrollHeight;
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
