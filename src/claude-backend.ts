// ===== Claude Code 后端（第三后端，2026-11-10）=====
// 每轮 spawn `claude -p <prompt> --output-format stream-json --verbose [--resume <id>]`，
// stdout 为 NDJSON 事件流，逐行解析推送（真流式：text/thinking 块到达即推）。
// 协议事实（2026-11-10 探针实测，claude 2.1.295 + DeepSeek 兼容层）：
//  - 首行 system/init：{type:'system',subtype:'init',session_id,tools,cwd}——session_id 即刻可得
//  - assistant 事件：{type:'assistant',message:{content:[{type:'thinking',thinking}|{type:'text',text}],...}}
//    （DeepSeek 走兼容层时整块到达；协议支持流式块，两种形态此解析层均兼容）
//  - 末行 result：{type:'result',stop_reason,session_id,usage:{input_tokens,output_tokens},...}
//  - stream-json 必须 --verbose 搭配，否则 exit 1 报错
//  - --resume <id> 跨进程续接成功，session_id 全程保持（与 init/result 同口径）
//  - 模型路由走 ~/.claude/settings.json（CC-Switch 管理），本后端不传 --model 直接继承

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentBackend, AgentBackendCapabilities, PromptBlock } from './agent-backend';

/** Claude Code 后端配置 */
export interface ClaudeOptions {
	/** claude CLI 路径（claude.cmd 或原生 claude.exe） */
	cliPath: string;
	/** 工作目录（Vault 根） */
	cwd: string;
	/** 跳过全部权限确认（permMode=yolo 时置 true → --dangerously-skip-permissions） */
	skipPermissions?: boolean;
	/** 模型档位 alias（haiku/sonnet/opus，经 ~/.claude/settings.json 映射实际模型）；省略 = CLI 默认档 */
	model?: string;
	/** 思考预算 token 数（MAX_THINKING_TOKENS 环境变量注入）；省略 = CLI 默认 */
	thinkingTokens?: number;
	/** 调试日志路径 */
	debugLogPath?: string;
}

/** 伪 ACP 结构推送（与 DoubaoBackend 同：整块/增量 text → agent_message_chunk，thinking → agent_thought_chunk） */
export interface ClaudeHandlers {
	onUpdate?: (sessionId: string, update: Record<string, unknown>) => void;
}

/** 默认 claude.cmd 位置：findNodeDir 同源 node 目录（与 codem/doubao 共用 node 安装） */
export function defaultClaudeCli(): string {
	const candidates = [
		...(process.env.PATH ?? '').split(path.delimiter),
		'C:\\ProgramData\\node-v24.15.0-win-x64',
	];
	for (const dir of candidates) {
		if (!dir) continue;
		const p = path.join(dir, 'claude.cmd');
		try {
			if (fs.existsSync(p)) return p;
		} catch {
			// 无权限段忽略
		}
	}
	return path.join('C:\\ProgramData\\node-v24.15.0-win-x64', 'claude.cmd');
}

/**
 * 读取 ~/.claude/settings.json 的档位→真实模型名映射（CC-Switch 管理 env）。
 * CC2：模型 chip 菜单直接显示当前可调用的真实模型名（如 deepseek-flash），而非抽象档位名。
 */
export function claudeModelNames(): Record<string, string> {
	try {
		const p = path.join(os.homedir(), '.claude', 'settings.json');
		const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { env?: Record<string, string> };
		const env = raw.env ?? {};
		return {
			haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME || env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '轻量档',
			sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME || env.ANTHROPIC_DEFAULT_SONNET_MODEL || '标准档',
			opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME || env.ANTHROPIC_DEFAULT_OPUS_MODEL || '旗舰档',
		};
	} catch {
		return { haiku: '轻量档', sonnet: '标准档', opus: '旗舰档' };
	}
}

export class ClaudeBackend implements AgentBackend {
	readonly name = 'claude';
	readonly capabilities: AgentBackendCapabilities = {
		streaming: true,
		permissionRequests: false,
		sessionReplay: false,
	};

