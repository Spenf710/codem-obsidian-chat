import { App, PluginSettingTab, Setting } from 'obsidian';
import type CodeMChatPlugin from './main';

export interface CodeMSettings {
	/** codem.cmd 完整路径，~ 自动展开为用户目录 */
	codemCliPath: string;
	/** Node.js 所在目录（codem.cmd 需要）；留空自动探测 */
	nodePath: string;
	/** 无头模式单次调用超时（毫秒） */
	timeoutMs: number;
	/** 额外 CLI 参数（空格分隔，如模型指定） */
	extraArgs: string;
	/** 多窗口模式：同时打开的聊天窗口上限 */
	maxWindows: number;
}

export const DEFAULT_SETTINGS: CodeMSettings = {
	codemCliPath: '~/.codem/bin/codem.cmd',
	nodePath: '',
	timeoutMs: 300000,
	extraArgs: '',
	maxWindows: 3,
};

export class CodeMSettingTab extends PluginSettingTab {
	plugin: CodeMChatPlugin;

	constructor(app: App, plugin: CodeMChatPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('CodeM CLI 路径')
			.setDesc('codem.cmd 完整路径，支持 ~ 表示用户目录')
			.addText((text) =>
				text
					.setPlaceholder('~/.codem/bin/codem.cmd')
					.setValue(this.plugin.settings.codemCliPath)
					.onChange(async (v) => {
						this.plugin.settings.codemCliPath = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Node.js 目录')
			.setDesc('codem.cmd 启动器需要 PATH 里有 node；留空自动探测（进程 PATH / 常见安装位置）')
			.addText((text) =>
				text
					.setPlaceholder('C:\\Program Files\\nodejs')
					.setValue(this.plugin.settings.nodePath)
					.onChange(async (v) => {
						this.plugin.settings.nodePath = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('调用超时（毫秒）')
			.setDesc('单次无头调用的最长等待时间')
			.addText((text) =>
				text
					.setPlaceholder('300000')
					.setValue(String(this.plugin.settings.timeoutMs))
					.onChange(async (v) => {
						this.plugin.settings.timeoutMs = Number(v) || DEFAULT_SETTINGS.timeoutMs;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('额外 CLI 参数')
			.setDesc('追加到每次调用的参数，空格分隔（如 --model xxx）')
			.addText((text) =>
				text.setValue(this.plugin.settings.extraArgs).onChange(async (v) => {
					this.plugin.settings.extraArgs = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('多窗口上限')
			.setDesc('同时打开的聊天窗口数量上限；新建会话按钮超过上限将提示')
			.addText((text) =>
				text
					.setPlaceholder('3')
					.setValue(String(this.plugin.settings.maxWindows))
					.onChange(async (v) => {
						const n = Number(v);
						this.plugin.settings.maxWindows = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SETTINGS.maxWindows;
						await this.plugin.saveSettings();
					})
			);
	}
}
