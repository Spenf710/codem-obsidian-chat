import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AcpOptions {
	cliPath: string;
	/** 工作目录，插件固定传 Vault 根 */
	cwd: string;
	/** Node.js 所在目录（codem.cmd 需要）；留空自动探测 */
	nodePath?: string;
	/** 额外 CLI 参数（空格分隔，如 "--intelligence high"） */
	extraArgs?: string;
}

export interface AcpHandlers {
	/** session/update 通知（agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update …） */
	onUpdate?: (update: Record<string, unknown>) => void;
	/** agent 请求权限确认，respond 回传 {outcome:{outcome:'selected',optionId}} */
	onPermissionRequest?: (params: Record<string, unknown>, respond: (result: unknown) => void) => void;
	/** 子进程退出 */
	onClose?: (code: number | null) => void;
}

export function expandPath(p: string): string {
	if (p === '~') return os.homedir();
	if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * 探测 node.exe 所在目录：用户配置 → 当前进程 PATH → 常见安装位置 → ProgramData 便携目录。
 * 背景：Obsidian 进程 PATH 可能残缺（实测连 cmd 都 ENOENT），spawn 层必须自兜底。
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

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
}

/**
 * CodeM ACP 客户端：长驻 `codem acp` 子进程，JSON-RPC 2.0 over stdio 双向通信。
 * 协议事实（2026-10-10 探针实测）：initialize 返回 protocolVersion=1 与 loadSession 等
 * capabilities；session/prompt 经 session/update 流式推送、最终响应 {stopReason}。
 */
export class AcpClient {
	private child: ChildProcess | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private buffer = '';
	private stderrTail = '';
	private initialized = false;
	private starting: Promise<void> | null = null;

	constructor(
		private opts: AcpOptions,
		public handlers: AcpHandlers = {}
	) {}

	async ensureStarted(): Promise<void> {
		if (this.child && this.initialized) return;
		if (this.starting) return this.starting;
		this.starting = this.start().finally(() => (this.starting = null));
		return this.starting;
	}

	private async start(): Promise<void> {
		const env: NodeJS.ProcessEnv = { ...process.env };
		const nodeDir = findNodeDir(this.opts.nodePath);
		const sysDirs = ['C:\\Windows\\System32', 'C:\\Windows'];
		if (nodeDir) sysDirs.push(nodeDir);
		env.PATH = [...sysDirs, env.PATH ?? ''].join(';');
		const comspec = env.ComSpec && fs.existsSync(env.ComSpec) ? env.ComSpec : 'C:\\Windows\\System32\\cmd.exe';
		const extra = this.opts.extraArgs?.trim() ? this.opts.extraArgs.trim().split(/\s+/) : [];
		// .cmd 必须经 cmd /c 启动；绝对路径防宿主 PATH 残缺
		this.child = spawn(comspec, ['/c', expandPath(this.opts.cliPath), 'acp', ...extra], {
			cwd: this.opts.cwd,
			windowsHide: true,
			env,
		});

		this.child.stdout!.on('data', (chunk: Buffer) => {
			this.buffer += chunk.toString('utf8');
			let idx: number;
			while ((idx = this.buffer.indexOf('\n')) >= 0) {
				const line = this.buffer.slice(0, idx).trim();
				this.buffer = this.buffer.slice(idx + 1);
				if (line) this.handleLine(line);
			}
		});
		this.child.stderr!.on('data', (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
		});
		this.child.on('error', (e) => this.failPending(e));
		this.child.on('close', (code) => {
			this.child = null;
			this.initialized = false;
			this.failPending(new Error(`CodeM ACP 进程退出（码 ${code}）\n${this.stderrTail}`));
			this.handlers.onClose?.(code);
		});

		await this.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
		this.initialized = true;
	}

	private handleLine(line: string): void {
		let m: Record<string, unknown>;
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		const id = m.id as number | undefined;
		if (id !== undefined && m.method) {
			// agent → client 请求
			if (m.method === 'session/request_permission') {
				this.handlers.onPermissionRequest?.(
					m.params as Record<string, unknown>,
					(result) => this.respond(id, result)
				);
			} else {
				// fs/* 等未支持的 agent 请求：CodeM 有本地读权限，正常不应出现
				this.respondError(id, { code: -32601, message: `client 未支持: ${String(m.method)}` });
			}
			return;
		}
		if (m.method === 'session/update') {
			const params = m.params as { update?: Record<string, unknown> } | undefined;
			if (params?.update) this.handlers.onUpdate?.(params.update);
			return;
		}
		if (id !== undefined) {
			const p = this.pending.get(id);
			if (!p) return;
			this.pending.delete(id);
			if (m.error) p.reject(new Error(JSON.stringify(m.error)));
			else p.resolve(m.result);
		}
	}

	private request(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.child?.stdin) {
				reject(new Error('ACP 进程未启动'));
				return;
			}
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject });
			this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
		});
	}

	respond(id: number, result: unknown): void {
		this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
	}

	private respondError(id: number, error: unknown): void {
		this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n');
	}

	private failPending(e: Error): void {
		for (const p of this.pending.values()) p.reject(e);
		this.pending.clear();
	}

	/** 新建会话，返回 sessionId */
	async newSession(): Promise<string> {
		await this.ensureStarted();
		const r = (await this.request('session/new', { cwd: this.opts.cwd, mcpServers: [] })) as {
			sessionId: string;
		};
		return r.sessionId;
	}

	/** 发送一轮对话，resolve 值为 stopReason（end_turn 等）；期间经 onUpdate 流式回调 */
	async prompt(sessionId: string, text: string): Promise<string> {
		await this.ensureStarted();
		const r = (await this.request('session/prompt', {
			sessionId,
			prompt: [{ type: 'text', text }],
		})) as { stopReason: string };
		return r.stopReason;
	}

	/**
	 * 载入历史会话（loadSession capability 实测可用）。resolve 后原 sessionId 即可续接 prompt。
	 * 载入期间 agent 会重放历史消息（user_message_chunk / agent_message_chunk 通知），调用方需忽略。
	 */
	async loadSession(sessionId: string): Promise<void> {
		await this.ensureStarted();
		await this.request('session/load', { sessionId, cwd: this.opts.cwd, mcpServers: [] });
	}

	stop(): void {
		this.child?.kill();
		this.child = null;
		this.initialized = false;
	}
}
