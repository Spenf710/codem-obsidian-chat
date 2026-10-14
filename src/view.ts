import { ItemView, Notice, WorkspaceLeaf, setIcon, TFile, TFolder } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import type CodeMChatPlugin from './main';
import { AcpClient, runCodemHeadless, expandPath, type AcpOptions } from './acp-client';
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
import {
	checkEnvironment,
	installCodem,
	probeCodemCli,
	toTildePath,
	friendlyError,
	CODEM_INSTALL_CMD,
} from './diagnostics';

export const VIEW_TYPE_CODEM_CHAT = 'codem-chat-view';

const TYPE_INTERVAL = 30;
const TOOL_RESULT_MAX_LEN = 2000;
const FOLDER_INJECT_MAX = 12000;
const SUGGEST_MAX = 50;

interface ToolCard {
	detailsEl: HTMLDetailsElement;
	headEl: HTMLElement;
	title: string;
	status: string;
}

/** 流式正文段：阶段性输出 / 最终结论各成一段（工具事件到达时收束） */
interface TextSeg {
	el: HTMLElement;
	buf: string;
	shown: number;
	done: boolean;
}

/** 一轮对话的渲染句柄（onUpdate 回调据此路由到当前消息块） */
interface RenderState {
	aiBlock: HTMLElement;
	thinking: HTMLDetailsElement;
	thinkingSummary: HTMLElement;
	thinkingBody: HTMLElement;
	/** 时间线插入锚点：思考区 → 工具卡片/正文段依次后移 */
	anchor: HTMLElement;
	curSeg: TextSeg | null;
	textSegs: TextSeg[];
	cards: Map<string, ToolCard>;
	/** 早于 tool_call 通知到达的权限条暂存（toolCallId → 条目），卡片创建时回挂 */
	pendingPerms: Map<string, HTMLElement[]>;
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
	/** 最近一次收到 CodeM 更新的时间（无响应看门狗用） */
	lastActivity: number;
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
	private stopBtn!: HTMLButtonElement;
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

		// 平台检测：spawn/codem.cmd/taskkill 均为 Windows 形态，非 Windows 无法运行
		if (process.platform !== 'win32') {
			new Notice('CodeM Chat 当前仅支持 Windows（依赖 codem.cmd 与 taskkill），无法在此平台启动。');
		}

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
		bottomRow.createSpan({ cls: 'codem-chat-agent', text: '✳ CodeM' });
		const actions = bottomRow.createDiv({ cls: 'codem-chat-actions' });
		this.yoloBtn = actions.createEl('button', { text: '🤖 YOLO', cls: 'codem-chat-yolo' });
		this.yoloBtn.setAttribute('aria-label', 'yolo 模式：自动批准工具权限请求');
		this.yoloBtn.onclick = () => this.toggleYolo();
		// 停止按钮：仅执行中显示（同步见 setStatusLight → syncStopButton），与 ESC 等效
		this.stopBtn = actions.createEl('button', { text: '⏹ 停止', cls: 'codem-chat-stop' });
		this.stopBtn.setAttribute('aria-label', '停止当前任务（Esc）');
		this.stopBtn.hide();
		this.stopBtn.onclick = () => this.stopActiveTurn();

