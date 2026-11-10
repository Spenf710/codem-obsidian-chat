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
	checkDoubaoEnvironment,
	installDoubaoCli,
	DOUBAO_INSTALL_CMD,
	type EnvStatus,
	type DoubaoEnvStatus,
} from './diagnostics';
import type { DoubaoSessionMeta } from './codem-sessions';

export interface CodeMSettings {
	/** 对话后端：codem（ACP 长驻双向流）/ doubao（每轮 -p 单次调用）/ claude（stream-json 流式，CC 集成） */
	backend: 'codem' | 'doubao' | 'claude';
	/** codem.cmd 完整路径，~ 自动展开为用户目录 */
	codemCliPath: string;
	/** doubao.exe 完整路径，空 = 默认位置探测（S2 新增） */
	doubaoCliPath: string;
	/** 豆包会话本地索引（S3：云端会话不落盘，历史面板数据源；key = 云端会话真 ID） */
	doubaoSessions: Record<string, DoubaoSessionMeta>;
	/** Claude CLI 路径（claude.cmd 或原生 exe），空 = 默认探测（CC 集成） */
	claudeCliPath: string;
	/** Claude 会话本地索引（CC 集成；key = CLI 会话真 ID，历史面板数据源） */
	claudeSessions: Record<string, DoubaoSessionMeta>;
	/** Node.js 所在目录（codem.cmd 需要）；留空自动探测 */
	nodePath: string;
	/** 无头模式单次调用超时（毫秒） */
	timeoutMs: number;
	/** 额外 CLI 参数（空格分隔，如模型指定） */
	extraArgs: string;
	/** 多窗口模式：同时打开的聊天窗口上限 */
	maxWindows: number;
	/** 只读工具白名单自动批准（read_files/grep/glob/skill 等免逐条弹窗） */
	readonlyAutoApprove: boolean;
	/** AI 生成的会话标题（sessionId → 标题），优先于历史列表里的首问显示 */
	sessionTitles: Record<string, string>;
	/** 上下文窗口 token 数（用于 ctx-meter 用量估算） */
	contextWindowTokens: number;
	/** 已记住的命令前缀白名单（如 "npm install"），同前缀命令自动放行 */
	allowedCommandPrefixes: string[];
	/** v0.8.0（叶部式）：已归档的会话 ID 列表，历史面板默认隐去 */
	archivedSessions: string[];
	/** v0.8.0：历史会话排序方式 */
	sessionSort: 'recent' | 'oldest' | 'turns' | 'title';
	/** v0.8.0：历史会话是否按时间分组（今天/昨天/本周/更早） */
	sessionGroup: boolean;
	/** v0.8.0：历史会话是否显示已归档 */
	showArchivedSessions: boolean;
}

export const DEFAULT_SETTINGS: CodeMSettings = {
	backend: 'codem',
	codemCliPath: '~/.codem/bin/codem.cmd',
	doubaoCliPath: '',
	doubaoSessions: {},
	claudeCliPath: '',
	claudeSessions: {},
	nodePath: '',
	timeoutMs: 300000,
	extraArgs: '',
	maxWindows: 3,
	readonlyAutoApprove: true,
	sessionTitles: {},
	contextWindowTokens: 200000,
	allowedCommandPrefixes: [],
	archivedSessions: [],
	sessionSort: 'recent',
	sessionGroup: true,
	showArchivedSessions: false,
};

export class CodeMSettingTab extends PluginSettingTab {
	plugin: CodeMChatPlugin;
	private envStatus: EnvStatus | null = null;
	private installing = false;
	private doubaoInstalling = false;
	private doubaoEnvStatus: DoubaoEnvStatus | null = null;

