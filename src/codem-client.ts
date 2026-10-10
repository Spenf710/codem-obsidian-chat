import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RunOptions {
	cliPath: string;
	/** 工作目录，插件固定传 Vault 根 */
	cwd: string;
	timeoutMs: number;
	/** 额外 CLI 参数（空格分隔字符串，如 "--model xxx"） */
	extraArgs?: string;
	/** --session 复用/指定会话 id；不传则 CodeM 自动新建 */
	sessionId?: string;
	/** Node.js 所在目录（codem.cmd 需 PATH 里有 node）；留空自动探测 */
	nodePath?: string;
}

/**
 * 探测 node.exe 所在目录：用户配置 → 当前进程 PATH → 常见安装位置。
 * 背景：CodeM CLI 的 codem.cmd 启动器要求 PATH 里有 node，而 GUI 进程继承的
 * PATH 可能失效（2026-10-10 事故：CodeM 更新清除临时 node 导致插件全挂）。
 */
export function findNodeDir(userOverride?: string): string | null {
	if (userOverride?.trim()) return userOverride.trim();
	const candidates = [
		...(process.env.PATH ?? '').split(';'),
		'C:\\Program Files\\nodejs',
		'C:\\Program Files (x86)\\nodejs',
		path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'nodejs'),
	];
	for (const dir of candidates) {
		if (!dir) continue;
		try {
			if (fs.existsSync(path.join(dir, 'node.exe'))) return dir;
		} catch {
			// 无权限/无效段忽略
		}
	}
	// C:\ProgramData 下用户自放的便携 node-v* 目录
	try {
		for (const d of fs.readdirSync('C:\\ProgramData')) {
			if (!d.startsWith('node-v')) continue;
			const dir = path.join('C:\\ProgramData', d);
			if (fs.existsSync(path.join(dir, 'node.exe'))) return dir;
		}
	} catch {
		// 目录不存在/无权限忽略
	}
	return null;
}

export interface CodemUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read?: number;
	cache_creation?: number;
}

export interface StreamHandlers {
	onThinking?: (delta: string) => void;
	onText?: (delta: string) => void;
	onUsage?: (usage: CodemUsage) => void;
	/** 未识别事件透传（工具调用等，MVP 阶段忽略即可） */
	onEvent?: (event: string, data: unknown) => void;
}

export function expandPath(p: string): string {
	if (p === '~') return os.homedir();
	if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** 生成插件侧会话 id；--session 对不存在的 id 静默新建，同 id 即续接 */
export function newSessionId(): string {
	return `sess_obsidian_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface SessionSummary {
	id: string;
	updatedAt: string;
	messageCount: number;
	firstUserMessage: string;
	transcript: Array<{ role: string; content: string }>;
}

/**
 * 读 ~/.codem/sessions/sess_*.json 索引卡，过滤 cwd 为当前 Vault 的会话，按更新时间倒序。
 * 只覆盖本地落盘会话（云端执行的对话无本地记录）。
 */
export function listSessions(vaultPath: string, limit = 30): SessionSummary[] {
	const dir = path.join(os.homedir(), '.codem', 'sessions');
	if (!fs.existsSync(dir)) return [];
	const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
	const vaultNorm = norm(vaultPath);

	const out: SessionSummary[] = [];
	for (const f of fs.readdirSync(dir)) {
		if (!f.startsWith('sess_') || !f.endsWith('.json')) continue;
		try {
			const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
			if (!j.cwd || norm(String(j.cwd)) !== vaultNorm) continue;
			const transcript: Array<{ role: string; content: string }> = Array.isArray(j.transcript)
				? j.transcript
				: [];
			const firstUser = transcript.find((m) => m.role === 'user')?.content ?? '';
			out.push({
				id: j.id ?? f.replace(/\.json$/, ''),
				updatedAt: j.updatedAt ?? '',
				messageCount: transcript.length,
				firstUserMessage: firstUser.slice(0, 80),
				transcript,
			});
		} catch {
			// 损坏的索引卡跳过
		}
	}
	out.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
	return out.slice(0, limit);
}

/**
 * 流式调用 CodeM：spawn `codem -p <prompt> --sse [--session id]`，
 * 逐行解析 stdout 的 SSE 事件流并分发回调。resolve 值为最终正文。
 *
 * P0 已验证事件类型（2026-10-10）：thinking / text / usage / context_report / done / session_mode_changed；
 * 工具调用事件格式待真实任务实测，未识别事件走 onEvent 透传，天然向前兼容。
 */
export function runPromptStream(opts: RunOptions, prompt: string, handlers: StreamHandlers): Promise<string> {
	const args = ['-p', prompt, '--sse'];
	if (opts.sessionId) args.push('--session', opts.sessionId);
	if (opts.extraArgs?.trim()) args.push(...opts.extraArgs.trim().split(/\s+/));

	return new Promise((resolve, reject) => {
		// .cmd 必须经 cmd /c 启动。实测 Obsidian 进程 PATH 可能残缺到 spawn cmd 都 ENOENT，
		// 故用绝对路径 cmd.exe，并显式补齐 System32 与探测到的 node 目录
		const env: NodeJS.ProcessEnv = { ...process.env };
		const nodeDir = findNodeDir(opts.nodePath);
		const sysDirs = ['C:\\Windows\\System32', 'C:\\Windows'];
		if (nodeDir) sysDirs.push(nodeDir);
		env.PATH = [...sysDirs, env.PATH ?? ''].join(';');
		const comspec = env.ComSpec && fs.existsSync(env.ComSpec) ? env.ComSpec : 'C:\\Windows\\System32\\cmd.exe';
		const child = spawn(comspec, ['/c', expandPath(opts.cliPath), ...args], {
			cwd: opts.cwd,
			windowsHide: true,
			env,
		});

		let buffer = '';
		let currentEvent = '';
		let textAcc = '';
		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => {
			settled = true;
			child.kill();
			reject(new Error(`CodeM 调用超时（${opts.timeoutMs}ms）`));
		}, opts.timeoutMs);

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};

		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			let idx: number;
			while ((idx = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, idx).replace(/\r$/, '');
				buffer = buffer.slice(idx + 1);
				handleLine(line);
			}
		});

		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
		child.on('error', (e) => settle(() => reject(e)));
		child.on('close', (code) =>
			settle(() => {
				if (code === 0) resolve(textAcc);
				else reject(new Error(`CodeM 退出码 ${code}\n${stderr || textAcc}`));
			})
		);

		function handleLine(line: string): void {
			if (line.startsWith('event:')) {
				currentEvent = line.slice(6).trim();
				return;
			}
			if (!line.startsWith('data:')) return;
			const raw = line.slice(5).trim();
			if (!raw) return;
			try {
				dispatch(currentEvent, JSON.parse(raw));
			} catch {
				// 非 JSON data 行忽略
			}
		}

		function dispatch(event: string, data: Record<string, unknown>): void {
			switch (event) {
				case 'thinking':
					if (typeof data.delta === 'string') handlers.onThinking?.(data.delta);
					break;
				case 'text':
					if (typeof data.delta === 'string') {
						textAcc += data.delta;
						handlers.onText?.(data.delta);
					}
					break;
				case 'usage':
					handlers.onUsage?.(data as CodemUsage);
					break;
				case 'done':
					// 多轮 SSE：每轮结束都发 done（reason: tool_use / end_turn …），
					// 只有带 final_text 的最终轮才结束调用，中间轮忽略继续监听
					if (typeof data.final_text === 'string') {
						settle(() => resolve(data.final_text as string));
					}
					break;
				default:
					handlers.onEvent?.(event, data);
			}
		}
	});
}