	private realIds = new Map<string, string>();
	private running = new Map<string, ChildProcess>();
	private cancelling = new Set<string>();

	constructor(private opts: ClaudeOptions, private handlers: ClaudeHandlers = {}) {}

	private log(line: string): void {
		if (!this.opts.debugLogPath) return;
		try {
			fs.appendFileSync(this.opts.debugLogPath, `[${new Date().toISOString()}] ${line}\n`);
		} catch {
			// 调试日志失败不影响主流程
		}
	}

	async newSession(): Promise<string> {
		return 'ccb-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
	}

	getRealSessionId(sessionId: string): string {
		return this.realIds.get(sessionId) ?? sessionId;
	}

	/** 载入即登记：--resume 语义续接（无重放通知），失效会话在下一轮以错误暴露 */
	async loadSession(sessionId: string): Promise<void> {
		this.realIds.set(sessionId, sessionId);
	}

	/** 无常驻进程占用：no-op */
	async closeSession(): Promise<void> {
		// no-op
	}

	private blocksToText(blocks: PromptBlock[]): string {
		return blocks
			.map((b) => (typeof b.text === 'string' ? b.text : ''))
			.filter(Boolean)
			.join('\n\n');
	}

	/**
	 * 启动目标解析：.cmd 壳升级为原生 claude.exe（绕 cmd /c 8191 字符限制）；
	 * 探测不到原生 exe 时回退 cmd /c 包装。
	 */
	private resolveSpawnTarget(): { exe: string; wrap: boolean } {
		const p = this.opts.cliPath;
		if (/\.(cmd|bat)$/i.test(p)) {
			// npm 布局：<nodeDir>/claude.cmd 与 <nodeDir>/node_modules/@anthropic-ai/claude-code/bin/claude.exe
			const exe = path.join(path.dirname(p), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
			try {
				if (fs.existsSync(exe)) {
					this.log(`cliPath=${p} 为 npm 壳，直启原生 exe：${exe}`);
					return { exe, wrap: false };
				}
			} catch {
				// 探测失败走 cmd 包装
			}
			this.log(`cliPath=${p} 未找到原生 exe，回退 cmd /c 包装（长文本受限）`);
			return { exe: p, wrap: true };
		}
		return { exe: p, wrap: false };
	}

	prompt(sessionId: string, blocks: PromptBlock[]): Promise<string> {
		const text = this.blocksToText(blocks);
		if (!text.trim()) return Promise.reject(new Error('Claude 后端收到空提示词'));
		const realId = this.realIds.get(sessionId);
		const args: string[] = ['-p', text, '--output-format', 'stream-json', '--verbose'];
		if (realId) args.push('--resume', realId);
		if (this.opts.skipPermissions) args.push('--dangerously-skip-permissions');
		if (this.opts.model) args.push('--model', this.opts.model);

		return new Promise<string>((resolve, reject) => {
			let child: ChildProcess;
			try {
				const { exe, wrap } = this.resolveSpawnTarget();
				// CC-fix：思考预算经 MAX_THINKING_TOKENS 注入（Claude Code 官方环境变量）
				const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
				if (this.opts.thinkingTokens) spawnEnv.MAX_THINKING_TOKENS = String(this.opts.thinkingTokens);
				if (wrap) {
					const comspec =
						process.env.ComSpec && fs.existsSync(process.env.ComSpec)
							? process.env.ComSpec
							: 'C:\\Windows\\System32\\cmd.exe';
					this.log(`spawn(cmd /c) ${exe}`);
					child = spawn(comspec, ['/c', exe, ...args], {
						cwd: this.opts.cwd,
						windowsHide: true,
						stdio: ['ignore', 'pipe', 'pipe'],
						env: spawnEnv,
					});
				} else {
					this.log(`spawn(direct) ${exe}`);
					child = spawn(exe, args, {
						cwd: this.opts.cwd,
						windowsHide: true,
						stdio: ['ignore', 'pipe', 'pipe'],
						env: spawnEnv,
					});
				}
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
				return;
			}
			this.running.set(sessionId, child);

			let buf = '';
			let stderrTail = '';
			let sidSeen = '';
			let stopReason = '';
			const handleLine = (line: string): void => {
				const t = line.trim();
				if (!t) return;
				this.log(`event: ${t.slice(0, 300)}`);
				let obj: Record<string, unknown>;
				try {
					obj = JSON.parse(t);
				} catch {
					return; // 非 JSON 行（版本提示等）忽略
				}
				const type = obj.type as string;
				if (type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
					sidSeen = obj.session_id;
					// init 即刻回填（比 result 更早，UI 更快拿到短码）；
					// 连聊修复（同豆包 b177374 教训）：view 轮末会把 tab.sessionId 换成云端真 ID，
					// 下一轮 prompt 传来真 ID 本身——补真 ID→真 ID 自映射，否则 --resume 不带、每轮开新会话
					if (!realId && !this.realIds.has(sessionId)) {
						this.realIds.set(sessionId, sidSeen);
						this.realIds.set(sidSeen, sidSeen);
					}
				} else if (type === 'assistant') {
					const msg = obj.message as { content?: Array<Record<string, unknown>> } | undefined;
					if (!Array.isArray(msg?.content)) return;
					for (const block of msg.content) {
						if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
							this.handlers.onUpdate?.(sessionId, {
								sessionUpdate: 'agent_thought_chunk',
								content: { text: block.thinking },
							});
						} else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
							this.handlers.onUpdate?.(sessionId, {
								sessionUpdate: 'agent_message_chunk',
								content: { text: block.text },
							});
						}
					}
				} else if (type === 'result') {
					if (typeof obj.stop_reason === 'string') stopReason = obj.stop_reason;
					// resume 轮兜底回填（init 未见的异常场景）
					if (!realId && typeof obj.session_id === 'string' && !sidSeen) {
						sidSeen = obj.session_id;
						this.realIds.set(sessionId, sidSeen);
					}
				}
			};
			child.stdout?.on('data', (c: Buffer) => {
				buf += c.toString('utf8');
				let idx: number;
				while ((idx = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, idx);
					buf = buf.slice(idx + 1);
					handleLine(line);
				}
			});
			child.stderr?.on('data', (c: Buffer) => {
				stderrTail = (stderrTail + c.toString('utf8')).slice(-2000);
			});
			child.on('error', (e) => {
				this.running.delete(sessionId);
				this.cancelling.delete(sessionId);
				reject(e);
			});
			child.on('close', (code) => {
				this.running.delete(sessionId);
				if (buf.trim()) handleLine(buf); // 末行无换行符兜底
				this.log(`close code=${code} sid=${sidSeen || '(无)'} stop=${stopReason || '(无)'}`);
				if (this.cancelling.delete(sessionId)) {
					resolve('cancelled');
					return;
				}
				if (code !== 0) {
					// stream-json 缺 --verbose / API 超限 / 认证失效等在此暴露
					reject(new Error(`Claude 进程退出（码 ${code}）\n${stderrTail.slice(-500)}`));
					return;
				}
				if (!stopReason) {
					reject(new Error(`Claude 无结果事件\n${stderrTail.slice(-500)}`));
					return;
				}
				// ACP 词表映射：end_turn 原样；其余（max_tokens 等）透传，view 按 end_turn 处理
				resolve(stopReason);
			});
		});
	}

	cancelSession(sessionId: string): void {
		if (!this.running.has(sessionId)) return;
		this.cancelling.add(sessionId);
		const child = this.running.get(sessionId);
		if (child?.pid && child.exitCode === null) {
			try {
				spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
			} catch {
				// 已退出：close 回调走正常收尾
			}
		}
	}

	stop(): void {
		for (const [sid, child] of this.running) {
			this.cancelling.add(sid);
			if (child.pid && child.exitCode === null) {
				try {
					spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
				} catch {
					// 已退出
				}
			}
		}
		this.running.clear();
	}
}
