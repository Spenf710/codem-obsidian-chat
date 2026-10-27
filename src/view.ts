import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon, TFile, TFolder } from 'obsidian';
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
/** 流式段长度阈值：超过后打字机降级为纯文本增量追加，段收束时再完整渲染 markdown。
 *  防的是每 tick 全量 parse+净化+重建 DOM 的 O(n²) 渲染——35KB 单条消息流式时主线程被吃满，整个 Obsidian 一起冻结 */
const STREAM_MD_LIMIT = 4000;
/** 收束后超长正文段阈值：折叠为 details，避免超大渲染 DOM 常驻拖慢整页布局与滚动 */
const SEG_COLLAPSE_LIMIT = 20000;
/** write_file 客户端自构造 diff 最多渲染行数（超出截断提示） */
const DIFF_MAX_LINES = 200;
/** 只读工具白名单：权限请求命中即自动批准（settings.readonlyAutoApprove 可关）；按工具名小写包含匹配 */
const READONLY_TOOLS = ['read_files', 'grep', 'glob', 'list_dir', 'skill', 'web_search', 'web_fetch', 'tool_search'];
/** 审批看门狗：权限条 5 分钟无人响应自动拒绝（回 decline + UI 留痕），不再永久挂死一轮 */
const PERM_WATCHDOG_MS = 300_000;

interface ToolCard {
	detailsEl: HTMLDetailsElement;
	headEl: HTMLElement;
	/** 头行组件：monospace 工具名（title 更新时 setText） */
	nameEl: HTMLElement;
	/** 右侧状态图标宿主（loader/勾/叉） */
	statusEl: HTMLElement;
	/** 内容区（左竖线线程）：入参/结果/diff/权限条的共同宿主 */
	contentEl: HTMLElement;
	title: string;
	status: string;
	/** tool_call 原始入参（pending 阶段用于客户端自构造 diff） */
	rawInput?: Record<string, unknown>;
}

/** 流式正文段：阶段性输出 / 最终结论各成一段（工具事件到达时收束） */
interface TextSeg {
	el: HTMLElement;
	buf: string;
	shown: number;
	done: boolean;
	/** 大段降级模式的 textNode：流式期间只 appendData 增量追加，段收束时 flushSeg 再完整渲染 */
	plainNode: Text | null;
}

/** 一个未决的权限审批请求：看门狗与轮末回收的登记项 */
interface PermRequest {
	/** 审批条 DOM（留痕用，回收后变灰保留不删除） */
	bar: HTMLElement;
	toolCallId?: string;
	/** 回传给 agent 的应答函数（allow/reject/cancelled） */
	respond: (result: unknown) => void;
	/** 5 分钟看门狗定时器 */
	timer: number;
	/** 已应答标记：防止超时与用户点击双重应答 */
	answered: boolean;
	/** 拒绝选项 id（自动拒绝首选）；无 reject 选项时回 cancelled */
	rejectOptionId?: string;
	/** 审批等待横幅（消息区顶部常驻，settle/expire 时移除） */
	banner: HTMLElement | null;
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
	/** 本轮未决的权限请求登记表（看门狗超时/停止回收的遍历对象） */
	permRequests: PermRequest[];
	/** 自动批准（yolo/只读白名单/记住授权）轮内聚合条（唯一，逐次更新计数，沉底不刷屏） */
	yoloNote?: { el: HTMLElement; counts: Map<string, number>; total: number; labels: Set<string> };
	/** 思考区增量 textNode：流式 thought chunk 只 appendData，避免 textContent += 每 chunk 全量重赋 */
	thinkNode: Text | null;
	/** 轮次统计：起始时间戳与工具调用次数，轮末渲染耗时条 */
	turnStart: number;
	toolCount: number;
	/** 运行读数（v0.5.0）：轮次进行中实时计时，180s 无响应转警示 */
	liveEl: HTMLElement;
	liveTimer: number;
}

/** 待发送图片（粘贴直接进内存，base64 无 data: 前缀） */
interface PendingImage {
	data: string;
	mime: string;
}

/** 视图内会话 tab：独立会话/消息 DOM/流式状态，可并行执行（三色灯） */
interface ChatTab {
	id: number;
	light: 'idle' | 'running' | 'done' | 'error';
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
	/** 输入框草稿：切 tab 时隔离，未发送内容不跨会话串台 */
	draft: string;
	/** v0.9.0：最近一次已发送的 prompt（重新生成/错误重试用） */
	lastPrompt: string;
	/** v0.7.0（叶部式）：tab Pin 标记，置顶显示 */
	pinned: boolean;
	/** v0.7.0（叶部式）：用户自定义 tab 标题（双击重命名），null = 用默认序号 */
	label: string | null;
	scrollEl: HTMLElement;
	/** 最近一次收到 CodeM 更新的时间（无响应看门狗用） */
	lastActivity: number;
	/** 轮次序号：watchdog 强制收尾时 +1，使挂起的旧 prompt finally 失效，防止破坏新一轮 */
	turnSeq: number;
}

/** v1.0.2 chip 菜单值中文映射：CLI 参数用英文原值，UI 显示用中文 */
const OPT_LABELS: Record<string, string> = {
	'': '跟随',
	'low': '低',
	'medium': '中',
	'high': '高',
	'xhigh': '超高',
	'minimal': '极简',
	'max': '最大',
};

/** 内联候选条目（/ 技能 与 @ 文件/文件夹共用） */
interface SuggestItem {
	label: string;
	desc: string;
	insert: string;
	/** vault 路径（@ 钻取：文件夹条目 → 键下钻用） */
	vaultPath?: string;
	isFolder?: boolean;
}

/** 工具名 → lucide 图标（语义映射，未命中回退扳手） */
function toolIcon(title: string): string {
	const t = title.toLowerCase();
	if (t.includes('read')) return 'file-text';
	if (t.includes('grep') || t.includes('search')) return 'search';
	if (t.includes('glob')) return 'file-search';
	if (t.includes('edit')) return 'pencil';
	if (t.includes('write')) return 'file-plus';
	if (t.includes('bash') || t.includes('shell')) return 'terminal';
	if (t.includes('web')) return 'globe';
	if (t.includes('skill')) return 'zap';
	return 'wrench';
}

/** 工具名 → 类别（v0.5.0 工具卡分类配色用）：bash / edit / search / web / other */
function toolCategory(title: string): string {
	const t = title.toLowerCase();
	if (t.includes('bash') || t.includes('shell') || t.includes('terminal')) return 'bash';
	if (t.includes('edit') || t.includes('write') || t.includes('patch')) return 'edit';
	if (t.includes('read') || t.includes('grep') || t.includes('glob') || t.includes('search') || t.includes('list'))
		return 'search';
	if (t.includes('web')) return 'web';
	return 'other';
}

/** 工具状态 → 右侧状态图标（loader 旋转/勾/叉），配色由 class 控制（线程线形态） */
function setToolStatus(el: HTMLElement, status: string): void {
	el.removeClass('is-running', 'is-completed', 'is-failed');
	el.empty();
	if (status === 'completed') {
		el.addClass('is-completed');
		setIcon(el, 'check');
	} else if (status === 'failed') {
		el.addClass('is-failed');
		setIcon(el, 'x');
	} else {
		el.addClass('is-running');
		setIcon(el, 'loader-2');
	}
}

/** 右侧边栏聊天视图（ACP 架构）：流式/思考/工具/权限确认/内联候选/轮次导航/历史续接 */
export class CodeMChatView extends ItemView {
	plugin: CodeMChatPlugin;
	private client: AcpClient | null = null;
	private inputEl!: HTMLTextAreaElement;
	private permBtn!: HTMLButtonElement;
	/** 权限 chip 的文案 span（v0.5.2：紧凑短词 + ▾，与智能/推理 chip 同构） */
	private permLabelEl: HTMLElement | null = null;
	/** 信息行会话标题 span（v0.6.1：叶部 info-title，AI 标题/首问溢出省略） */
	private infoTitleEl: HTMLElement | null = null;
	/** ctx-meter 用量指示 span（v0.7.0 叶部式：上下文窗口 token 占比估算） */
	private ctxMeterEl: HTMLElement | null = null;
	/** 队列面板（v0.8.0 叶部式：全量列表 + Steer + 清空 + 逐条编辑/删除/重排） */
	private queueEl: HTMLElement | null = null;
	private stopBtn!: HTMLButtonElement;
	/** 权限模式三档（v0.5.0 UI 对标叶版）：🔒手动 / ✨智能（只读白名单自动）/ 🤖YOLO（全部自动） */
	private permMode: 'manual' | 'smart' | 'yolo' = 'smart';
	/** 模型参数（v0.5.1 UI 对标叶版）：CLI 进程启动参数，变更后重启 ACP 进程生效（探针实测 --intelligence/--reasoning-effort/--plan 均可用） */
	private modelOpts: { intelligence: string; reasoning: string; plan: boolean } = {
		intelligence: '', // 空 = 跟随配置（不传参）
		reasoning: '',
		plan: false,
	};
	/** 底部会话短码显示（叶版式：✳ CodeM · 376d7c7d） */
	private sidEl: HTMLElement | null = null;
	/** 参数重启中标志：抑制 onClose 的"服务已断开"误报 */
	private restarting = false;

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

	/** 排队发送的条目（Agent 执行中用户提交的消息不会被丢弃） */
	private inputQueue: { prompt: string; images: PendingImage[] }[] = [];

	/** 输入历史（最近 50 条已发送 prompt，输入框空时 ↑↓ 回溯；本次会话内有效） */
	private promptHistory: string[] = [];
	/** 输入历史回溯游标（-1 = 未在回溯态） */
	private promptHistPos = -1;

	/** 本会话记住的权限授权：工具名 → 已批准的 kind 集合（插件生命周期内有效，重启清空） */
	private rememberedPerms = new Map<string, Set<string>>();

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
		// 图片点击放大：事件委托挂 msgArea（全 tab 共享父容器），模态挂 contentEl
		this.msgArea.addEventListener('click', (e) => {
			const img = (e.target as HTMLElement).closest('img');
			if (img instanceof HTMLImageElement && img.src.startsWith('data:')) this.openImageModal(img.src);
		});

	// tab 行在输入框外面（上方）：左 tab 组，右功能图标组
	const tabRow = root.createDiv({ cls: 'codem-chat-tabrow' });
	this.tabsEl = tabRow.createDiv({ cls: 'codem-chat-tabs' });
	const tabActions = tabRow.createDiv({ cls: 'codem-chat-actions' });
	// 导出会话：把当前会话序列化为 Markdown 写入剪贴板
	const exportBtn = tabActions.createEl('button', { cls: 'codem-chat-iconbtn' });
	exportBtn.setAttribute('aria-label', '导出会话为 Markdown');
	setIcon(exportBtn, 'download');
	exportBtn.onclick = () => {
		const tab = this.activeTab;
		let md = `# CodeM 会话导出\n\n> 时间：${new Date().toLocaleString()}\n\n`;
		for (let j = 0; j < tab.scrollEl.children.length; j++) {
			const el = tab.scrollEl.children[j] as HTMLElement;
			const isUser = el.classList.contains('codem-chat-user');
			const text = el.textContent ?? '';
			md += isUser ? `## 👤 用户\n\n${text}\n\n` : `## ✳ CodeM\n\n${text}\n\n`;
		}
		void navigator.clipboard.writeText(md).then(() => new Notice('会话已导出到剪贴板', 3000));
	};
	// 保存为笔记：把当前会话写入 Vault 笔记文件
	const saveBtn = tabActions.createEl('button', { cls: 'codem-chat-iconbtn' });
	saveBtn.setAttribute('aria-label', '保存会话为笔记');
	setIcon(saveBtn, 'file-text');
	saveBtn.onclick = async () => {
		try {
			const folder = 'CodeM会话';
			const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const path = `${folder}/CodeM会话 ${ts}.md`;
			const tab = this.activeTab;
			let md = `---\nsource: codem-chat\nsession: ${tab.sessionId ?? 'unknown'}\ndate: ${new Date().toISOString()}\ntags:\n  - codem-chat\n  - ai-session\n---\n\n# CodeM 会话记录\n\n> ${new Date().toLocaleString()}\n\n`;
			for (let j = 0; j < tab.scrollEl.children.length; j++) {
				const el = tab.scrollEl.children[j] as HTMLElement;
				const isUser = el.classList.contains('codem-chat-user');
				const text = el.textContent ?? '';
				md += isUser ? `## 👤 用户\n\n${text}\n\n` : `## ✳ CodeM\n\n${text}\n\n`;
			}
			await this.app.vault.createFolder(folder).catch(() => {}); // 已存在则忽略
			await this.app.vault.create(path, md);
			new Notice(`已保存到 ${path}`, 5000);
		} catch (e) {
			new Notice(`保存失败：${e instanceof Error ? e.message : String(e)}`, 5000);
		}
	};
	// 新会话
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

