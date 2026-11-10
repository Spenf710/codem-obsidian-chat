import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandPath, findNodeDir } from './acp-client';
import { defaultDoubaoExe } from './doubao-backend';

/** CodeM 官方 Windows 一键安装（PowerShell） */
export const CODEM_INSTALL_CMD =
	'irm https://codem-public.tos-cn-beijing.volces.com/codem/install.ps1 | iex';

export const CODEM_INSTALL_HINT =
	'PowerShell 执行：' + CODEM_INSTALL_CMD;

export interface EnvStatus {
	/** missing=未安装 CLI；no-node=缺 Node.js；ready=就绪 */
	state: 'missing' | 'no-node' | 'ready';
	/** CLI 完整路径或探测位置 */
	cliPath: string;
	/** ready 时的版本号（codem --version 首行） */
	version?: string;
}

/**
 * 环境自检：CLI 存在性 → Node 可用性 → 版本号。
 * 设置页「CodeM 环境」区块与聊天空状态欢迎页共用同一结论。
 */
export async function checkEnvironment(cliPath: string, nodePath?: string): Promise<EnvStatus> {
	const exe = expandPath(cliPath || path.join('~', '.codem', 'bin', 'codem.cmd'));
	if (!fs.existsSync(exe)) return { state: 'missing', cliPath: exe };
	if (!findNodeDir(nodePath)) return { state: 'no-node', cliPath: exe };
	const version = await runCodemVersion(exe, nodePath);
	return { state: 'ready', cliPath: exe, version: version ?? '未知版本' };
}

/**
 * 自动定位 CodeM CLI：按常见安装位置探测（默认目录 → npm 全局 → PATH 扫描）。
 * 命中返回绝对路径；调用方（设置页/欢迎页）在配置路径未命中时用它自动填入。
 */
export function probeCodemCli(): string | null {
	const home = os.homedir();
	const candidates = [
		path.join(home, '.codem', 'bin', 'codem.cmd'),
		path.join(home, '.codem', 'bin', 'codem.exe'),
		path.join(
			process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
			'npm',
			'codem.cmd'
		),
	];
	for (const c of candidates) {
		try {
			if (fs.existsSync(c)) return c;
		} catch {
			/* 无权限忽略 */
		}
	}
	// PATH 扫描（Obsidian 进程 PATH 可能残缺，尽力而为）
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir) continue;
		for (const name of ['codem.cmd', 'codem.exe']) {
			const p = path.join(dir, name);
			try {
				if (fs.existsSync(p)) return p;
			} catch {
				/* 无权限段忽略 */
			}
		}
	}
	return null;
}

/** 绝对路径转 ~ 形式（home 下才转换），便于设置页展示与存储一致 */
export function toTildePath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home + path.sep) ? '~' + p.slice(home.length).split(path.sep).join('/') : p;
}

/** `codem --version`（cmd /c 包装 + PATH 兜底），失败返回 null */
function runCodemVersion(exe: string, nodePath?: string): Promise<string | null> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const nodeDir = findNodeDir(nodePath);
	const sysDirs = ['C:\\Windows\\System32', 'C:\\Windows'];
	if (nodeDir) sysDirs.push(nodeDir);
	env.PATH = [...sysDirs, env.PATH ?? ''].join(path.delimiter);
	const comspec = env.ComSpec && fs.existsSync(env.ComSpec) ? env.ComSpec : 'C:\\Windows\\System32\\cmd.exe';
	return new Promise((resolve) => {
		const child = spawn(comspec, ['/c', exe, '--version'], { windowsHide: true, env });
		let out = '';
		let done = false;
		const finish = (v: string | null): void => {
			if (!done) {
				done = true;
				resolve(v);
			}
		};
		const timer = window.setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* 已退出 */
			}
			finish(null);
		}, 15000);
		child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
		child.stderr?.on('data', () => {});
		child.on('error', () => {
			window.clearTimeout(timer);
			finish(null);
		});
		child.on('close', () => {
			window.clearTimeout(timer);
			const first = out.split('\n').map((s) => s.trim()).find(Boolean) ?? null;
			finish(first);
		});
	});
}

export interface InstallProgress {
	/** 安装器输出行 */
	line: string;
	/** 进程是否已结束 */
	done: boolean;
	/** 结束时的退出码（未结束时为 null） */
	code: number | null;
}

/**
 * 一键安装 CodeM：spawn 独立 PowerShell 跑官方 install.ps1。
 * 返回 stop 函数（放弃跟踪；进程随安装自然结束）。
 */
export function installCodem(onProgress: (p: InstallProgress) => void): () => void {
	const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
	const child: ChildProcess = spawn(
		ps,
		['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', CODEM_INSTALL_CMD],
		{ windowsHide: true }
	);
	const pump = (buf: Buffer): void => {
		for (const line of buf.toString('utf8').split('\n')) {
			const t = line.trim();
			if (t) onProgress({ line: t, done: false, code: null });
		}
	};
	child.stdout?.on('data', pump);
	child.stderr?.on('data', pump);
	child.on('error', (e) => onProgress({ line: e.message, done: true, code: -1 }));
	child.on('close', (code) => onProgress({ line: '', done: true, code: code ?? -1 }));
	return () => {
		try {
			child.kill();
		} catch {
			/* 自然结束 */
		}
	};
}

