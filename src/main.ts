import { Plugin, WorkspaceLeaf } from 'obsidian';
import { CodeMChatView, VIEW_TYPE_CODEM_CHAT } from './view';
import { CodeMSettingTab, CodeMSettings, DEFAULT_SETTINGS } from './settings';

export default class CodeMChatPlugin extends Plugin {
	settings: CodeMSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_CODEM_CHAT, (leaf: WorkspaceLeaf) => new CodeMChatView(leaf, this));

		this.addRibbonIcon('message-square', '打开 CodeM 聊天框', () => void this.activateView());

		this.addCommand({
			id: 'open-chat',
			name: '打开 CodeM 聊天框',
			callback: () => void this.activateView(),
		});

		this.addSettingTab(new CodeMSettingTab(this.app, this));
	}

	onunload(): void {}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_CODEM_CHAT);
		let leaf: WorkspaceLeaf;
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = workspace.getRightLeaf(false)!;
			await leaf.setViewState({ type: VIEW_TYPE_CODEM_CHAT, active: true });
		}
		void workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
