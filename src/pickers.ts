import { App, FuzzySuggestModal } from 'obsidian';
import type { SessionCard } from './codem-sessions';

/** 格式化 ISO 时间 → MM-DD HH:mm */
export function formatTime(iso: string): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (isNaN(d.getTime())) return iso.slice(5, 16);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 历史会话选择弹窗（/ 与 @ 已改为输入框内联候选，不走弹窗） */
export class SessionPickerModal extends FuzzySuggestModal<SessionCard> {
	private items: SessionCard[] = [];

	constructor(
		app: App,
		cards: SessionCard[],
		private onPick: (c: SessionCard) => void
	) {
		super(app);
		this.items = cards;
		this.setPlaceholder('搜索历史会话（首问关键词），Enter 续接并回显');
	}

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