export interface FriendlyError {
	/** 一句话标题（用户视角） */
	title: string;
	/** 行动建议 */
	hint: string;
}

type ErrorRule = [RegExp, string, string];

/**
 * 错误翻译层：技术报错 → 标题 + 建议。规则按高频排序，首条命中即返回。
 * 全部未命中归入兜底「操作未能完成」。原文始终保留在「查看详情」与 debug.log。
 */
const ERROR_RULES: ErrorRule[] = [
	[
		/enoent|无法将.*codem|不是内部或外部命令|is not recognized|cannot find the path.*codem|find.*codem\.cmd/i,
		'CLI 未安装或路径不对',
		'到本插件设置页检查「CodeM CLI 路径 / 豆包 CLI 路径」，或点击对应的一键安装按钮。',
	],
	[
		/node\.js not found|node is not recognized|'node' 不是内部|cannot find module node|no such file or directory.*node/i,
		'缺少 Node.js 运行环境',
		'到 nodejs.org 安装 Node.js（LTS 版）后重启 Obsidian；或在本插件设置中填写「Node.js 目录」。',
	],
	[
		/active writer|already active in this .* connection/i,
		'该对话正在被其他窗口使用',
		'关闭终端 / 飞书里正在运行的同一任务后重试，或新建一个对话。',
	],
	[
		/unknown acp session|session does not exist|invalid params/i,
		'对话已过期',
		'CodeM 更新或重启后旧对话会失效，请新建对话；历史内容仍可在「历史会话」中回看。',
	],
	[
		/internal_error: 无法启动主任务/i,
		'豆包服务暂时不可用',
		'稍后重试；反复出现请在终端执行 doubao update 升级 CLI，或向豆包官方反馈。',
	],
	[
		/Unsupported --model value|--effort must be one of|invalid_arguments/i,
		'豆包参数不被当前版本支持',
		'该模型/档位与已安装的豆包 CLI 版本不符，请换一档或执行 doubao update 升级。',
	],
	[
		/请先完成登录|豆包.*未登录|not logged in.*doubao/i,
		'豆包尚未登录或登录已过期',
		'在终端执行 doubao login，用豆包或飞书 App 扫码登录（需团队/企业订阅）。',
	],
	[
		/not logged in|unauthorized|401|login required|请先登录/i,
		'尚未登录或登录已过期',
		'在终端执行 codem login 或 doubao login，扫码重新登录。',
	],
	[
		/econnrefused|etimedout|enotfound|getaddrinfo|econnreset|socket hang up|network error|fetch failed/i,
		'网络连接失败',
		'检查网络与代理设置；企业网络可能拦截 CodeM 服务地址。',
	],
	[
		/blocked"|guard_result.*block|intercept/i,
		'操作被安全策略拦截',
		'该命令可能触发了企业安全规则，调整任务描述后重试。',
	],
	[
		/image prompt blocks/i,
		'图片发送失败',
		'当前通道不支持直传图片，请重新粘贴截图再试。',
	],
	[
		/超时|timeout/i,
		'等待超时',
		'任务较长时会自动继续；若长时间无响应，检查网络后重试。',
	],
	[
		/豆包进程退出/i,
		'豆包 CLI 进程异常退出',
		'重试一次；反复出现请在终端执行 doubao --version 检查安装。',
	],
	[
		/进程退出|process exit|exit code|退出码/i,
		'后端服务意外退出',
		'重试一次；反复出现请展开「查看详情」并反馈给插件作者。',
	],
];

export function friendlyError(detail: string): FriendlyError {
	for (const [re, title, hint] of ERROR_RULES) {
		if (re.test(detail)) return { title, hint };
	}
	return { title: '操作未能完成', hint: '请重试；若反复出现，请展开「查看详情」反馈。' };
}

