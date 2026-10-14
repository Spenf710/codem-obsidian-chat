import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type CodeMChatPlugin from './main';
import { expandPath } from './acp-client';
import {
	checkEnvironment,
	installCodem,
	probeCodemCli,
	toTildePath,
	CODEM_INSTALL_CMD,
	abbreviateHome,
	type EnvStatus,
} from './diagnostics';

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
	/** AI 生成的会话标题（sessionId → 标题），优先于历史列表里的首问显示 */
	sessionTitles: Record<string, string>;
}

export const DEFAULT_SETTINGS: CodeMSettings = {
	codemCliPath: '~/.codem/bin/codem.cmd',
	nodePath: '',
	timeoutMs: 300000,
	extraArgs: '',
	maxWindows: 3,
	sessionTitles: {},
};

export class CodeMSettingTab extends PluginSettingTab {
	plugin: CodeMChatPlugin;
	private envStatus: EnvStatus | null = null;
	private installing = false;

	constructor(app: App, plugin: CodeMChatPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// —— CodeM 环境（自检 + 一键安装）——
		const envSetting = new Setting(containerEl).setName('CodeM 环境');
		this.refreshEnv(envSetting);

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
			.setDesc('单次后台轻量调用的最长等待时间')
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

	/** 环境自检并刷新「CodeM 环境」区块（重建该行按钮） */
	private async refreshEnv(envSetting: Setting): Promise<void> {
		if (this.installing) return;
		this.clearEnvButtons(envSetting);
		envSetting.setDesc('正在检查 CodeM 安装状态…');
		const status = await checkEnvironment(this.plugin.settings.codemCliPath, this.plugin.settings.nodePath);
		this.envStatus = status;

		if (status.state === 'ready') {
			envSetting.setDesc(`已就绪（版本 ${status.version}）· ${abbreviateHome(status.cliPath)}`);
			envSetting.addButton((btn) =>
				btn.setButtonText('重新检查').onClick(() => void this.refreshEnv(envSetting))
			);
			return;
		}

		if (status.state === 'no-node') {
			envSetting.setDesc(
				'已找到 CodeM，但缺少 Node.js 运行环境。请到 nodejs.org 安装 Node.js（LTS 版）后重启 Obsidian，或在下方填写「Node.js 目录」。'
			);
			envSetting.addButton((btn) =>
				btn.setButtonText('重新检查').onClick(() => void this.refreshEnv(envSetting))
			);
			return;
		}

		// missing：先尝试自动定位（常见安装位置扫描），命中即自动填入并复检
		const found = probeCodemCli();
		if (found && found !== expandPath(this.plugin.settings.codemCliPath)) {
			this.plugin.settings.codemCliPath = toTildePath(found);
			await this.plugin.saveSettings();
			new Notice(`已自动定位 CodeM：${abbreviateHome(found)}`, 6000);
			return this.refreshEnv(envSetting); // 复检（不会无限递归：定位成功后状态必然变化）
		}

		// 仍未找到：一键安装 + 手动命令提示
		envSetting.setDesc('尚未检测到 CodeM。点击「安装 CodeM」自动完成安装（需联网，约 1-3 分钟）。');
		envSetting.addButton((btn) =>
			btn
				.setButtonText('安装 CodeM')
				.setCta()
				.onClick(() => void this.startInstall(envSetting))
		);
		envSetting.addButton((btn) =>
			btn.setButtonText('重新检查').onClick(() => void this.refreshEnv(envSetting))
		);
	}

	/** 一键安装：官方 install.ps1，输出实时回显；结束后自检刷新并通知聊天视图 */
	private startInstall(envSetting: Setting): void {
		if (this.installing) return;
		this.installing = true;
		this.clearEnvButtons(envSetting);
		new Notice('开始安装 CodeM（约 1-3 分钟），请保持网络畅通…', 8000);
		envSetting.setDesc('正在安装 CodeM…');

		this.installCodemWithProgress(envSetting, (ok, code) => {
			this.installing = false;
			if (ok) {
				new Notice('CodeM 安装完成！现在可以在聊天框中直接使用了。', 10000);
				void this.refreshEnv(envSetting);
				// 已打开的聊天视图同步刷新空状态引导
				const leaf = this.app.workspace.getLeavesOfType('codem-chat-view')[0];
				const view = leaf?.view as { refreshEnvironment?: () => void } | undefined;
				view?.refreshEnvironment?.();
			} else {
				envSetting.setDesc(
					`安装未完成（退出码 ${code}）。请检查网络后在下方重试；或手动在 PowerShell 执行：${CODEM_INSTALL_CMD}`
				);
				envSetting.addButton((btn) =>
					btn
						.setButtonText('重试安装')
						.setCta()
						.onClick(() => this.startInstall(envSetting))
				);
				envSetting.addButton((btn) =>
					btn.setButtonText('我已手动安装，重新检查').onClick(() => void this.refreshEnv(envSetting))
				);
				new Notice('CodeM 安装失败，可在设置页重试或按提示手动安装。', 10000);
			}
		});
	}

	private installCodemWithProgress(envSetting: Setting, onDone: (ok: boolean, code: number) => void): void {
		const stop = installCodem((p) => {
			if (!p.done) {
				if (p.line) envSetting.setDesc(`正在安装 CodeM… ${p.line.slice(0, 80)}`);
				return;
			}
			onDone(p.code === 0, p.code ?? -1);
		});
		// 安装期间离开设置页：Setting 引用随 DOM 释放，进度回调写入已分离节点不报错，结果照常经 Notice 提示
		void stop;
	}

	private clearEnvButtons(envSetting: Setting): void {
		envSetting.controlEl.querySelectorAll('button').forEach((b) => b.remove());
	}
}