		this.bindInputEvents();
		this.bindPaste();
		this.setStatusLight('idle');
	}

	private bindInputEvents(): void {
		// ESC 中途停止：capture 绑在视图根上，焦点在消息区/按钮时也能响应；
		// 浮层（候选/历史）开启时让位给输入框 handler 的关浮层逻辑
		this.containerEl.addEventListener(
			'keydown',
			(e) => {
				if (e.key !== 'Escape' || e.isComposing || !this.activeTab.busy) return;
				const suggestActive = this.suggestPrefix !== null && this.suggestItems.length > 0;
				const histActive = this.histOpen && this.histItems.length > 0;
				if (suggestActive || histActive) return;
				e.preventDefault();
				this.stopActiveTurn();
			},
			true
		);
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
		const el = this.msgContainer.createDiv({ cls: 'codem-chat-empty' });
		el.setText('正在检查 CodeM 环境…');
		void this.renderEmptyContent(el);
	}

	/** 空状态内容（异步）：按环境检测结果渲染引导或欢迎页 */
	private async renderEmptyContent(el: HTMLElement): Promise<void> {
		const status = await checkEnvironment(this.plugin.settings.codemCliPath, this.plugin.settings.nodePath);
		if (!el.isConnected) return; // 检测期间用户已开始对话
		el.empty();

		if (status.state === 'ready') {
			el.createDiv({ cls: 'codem-chat-empty-icon', text: '✳' });
			el.createDiv({ cls: 'codem-chat-empty-title', text: 'CodeM 已就绪' });
			el.createDiv({
				cls: 'codem-chat-empty-sub',
				text: '你的笔记库就是 CodeM 的工作目录，直接开始提问吧。',
			});
			el.createDiv({
				cls: 'codem-chat-empty-tip',
				text: '💡 可直接粘贴截图提问 · 输入 @ 引用笔记 · 输入 / 调用技能',
			});
			return;
		}

		if (status.state === 'no-node') {
			el.createDiv({ cls: 'codem-chat-empty-icon', text: '⬇' });
			el.createDiv({ cls: 'codem-chat-empty-title', text: '缺少 Node.js 运行环境' });
			el.createDiv({
				cls: 'codem-chat-empty-sub',
				text: '已找到 CodeM，但运行它还需要 Node.js。请到 nodejs.org 下载安装 LTS 版本，安装完成后重启 Obsidian。',
			});
			const retry = el.createDiv({ cls: 'codem-chat-empty-samples' });
			retry.createEl('button', { cls: 'codem-chat-sample', text: '我已安装 Node.js，重新检查' }).onclick =
				() => void this.refreshEnvironment();
			return;
		}

		// missing：先尝试自动定位（常见安装位置扫描），命中即自动填入并重渲染
		const found = probeCodemCli();
		if (found && found !== expandPath(this.plugin.settings.codemCliPath)) {
			this.plugin.settings.codemCliPath = toTildePath(found);
			await this.plugin.saveSettings();
			return this.renderEmptyContent(el); // 复检（定位成功后状态必然变化，不会无限递归）
		}

		// 仍未找到：引导安装（欢迎页内直接提供一键安装）
		el.createDiv({ cls: 'codem-chat-empty-icon', text: '⬇' });
		el.createDiv({ cls: 'codem-chat-empty-title', text: '开始之前，先安装 CodeM' });
		el.createDiv({
			cls: 'codem-chat-empty-sub',
			text: 'CodeM 是飞书原生的 AI 智能体，本插件通过它读写你的笔记。检测到这台电脑尚未安装，点击下方按钮自动完成安装（需联网，约 1-3 分钟）。',
		});
		const actions = el.createDiv({ cls: 'codem-chat-empty-samples' });
		const installBtn = actions.createEl('button', { cls: 'codem-chat-sample is-cta', text: '一键安装 CodeM' });
		installBtn.onclick = () => {
			if (installBtn.dataset.installing) return;
			installBtn.dataset.installing = '1';
			installBtn.textContent = '正在安装…';
			installCodem((p) => {
				if (!p.done) {
					if (p.line) installBtn.textContent = `正在安装… ${p.line.slice(0, 40)}`;
					return;
				}
				delete installBtn.dataset.installing;
				if (p.code === 0) {
					new Notice('CodeM 安装完成！', 8000);
					void this.refreshEnvironment();
				} else {
					installBtn.textContent = '安装未成功，点击重试';
					new Notice(`CodeM 安装失败（退出码 ${p.code}）。可重试，或按下方手动方式安装。`, 10000);
				}
			});
		};
		const manual = el.createEl('details', { cls: 'codem-chat-empty-manual' });
		manual.createEl('summary', { text: '无法自动安装？手动方式' });
		manual.createDiv({
			cls: 'codem-chat-empty-tip',
			text: `在 PowerShell 中执行：${CODEM_INSTALL_CMD}\n（或到飞书工作台搜索「飞书 CodeM」了解详情）`,
		});
	}

	/** 外部触发空状态重渲染（设置页完成安装后回调） */
	refreshEnvironment(): void {
		const el = this.msgContainer.querySelector('.codem-chat-empty');
		if (el) void this.renderEmptyContent(el as HTMLElement);
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
		this.dirEl.addClass('is-open');
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
		if (this.dirEl) this.dirEl.removeClass('is-open');
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
			lastActivity: 0,
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
		for (const t of this.tabs) t.scrollEl.toggleClass('codem-is-hidden', t !== tab);
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
		// 当前 tab 还没开始过对话（且非执行中）→ 就地重置，不占 tab 额度；
		// busy 时跳过重置直接新开 tab：多会话并行，执行中的会话继续跑
		if (!tab.busy && !tab.sessionId && tab.turnCount === 0 && !tab.pendingContext) {
			this.resetActiveTab();
			return;
		}
		const max = Math.max(1, this.plugin.settings.maxWindows || 3);
		if (this.tabs.length >= max) {
			new Notice(`已达会话上限（${max} 个），可关闭 tab 或在设置中调整`);
			return;
		}
		this.closeDir();
		for (const t of this.tabs) t.scrollEl.addClass('codem-is-hidden');
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
		this.syncStopUi();
	}

	/** 停止按钮与输入框提示跟随当前 tab 执行状态（setStatusLight 是所有状态切换汇聚点） */
	private syncStopUi(): void {
		if (!this.stopBtn) return;
		this.stopBtn.toggle(this.activeTab.busy);
		this.inputEl.placeholder = this.activeTab.busy
			? '执行中…按 Esc 或点击「⏹ 停止」可中途停止'
			: '询问 CodeM，/ 技能，@ 文件…（Enter 发送）';
	}

	/** 中途停止当前 tab 正在执行的一轮（ESC / ⏹ 按钮），已流出的正文保留 */
	private lastStopAt = 0;
	private stopActiveTurn(): void {
		const tab = this.activeTab;
		if (!tab.busy) return;
		if (Date.now() - this.lastStopAt < 800) return; // 连按防抖：cancel 重复发无害，提示会闪
		this.lastStopAt = Date.now();
		// client 尚未建好时 prompt 还没发出，挂起的流程会随启动失败自然收尾
		if (this.client && tab.sessionId) this.client.cancelSession(tab.sessionId);
		new Notice('已发送停止指令…', 2500);
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

	private pluginOpts(): AcpOptions {
		return {
			cliPath: this.plugin.settings.codemCliPath,
			cwd: (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath(),
			nodePath: this.plugin.settings.nodePath,
			extraArgs: this.plugin.settings.extraArgs,
		};
	}

	private async ensureClient(): Promise<AcpClient> {
		if (this.client) return this.client;
		this.client = new AcpClient(
			this.pluginOpts(),
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
					new Notice('CodeM 服务已断开，下次发送时会自动重新连接。', 6000);
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

		// 无响应看门狗：5 分钟没有任何更新则提示一次（不中断执行，等待或重试由用户决定）
		tab.lastActivity = Date.now();
		let stallNotified = false;
		const watchdog = window.setInterval(() => {
			if (!tab.busy) {
				window.clearInterval(watchdog);
				return;
			}
			if (!stallNotified && Date.now() - tab.lastActivity > 300000) {
				stallNotified = true;
				new Notice(
					'已超过 5 分钟没有新响应。若一直停在这里，请检查网络后重试；也可能是 CodeM 刚自动更新导致，可向官方反馈。',
					12000
				);
			}
		}, 30000);

		const images = tab.images; // capture 引用：气泡渲染与 prompt blocks 都用它
		tab.images = [];
		this.renderPreviews();
		const userBlock = this.renderUserMessage(rawPrompt, images);
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
			// 图片发送：CodeM 0.1.224 ACP 不支持 image prompt block（探针实测报
			// "image prompt blocks are not supported"），改 base64 data URI 内嵌文本，
			// CodeM 自行解码识图（探针验证可走通完整识图流程）
			let promptText = finalPrompt;
			images.forEach((img, i) => {
				promptText += `\n\n[图片附件${i + 1}]（base64 编码，请读取并分析图片内容）\ndata:${img.mime};base64,${img.data}`;
			});
			const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: promptText }];
			this.startTypewriter(st, tab);
			const reason = await client.prompt(tab.sessionId, blocks);
			// 用户中途停止（session/cancel）：已流出正文保留，时间线打停止标记
			if (reason === 'cancelled') {
				this.stopTypewriter(tab);
				tab.scrollEl
					.createDiv({ cls: 'codem-chat-msg codem-chat-stopped' })
					.setText('⏹ 已停止（本轮内容可能不完整）');
			}
			this.finishTurn(st, tab, reason === 'cancelled');
			// 首轮结束后台生成会话标题（无头 -p 调用，静默失败）
			if (tab.turnCount === 1 && tab.sessionId && !this.plugin.settings.sessionTitles[tab.sessionId]) {
				void this.generateTitle(tab, rawPrompt);
			}
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
			// 友好错误卡：人话标题 + 行动建议 + 技术原文折叠（排障能力保留）
			const fe = friendlyError(detail);
			const errBlock = tab.scrollEl.createDiv({ cls: 'codem-chat-msg codem-chat-error' });
			errBlock.createDiv({ cls: 'codem-chat-error-title', text: '⚠️ ' + fe.title });
			errBlock.createDiv({ cls: 'codem-chat-error-hint', text: fe.hint });
			const det = errBlock.createEl('details', { cls: 'codem-chat-error-details' });
			det.createEl('summary', { text: '查看详情' });
			det.createDiv({ cls: 'codem-chat-error-raw', text: detail.slice(0, 2000) });
		} finally {
			window.clearInterval(watchdog);
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

	/** 一轮完成收尾：停打字机、收束正文段、折叠思考区（stopped=用户中途停止） */
	private finishTurn(st: RenderState, tab: ChatTab, stopped = false): void {
		if (tab.typeTimer !== null) {
			window.clearInterval(tab.typeTimer);
			tab.typeTimer = null;
		}
		this.flushSeg(st);
		if (st.thinkingBody.textContent) {
			st.thinkingSummary.setText('思考过程');
			st.thinking.removeAttribute('open');
		} else {
			st.thinking.hide();
		}
		// 兜底：轮结束仍无对应卡片的权限条（plan 批准等无 tool_call 的请求）落回正文末尾，不丢信息；
		// 停止的轮次权限请求已随轮作废，直接清掉（按钮点击也不会再有响应）
		if (st.pendingPerms.size) {
			if (!stopped) {
				for (const list of st.pendingPerms.values()) {
					for (const el of list) st.aiBlock.appendChild(el);
				}
			}
			st.pendingPerms.clear();
		}
	}

	/**
	 * AI 生成会话标题：无头 `codem -p` 一次性调用（不走 ACP 长连接），
	 * 依据首轮用户问题 + 助手回复摘要；结果持久化到 settings.sessionTitles。
	 */
	private async generateTitle(tab: ChatTab, userText: string): Promise<void> {
		try {
			const reply = tab.mdBuffer.replace(/\s+/g, ' ').slice(0, 600);
			const ask = userText.replace(/\s+/g, ' ').replace(/["'`]/g, ' ').slice(0, 200);
			// cmd /c 参数不能带换行，整体单行化
			const prompt =
				`[标题生成]请为以下对话生成一个不超过12字的中文标题，直接输出标题本身，不要引号、句号或其他说明。` +
				` 用户：${ask} 助手：${reply}`;
			const title = await runCodemHeadless(this.pluginOpts(), prompt, 30000);
			// stdout 可能混入 CLI 版本提示等噪音行，取最后一行作标题
			const lines = (title ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
			const clean = (lines.pop() ?? '')
				.replace(/^[\s"'「『【]+|[\s"'」』】。.]+$/g, '')
				.slice(0, 20)
				.trim();
			if (!clean || !tab.sessionId) return;
			this.plugin.settings.sessionTitles[tab.sessionId] = clean;
			await this.plugin.saveSettings();
			if (this.histOpen) this.filterHistory(); // 浮层开着则即时刷新标题
		} catch {
			// 标题生成失败静默：历史列表继续显示首问
		}
	}

	private renderUserMessage(text: string, images: PendingImage[]): HTMLElement {
		const userBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-user' });
		if (text) {
			const body = userBlock.createDiv({ cls: 'codem-chat-body markdown-rendered' });
			body.appendChild(renderMarkdown(text));
			this.linkifyWikilinks(body);
		}
		for (const img of images) {
			userBlock.createEl('img', { cls: 'codem-chat-img', attr: { src: `data:${img.mime};base64,${img.data}` } });
		}
		return userBlock;
	}

	/**
	 * 发送 prompt → 仅展示用文本：剔除注入的笔记/文件夹全文（📎 标记）、
	 * 软续接快照背景（[背景]…[本次问题]）、图片 base64 内嵌——用户消息只留提问本身
	 */
	private cleanPromptForDisplay(text: string): string {
		let s = text;
		const qi = s.indexOf('\n[本次问题]\n');
		if (s.startsWith('[背景]') && qi >= 0) s = s.slice(qi + '\n[本次问题]\n'.length);
		const ai = s.indexOf('📎 附加知识库内容：');
		if (ai >= 0) s = s.slice(0, ai);
		s = s.replace(/\[图片附件\d+\][\s\S]*?data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '');
		// 剔除注入产生的孤立分隔线
		s = s.replace(/\n---\s*$/g, '').trim();
		return s;
	}

	/** 文本节点中的 [[笔记|显示名]] → 可点击内部链接（Obsidian 主题样式） */
	private linkifyWikilinks(root: HTMLElement): void {
		const re = /\[\[([^\][|]+)(?:\|([^\]]*))?\]\]/g;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		while (walker.nextNode()) {
			const t = walker.currentNode as Text;
			if (re.test(t.textContent ?? '')) nodes.push(t);
			re.lastIndex = 0;
		}
		for (const node of nodes) {
			const text = node.textContent ?? '';
			const frag = createFragment();
			let last = 0;
			let m: RegExpExecArray | null;
			re.lastIndex = 0;
			while ((m = re.exec(text))) {
				if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
				const ref = m[1];
				const a = frag.createEl('a', { cls: 'internal-link' });
				a.setText((m[2] || ref).trim());
				a.setAttribute('data-href', ref);
				a.onclick = (e) => {
					e.preventDefault();
					const dest = this.app.metadataCache.getFirstLinkpathDest(ref, '');
					if (dest) void this.app.workspace.openLinkText(dest.path, '');
					else new Notice(`未找到引用目标：${ref}`);
				};
				last = m.index + m[0].length;
			}
			if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
			node.replaceWith(frag);
		}
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
		this.scrollBottom();
		return { aiBlock, thinking, thinkingSummary, thinkingBody, anchor: thinking, curSeg: null, textSegs: [], cards: new Map(), pendingPerms: new Map() };
	}

	/** [[笔记/文件夹]] 引用 → 注入内容（发送给 CodeM，UI 显示原文） */
	private async resolveNoteContexts(prompt: string): Promise<string> {
		const refs = [...prompt.matchAll(/\[\[([^\][|]+)(?:\|[^\]]*)?\]\]/g)];
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
			// 仅追赶当前活动段（已收束段落已定格全文）
			const seg = st.curSeg;
			if (!seg || seg.shown >= seg.buf.length) return;
			const step = Math.max(1, Math.ceil((seg.buf.length - seg.shown) / 15));
			seg.shown = Math.min(seg.buf.length, seg.shown + step);
			seg.el.empty();
			seg.el.appendChild(renderMarkdown(seg.buf.slice(0, seg.shown)));
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
		tab.lastActivity = Date.now();
		const kind = update.sessionUpdate as string;
		const content = update.content as { text?: string } | undefined;

		if (kind === 'agent_message_chunk') {
			const text = content?.text ?? '';
			tab.mdBuffer += text;
			// 时间线分段：无活动段则新开一段（插在最近工具卡片之后）——
			// 阶段性输出紧跟其上方工具调用，最后一段即最终结论，自然落在最下方
			if (!st.curSeg) {
				const el = createEl('div', { cls: 'codem-chat-text markdown-rendered' });
				st.anchor.after(el);
				st.anchor = el;
				st.curSeg = { el, buf: '', shown: 0, done: false };
				st.textSegs.push(st.curSeg);
			}
			st.curSeg.buf += text;
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
		// 工具事件收束当前正文段：阶段输出定格在其上方对应位置
		this.flushSeg(st);
		let card = st.cards.get(id);
		if (!card) {
			const title = (update.title as string) || (update.kind as string) || '工具';
			// 独立工具卡片（时间线节点）：执行中展开，完成后收起，失败保持展开
			const details = createEl('details', { cls: 'codem-chat-tool' });
			details.setAttribute('open', '');
			st.anchor.after(details);
			st.anchor = details;
			const headEl = details.createEl('summary', { cls: 'codem-chat-tool-head' });
			headEl.setText(`${title} ${statusMark(status)}`.trimEnd());
			const rawInput = update.rawInput;
			if (rawInput && typeof rawInput === 'object' && Object.keys(rawInput).length > 0) {
				details.createDiv({ cls: 'codem-chat-tool-raw' }).setText(JSON.stringify(rawInput).slice(0, 300));
			}
			card = { detailsEl: details, headEl, title, status };
			st.cards.set(id, card);
			// 回挂早到的权限条（request_permission 先于 tool_call 到达的场景）
			const pended = st.pendingPerms.get(id);
			if (pended) {
				for (const el of pended) card.detailsEl.appendChild(el);
				st.pendingPerms.delete(id);
			}
		} else {
			const incomingTitle = update.title as string | undefined;
			if (incomingTitle) card.title = incomingTitle;
			if (status && status !== card.status) {
				card.status = status;
				card.headEl.setText(`${card.title} ${statusMark(status)}`.trimEnd());
				if (status === 'completed') card.detailsEl.removeAttribute('open');
			}
		}
		const contents = (update.content as Array<{ text?: string; content?: { text?: string } }>) ?? [];
		for (const c of contents) {
			const text = c?.content?.text ?? c?.text;
			if (text) {
				card.detailsEl.createEl('pre', { cls: 'codem-chat-tool-result' }).setText(
					text.length > TOOL_RESULT_MAX_LEN
						? text.slice(0, TOOL_RESULT_MAX_LEN) + `…（截断，共 ${text.length} 字符）`
						: text
				);
			}
		}
		this.scrollBottom(scrollEl);
	}

	/** 收束当前流式正文段：全文渲染定格，打字机不再写它 */
	private flushSeg(st: RenderState): void {
		const seg = st.curSeg;
		if (!seg) return;
		st.curSeg = null;
		seg.done = true;
		seg.el.empty();
		seg.el.appendChild(renderMarkdown(seg.buf));
	}

	private handlePermission(
		params: Record<string, unknown>,
		respond: (result: unknown) => void
	): void {
		// 按 sessionId 路由到发起 tab；协议未带时退回当前 tab
		const tab = this.tabs.find((t) => t.sessionId === params.sessionId) ?? this.activeTab;
		const st = tab.current;
		const toolCall = params.toolCall as { toolCallId?: string; title?: string } | undefined;
		const label = toolCall?.title ?? '工具请求权限';
		const options = (params.options as Array<{ optionId: string; name: string; kind?: string }>) ?? [];
		const allow = options.find((o) => String(o.kind).startsWith('allow'));

		if (!st) {
			respond({ outcome: { outcome: 'cancelled' } });
			return;
		}
		// 宿主：对应工具卡片内部（通知/确认条跟随该工具，不挤在正文后）。
		// CodeM 时序：request_permission 可能先于 tool_call 通知到达，此时卡片尚未创建——
		// 条目暂存 pendingPerms，卡片创建（handleToolEvent）时回挂；无 toolCallId 才落 aiBlock 末尾
		let host: HTMLElement | null = null;
		if (toolCall?.toolCallId) {
			const card = st.cards.get(toolCall.toolCallId);
			if (card) host = card.detailsEl;
		}
		const park = (el: HTMLElement): void => {
			if (host) {
				host.appendChild(el);
			} else if (toolCall?.toolCallId) {
				const list = st.pendingPerms.get(toolCall.toolCallId) ?? [];
				list.push(el);
				st.pendingPerms.set(toolCall.toolCallId, list);
			} else {
				st.aiBlock.appendChild(el);
			}
		};
		if (this.yolo && allow) {
			respond({ outcome: { outcome: 'selected', optionId: allow.optionId } });
			const note = createEl('div', { cls: 'codem-chat-perm codem-chat-perm-auto' });
			note.setText(`🤖 yolo 自动批准：${label}`);
			park(note);
			this.scrollBottom(tab.scrollEl);
			return;
		}
		const bar = createEl('div', { cls: 'codem-chat-perm' });
		bar.createSpan({ text: `🔒 ${label}` });
		for (const opt of options) {
			bar.createEl('button', { text: opt.name }).onclick = () => {
				bar.remove();
				respond({ outcome: { outcome: 'selected', optionId: opt.optionId } });
			};
		}
		park(bar);
		this.scrollBottom(tab.scrollEl);
	}

	// ===== 内联候选（/ 技能、@ 文件/文件夹） =====

	/** 扫描光标前的 token，命中 / 或 @ 词首则展示候选 */
	private updateSuggest(): void {
		const el = this.inputEl;
		const pos = el.selectionStart ?? 0;
		const before = el.value.slice(0, pos);
		const m = before.match(/(^|\s)([/@])([^\s]*)$/);
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
	 * @ 候选，两种模式：
	 * - '@关键字'（无 /）：全局检索文件与文件夹（跨目录），文件夹仍可 → 钻取
	 * - '@a/b/过滤词'（含 /）：按路径段逐级下钻到当前目录，列出子文件夹与文件
	 */
	private updateVaultSuggestions(query: string): void {
		if (!query.includes('/')) {
			this.suggestDirPath = '';
			const q = query.toLowerCase();
			const folders: SuggestItem[] = [];
			for (const af of this.app.vault.getAllLoadedFiles()) {
				if (!af.path || af.path.startsWith(this.app.vault.configDir)) continue;
				if (af instanceof TFolder && af.path.toLowerCase().includes(q)) {
					folders.push({ label: `📁 ${af.path}`, desc: '', insert: `[[${af.path}]] `, vaultPath: af.path, isFolder: true });
				}
			}
			const files = this.app.vault
				.getFiles()
				.filter((f) => !f.path.startsWith(this.app.vault.configDir) && f.path.toLowerCase().includes(q))
				.sort((a, b) => a.path.localeCompare(b.path))
				.map((f) => ({ label: f.path, desc: f.extension, insert: `[[${f.path}]] ` }));
			const items = [...folders.sort((a, b) => a.label.localeCompare(b.label)), ...files].slice(0, SUGGEST_MAX);
			if (!items.length) items.push({ label: '（无匹配）', desc: '', insert: '' });
			this.renderSuggestList(items);
			return;
		}
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
			.filter((f) => f.parent?.path === dir.path && !f.path.startsWith(this.app.vault.configDir))
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
		// @ 模式：顶部显示当前目录面包屑（不占候选索引）；全局检索模式显示提示
		if (this.suggestPrefix === '@') {
			const headText = this.suggestDirPath
				? `📁 ${this.suggestDirPath}`
				: '🔍 全局检索 · 输入 / 进入目录钻取';
			this.suggestEl.createDiv({ cls: 'codem-suggest-head', text: headText });
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
			// 当前会话执行中：自动新开 tab 承接历史载入（并行不中断）；达上限则放弃
			await this.startNewSession();
			if (this.busy) return;
		}
		this.closeSuggest();
		if (!this.histEl) {
			this.histEl = this.inputWrapEl.createDiv({ cls: 'codem-suggest codem-hist-panel' });
			this.histEl.hide();
		}
		this.histEl.empty();
		this.histEl.createDiv({ cls: 'codem-hist-loading', text: '扫描 ~/.codem/sessions …' });
		this.histEl.show();
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

	/** 输入内容实时过滤历史会话（按 AI 标题/首问子串） */
	private filterHistory(): void {
		const q = this.inputEl.value.trim().toLowerCase();
		this.histItems = q
			? this.allCards.filter((c) => this.sessionTitle(c).toLowerCase().includes(q))
			: this.allCards;
		this.histIndex = 0;
		this.renderHistoryPanel();
	}

	/** 会话显示标题：AI 生成（settings.sessionTitles）优先，无则回退首问 */
	private sessionTitle(c: SessionCard): string {
		return this.plugin.settings.sessionTitles[c.sessionId] || c.firstPrompt;
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
			row.createSpan({ cls: 'codem-suggest-desc', text: this.sessionTitle(c) });
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
		if (this.histEl) this.histEl.hide();
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
				`📜 ${this.sessionTitle(card).slice(0, 40)}（${src} · ${card.userTurns} 问）` +
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
			// jsonl 记录的是完整 prompt（含注入全文/快照/图片 base64），回显前清洗为提问本身
			const userBlock = this.renderUserMessage(this.cleanPromptForDisplay(t.blocks.map((b) => b.content).join('\n\n')), []);
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
					const segEl = aiBlock.createDiv({ cls: 'codem-chat-text markdown-rendered' });
					segEl.appendChild(renderMarkdown(b.content));
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