		// 信息行（输入框上方，只放只读事实——用户实测叶部位置在输入框上方，v0.6.2 修正）
		const infoRow = root.createDiv({ cls: 'codem-chat-info-row' });
		this.lightEl = infoRow.createSpan({ cls: 'codem-chat-light is-idle' });
		infoRow.createSpan({ cls: 'codem-chat-agent', text: '✳ CodeM' });
		this.sidEl = infoRow.createSpan({ cls: 'codem-chat-sid' });
		this.infoTitleEl = infoRow.createSpan({ cls: 'codem-chat-info-title is-empty' });

		// 输入容器（圆角边框内：图片预览行 + textarea + 底部状态行）
		this.inputWrapEl = root.createDiv({ cls: 'codem-chat-inputwrap' });
		const inputWrap = this.inputWrapEl;
		this.previewEl = inputWrap.createDiv({ cls: 'codem-chat-previews' });
		this.previewEl.hide();
		// v0.8.0（叶部式）：队列面板——输入区上方，排队消息全量可见可改可排
		this.queueEl = inputWrap.createDiv({ cls: 'codem-chat-queue-panel' });
		this.queueEl.hide();
		this.suggestEl = inputWrap.createDiv({ cls: 'codem-suggest' });
		this.suggestEl.hide();

		this.activeTab = this.createTab();
		this.renderEmpty();
		this.buildNavGroup();
		this.renderTabs();
		this.inputEl = inputWrap.createEl('textarea', {
			cls: 'codem-chat-input',
			attr: { placeholder: '询问 CodeM，/ 技能，@ 文件…（Enter 发送）', rows: 2 },
		});
		// 工具栏（输入框内底部，只放可操作控件——叶部 v1.8.0 Composer 重排结构）
		const bottomRow = inputWrap.createDiv({ cls: 'codem-chat-bottomrow' });
		const chips = bottomRow.createDiv({ cls: 'codem-chat-chips' });
		// 权限模式 chip（v0.6.0 三段式：档位名 value + chevron，对齐叶部 chip 结构）
		// v0.6.5：方案 F（对照实验唯一零错位）——全部内容包进内层 flex span，基线由 flex 强制，免疫 emoji 大行盒
		this.permBtn = chips.createEl('button', { cls: 'codem-chat-chip codem-chat-perm', attr: { type: 'button' } });
		const permInner = this.permBtn.createSpan({ cls: 'codem-chat-chip-inner' });
		this.permLabelEl = permInner.createSpan({ cls: 'codem-chat-chip-value' });
		permInner.createSpan({ cls: 'codem-chat-chip-chevron', text: '▾' });
		this.permBtn.setAttribute('aria-label', '权限模式：请求批准 / 帮我批准 / 完全访问，点击选择');
		this.permBtn.onclick = (e) => {
			const menu = new Menu();
			// v1.0.5：按 CodeM 原生客户端命名（截屏确认：请求批准 / 帮我批准 / 完全访问）
			const modes: Array<{ mode: 'manual' | 'smart' | 'yolo'; title: string; icon: string }> = [
				{ mode: 'manual', title: '请求批准', icon: 'shield' },
				{ mode: 'smart', title: '帮我批准', icon: 'shield-check' },
				{ mode: 'yolo', title: '完全访问', icon: 'zap' },
			];
			for (const it of modes) {
				menu.addItem((mi) =>
					mi.setTitle(it.title).setIcon(it.icon).setChecked(this.permMode === it.mode).onClick(() => this.setPermMode(it.mode))
				);
			}
			menu.showAtMouseEvent(e);
		};
		this.setPermMode(this.plugin.settings.readonlyAutoApprove === false ? 'manual' : 'smart');
		// 智能强度 chip（v1.0.5 对齐原生命名）：label 语义紫蓝（叶部 --codem-accent）；CLI --intelligence，跟随配置=不传
		this.buildOptChip(chips, '智能强度', 'codem-chat-intelligence', ['low', 'medium', 'high', 'xhigh'], () => this.modelOpts.intelligence, (v) => (this.modelOpts.intelligence = v));
		// 推理 chip v1.0.4 已移除：预置模型用「智能」档，推理档对预置模型无效且混淆视觉
		// Plan toggle chip：只读工作模式开关（CLI --plan，与权限模式正交）；开启渐变高亮（叶部式）
		const planBtn = chips.createEl('button', { cls: 'codem-chat-chip codem-chat-plan', attr: { type: 'button' } });
		planBtn.createSpan({ cls: 'codem-chat-chip-inner', text: '📋 Plan' });
		planBtn.setAttribute('aria-label', 'Plan 模式：只读不写（新进程生效）');
		planBtn.onclick = () => {
			this.modelOpts.plan = !this.modelOpts.plan;
			planBtn.toggleClass('is-active', this.modelOpts.plan);
			this.applyModelOpts();
			new Notice(this.modelOpts.plan ? 'Plan 模式：只读不写，已按新参数重启 CodeM' : 'Plan 模式已关闭，已按新参数重启 CodeM', 3000);
		};
		// v0.7.0（叶部式）：ctx-meter 上下文用量指示——按会话总字符量估算 token 占比
		this.ctxMeterEl = chips.createSpan({ cls: 'codem-chat-ctx-text', text: '' });
		this.ctxMeterEl.setAttribute('aria-label', '上下文窗口用量');
		const actions = bottomRow.createDiv({ cls: 'codem-chat-actions' });
		// 停止按钮：常驻图标 chip，空闲禁用（叶部式，不再显示/隐藏）；内容包 inner（v0.6.5 方案 F）
		this.stopBtn = actions.createEl('button', { cls: 'codem-chat-stop codem-chat-chip', attr: { type: 'button' } });
		this.stopBtn.createSpan({ cls: 'codem-chat-chip-inner', text: '⏹' });
		this.stopBtn.setAttribute('aria-label', '停止当前任务（Esc）');
		this.stopBtn.disabled = true;
		this.stopBtn.onclick = () => this.stopActiveTurn();