/** 便于日志/详情展示的 home 缩写（C:\Users\xxx → ~） */
export function abbreviateHome(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// ===== 豆包 CLI 环境（S4 尾巴：官方安装命令集成进插件，2026-11-10）=====

/** 豆包官方 npm 安装命令（前置 Node 18+；postinstall 下载平台原生二进制，需允许 npm 安装脚本） */
export const DOUBAO_INSTALL_CMD =
	"npm install -g '@bytedance/doubao-cli' --registry=https://registry.npmjs.org/";

/** 豆包环境状态：missing=未装；no-npm=缺 npm 装不了；no-login=已装未登录；ready=就绪 */
export interface DoubaoEnvStatus {
	state: 'missing' | 'no-npm' | 'no-login' | 'ready';
	/** doubao.exe 路径（配置或默认探测） */
	cliPath: string;
	/** doubao --version 首行 */
	version?: string;
	/** auth status --verify 输出摘要（排障展示） */
	authOutput?: string;
}

/** 子进程捕获（cmd /c 包装 + PATH 兑底，与 runCodemVersion 同款环境组装），供豆包版本/登录探测 */
function captureOutput(
	exe: string,
	args: string[],
	nodePath: string | undefined,
	timeoutMs: number
): Promise<{ code: number | null; out: string; err: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const nodeDir = findNodeDir(nodePath);
	const sysDirs = ['C:\\Windows\\System32', 'C:\\Windows'];
	if (nodeDir) sysDirs.push(nodeDir);
	env.PATH = [...sysDirs, env.PATH ?? ''].join(path.delimiter);
	const comspec = env.ComSpec && fs.existsSync(env.ComSpec) ? env.ComSpec : 'C:\\Windows\\System32\\cmd.exe';
	return new Promise((resolve) => {
		const child = spawn(comspec, ['/c', exe, ...args], { windowsHide: true, env });
		let out = '';
		let err = '';
		let done = false;
		const finish = (r: { code: number | null; out: string; err: string }): void => {
			if (!done) {
				done = true;
				resolve(r);
			}
		};
		const timer = window.setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* 已退出 */
			}
			finish({ code: null, out, err });
		}, timeoutMs);
		child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
		child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
		child.on('error', (e) => {
			window.clearTimeout(timer);
			err += e.message;
			finish({ code: -1, out, err });
		});
		child.on('close', (code) => {
			window.clearTimeout(timer);
			finish({ code, out, err });
		});
	});
}

/**
 * 豆包环境自检：exe 存在性（配置 → 默认位置）→ npm 可用性（安装/升级通道）→ 版本 → 登录态。
 * 设置页「豆包环境」区块与聊天空状态共用同一结论；登录实测输出含「登录成功，账号已通过验证」。
 */
export async function checkDoubaoEnvironment(cliPathSetting: string, nodePath?: string): Promise<DoubaoEnvStatus> {
	const exe = expandPath(cliPathSetting || defaultDoubaoExe());
	if (!fs.existsSync(exe)) {
		return { state: 'missing', cliPath: exe };
	}
	const nodeDir = findNodeDir(nodePath);
	if (!nodeDir || !fs.existsSync(path.join(nodeDir, 'npm.cmd'))) {
		return { state: 'no-npm', cliPath: exe };
	}
	const ver = await captureOutput(exe, ['--version'], nodePath, 15000);
	const version = ver.out.split('\n').map((s) => s.trim()).find(Boolean) || '未知版本';
	const auth = await captureOutput(exe, ['auth', 'status', '--verify'], nodePath, 30000);
	const authText = (auth.out + '\n' + auth.err).trim();
	const logged = auth.code === 0 && /登录成功|已通过验证/.test(authText);
	return {
		state: logged ? 'ready' : 'no-login',
		cliPath: exe,
		version,
		authOutput: authText.slice(0, 200),
	};
}

/**
 * 一键安装豆包 CLI：spawn cmd /c npm install -g（官方命令，需允许 npm 安装脚本）。
 * npm.cmd 经 cmd 启动；findNodeDir 探测不到 npm 时 spawn 会报错并经 onProgress 回传。
 */
export function installDoubaoCli(onProgress: (p: InstallProgress) => void): () => void {
	const nodeDir = findNodeDir(undefined);
	const env: NodeJS.ProcessEnv = { ...process.env };
	const sysDirs = ['C:\\Windows\\System32', 'C:\\Windows'];
	if (nodeDir) sysDirs.push(nodeDir);
	env.PATH = [...sysDirs, env.PATH ?? ''].join(path.delimiter);
	const comspec = env.ComSpec && fs.existsSync(env.ComSpec) ? env.ComSpec : 'C:\\Windows\\System32\\cmd.exe';
	const npmCmd =
		nodeDir && fs.existsSync(path.join(nodeDir, 'npm.cmd')) ? path.join(nodeDir, 'npm.cmd') : 'npm.cmd';
	const child: ChildProcess = spawn(
		comspec,
		['/c', npmCmd, 'install', '-g', '@bytedance/doubao-cli', '--registry=https://registry.npmjs.org/'],
		{ windowsHide: true, env }
	);
	const pump = (buf: Buffer): void => {
		for (const line of buf.toString('utf8').split('\n')) {
			const t = line.trim();
			if (t) onProgress({ line: t, done: false, code: null });
		}
	};
	child.stdout?.on('data', pump);
	child.stderr?.on('data', pump);
	child.on('error', (e) => onProgress({ line: e.message, done: true, code: -1 }));
	child.on('close', (code) => onProgress({ line: '', done: true, code: code ?? -1 }));
	return () => {
		try {
			child.kill();
		} catch {
			/* 自然结束 */
		}
	};
}
