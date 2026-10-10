import { App, FuzzySuggestModal, TFile } from 'obsidian';
import type { SessionCard, SkillInfo } from './codem-sessions';

/** 格式化 ISO 时间 → MM-DD HH:mm */
export function formatTime(iso: string): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso.slice(5, 16);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** / 技能选择弹窗 */
export class SkillPickerModal extends FuzzySuggestModal<SkillInfo> {
	private items: SkillInfo[] = [];

	constructor(
		app: App,
		skills: SkillInfo[],
		private onPick: (s: SkillInfo) => void
	) {
		super(app);
		this.items = skills;
		this.setPlaceholder('选择技能（Enter 插入，Esc 取消）');
	}

	getItems(): SkillInfo[] {
		return this.items;
	}

	getItemText(s: SkillInfo): string {
		return s.description ? `${s.name} — ${s.description}` : s.name;
	}

	onChooseItem(s: SkillInfo): void {
		this.onPick(s);
	}
}

/** @ 文件引用弹窗 */
export class FilePickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private onPick: (f: TFile) => void
	) {
		super(app);
		this.setPlaceholder('引用文件（选中后以 [[路径]] 插入，发送时注入笔记内容）');
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => !f.path.startsWith('.obsidian'));
	}

	getItemText(f: TFile): string {
		return f.path;
	}

	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}

/** 历史会话选择弹窗 */
export class SessionPickerModal extends FuzzySuggestModal<SessionCard> {
	constructor(
		app: App,
		cards: SessionCard[],
		private onPick: (c: SessionCard) => void
	) {
		super(app);
		this.setPlaceholder('搜索历史会话（首问关键词），Enter 续接并回显');
		this.items = cards;
	}

	private items: SessionCard[] = [];

	getItems(): SessionCard[] {
		return this.items;
	}

	getItemText(c: SessionCard): string {
		const src = c.source === 'bot' ? '飞书' : c.source === 'tui' ? '终端' : 'CLI';
		return `${formatTime(c.lastTime)} · ${src} · ${c.userTurns}问 · ${c.firstPrompt}`;
	}

	onChooseItem(c: SessionCard): void {
		this.onPick(c);
	}
}