		this.bindInputEvents();
		this.bindPaste();
		this.bindDragDrop();
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
			// 输入历史回溯：输入框为空时 ↑↓ 调取最近发送的 prompt（浮层开启时不抢键）
			if (!suggestActive && !histActive && !e.isComposing && this.inputEl.value === '') {
				if (e.key === 'ArrowUp') {
					e.preventDefault();
				this.recallPrompt(-1);
				return;
				}
				if (e.key === 'ArrowDown') {
					e.preventDefault();
				this.recallPrompt(1);
				return;
				}
			}
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
			if (e.key === 'Enter' && !e.isComposing && (!e.shiftKey || e.ctrlKey || e.metaKey)) {
				// Enter 发送；Shift+Enter 换行；Ctrl/Cmd+Enter 也发送（v0.5.0 UI 对标叶版）
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
			const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()];
			el.createDiv({ cls: 'codem-chat-empty-icon', text: '✳' });
			 el.createDiv({ cls: 'codem-chat-empty-title', text: `${wd}好，CodeM 已就绪` });
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
			draft: '',
			lastPrompt: '',
			pinned: false,
			label: null,
			scrollEl: null as unknown as HTMLElement,
			lastActivity: 0,
			turnSeq: 0,
		};
		tab.scrollEl = this.msgArea.createDiv({ cls: 'codem-chat-messages' });
		tab.scrollEl.addEventListener('click', () => this.closeDir());
		this.tabs.push(tab);
		return tab;
	}

	/** tab 行渲染（v0.7.0 叶部式增强）：Pin 置顶 + 双击重命名 + 消息计数徽章 + 三色灯 + 悬停 × 关闭 */
	private renderTabs(): void {
		const el = this.tabsEl;
		el.empty();
		// Pin 的 tab 排前面
			const sorted = [...this.tabs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
			sorted.forEach((tab) => {
			const i = this.tabs.indexOf(tab);
			const b = el.createEl('button', {
			cls: 'codem-chat-tab' + (tab === this.activeTab ? ' is-active' : '') + (tab.pinned ? ' is-pinned' : ''),
			});
			const dot = b.createSpan({ cls: 'codem-chat-light' });
				dot.addClass('is-' + tab.light);
				// 标题：用户重命名 > 会话 AI 标题 > 序号
					const label = tab.label ?? this.plugin.settings.sessionTitles[tab.sessionId ?? '']?.slice(0, 8) ?? String(i + 1);
					b.createSpan({ cls: 'codem-chat-tab-label', text: label });
				// 消息计数徽章
			if (tab.turnCount > 0) {
		b.createSpan({ cls: 'codem-chat-tab-count', text: `·${tab.turnCount}` });
	}
	  b.setAttribute('aria-label', `会话 ${i + 1}${tab.pinned ? '（已固定）' : ''}`);
	  b.onclick = () => this.switchTab(tab);
	  // 双击重命名（叶部式）
	  b.addEventListener('dblclick', () => {
	   b.empty();
	   const input = b.createEl('input', { cls: 'codem-chat-tab-rename-input', type: 'text' });
	   input.value = tab.label ?? '';
	   input.placeholder = `会话 ${i + 1}`;
	   input.focus();
	   input.select();
	   const commit = (): void => {
	    tab.label = input.value.trim() || null;
	    this.renderTabs();
	   };
	   input.addEventListener('blur', commit);
	   input.addEventListener('keydown', (ev) => {
	    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
	    if (ev.key === 'Escape') { ev.preventDefault(); this.renderTabs(); }
	   });
	  });
	  // Pin 星标（叶部式）
	  const pin = b.createSpan({ cls: 'codem-chat-tab-pin', text: tab.pinned ? '★' : '☆' });
	  pin.onclick = (e) => {
	   e.stopPropagation();
	   tab.pinned = !tab.pinned;
	   this.renderTabs();
	  };
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
		// 输入框草稿随 tab 隔离：离开时保存、进入时恢复
		this.activeTab.draft = this.inputEl.value;
		for (const t of this.tabs) t.scrollEl.toggleClass('codem-is-hidden', t !== tab);
		this.activeTab = tab;
		this.inputEl.value = tab.draft;
		this.renderTabs();
		this.renderPreviews();
		this.updateSidEl();
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
		this.updateSidEl();
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
		tab.draft = this.inputEl.value; // 旧会话草稿随 tab 保留
		for (const t of this.tabs) t.scrollEl.addClass('codem-is-hidden');
		this.activeTab = this.createTab();
		this.inputEl.value = ''; // 新窗口从空输入开始
		this.renderEmpty();
		this.renderTabs();
		this.setStatusLight('idle');
		this.inputEl.focus();
	}

	/**
	 * 状态灯：灰=静默 / 黄=执行中 / 绿=执行结束 / 红=失败（v0.4.0：失败不再复用 done）。
	 * 同步两处：底部状态行 dot + tab 行（tab 行即状态面板）
	 */
	private setStatusLight(state: 'idle' | 'running' | 'done' | 'error'): void {
		this.activeTab.light = state;
		if (this.lightEl) {
			this.lightEl.removeClass('is-idle', 'is-running', 'is-done', 'is-error');
			this.lightEl.addClass('is-' + state);
		}
		this.renderTabs();
		this.syncStopUi();
	}

	/** 停止按钮与输入框提示跟随当前 tab 执行状态（setStatusLight 是所有状态切换汇聚点）。
	 *  v0.6.0：停止按钮常驻（叶部式），空闲为禁用态而非隐藏 */
	private syncStopUi(): void {
		if (!this.stopBtn) return;
		this.stopBtn.disabled = !this.activeTab.busy;
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

	/** 设置权限模式：chip 文案同步（v0.6.4 回归叶部实现：emoji+文字，无 SVG 图标）；YOLO 激活态背景高亮 */
	private setPermMode(mode: 'manual' | 'smart' | 'yolo'): void {
		this.permMode = mode;
		const labels: Record<'manual' | 'smart' | 'yolo', string> = {
			manual: '请求批准',
			smart: '帮我批准',
			yolo: '完全访问',
		};
		this.permLabelEl?.setText(labels[mode]);
		this.permBtn.toggleClass('is-active', mode === 'yolo');
	}

	/** 输入历史回溯：delta<0 上一条（从最近开始），delta>0 下一条，走到底恢复空输入 */
	private recallPrompt(delta: number): void {
		if (!this.promptHistory.length) return;
		if (delta < 0) {
			this.promptHistPos =
				this.promptHistPos < 0 ? this.promptHistory.length - 1 : Math.max(0, this.promptHistPos - 1);
		} else {
			if (this.promptHistPos < 0) return; // 已在最新态，↓ 无动作
			this.promptHistPos++;
			if (this.promptHistPos >= this.promptHistory.length) {
				this.promptHistPos = -1;
				this.inputEl.value = '';
				return;
			}
		}
		this.inputEl.value = this.promptHistory[this.promptHistPos];
	}

	/** 图片拖拽上传：拖入输入区即预览（与粘贴共用 images 数组，v0.5.0 UI 对标叶版） */
	private bindDragDrop(): void {
		const wrap = this.inputWrapEl;
		wrap.addEventListener('dragover', (e) => {
			e.preventDefault();
			wrap.addClass('is-dragover');
		});
		wrap.addEventListener('dragleave', () => wrap.removeClass('is-dragover'));
		wrap.addEventListener('drop', (e) => {
			e.preventDefault();
			wrap.removeClass('is-dragover');
			const files = Array.from(e.dataTransfer?.files ?? []);
			for (const file of files) {
				if (!file.type.startsWith('image/')) continue;
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

	private pluginOpts(): AcpOptions {
		const cwd = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
		// 模型参数（v0.5.1）：进程启动参数，拼在用户额外参数之后；空值/关闭不传
		const optArgs: string[] = [];
		if (this.modelOpts.intelligence) optArgs.push(`--intelligence ${this.modelOpts.intelligence}`);
		if (this.modelOpts.reasoning) optArgs.push(`--reasoning-effort ${this.modelOpts.reasoning}`);
		if (this.modelOpts.plan) optArgs.push('--plan');
		const extra = [this.plugin.settings.extraArgs?.trim(), ...optArgs].filter(Boolean).join(' ');
		return {
			cliPath: this.plugin.settings.codemCliPath,
			cwd,
			nodePath: this.plugin.settings.nodePath,
			extraArgs: extra,
			debugLogPath: undefined,
		};
	}

	/** 构建「标签 值 ▾」chip（v0.6.0 三段式对齐叶部：label 淡灰/语义色 + value 半粗 + chevron 淡显）；
	 *  点击弹菜单选值，空串 = 跟随配置不传参 */
	private buildOptChip(
		host: HTMLElement,
		label: string,
		kindCls: string,
		values: string[],
		get: () => string,
		set: (v: string) => void
	): void {
		const btn = host.createEl('button', { cls: 'codem-chat-chip ' + kindCls, attr: { type: 'button' } });
		const inner = btn.createSpan({ cls: 'codem-chat-chip-inner' });
		inner.createSpan({ cls: 'codem-chat-chip-label', text: label });
		const valEl = inner.createSpan({ cls: 'codem-chat-chip-value', text: OPT_LABELS[''] ?? '跟随' });
		inner.createSpan({ cls: 'codem-chat-chip-chevron', text: '▾' });
		btn.onclick = (e) => {
			const menu = new Menu();
			// v1.0.2：菜单显示中文（OPT_LABELS 映射），CLI 参数传英文原值
			menu.addItem((mi) =>
				mi.setTitle(OPT_LABELS[''] ?? '跟随配置').setChecked(get() === '').onClick(() => {
					set('');
					valEl.setText(OPT_LABELS[''] ?? '跟随');
					this.applyModelOpts();
				})
			);
			for (const v of values) {
				menu.addItem((mi) =>
					mi.setTitle(OPT_LABELS[v] ?? v).setChecked(get() === v).onClick(() => {
						set(v);
						valEl.setText(OPT_LABELS[v] ?? v);
						this.applyModelOpts();
					})
				);
			}
			menu.showAtMouseEvent(e);
		};
	}

	/**
	 * 模型参数变更（智能/推理/Plan）：参数是进程启动参数，需重启 ACP 进程生效；
	 * 各 tab 已持有的会话重启后自动 load 恢复（重放通知因 tab.current 为空被忽略，不污染时间线）
	 */
	private applyModelOpts(): void {
		const held = this.tabs
			.map((t) => ({ t, sid: t.sessionId }))
			.filter((x): x is { t: ChatTab; sid: string } => !!x.sid);
		this.restarting = true; // 抑制 onClose 的"服务已断开"误报
		this.client?.stop();
		this.client = null;
		for (const t of this.tabs) t.sessionId = null;
		if (!held.length) {
			// 还没有活会话：无需恢复，下次 ensureClient 时新参数自然生效
			this.restarting = false;
			return;
		}
		new Notice('已按新参数重启 CodeM 进程，正在恢复会话…', 3000);
		void (async () => {
			try {
				const client = await this.ensureClient();
				for (const { t, sid } of held) {
					try {
						await client.loadSession(sid);
						t.sessionId = sid;
					} catch {
						// 恢复失败：该 tab 下次发送时自动新建会话
					}
				}
			} catch {
				// 重启失败：下次发送时自动重连
			} finally {
				this.restarting = false;
			}
		})();
	}

	/** 底部会话短码 + 会话标题（叶部 info-title：AI 标题/首问，ellipsis 溢出）：切 tab/新会话/载入历史/标题生成时同步 */
	private updateSidEl(): void {
		if (!this.sidEl) return;
		const sid = this.activeTab.sessionId;
		this.sidEl.setText(sid ? '· ' + sid.slice(0, 8) : '');
		if (this.infoTitleEl) {
			const title = sid ? (this.plugin.settings.sessionTitles[sid] ?? '') : '';
			this.infoTitleEl.setText(title);
			this.infoTitleEl.toggleClass('is-empty', !title);
		}
		this.updateCtxMeter();
	}

	/** v0.7.0（叶部式）：ctx-meter 用量更新——按当前 tab 会话总字符量估算 token 占比 */
	private updateCtxMeter(): void {
		if (!this.ctxMeterEl) return;
		const total = this.plugin.settings.contextWindowTokens || 200000;
		// 粗估：中文字符≈1 token，英文≈0.25 token；用 mdBuffer 长度×0.7 作近似
		const used = Math.round(this.activeTab.mdBuffer.length * 0.7);
		const pct = Math.min(100, Math.round((used / total) * 100));
		this.ctxMeterEl.setText(pct > 0 ? `${pct}%` : '');
		// >80% 警示色
		this.ctxMeterEl.toggleClass('is-warn', pct >= 80);
	}

	private async ensureClient(): Promise<AcpClient> {
		if (this.client) return this.client;
		this.client = new AcpClient(
			this.pluginOpts(),
			{
				onUpdate: (sid, u) => this.handleUpdate(sid, u),
				onPermissionRequest: (params, respond) => this.handlePermission(params, respond),
				onClose: (code) => {
				// 参数重启流程（applyModelOpts）自行接管复位，跳过误报
				if (this.restarting) return;
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

	// ===== v0.8.0（叶部式）队列面板：全量列表 + Steer + 清空 + 逐条编辑/删除/重排 =====

	/** 渲染队列面板：排队消息全量可见，每条 ↑↓ ✎ ✕，面板级 Steer / 清空 */
	private renderQueuePanel(): void {
		if (!this.queueEl) return;
		this.queueEl.empty();
		if (!this.inputQueue.length) {
			this.queueEl.hide();
			return;
		}
		this.queueEl.show();
		// 面板头：计数 + Steer + 清空
		const head = this.queueEl.createDiv({ cls: 'codem-chat-queue-head' });
		head.createSpan({ cls: 'codem-chat-queue-title', text: `已排队 ${this.inputQueue.length} 条` });
		const headBtns = head.createDiv({ cls: 'codem-chat-queue-actions' });
		// Steer：停止当前回合，队首立刻发出（cancel 后 finishTurn → finally 自动 shift 队首续发）
		const steerBtn = headBtns.createEl('button', { text: '⚡ Steer', cls: 'codem-chat-queue-steer' });
		steerBtn.setAttribute('aria-label', '停止当前任务并立刻发出队首消息');
		steerBtn.onclick = () => {
			if (!this.activeTab.busy || !this.inputQueue.length) return;
			this.stopActiveTurn(); // cancel → reason='cancelled' → finally 不恢复（队列保留）→ shift 自动发队首
		};
		// 清空：全部排队项丢弃（不影响输入框当前草稿）
		const clearBtn = headBtns.createEl('button', { text: '清空', cls: 'codem-chat-queue-discard' });
		clearBtn.setAttribute('aria-label', '清空全部排队消息');
		clearBtn.onclick = () => {
			this.inputQueue = [];
			this.renderQueuePanel();
		};
		// 逐条列表
		const list = this.queueEl.createDiv({ cls: 'codem-chat-queue-list', attr: { role: 'list' } });
		this.inputQueue.forEach((item, idx) => {
			const row = list.createDiv({ cls: 'codem-chat-queue-item', attr: { role: 'listitem' } });
			row.createSpan({ cls: 'codem-chat-queue-item-text', text: item.prompt.slice(0, 80) || '（图片）' });
			const btns = row.createDiv({ cls: 'codem-chat-queue-item-actions' });
			const mkBtn = (label: string, title: string, fn: () => void, disabled = false): void => {
				const b = btns.createEl('button', { text: label, cls: 'codem-chat-queue-move' });
				b.setAttribute('aria-label', title);
				if (disabled) { (b as HTMLButtonElement).disabled = true; return; }
				b.onclick = () => fn();
			};
			mkBtn('↑', '上移一位', () => {
				if (idx <= 0) return;
				const t = this.inputQueue[idx - 1];
				this.inputQueue[idx - 1] = this.inputQueue[idx];
				this.inputQueue[idx] = t;
				this.renderQueuePanel();
			}, idx === 0);
			mkBtn('↓', '下移一位', () => {
				if (idx >= this.inputQueue.length - 1) return;
				const t = this.inputQueue[idx + 1];
				this.inputQueue[idx + 1] = this.inputQueue[idx];
				this.inputQueue[idx] = t;
				this.renderQueuePanel();
			}, idx === this.inputQueue.length - 1);
			mkBtn('✎', '撤回输入框编辑', () => {
				this.inputQueue.splice(idx, 1);
				this.inputEl.value = (this.inputEl.value ? this.inputEl.value + '\n' : '') + item.prompt;
				// 图片也回填到预览区
				if (item.images.length) {
					this.activeTab.images.push(...item.images);
					this.renderPreviews();
				}
				this.renderQueuePanel();
				this.inputEl.focus();
			});
			mkBtn('✕', '删除这一条', () => {
				this.inputQueue.splice(idx, 1);
				this.renderQueuePanel();
			});
		});
	}

	// ===== 发送与流式渲染 =====

	private async send(): Promise<void> {
		const rawPrompt = this.inputEl.value.trim();
		const tab = this.activeTab;
		if ((!rawPrompt && !tab.images.length)) return;

		// Agent 执行中：入队等待而非拒绝输入
		if (tab.busy) {
			this.inputQueue.push({ prompt: rawPrompt, images: tab.images.slice() });
			tab.images = [];
			this.inputEl.value = '';
			tab.draft = '';
			this.renderPreviews();
			this.renderQueuePanel();
			new Notice(`已排队（当前第 ${this.inputQueue.length} 条），稍后自动发送`);
			return;
		}

		// 输入历史：记录最近 50 条已发送 prompt（输入框空时 ↑↓ 回溯）
		if (rawPrompt && this.promptHistory[this.promptHistory.length - 1] !== rawPrompt) {
			this.promptHistory.push(rawPrompt);
			if (this.promptHistory.length > 50) this.promptHistory.shift();
		}
		this.promptHistPos = -1;
		tab.lastPrompt = rawPrompt; // v0.9.0：记录本轮 prompt，供重新生成/错误重试

		const seq = ++tab.turnSeq; // 本轮序号：watchdog 强制收尾后，迟到的旧 finally 自动失效
		tab.busy = true;
		this.setStatusLight('running');
		this.inputEl.value = '';
		tab.draft = '';
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
				return;
			}
			// 强制收尾：CLI 端 turn 可能已结束但最终 response 丢失，prompt 永久挂起、UI 卡"执行中"。
			// turnSeq+1 使旧 send 的 finally 失效，由这里接管 UI 复位（cancel 只是 best effort，不保证救回）。
			if (stallNotified && Date.now() - tab.lastActivity > 360000) {
				window.clearInterval(watchdog);
				tab.turnSeq++;
				if (tab.sessionId) this.client?.cancelSession(tab.sessionId);
				this.stopTypewriter(tab);
				// 强制收尾前回收挂起审批（服务端还在等应答）；长时间无响应按失败置灯，不再复用 done
				if (tab.current) {
					this.recyclePerms(tab.current, '（本轮长时间无响应，已自动拒绝）');
					window.clearInterval(tab.current.liveTimer);
					tab.current.liveEl.remove();
				}
				tab.current = null;
				tab.busy = false;
				tab.light = 'error';
				tab.scrollEl
					.createDiv({ cls: 'codem-chat-msg codem-chat-stopped' })
					.setText('⏱ 本轮长时间无响应，已自动结束显示；若 CodeM 仍在后台执行，结果可能稍后出现。');
				this.renderTabs();
				this.syncStopUi();
				if (this.lightEl) {
					this.lightEl.removeClass('is-idle', 'is-running', 'is-done', 'is-error');
					this.lightEl.addClass('is-' + (tab === this.activeTab ? 'error' : tab.light));
				}
				this.scrollBottom(tab.scrollEl);
			}
		}, 30000);

		const images = tab.images; // capture 引用：气泡渲染与 prompt blocks 都用它
		tab.images = [];
		this.renderPreviews();
		const userBlock = this.renderUserMessage(rawPrompt, images);
		this.forceScrollBottom();
		this.addTurnAnchor(userBlock);
		const st = this.renderAssistantSkeleton();
		tab.current = st;
		tab.mdBuffer = '';
		tab.displayLen = 0;
		let turnFailed = false; // 失败标记：finally 据此把灯设为 error（此前失败也显示绿色 done）
		let wasCancelled = false; // v0.8.0：停止时排队消息回填输入框而非自动续发（叶部式）
		// 运行读数（v0.5.0）：1s 刷新实时耗时，180s 无响应转警示（区分长任务与卡死）
		st.liveTimer = window.setInterval(() => {
			if (!tab.busy) {
				window.clearInterval(st.liveTimer);
				return;
			}
			const secs = Math.round((Date.now() - st.turnStart) / 1000);
			const stalled = Date.now() - tab.lastActivity > 180000;
			st.liveEl.setText(stalled ? `⏱ ${secs}s · ⚠ 长时间无响应` : `⏱ ${secs}s`);
		}, 1000);

		try {
			const client = await this.ensureClient();
			if (!tab.sessionId) {
				tab.sessionId = await client.newSession();
				if (tab === this.activeTab) this.updateSidEl();
			}
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
			// 本轮已被 watchdog 强制收尾接管：丢弃迟到结果，不再渲染时间线/标题
			if (seq !== tab.turnSeq) return;
			// 用户中途停止（session/cancel）：已流出正文保留，时间线打停止标记
			if (reason === 'cancelled') {
				wasCancelled = true;
				this.stopTypewriter(tab);
				tab.scrollEl
					.createDiv({ cls: 'codem-chat-msg codem-chat-stopped' })
					.setText('⏹ 已停止（本轮内容可能不完整）');
			}
			this.finishTurn(st, tab, reason === 'cancelled');
		// v0.9.0（叶部式）：assistant 消息重新生成按钮 ↻
		if (reason !== 'cancelled' && rawPrompt) {
			const regenBtn = st.aiBlock.createEl('button', { cls: 'codem-chat-regen-btn', text: '↻ 重新生成' });
			regenBtn.setAttribute('aria-label', '用同样的提问重新生成回复');
			regenBtn.onclick = () => {
				if (tab.busy) return;
				this.inputEl.value = rawPrompt;
				void this.send();
			};
		}
			// 首轮结束后台生成会话标题（无头 -p 调用，静默失败）
			if (tab.turnCount === 1 && tab.sessionId && !this.plugin.settings.sessionTitles[tab.sessionId]) {
				void this.generateTitle(tab, rawPrompt);
			}
		} catch (e) {
			turnFailed = true;
			this.stopTypewriter(tab);
			window.clearInterval(st.liveTimer);
			// v0.7.0（叶部式）：未送达标记——发送失败时用户气泡标灰提示，内容不丢
			userBlock.addClass('codem-chat-undelivered');
			const un = userBlock.querySelector('.codem-chat-user');
			un?.createDiv({ cls: 'codem-chat-undelivered-note', text: '未送达 · 可复制后重试' });
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
			// v0.9.0（叶部式）：错误重试按钮——恢复上条 prompt 重发
			const retryBtn = errBlock.createEl('button', { cls: 'codem-chat-error-retry', text: '↻ 重试' });
			retryBtn.setAttribute('aria-label', '重试上一条消息');
			retryBtn.onclick = () => {
				if (tab.busy) return;
				errBlock.remove();
				userBlock.removeClass('codem-chat-undelivered');
				userBlock.querySelector('.codem-chat-undelivered-note')?.remove();
				this.inputEl.value = rawPrompt;
				void this.send();
			};
		} finally {
			// 本轮已被强制收尾接管（turnSeq 已推进）：跳过复位，防止破坏接管方状态
			if (seq !== tab.turnSeq) {
				window.clearInterval(watchdog);
				return;
			}
			window.clearInterval(watchdog);
			tab.current = null;
			tab.busy = false;
			const finalLight: 'done' | 'error' = turnFailed ? 'error' : 'done';
			tab.light = finalLight;
			this.renderTabs();
			this.syncStopUi(); // 复位停止按钮与"执行中…"输入框提示（手动改灯绕过了 setStatusLight）
			if (this.lightEl) {
				this.lightEl.removeClass('is-idle', 'is-running', 'is-done', 'is-error');
				this.lightEl.addClass('is-' + (tab === this.activeTab ? finalLight : tab.light));
			}
			this.scrollBottom(tab.scrollEl);
			// 消费排队中的下一条消息
			if (this.inputQueue.length > 0) {
				if (wasCancelled) {
					// v0.8.0（叶部式）：用户停止 → 排队消息回填输入框（不丢、可编辑），不自动续发
					const next = this.inputQueue.shift()!;
					if (this.activeTab !== tab) this.switchTab(tab);
					tab.images = next.images;
					this.inputEl.value = next.prompt;
					tab.draft = next.prompt;
					this.renderPreviews();
				} else {
					// 正常完成：自动发送下一条
					const next = this.inputQueue.shift()!;
					// 如果当前不在发起排队的 tab 上，切回去再发
					if (this.activeTab !== tab) this.switchTab(tab);
					tab.images = next.images;
					this.inputEl.value = next.prompt;
					tab.draft = next.prompt;
					this.renderPreviews();
					window.setTimeout(() => void this.send(), 200);
				}
				this.renderQueuePanel();
			}
		}
	}

	/** 一轮完成收尾：停打字机、收束正文段、折叠思考区（stopped=用户中途停止） */
	private finishTurn(st: RenderState, tab: ChatTab, stopped = false): void {
		if (tab.typeTimer !== null) {
			window.clearInterval(tab.typeTimer);
			tab.typeTimer = null;
		}
		window.clearInterval(st.liveTimer);
		st.liveEl.remove();
		this.flushSeg(st);
		if (st.thinkingBody.textContent) {
			st.thinkingSummary.setText('思考过程');
			st.thinking.addClass('is-done'); // 停思考呼吸动画（回看静止态）
			st.thinking.removeAttribute('open');
		} else {
			st.thinking.hide();
		}
		// 轮末回收：未决审批统一回拒绝应答（服务端在等答复，不回会挂死这一轮），条目留痕不静默消失
		this.recyclePerms(st, stopped ? '（本轮已停止，未处理）' : '（本轮已结束，未处理）');
		st.pendingPerms.clear();
		// 轮末统计条：耗时与工具次数（CodeM 不发 token 用量，改用可观测指标）
		if (!stopped) {
			const secs = Math.max(1, Math.round((Date.now() - st.turnStart) / 1000));
			const parts = [`⏱ 耗时 ${secs} 秒`];
			if (st.toolCount > 0) parts.push(`🔧 ${st.toolCount} 次工具`);
			st.aiBlock.createDiv({ cls: 'codem-chat-usage', text: parts.join(' · ') });
			// 助手回复末尾扫描 [[引用]] → 渲染可折叠笔记引用块
			this.appendCitations(st.aiBlock);
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
		// 行容器：气泡 + 气泡外侧的时间戳（时间戳不放进深色气泡内，避免看不清）
		const row = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-user-row' });
		// 消息时间戳（HH:MM）：气泡上方、左对齐——DOM 排在气泡前（column 布局在上），行容器内左对齐
		const now = new Date();
		const hh = String(now.getHours()).padStart(2, '0');
		const mm = String(now.getMinutes()).padStart(2, '0');
		row.createSpan({ cls: 'codem-chat-time', text: `${hh}:${mm}` });
		const userBlock = row.createDiv({ cls: 'codem-chat-user' });
		if (text) {
			const body = userBlock.createDiv({ cls: 'codem-chat-body markdown-rendered' });
			body.appendChild(renderMarkdown(text));
			this.linkifyWikilinks(body);
			this.decorateCodeBlocks(body);
		}
		// v1.0.5：消息 hover 操作按钮统一 lucide SVG 图标（copy/pencil/quote，与叶部/原生一致）
		if (text) {
			const copyBtn = row.createEl('button', { cls: 'codem-chat-copy-btn' });
			setIcon(copyBtn, 'copy');
			copyBtn.setAttribute('aria-label', '复制此消息');
			copyBtn.onclick = (e) => {
				e.stopPropagation();
				void navigator.clipboard.writeText(text).then(() => {
					setIcon(copyBtn, 'check');
					window.setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
				});
			};
			const editBtn = row.createEl('button', { cls: 'codem-chat-copy-btn codem-chat-edit-btn' });
			setIcon(editBtn, 'pencil');
			editBtn.setAttribute('aria-label', '编辑此消息（回填输入框）');
			editBtn.onclick = (e) => {
				e.stopPropagation();
				this.inputEl.value = text;
				this.inputEl.focus();
			};
			const quoteBtn = row.createEl('button', { cls: 'codem-chat-copy-btn codem-chat-quote-btn' });
			setIcon(quoteBtn, 'quote');
			quoteBtn.setAttribute('aria-label', '引用此消息');
			quoteBtn.onclick = (e) => {
				e.stopPropagation();
				this.inputEl.value = (this.inputEl.value ? this.inputEl.value + '\n\n' : '') + '> ' + text.split('\n').join('\n> ') + '\n\n';
				this.inputEl.focus();
			};
		}
		for (const img of images) {
			userBlock.createEl('img', { cls: 'codem-chat-img', attr: { src: `data:${img.mime};base64,${img.data}` } });
		}
		return row;
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

	/** 扫描助手回复全部正文段中的 [[引用]] 并追加到消息底部：可折叠展开笔记引用块，点击链到原笔记 */
	private appendCitations(aiBlock: HTMLElement): void {
		const allText = Array.from(aiBlock.querySelectorAll('.codem-chat-text.markdown-rendered'))
			.map((el) => el.textContent ?? '')
			.join('\n');
		const seen = new Set<string>();
		const refs: string[] = [];
		for (const m of allText.matchAll(/\[\[([^\][|]+)(?:\|[^\]]*)?\]\]/g)) {
			const ref = m[1].trim();
			if (ref && !seen.has(ref)) {
				seen.add(ref);
				refs.push(ref);
			}
		}
		if (!refs.length) return;
		const d = aiBlock.createEl('details', { cls: 'codem-chat-citations' });
		d.createEl('summary', { cls: 'codem-chat-citations-header',
			text: `📖 引用笔记 ${refs.length} 篇` });
		const content = d.createDiv({ cls: 'codem-chat-citations-content' });
		for (const ref of refs) {
			const dest = this.app.metadataCache.getFirstLinkpathDest(ref, '');
			const row = content.createDiv({ cls: 'codem-chat-citation-item' });
			row.createSpan({ cls: 'codem-chat-citation-icon', text: '📄' });
			const a = row.createEl('a', { cls: 'internal-link', text: ref });
			a.onclick = (e) => {
				e.preventDefault();
				if (dest) void this.app.workspace.openLinkText(dest.path, '');
				else new Notice(`未找到引用目标：${ref}`);
			};
		}
	}

	/** 文本节点中的 [[笔记|显示名]] → 可点击内部链接（Obsidian 主题样式）。
	 *  用户消息保留跳转行为；助手回复的引用块由 finishTurn 统一渲染，
	 *  不在流式阶段逐个 linkify（避免每个 delta 重扫 DOM 开销过大）。 */
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
		// 运行读数（v0.5.0）：轮次头部实时计时，finishTurn 移除并换轮末耗时条
		const liveEl = aiBlock.createDiv({ cls: 'codem-chat-live', text: '⏱ 0s' });
		const thinking = aiBlock.createEl('details', { cls: 'codem-chat-thinking' });
		thinking.setAttribute('open', '');
		const thinkingSummary = thinking.createEl('summary', { text: '思考中…' });
		const thinkingBody = thinking.createDiv({ cls: 'codem-chat-thinking-body' });
		this.scrollBottom();
		return { aiBlock, thinking, thinkingSummary, thinkingBody, anchor: thinking, curSeg: null, textSegs: [], cards: new Map(), pendingPerms: new Map(), permRequests: [], thinkNode: null, liveEl, liveTimer: 0, turnStart: Date.now(), toolCount: 0 };
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
			// 大段降级：超过阈值不再每 tick 全量 parse+净化+重建 DOM（长消息冻结主因），
			// 切换为单 textNode 增量追加；段收束（flushSeg）时一次性完整渲染定格
			if (seg.buf.length > STREAM_MD_LIMIT) {
				if (!seg.plainNode) {
					seg.el.empty();
					seg.el.addClass('is-plain');
					seg.plainNode = document.createTextNode(seg.buf.slice(0, seg.shown));
					seg.el.appendChild(seg.plainNode);
				} else if (seg.shown > seg.plainNode.length) {
					seg.plainNode.appendData(seg.buf.slice(seg.plainNode.length, seg.shown));
				}
			} else {
					seg.el.empty();
					seg.el.appendChild(renderMarkdown(seg.buf.slice(0, seg.shown)));
			}
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
				st.curSeg = { el, buf: '', shown: 0, done: false, plainNode: null };
				st.textSegs.push(st.curSeg);
			}
			st.curSeg.buf += text;
		} else if (kind === 'agent_thought_chunk') {
			// 增量追加：textNode.appendData 替代 textContent +=（后者每 chunk 全量重赋+强制布局）；
			// 思考区自身不再逐 chunk 滚动，外层滚底已由 rAF 节流统一处理
			if (!st.thinkNode) {
				st.thinkNode = document.createTextNode('');
				st.thinkingBody.appendChild(st.thinkNode);
			}
			st.thinkNode.appendData(content?.text ?? '');
			this.scrollBottom(tab.scrollEl);
		} else if (kind === 'tool_call' || kind === 'tool_call_update') {
			// ask_user 在当前 CodeM 版本（0.1.229/agent 0.8.59+）不支持插件侧 RPC 交互：
			// 探针实测 agent 不发送任何 agent→client 请求，tool_call 秒完成并返回
			// {"status":"cancelled"}。用户无法进行任何选择，故在工具卡上方给明确提示。
			// 修 bug：原代码误用未声明的 status（静默命中 window.status 恒为空串，提示永不触发）
			const isAskUserCancel =
				(update.title === 'ask_user' || update.kind === 'other') &&
				(update.status as string) === 'completed';
			if (isAskUserCancel) {
				st.aiBlock.createDiv({ cls: 'codem-chat-askuser-hint' }).setText('ℹ️ ask_user 选项交互当前版本暂不支持，CodeM 侧已自动取消本次选择。');
			}
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
			// v1.0.0 DOM 对齐叶部：类名 cat-* → is-*（叶部 CSS 选择器 .codem-chat-tool.is-bash 等）
			// 图标由叶部 CSS ::before 伪元素渲染（content:"💻" 等），不再在 DOM 里插 span
			const cat = toolCategory(title);
			const details = createEl('details', { cls: 'codem-chat-tool is-' + cat });
			details.setAttribute('open', '');
			st.anchor.after(details);
			st.anchor = details;
			// v1.0.0 DOM 对齐叶部：summary 直接 flex 布局（CSS 控制图标+间距），无 tool-head/tool-icon span
			const headEl = details.createEl('summary');
			const nameEl = headEl.createSpan({ cls: 'codem-chat-tool-name', text: title });
			// v1.0.0 DOM 对齐叶部：状态用 data-status 属性驱动 CSS 颜色（.codem-chat-tool-status[data-status="completed"] { color: green }）
			const statusEl = headEl.createSpan({ cls: 'codem-chat-tool-status' });
			statusEl.setAttribute('data-status', status || 'in_progress');
			statusEl.setText(status === 'completed' ? '✓' : status === 'failed' ? '✗' : '…');
			const contentEl = details.createDiv({ cls: 'codem-chat-tool-content' });
			const rawInput = update.rawInput;
			if (rawInput && typeof rawInput === 'object' && Object.keys(rawInput).length > 0) {
				contentEl.createDiv({ cls: 'codem-chat-tool-raw' }).setText(JSON.stringify(rawInput).slice(0, 300));
			}
			card = {
				detailsEl: details,
				headEl,
				nameEl,
				statusEl,
				contentEl,
				title,
				status,
				rawInput: rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : undefined,
			};
			st.cards.set(id, card);
			// 回挂早到的权限条（request_permission 先于 tool_call 到达的场景）到内容区；
			// 确保卡片展开，防权限条藏在折叠区内不可见
			const pended = st.pendingPerms.get(id);
			if (pended) {
				for (const el of pended) {
					if (el.dataset.answered === '1') continue; // 已响应的条不复活
					card.contentEl.appendChild(el);
				}
				st.pendingPerms.delete(id);
				card.detailsEl.setAttribute('open', '');
			}
			st.toolCount++;
			// 客户端自构造 diff（CodeM 不发 diff 数据）：pending 阶段读原文件定位行号
			void this.buildEditDiff(card);
		} else {
			const incomingTitle = update.title as string | undefined;
			if (incomingTitle && incomingTitle !== card.title) {
				card.title = incomingTitle;
				card.nameEl.setText(incomingTitle);
			}
			if (status && status !== card.status) {
				card.status = status;
				card.statusEl.setAttribute('data-status', status);
				card.statusEl.setText(status === 'completed' ? '✓' : status === 'failed' ? '✗' : '…');
				if (status === 'completed') card.detailsEl.removeAttribute('open');
			}
		}
		const contents = (update.content as Array<{ text?: string; content?: { text?: string } }>) ?? [];
		for (const c of contents) {
			const text = c?.content?.text ?? c?.text;
			if (text) {
				// 工具失败归类（v0.5.0 UI 对标叶版）：exit code 人话化置顶
				const ec = text.match(/"exit_code"\s*:\s*(\d+)/);
				const code = ec ? Number(ec[1]) : 0;
				const failMap: Record<number, string> = {
					127: '命令不存在（exit 127）',
					126: '权限不足或不可执行（exit 126）',
					124: '执行超时（exit 124）',
				};
				if (code && failMap[code]) {
					card.contentEl.createDiv({ cls: 'codem-chat-tool-error', text: `❌ ${failMap[code]}` });
				}
				card.contentEl.createEl('pre', { cls: 'codem-chat-tool-result' }).setText(
					text.length > TOOL_RESULT_MAX_LEN
						? text.slice(0, TOOL_RESULT_MAX_LEN) + `…（截断，共 ${text.length} 字符）`
						: text
				);
			}
		}
		this.scrollBottom(scrollEl);
	}

	/** 收束当前流式正文段：全文渲染定格，打字机不再写它；追加 hover 复制按钮 */
	private flushSeg(st: RenderState): void {
		const seg = st.curSeg;
		if (!seg) return;
		st.curSeg = null;
		seg.done = true;
		seg.el.removeClass('is-plain');
		seg.el.empty();
		const frag = renderMarkdown(seg.buf);
		// 超长段折叠：单次渲染几十 KB markdown 也会产生大 DOM 常驻，折叠避免拖慢整页布局与滚动
		if (seg.buf.length > SEG_COLLAPSE_LIMIT) {
			const det = createEl('details', { cls: 'codem-chat-seg-fold' });
			det.createEl('summary', { text: `📄 长内容（约 ${seg.buf.length} 字）已折叠，点击展开` });
			det.appendChild(frag);
			seg.el.appendChild(det);
		} else {
			seg.el.appendChild(frag);
		}
		this.decorateCodeBlocks(seg.el);
		// hover 复制按钮（Claudian 式：浮在文本段右下角，hover 才出现）
		const copyBtn = seg.el.createEl('button', { cls: 'codem-chat-copy-btn' });
		setIcon(copyBtn, 'copy');
		copyBtn.setAttribute('aria-label', '复制此段');
		copyBtn.onclick = (e) => {
			e.stopPropagation();
			void navigator.clipboard.writeText(seg.buf).then(() => {
				setIcon(copyBtn, 'check');
				window.setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
			});
		};
	}

	/** 渲染后处理（v0.5.0 UI 对标叶版）：代码块加语言标签 + hover 复制按钮（幂等，DOM API） */
	private decorateCodeBlocks(root: HTMLElement): void {
		root.querySelectorAll('pre').forEach((pre) => {
			if (pre.querySelector('.codem-chat-code-tools')) return;
			const code = pre.querySelector('code');
			const lang = code?.className.match(/language-([\w+-]+)/)?.[1] ?? '';
			const bar = createDiv({ cls: 'codem-chat-code-tools' });
			if (lang) bar.createSpan({ cls: 'codem-chat-code-lang', text: lang });
			const btn = bar.createEl('button', { cls: 'codem-chat-code-copy', text: '📋' });
			btn.setAttribute('aria-label', '复制代码');
			btn.onclick = () => {
				void navigator.clipboard.writeText(code?.textContent ?? pre.textContent ?? '').then(() => {
					btn.setText('✅');
					window.setTimeout(() => btn.setText('📋'), 1500);
				});
			};
			pre.appendChild(bar);
		});
	}

	/** 双列 diff 渲染（v0.5.0 UI 对标叶版）：左列删除侧 / 右列新增侧，ctx 两列同显；DOM API（textContent）防注入 */
	private renderDiff(container: HTMLElement, lines: Array<{ kind: 'ins' | 'del' | 'ctx'; old?: number; new?: number; text: string }>): void {
		if (!lines.length) return;
		const wrap = container.createDiv({ cls: 'codem-chat-diff' });
		for (const line of lines) {
			const row = wrap.createDiv({ cls: 'codem-chat-diff-row' });
			// 左列（old 侧）：del 显示原文，ins 留空，ctx 显示
			const left = row.createDiv({ cls: `codem-chat-diff-cell ${line.kind === 'ins' ? 'is-empty' : 'is-' + line.kind}` });
			left.createSpan({ cls: 'codem-chat-diff-ln', text: line.kind === 'ins' || line.old == null ? '' : String(line.old) });
			left.createSpan({ cls: 'codem-chat-diff-sign', text: line.kind === 'del' ? '-' : '' });
			left.createSpan({ cls: 'codem-chat-diff-text', text: line.kind === 'ins' ? '' : line.text });
			// 右列（new 侧）：ins 显示新文，del 留空，ctx 显示
			const right = row.createDiv({ cls: `codem-chat-diff-cell ${line.kind === 'del' ? 'is-empty' : 'is-' + line.kind}` });
			right.createSpan({ cls: 'codem-chat-diff-ln', text: line.kind === 'del' || line.new == null ? '' : String(line.new) });
			right.createSpan({ cls: 'codem-chat-diff-sign', text: line.kind === 'ins' ? '+' : '' });
			right.createSpan({ cls: 'codem-chat-diff-text', text: line.kind === 'del' ? '' : line.text });
		}
	}

	/** 客户端自构造 diff：CodeM 的 tool_call_update 不带 diff 数据，
	 * 在 tool_call（pending，早于实际执行）阶段用 vault API 读原文件定位 old_string 行号 */
	private async buildEditDiff(card: ToolCard): Promise<void> {
		const raw = card.rawInput;
		if (!raw) return;
		try {
			const oldStr = typeof raw.old_string === 'string' ? raw.old_string : '';
			const newStr = typeof raw.new_string === 'string' ? raw.new_string : '';
			if (!oldStr) {
				// 全量写入（write_file）：所有行按新增展示，行号即内容行序；大文件截断防几千行 DOM
				const content = typeof raw.content === 'string' ? raw.content : '';
				if (!content) return;
				const lines = content.split('\n');
				this.renderDiff(
			card.contentEl,
			  lines.slice(0, DIFF_MAX_LINES).map((text, i) => ({ kind: 'ins' as const, new: i + 1, text }))
			 );
			 if (lines.length > DIFF_MAX_LINES) {
			  card.contentEl.createDiv({ cls: 'codem-chat-diff-trunc', text: `…（diff 已截断：仅显示前 ${DIFF_MAX_LINES} 行，共 ${lines.length} 行）` });
			 }
			 return;
			}
			const path = typeof raw.path === 'string' ? raw.path : '';
			if (!path) return;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			const content = await this.app.vault.cachedRead(file);
			const idx = content.indexOf(oldStr);
			if (idx < 0) return;
			const startLine = content.slice(0, idx).split('\n').length;
			const oldLines = oldStr.split('\n');
			const newLines = newStr === '' ? [] : newStr.split('\n');
			const out: Array<{ kind: 'ins' | 'del' | 'ctx'; old?: number; new?: number; text: string }> = [];
			const n = Math.max(oldLines.length, newLines.length);
			for (let i = 0; i < n; i++) {
				const ol = oldLines[i];
				const nl = newLines[i];
				if (ol !== undefined && nl !== undefined && ol === nl) {
					out.push({ kind: 'ctx', old: startLine + i, new: startLine + i, text: ol });
				} else if (ol !== undefined && nl !== undefined) {
					out.push({ kind: 'del', old: startLine + i, text: ol });
					out.push({ kind: 'ins', new: startLine + i, text: nl });
				} else if (ol !== undefined) {
					out.push({ kind: 'del', old: startLine + i, text: ol });
				} else if (nl !== undefined) {
					out.push({ kind: 'ins', new: startLine + i, text: nl });
				}
			}
			this.renderDiff(card.contentEl, out);
		} catch {
			// 读文件/定位失败：静默降级，不影响主流程
		}
	}

	/** 图片放大模态：挂 contentEl（scrollEl 会被 empty() 清空），点击遮罩关闭 */
	private openImageModal(src: string): void {
		const overlay = this.contentEl.createDiv({ cls: 'codem-chat-image-modal-overlay' });
		overlay.addEventListener('click', () => overlay.remove());
		const modal = overlay.createDiv({ cls: 'codem-chat-image-modal' });
		modal.createEl('img', { attr: { src } });
		const close = modal.createDiv({ cls: 'codem-chat-image-modal-close', text: '×' });
		close.addEventListener('click', (e) => { e.stopPropagation(); overlay.remove(); });
	}

	/** 自动批准类（yolo/只读白名单/本会话记住）轮内聚合条：唯一沉底，按工具名计数不刷屏 */
	private noteAutoApprove(st: RenderState, tab: ChatTab, toolName: string, label: string): void {
		let note = st.yoloNote;
		if (!note) {
			const el = createEl('div', { cls: 'codem-chat-perm codem-chat-perm-auto' });
			st.aiBlock.appendChild(el);
			note = { el, counts: new Map(), total: 0, labels: new Set() };
			st.yoloNote = note;
		}
		note.counts.set(toolName, (note.counts.get(toolName) ?? 0) + 1);
		note.total++;
		note.labels.add(label);
		const parts = [...note.counts.entries()].map(([t, n]) => `${t} ×${n}`);
		note.el.setText(`🔓 自动批准 ${note.total} 次（${[...note.labels].join('/')}）：${parts.join(' · ')}`);
		this.scrollBottom(tab.scrollEl);
	}

	private handlePermission(
		params: Record<string, unknown>,
		respond: (result: unknown) => void
	): void {
		// 按 sessionId 路由到发起 tab；匹配不到时优先回退到唯一执行中的 tab（防多 tab 下
		// 回落到新建空会话 → 找不到渲染状态 → 权限被默认取消）；都没有才退回当前 tab
		const tab =
			this.tabs.find((t) => t.sessionId === params.sessionId) ??
			this.tabs.find((t) => t.busy && t.current) ??
			this.activeTab;
		const st = tab.current;
		const toolCall = params.toolCall as { toolCallId?: string; title?: string; rawInput?: unknown } | undefined;
		const toolName = toolCall?.title ?? '工具';
		const label = toolName + '请求权限';
		const options = (params.options as Array<{ optionId: string; name: string; kind?: string }>) ?? [];
		const allowOnce = options.find((o) => String(o.kind) === 'allow_once');
		const allowAlways = options.find((o) => String(o.kind) === 'allow_always');
		const reject = options.find((o) => String(o.kind) === 'reject_once');

		if (!st) {
			// 无活动渲染状态（本轮已结束/watchdog 收尾）：可见反馈而非静默取消，
			// 否则用户不知道有审批请求被吞
			new Notice(`CodeM：${label} 的权限请求到达时对话已结束，已自动取消`);
			respond({ outcome: { outcome: 'cancelled' } });
			return;
		}
		// 宿主：对应工具卡片内部（通知/确认条跟随该工具，不挤在正文后）。
		// CodeM 时序：request_permission 可能先于 tool_call 通知到达，此时卡片尚未创建——
		// 条目暂存 pendingPerms，卡片创建（handleToolEvent）时回挂；无 toolCallId 才落 aiBlock 末尾
		let host: HTMLElement | null = null;
		if (toolCall?.toolCallId) {
			const card = st.cards.get(toolCall.toolCallId);
			if (card) host = card.contentEl;
		}
		const park = (el: HTMLElement): void => {
			if (host) {
				host.appendChild(el);
			} else if (toolCall?.toolCallId) {
				// 卡片未创建：先落 aiBlock 末尾保证立即可见可点——agent 在等权限响应，
				// 只存 pendingPerms 会让条目不可见、用户不响应则对话挂死；
				// 卡片创建（handleToolEvent 回挂）时 appendChild 自动迁移进卡片
				st.aiBlock.appendChild(el);
				const list = st.pendingPerms.get(toolCall.toolCallId) ?? [];
				list.push(el);
				st.pendingPerms.set(toolCall.toolCallId, list);
			} else {
				st.aiBlock.appendChild(el);
			}
		};

		// 本会话记住授权 Map（插件生命周期内，重启 Obsidian 清空）
		if (!this.rememberedPerms) this.rememberedPerms = new Map<string, Set<string>>();
		if (allowAlways && this.rememberedPerms.get(toolName)?.has('allow_always')) {
			respond({ outcome: { outcome: 'selected', optionId: allowAlways.optionId } });
			this.noteAutoApprove(st, tab, toolName, '本会话记住');
			return;
		}

		// 命令前缀白名单（v0.7.0 叶部式）：命中前缀的命令自动放行
		if (allowOnce) {
			const cmd = this.extractPermPath(toolCall);
			if (cmd && this.isPrefixAllowed(cmd)) {
				respond({ outcome: { outcome: 'selected', optionId: allowOnce.optionId } });
				this.noteAutoApprove(st, tab, toolName, '前缀白名单');
				return;
			}
		}

		// 权限模式三档（v0.5.0）：🤖YOLO 全自动；✨智能 只读白名单自动；🔒手动 全部逐条确认
		if (allowOnce && this.permMode === 'yolo') {
			respond({ outcome: { outcome: 'selected', optionId: allowOnce.optionId } });
			this.noteAutoApprove(st, tab, toolName, 'yolo');
			return;
		}

		if (
			allowOnce &&
			this.permMode === 'smart' &&
			READONLY_TOOLS.some((t) => toolName.toLowerCase().includes(t))
		) {
			respond({ outcome: { outcome: 'selected', optionId: allowOnce.optionId } });
			this.noteAutoApprove(st, tab, toolName, '只读白名单');
			return;
		}
		const bar = createEl('div', { cls: 'codem-chat-perm' });
		// v0.7.0（叶部式）：风险分级 + 路径显示
		const head = bar.createDiv({ cls: 'codem-chat-perm-head' });
		head.createSpan({ text: `🔒 ${toolName}` });
		// 风险分级：按工具名/类型判定（叶部 isVaultEditRequest 同理）
		const risk = this.assessPermRisk(toolName, toolCall);
		head.createSpan({ cls: `codem-chat-perm-risk is-${risk}` }).setText(
			risk === 'high' ? '高危' : risk === 'medium' ? '可写' : '只读'
		);
		// 路径显示：从 rawInput 提取文件路径或命令
		const permPath = this.extractPermPath(toolCall);
		if (permPath) bar.createDiv({ cls: 'codem-chat-perm-path' }).setText(`📁 ${permPath}`);
		// 登记为未决请求：按钮应答/看门狗超时/轮末回收统一走 settle/expire，防双重应答
		const pr: PermRequest = {
			bar,
			toolCallId: toolCall?.toolCallId,
			respond,
			timer: 0,
			answered: false,
			rejectOptionId: reject?.optionId,
			banner: null,
		};
		// 权限三档：Allow once / Allow for this session / Reject（自然语义，排开三个醒目按钮）
		if (allowOnce) {
			bar.createEl('button', { text: 'Allow once' }).onclick = () =>
				this.settlePermRequest(st, pr, { outcome: { outcome: 'selected', optionId: allowOnce.optionId } });
		}
		if (allowAlways) {
			bar.createEl('button', { text: 'Allow for this session' }).onclick = () => {
				if (!this.rememberedPerms) this.rememberedPerms = new Map();
				const s = this.rememberedPerms.get(toolName) ?? new Set();
					s.add('allow_always');
				this.rememberedPerms.set(toolName, s);
				this.settlePermRequest(st, pr, { outcome: { outcome: 'selected', optionId: allowAlways.optionId } });
			};
		}
		if (reject) {
			bar.createEl('button', { text: 'Reject' }).onclick = () =>
				this.settlePermRequest(st, pr, { outcome: { outcome: 'selected', optionId: reject.optionId } });
		}
		// 一键开启 yolo 并批准备次请求：底部 YOLO 按钮不显眼，逐条审批时最容易够到的开关
		if (allowOnce) {
			const autoAll = bar.createEl('button', { text: '🤖 后续全自动', cls: 'codem-chat-perm-yolo' });
			autoAll.onclick = () => {
				if (this.permMode !== 'yolo') this.setPermMode('yolo');
				this.settlePermRequest(st, pr, { outcome: { outcome: 'selected', optionId: allowOnce.optionId } });
			};
		}
		// v0.7.0（叶部式）：命令前缀授权记忆——「始终允许「前缀」」按钮，同前缀命令后续自动放行
		const cmdPrefix = this.extractCmdPrefix(toolCall);
		if (allowAlways && cmdPrefix) {
			const memBtn = bar.createEl('button', { text: `✓ 始终允许「${cmdPrefix}」`, cls: 'codem-chat-perm-mem' });
			memBtn.onclick = async () => {
				if (!this.plugin.settings.allowedCommandPrefixes.includes(cmdPrefix)) {
					this.plugin.settings.allowedCommandPrefixes.push(cmdPrefix);
					await this.plugin.saveSettings();
				}
				this.settlePermRequest(st, pr, { outcome: { outcome: 'selected', optionId: allowAlways.optionId } });
			};
		}
		// 审批看门狗：5 分钟无人响应自动拒绝并留痕——审批条不再永久挂死一轮（用户不在电脑前时服务端会一直等）
		st.permRequests.push(pr);
		pr.timer = window.setTimeout(
			() => this.expirePermRequest(st, pr, '（审批超时 5 分钟，已自动拒绝）'),
			PERM_WATCHDOG_MS
		);
		park(bar);
		// 审批等待横幅（v0.5.0 UI 对标叶版）：消息区顶部常驻提示，滚到任何位置/切走 Tab 都看得见
		pr.banner = tab.scrollEl.createDiv({ cls: 'codem-chat-perm-banner' });
		pr.banner.setText(`⏸ 等待你批准：${toolName}`);
		tab.scrollEl.insertBefore(pr.banner, tab.scrollEl.firstChild);
		// 权限条落在发起 tab 的时间线里：当前正看别的 tab 时给导航提示，否则用户不知道要去哪确认
		if (tab !== this.activeTab) {
			new Notice(`🔒 会话 ${this.tabs.indexOf(tab) + 1} 请求权限确认，请切换到该窗口`);
		}
		this.scrollBottom(tab.scrollEl);
	}

	/** v0.7.0（叶部式）：风险分级——bash/shell=high，edit/write/patch=medium，其余=low */
	private assessPermRisk(toolName: string, toolCall?: { rawInput?: unknown }): 'high' | 'medium' | 'low' {
		const t = toolName.toLowerCase();
		if (/(bash|shell|cmd|exec|delete|remove|run_command|process)/i.test(t)) return 'high';
		if (/(edit|write|patch|multi_edit|create|move|copy)/i.test(t)) return 'medium';
		return 'low';
	}

	/** v0.7.0（叶部式）：从 rawInput 提取路径（filePath/command/target），供审批条显示 */
	private extractPermPath(toolCall?: { rawInput?: unknown }): string {
		if (!toolCall?.rawInput || typeof toolCall.rawInput !== 'object') return '';
		const raw = toolCall.rawInput as Record<string, unknown>;
		return (
			(typeof raw.filePath === 'string' && raw.filePath) ||
			(typeof raw.command === 'string' && raw.command.split(' ').slice(0, 3).join(' ')) ||
			(typeof raw.target === 'string' && raw.target) ||
			''
		);
	}

	/** v0.7.0（叶部式）：从 rawInput 提取命令前两词作「命令前缀」（如 npm install） */
	private extractCmdPrefix(toolCall?: { rawInput?: unknown }): string {
		if (!toolCall?.rawInput || typeof toolCall.rawInput !== 'object') return '';
		const raw = toolCall.rawInput as Record<string, unknown>;
		if (typeof raw.command !== 'string' || !raw.command) return '';
		const words = raw.command.trim().split(/\s+/);
		return words.slice(0, Math.min(2, words.length)).join(' ');
	}

	/** v0.7.0（叶部式）：检查命令是否命中已记住的前缀白名单 */
	private isPrefixAllowed(cmd: string): boolean {
		const prefixes = this.plugin.settings.allowedCommandPrefixes ?? [];
		return prefixes.some((p) => {
			const t = p.trim();
			return t && (cmd === t || cmd.startsWith(t + ' '));
		});
	}

	/** 防僵尸复活辅助：已点击的按钮从 pendingPerms 摘除 + 打 dataset 标记 */
	private prunePending(st: RenderState, toolCallId: string | undefined, bar: HTMLElement): void {
		bar.dataset.answered = '1';
		if (toolCallId) {
			const list = st.pendingPerms.get(toolCallId);
			if (list) {
				const idx = list.indexOf(bar);
				if (idx >= 0) list.splice(idx, 1);
				if (!list.length) st.pendingPerms.delete(toolCallId);
			}
		}
	}

	/** 权限应答统一出口（用户点击按钮）：防双重应答、清看门狗、摘暂存、移除条目 */
	private settlePermRequest(st: RenderState, pr: PermRequest, result: unknown): void {
		if (pr.answered) return;
		pr.answered = true;
		window.clearTimeout(pr.timer);
		const idx = st.permRequests.indexOf(pr);
		if (idx >= 0) st.permRequests.splice(idx, 1);
		this.prunePending(st, pr.toolCallId, pr.bar);
		pr.respond(result);
		pr.bar.remove();
		pr.banner?.remove();
	}

	/** 看门狗超时/轮末回收：自动回拒绝应答（无 reject 选项则 cancelled），条目留痕不静默消失 */
	private expirePermRequest(st: RenderState, pr: PermRequest, note: string): void {
		if (pr.answered) return;
		pr.answered = true;
		window.clearTimeout(pr.timer);
		const idx = st.permRequests.indexOf(pr);
		if (idx >= 0) st.permRequests.splice(idx, 1);
		this.prunePending(st, pr.toolCallId, pr.bar);
		pr.respond(
			pr.rejectOptionId
				? { outcome: { outcome: 'selected', optionId: pr.rejectOptionId } }
				: { outcome: { outcome: 'cancelled' } }
		);
		pr.banner?.remove();
		pr.bar.addClass('codem-chat-perm-expired');
		pr.bar.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
		pr.bar.createSpan({ text: note, cls: 'codem-chat-perm-expired-note' });
	}

	/** 批量回收全部未决审批（停止/轮末/看门狗强制收尾时） */
	private recyclePerms(st: RenderState, note: string): void {
		for (const pr of [...st.permRequests]) this.expirePermRequest(st, pr, note);
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

	/** 输入内容实时过滤历史会话（按 AI 标题/首问子串）+ 归档过滤 + 4 种排序（v0.8.0 叶部式） */
	private filterHistory(): void {
		const q = this.inputEl.value.trim().toLowerCase();
		const archived = new Set(this.plugin.settings.archivedSessions ?? []);
		const showArchived = this.plugin.settings.showArchivedSessions ?? false;
		let items = this.allCards.filter((c) => {
			if (!showArchived && archived.has(c.sessionId)) return false;
			if (q && !this.sessionTitle(c).toLowerCase().includes(q)) return false;
			return true;
		});
		// 排序
		const sort = this.plugin.settings.sessionSort ?? 'recent';
		const t = (c: SessionCard): number => new Date(c.lastTime).getTime();
		switch (sort) {
			case 'oldest': items = [...items].sort((a, b) => t(a) - t(b)); break;
			case 'turns': items = [...items].sort((a, b) => b.userTurns - a.userTurns); break;
			case 'title': items = [...items].sort((a, b) => this.sessionTitle(a).localeCompare(this.sessionTitle(b))); break;
			default: items = [...items].sort((a, b) => t(b) - t(a)); break; // recent
		}
		this.histItems = items;
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
		// v0.8.0 工具条：排序 + 分组 + 显示已归档（三个区域独立，改排序/分组时搜索框不失焦）
		const toolbar = this.histEl.createDiv({ cls: 'codem-chat-hist-toolbar' });
		// 排序循环按钮
		const sortLabels: Record<string, string> = { recent: '最近', oldest: '最早', turns: '轮数', title: '标题' };
		const sortBtn = toolbar.createEl('button', {
			cls: 'codem-chat-hist-toolbtn',
			text: `排序：${sortLabels[this.plugin.settings.sessionSort ?? 'recent']}`,
		});
		sortBtn.onclick = () => {
			const order: Array<'recent' | 'oldest' | 'turns' | 'title'> = ['recent', 'oldest', 'turns', 'title'];
			const cur = order.indexOf(this.plugin.settings.sessionSort ?? 'recent');
			this.plugin.settings.sessionSort = order[(cur + 1) % order.length];
			this.filterHistory();
		};
		// 分组开关
		const groupBtn = toolbar.createEl('button', {
			cls: 'codem-chat-hist-toolbtn' + (this.plugin.settings.sessionGroup ? ' is-on' : ''),
			text: this.plugin.settings.sessionGroup ? '☑ 分组' : '☐ 分组',
		});
		groupBtn.onclick = () => {
			this.plugin.settings.sessionGroup = !this.plugin.settings.sessionGroup;
			this.renderHistoryPanel();
		};
		// 显示已归档开关
		const archBtn = toolbar.createEl('button', {
			cls: 'codem-chat-hist-toolbtn' + (this.plugin.settings.showArchivedSessions ? ' is-on' : ''),
			text: this.plugin.settings.showArchivedSessions ? '☑ 归档' : '☐ 归档',
		});
		archBtn.onclick = () => {
			this.plugin.settings.showArchivedSessions = !this.plugin.settings.showArchivedSessions;
			this.filterHistory();
		};
		// 列表（分组 / 平铺）
		const list = this.histEl.createDiv({ cls: 'codem-chat-hist-list' });
		const archived = new Set(this.plugin.settings.archivedSessions ?? []);
		const groupEnabled = this.plugin.settings.sessionGroup ?? true;
		this.histIndex = Math.min(this.histIndex, this.histItems.length - 1);
		// 分组渲染：按 lastTime 分桶（今天/昨天/本周/更早）
		if (groupEnabled) {
			const now = new Date();
			const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
			const yesterdayStart = todayStart - 86400000;
			const weekStart = todayStart - 7 * 86400000;
			const groups: Array<{ label: string; items: typeof this.histItems }> = [
				{ label: '今天', items: [] },
				{ label: '昨天', items: [] },
				{ label: '本周', items: [] },
				{ label: '更早', items: [] },
			];
			for (const c of this.histItems) {
				const ts = new Date(c.lastTime).getTime();
				if (ts >= todayStart) groups[0].items.push(c);
				else if (ts >= yesterdayStart) groups[1].items.push(c);
				else if (ts >= weekStart) groups[2].items.push(c);
				else groups[3].items.push(c);
			}
			for (const g of groups) {
				if (!g.items.length) continue;
				list.createDiv({ cls: 'codem-chat-hist-group', text: g.label });
				this.renderHistRows(list, g.items, archived);
			}
		} else {
			this.renderHistRows(list, this.histItems, archived);
		}
		const active = this.histEl.querySelector('.codem-suggest-item.is-active');
		active?.scrollIntoView({ block: 'nearest' });
	}

	/** 渲染历史会话行（含归档按钮），供分组/平铺两种模式复用 */
	private renderHistRows(list: HTMLElement, items: SessionCard[], archived: Set<string>): void {
		items.forEach((c) => {
			const i = this.histItems.indexOf(c);
			const src = c.source === 'bot' ? '飞书' : c.source === 'tui' ? '终端' : 'CLI';
			const turnTxt = c.userTurns > 0 ? ` · ${c.userTurns}问` : '';
			const row = list.createDiv({ cls: 'codem-suggest-item' + (i === this.histIndex ? ' is-active' : '') });
			row.createSpan({ cls: 'codem-suggest-label', text: `${formatTime(c.lastTime)} · ${src}${turnTxt}` });
			row.createSpan({ cls: 'codem-suggest-desc', text: this.sessionTitle(c) });
			// v0.8.0 归档/恢复按钮：📦 归档 / ↩ 恢复
			const archBtn = row.createEl('button', {
				cls: 'codem-chat-hist-archbtn',
				text: archived.has(c.sessionId) ? '↩' : '📦',
			});
			archBtn.setAttribute('aria-label', archived.has(c.sessionId) ? '取消归档' : '归档此会话');
			archBtn.onclick = async (e) => {
				e.stopPropagation();
				const idx = this.plugin.settings.archivedSessions.indexOf(c.sessionId);
				if (idx >= 0) {
					this.plugin.settings.archivedSessions.splice(idx, 1); // 取消归档
				} else {
					this.plugin.settings.archivedSessions.push(c.sessionId); // 归档
				}
				await this.plugin.saveSettings();
				this.filterHistory();
			};
			row.addEventListener('mousedown', (e) => e.preventDefault());
			row.addEventListener('mouseenter', () => {
				if (this.histIndex === i) return;
				this.histIndex = i;
				this.histEl?.querySelectorAll('.codem-suggest-item.is-active').forEach((el) => el.removeClass('is-active'));
				row.addClass('is-active');
				row.scrollIntoView({ block: 'nearest' });
			});
			row.addEventListener('click', () => {
				this.closeHistory();
				void this.loadHistory(c);
			});
		});
	}

	private closeHistory(): void {
		this.histOpen = false;
		if (this.histEl) this.histEl.hide();
	}

	/** 载入历史会话：jsonl 回显 + ACP session/load 原生续接；失败自动转软续接（快照上下文） */
	private async loadHistory(card: SessionCard): Promise<void> {
		// 会话唯一持有：目标会话已在其他 tab 打开 → 直接切换过去，禁止双开。
		// 双开会使两个 tab 持有同一 sessionId：update/permission 按 find 首个匹配路由到旧 tab，
		// 表现为新窗口内容串台、权限请求找不到渲染状态被默认取消；busy 会话还会被 closeSession 误杀
		const holder = this.tabs.find((t) => t !== this.activeTab && t.sessionId === card.sessionId);
		if (holder) {
			new Notice('该会话已在另一个窗口打开，已为你切换过去');
			this.switchTab(holder);
			return;
		}
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
				this.updateSidEl();
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
			// v1.0.4：tool_result 并入前一个 tool_use 卡片——结果跟卡片走（叶部/Claudian 同构），
			// 消灭游离的裸奔「工具结果」行；跨用户消息不配对，配不上保留原样兜底
			const merged: Turn[] = [];
			for (const t of turns) {
			 const isResult = t.role === 'tool' && t.blocks.length === 1 && t.blocks[0].kind === 'tool_result';
			 if (isResult && merged.length) {
			  let attached = false;
			  for (let k = merged.length - 1; k >= 0; k--) {
			   if (merged[k].role === 'user') break; // 不跨用户消息配对
			   const tu = [...merged[k].blocks].reverse().find((b) => b.kind === 'tool_use');
			   if (tu) {
			    tu.content += '\n——— 结果 ———\n' + t.blocks[0].content;
			    attached = true;
			    break;
			   }
			  }
			  if (attached) continue;
			 }
			 merged.push(t);
			}
			for (const t of merged) this.renderHistoryTurn(t);
			if (!turns.length) this.renderEmpty();
			const head = this.msgContainer.createDiv({ cls: 'codem-chat-history-head' });
			const src = card.source === 'bot' ? '飞书' : card.source === 'tui' ? '终端' : 'CLI';
			head.setText(
				`📜 ${this.sessionTitle(card).slice(0, 40)}（${src} · ${card.userTurns} 问）` +
					(this.sessionId ? ' · 已续接，可直接继续提问' : ' · 快照续聊：历史将随下一条消息附带')
			);
			this.msgContainer.scrollTop = this.msgContainer.scrollHeight;
		} finally {
			this.busy = false;
			// busy 复位后再同步状态灯/输入框提示：setStatusLight 内部的 syncStopUi 读 busy，
			// 放在 try 内会让 placeholder 写成"执行中"后不再刷新（打开历史会话后输入框卡"执行中"）
			this.setStatusLight('idle');
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

	/** v1.0.2 P0：历史会话渲染——DOM 对齐叶部 CSS（与实时对话 handleToolEvent 同构） */
		private renderHistoryTurn(t: Turn): void {
			if (t.role === 'user') {
			// jsonl 记录的是完整 prompt（含注入全文/快照/图片 base64），回显前清洗为提问本身
			const userBlock = this.renderUserMessage(this.cleanPromptForDisplay(t.blocks.map((b) => b.content).join('\n\n')), []);
		this.addTurnAnchor(userBlock);
			} else if (t.role === 'assistant') {
			const aiBlock = this.msgContainer.createDiv({ cls: 'codem-chat-msg codem-chat-assistant' });
			const thinks = t.blocks.filter((b) => b.kind === 'thinking');
				if (thinks.length) {
				const d = aiBlock.createEl('details', { cls: 'codem-chat-thinking is-done' });
				d.createEl('summary', { text: '思考过程' });
			d.createDiv({ cls: 'codem-chat-thinking-body' }).setText(thinks.map((b) => b.content).join('\n\n'));
			}
				for (const b of t.blocks) {
					if (b.kind === 'text') {
					const segEl = aiBlock.createDiv({ cls: 'codem-chat-text markdown-rendered' });
					// 超长段折叠（长会话载入一次性全渲染同样会卡）
						if (b.content.length > SEG_COLLAPSE_LIMIT) {
						const det = segEl.createEl('details', { cls: 'codem-chat-seg-fold' });
						det.createEl('summary', { text: `📄 长内容（约 ${b.content.length} 字）已折叠，点击展开` });
					det.appendChild(renderMarkdown(b.content));
						} else {
					segEl.appendChild(renderMarkdown(b.content));
					}
				this.decorateCodeBlocks(segEl);
				// v1.0.5：历史会话文本段复制按钮（与实时对话一致，hover 显示）
				const hCopy = segEl.createEl('button', { cls: 'codem-chat-copy-btn' });
				setIcon(hCopy, 'copy');
				hCopy.setAttribute('aria-label', '复制此段');
				hCopy.onclick = (e) => {
					e.stopPropagation();
					void navigator.clipboard.writeText(b.content).then(() => {
						setIcon(hCopy, 'check');
						window.setTimeout(() => setIcon(hCopy, 'copy'), 1500);
					});
				};
			}
			}
			// v1.0.2：工具卡 DOM 对齐叶部——每张工具卡独立 details.is-*，同实时对话
				for (const b of t.blocks) {
				if (b.kind !== 'tool_use') continue;
				const label = b.label ?? '工具';
					const cat = toolCategory(label);
					const details = aiBlock.createEl('details', { cls: `codem-chat-tool is-${cat}` });
					const summary = details.createEl('summary');
				summary.createSpan({ cls: 'codem-chat-tool-name', text: label });
				 const statusEl = summary.createSpan({ cls: 'codem-chat-tool-status' });
				 statusEl.setAttribute('data-status', 'completed');
				 statusEl.setText('✓');
				const content = details.createDiv({ cls: 'codem-chat-tool-content' });
			if (b.content) {
		content.createEl('pre', { cls: 'codem-chat-tool-result' }).setText(
			b.content.length > TOOL_RESULT_MAX_LEN
			? b.content.slice(0, TOOL_RESULT_MAX_LEN) + `…（截断，共 ${b.content.length} 字符）`
				: b.content
				);
			}
		}
	} else {
		// v1.0.2 修复：独立工具条目分两种——tool_call 产生的 tool_use 用叶部 is-{cat} 卡片（与实时对话一致），
		// tool_result 产生的结果块用 fold；此前统一走 toolitem-standalone 导致 run_bash 裸奔
		for (const b of t.blocks) {
			if (b.kind === 'tool_use') {
				const label = b.label ?? '工具';
				const cat = toolCategory(label);
				const details = this.msgContainer.createEl('details', { cls: `codem-chat-tool is-${cat}` });
				const summary = details.createEl('summary');
				summary.createSpan({ cls: 'codem-chat-tool-name', text: label });
				const statusEl = summary.createSpan({ cls: 'codem-chat-tool-status' });
				statusEl.setAttribute('data-status', 'completed');
				statusEl.setText('✓');
				const content = details.createDiv({ cls: 'codem-chat-tool-content' });
				if (b.content) {
					content.createEl('pre', { cls: 'codem-chat-tool-result' }).setText(
						b.content.length > TOOL_RESULT_MAX_LEN
							? b.content.slice(0, TOOL_RESULT_MAX_LEN) + `…（截断，共 ${b.content.length} 字符）`
							: b.content
					);
				}
			} else {
				const d = this.msgContainer.createEl('details', { cls: 'codem-chat-toolitem-standalone' });
				d.createEl('summary', { text: b.label ?? '工具结果' });
				d.createEl('pre', { cls: 'codem-chat-tool-result' }).setText(b.content);
			}
		}
	}
	}

	/** 节流滚底：rAF 合并同帧多次调用；用户上翻（距底 >160px）时不抢滚动，保留阅读位置。
	 *  原实现每次调用同步读写 scrollTop/scrollHeight，流式期间每 tick 一次强制布局（layout thrash） */
	private scrollRaf = 0;
	private scrollBottom(el?: HTMLElement): void {
		const t = el ?? this.msgContainer;
		if (this.scrollRaf) return;
		this.scrollRaf = window.requestAnimationFrame(() => {
			this.scrollRaf = 0;
			if (t.scrollHeight - t.scrollTop - t.clientHeight > 160) return;
			t.scrollTop = t.scrollHeight;
		});
	}

	/** 强制立即滚底（发送/载入等关键节点，不受用户上翻限制） */
	private forceScrollBottom(el?: HTMLElement): void {
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

	// ===== v0.7.0（叶部式）：会话持久化 getState/setState —— 重启 Obsidian 后恢复 tab 结构 =====

	/** 序列化当前视图状态：各 tab 的会话 id/标题/pin/标签，重启后据此重建 */
	getState(): Record<string, unknown> {
		const tabs = this.tabs.map((t) => ({
			sessionId: t.sessionId,
			pinned: t.pinned,
			label: t.label,
			turnCount: t.turnCount,
		}));
		return { codemChatTabs: tabs, activeIdx: this.tabs.indexOf(this.activeTab) };
	}

	/** 恢复视图状态：重建 tab 槽位并标记待恢复会话（内容在下次 ensureClient 后 load 回来） */
	async setState(state: unknown, result: unknown): Promise<void> {
		const s = state as Record<string, unknown>;
		const tabs = s.codemChatTabs as Array<{ sessionId: string | null; pinned?: boolean; label?: string | null; turnCount?: number }> | undefined;
		if (!Array.isArray(tabs) || !tabs.length) return;
		try {
			// 清掉默认 tab，按快照重建
			for (const t of this.tabs) t.scrollEl.remove();
			this.tabs = [];
			for (const t of tabs.slice(0, this.plugin.settings.maxWindows || 3)) {
				const tab = this.createTab();
				tab.sessionId = t.sessionId ?? null;
				tab.pinned = !!t.pinned;
				tab.label = t.label ?? null;
				tab.turnCount = t.turnCount ?? 0;
			}
			if (!this.tabs.length) this.createTab();
			const activeIdx = typeof s.activeIdx === 'number' ? s.activeIdx : 0;
			this.activeTab = this.tabs[Math.min(Math.max(0, activeIdx), this.tabs.length - 1)];
			for (const t of this.tabs) t.scrollEl.toggleClass('codem-is-hidden', t !== this.activeTab);
			this.renderTabs();
			this.renderEmpty();
			this.setStatusLight(this.activeTab.light);
			this.updateSidEl();
			// 会话内容用既有历史载入机制拉回（软续接兑底，原生 load 失败也不丢）
			for (const t of this.tabs) {
				if (t.sessionId) void this.restoreTabSession(t);
			}
		} catch {
			// 恢复失败：保持默认空 tab，不影响使用
		}
	}

	/** 恢复单个 tab 的会话：优先原生 load，失败转软续接快照（复用 loadHistory 机制的数据层） */
	private async restoreTabSession(tab: ChatTab): Promise<void> {
		try {
			const client = await this.ensureClient();
			await client.loadSession(tab.sessionId!);
			// load 成功：重放通知因 tab.current 为空被忽略，不污染时间线
		} catch {
			// 被占用/不可载入：留 sessionId，下次发送时会自动新建会话并带软续接
		}
	}
}
