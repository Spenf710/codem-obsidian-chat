import { App, Modal } from 'obsidian';
import type { SessionSummary } from './codem-client';

/** 历史会话选择弹窗：时间 + 消息数 + 首句摘要，点击切换 */
export class SessionListModal extends Modal {
	constructor(
		app: App,
		private sessions: SessionSummary[],
		private onPick: (s: SessionSummary) => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('历史会话（当前 Vault）');
		const { contentEl } = this;
		contentEl.addClass('codem-session-modal');
		if (this.sessions.length === 0) {
			contentEl.createDiv({
				cls: 'codem-session-empty',
				text: '当前 Vault 下暂无本地会话记录（云端执行的对话不落本地）',
			});
			return;
		}
		for (const s of this.sessions) {
			const item = contentEl.createDiv({ cls: 'codem-session-item' });
			item.createDiv({
				cls: 'codem-session-title',
				text: s.firstUserMessage || '(无文本消息)',
			});
			item.createDiv({
				cls: 'codem-session-meta',
				text: `${formatTime(s.updatedAt)} · ${s.messageCount} 条消息`,
			});
			item.onclick = () => {
				this.close();
				this.onPick(s);
			};
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function formatTime(iso: string): string {
	if (!iso) return '未知时间';
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