	constructor(app: App, plugin: CodeMChatPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// —— 对话后端（豆包集成 S2 / CC 集成）：切换立即生效 ——
		new Setting(containerEl)
			.setName('对话后端')
			.setDesc('CodeM（ACP 流式）/ 豆包 CLI / Claude Code（stream-json）；切换立即生效（聊天框底部也有快捷切换 chip）')
			.addDropdown((dd) =>
				dd
					.addOption('codem', 'CodeM（ACP）')
					.addOption('doubao', '豆包 CLI')
					.addOption('claude', 'Claude Code')
					.setValue(this.plugin.settings.backend)
					.onChange(async (v) => {
						this.plugin.settings.backend = v as 'codem' | 'doubao' | 'claude';
						await this.plugin.saveSettings();
						// 切换立即生效：通知所有打开的聊天视图杀旧后端并按新后端重渲染（无需重开窗口）
						for (const leaf of this.app.workspace.getLeavesOfType('codem-chat-view')) {
							const view = leaf.view as { switchBackend?: () => void } | undefined;
							view?.switchBackend?.();
						}
					})
		);

		new Setting(containerEl)
			.setName('豆包 CLI 路径')
			.setDesc('推荐 doubao.exe 原生路径，留空用默认位置（%LOCALAPPDATA%\\doubao_cli\\app\\current\\doubao.exe）；填 doubao.cmd 也可，将自动升级为原生 exe')
			.addText((text) =>
				text
				.setPlaceholder('留空自动探测')
				.setValue(this.plugin.settings.doubaoCliPath)
				.onChange(async (v) => {
					this.plugin.settings.doubaoCliPath = v;
					await this.plugin.saveSettings();
				})
		)

		new Setting(containerEl)
			.setName('Claude CLI 路径')
			.setDesc('claude.cmd 或原生 claude.exe，留空自动探测（与 CodeM/豆包同 node 目录）；模型路由沿用 ~/.claude/settings.json（CC-Switch 管理），本插件不传 --model')
			.addText((text) =>
				text
				.setPlaceholder('留空自动探测')
				.setValue(this.plugin.settings.claudeCliPath)
				.onChange(async (v) => {
					this.plugin.settings.claudeCliPath = v;
					await this.plugin.saveSettings();
				})
		);

		// —— 豆包环境（S4 尾巴：自检 + npm 一键安装）——
		const doubaoEnvSetting = new Setting(containerEl).setName('豆包环境');
		this.refreshDoubaoEnv(doubaoEnvSetting);

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

		new Setting(containerEl)
			.setName('初始权限模式')
			.setDesc('决定聊天框启动时的权限档位：开=✨智能（白名单只读工具自动批准），关=🔒手动；聊天框底部按钮可随时切换 🔒手动 / ✨智能 / 🤖YOLO')
			.addToggle((tg) =>
				tg.setValue(this.plugin.settings.readonlyAutoApprove).onChange(async (v) => {
					this.plugin.settings.readonlyAutoApprove = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('上下文窗口 token 数')
			.setDesc('用于底部用量环（ctx-meter）的百分比估算，不影响实际行为')
			.addText((text) =>
				text
					.setPlaceholder('200000')
					.setValue(String(this.plugin.settings.contextWindowTokens))
					.onChange(async (v) => {
						this.plugin.settings.contextWindowTokens = Number(v) || 200000;
						await this.plugin.saveSettings();
					})
			);

		// 已记住的命令前缀（叶部式：设置页逐条移除）
		const prefixes = this.plugin.settings.allowedCommandPrefixes ?? [];
		if (prefixes.length > 0) {
			const prefSection = containerEl.createEl('details');
			prefSection.createEl('summary', { text: `已记住的命令前缀（${prefixes.length} 条）` });
			const prefList = prefSection.createDiv({ cls: 'codem-chat-allowed-list' });
			for (const p of prefixes) {
				const row = prefList.createDiv({ cls: 'codem-chat-allowed-row' });
				row.createSpan({ text: p });
				const rm = row.createEl('button', { text: '✕' });
				rm.onclick = async () => {
					const idx = this.plugin.settings.allowedCommandPrefixes.indexOf(p);
					if (idx >= 0) this.plugin.settings.allowedCommandPrefixes.splice(idx, 1);
					await this.plugin.saveSettings();
					prefSection.remove();
					this.display();
				};
			}
		}
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

	/** 豆包环境自检并刷新「豆包环境」区块（S4：版本 + 登录态 + 一键安装） */
	private async refreshDoubaoEnv(envSetting: Setting): Promise<void> {
		if (this.doubaoInstalling) return;
		envSetting.controlEl.querySelectorAll('button').forEach((b) => b.remove());
		envSetting.setDesc('正在检查豆包 CLI 安装与登录状态…');
		const status = await checkDoubaoEnvironment(
			this.plugin.settings.doubaoCliPath,
			this.plugin.settings.nodePath
		);
		this.doubaoEnvStatus = status;
		envSetting.controlEl.querySelectorAll('button').forEach((b) => b.remove());
		if (status.state === 'ready') {
			envSetting.setDesc(`已就绪（版本 ${status.version}）· 已登录 · ${abbreviateHome(status.cliPath)}`);
		} else if (status.state === 'no-login') {
			envSetting.setDesc(
				`已安装（版本 ${status.version}）但未登录——在终端执行 doubao login，用豆包或飞书 App 扫码（需团队/企业订阅）`
			);
		} else if (status.state === 'no-npm') {
			envSetting.setDesc('已找到豆包 CLI，但缺少 npm（Node.js）——一键安装/升级不可用，请先安装 Node.js 18+');
		} else {
			envSetting.setDesc(
				'尚未检测到豆包 CLI。点击「安装豆包 CLI」执行官方 npm 安装（需联网，约 1-3 分钟；安装脚本会下载原生程序）'
			);
			envSetting.addButton((btn) =>
					btn.setButtonText('安装豆包 CLI').setCta().onClick(() => this.startDoubaoInstall(envSetting))
			);
		}
		envSetting.addButton((btn) =>
			btn.setButtonText('重新检查').onClick(() => void this.refreshDoubaoEnv(envSetting))
		);
	}

	/** 一键安装豆包 CLI（官方 npm 命令）：进度实时回显，结束后自检刷新并通知聊天视图重渲染空状态 */
	private startDoubaoInstall(envSetting: Setting): void {
		if (this.doubaoInstalling) return;
		this.doubaoInstalling = true;
		envSetting.controlEl.querySelectorAll('button').forEach((b) => b.remove());
		new Notice('开始安装豆包 CLI（npm 安装 + 下载原生程序），请保持网络畅通…', 8000);
		envSetting.setDesc('正在安装豆包 CLI…');
		installDoubaoCli((p) => {
			if (!p.done) {
				if (p.line) envSetting.setDesc(`正在安装豆包 CLI… ${p.line.slice(0, 80)}`);
				return;
			}
			this.doubaoInstalling = false;
			if (p.code === 0) {
				new Notice('豆包 CLI 安装完成！可在终端执行 doubao login 扫码登录后使用。', 10000);
				void this.refreshDoubaoEnv(envSetting);
				// 已打开的聊天视图同步刷新豆包空状态
				for (const leaf of this.app.workspace.getLeavesOfType('codem-chat-view')) {
					const view = leaf.view as { refreshEnvironment?: () => void } | undefined;
					view?.refreshEnvironment?.();
				}
			} else {
				envSetting.setDesc(`安装未完成（退出码 ${p.code}）。可重试；或手动执行：${DOUBAO_INSTALL_CMD}`);
				envSetting.addButton((btn) =>
					btn.setButtonText('重试安装').setCta().onClick(() => this.startDoubaoInstall(envSetting))
			);
				envSetting.addButton((btn) =>
					btn.setButtonText('我已手动安装，重新检查').onClick(() => void this.refreshDoubaoEnv(envSetting))
			);
				new Notice('豆包 CLI 安装失败，可在设置页重试或手动安装。', 10000);
			}
		});
	}

	private clearEnvButtons(envSetting: Setting): void {
		envSetting.controlEl.querySelectorAll('button').forEach((b) => b.remove());
	}
}
