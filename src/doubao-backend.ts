// ===== 豆包 CLI 后端（豆包集成 S2，2026-11-09）=====
// 每轮 spawn `doubao.exe -C <cwd> [--resume <id>] -p <prompt>` 单次调用，无长驻进程。
// 协议事实（2026-11-09 探针实测，doubao 2.31.3）：
//  - 正文走 stdout（纯 markdown，整轮一次性到达，不流式）；
//    session 事件走 stderr：{"type":"session","session_id":"3845xxx…"}（云端会话 ID 在此回填）
//  - `--resume <id>` 与 stderr 事件的 session_id 同口径，跨进程续聊可用
//  - 退出码：正常 0、参数错 2；`internal_error:` 样式错误可能仍 exit 0（--list 实测），需文本识别
//  - 无权限反向请求、无工具事件流（capabilities 三项 false 的依据）
//  - exe 直启可行（多行 prompt 作为单 argv 传递），绕开 npm wrapper 更新检查与 cmd /c 转义/长度限制

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentBackend, AgentBackendCapabilities, PromptBlock } from './agent-backend';

/** 豆包后端配置 */
export interface DoubaoOptions {
	/** doubao.exe 完整路径 */
	cliPath: string;
	/** 工作目录（插件固定传 Vault 根；目录必须存在，否则 exit 2） */
	cwd: string;
	/** 权限档位：ask_always / ask_risky / always_allow（省略 = CLI 默认 ask_risky） */
	permissionMode?: string;
	/** 推理强度：Low / Medium / High（省略 = CLI 默认 High） */
	effort?: string;
	/** 模型（空 = Auto） */
	model?: string;
	/** 调试日志路径（stderr 事件与退出码，排障用） */
	debugLogPath?: string;
}

/** 伪流式回推：整轮正文按 ACP agent_message_chunk 结构推给 view，复用其打字机/渲染管线 */
export interface DoubaoHandlers {
	onUpdate?: (sessionId: string, update: Record<string, unknown>) => void;
}

/** 默认 doubao.exe 位置（npm 安装器固定落点；`current` 目录由官方 updater 维护，版本升级路径不变） */
export function defaultDoubaoExe(): string {
	const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
	return path.join(base, 'doubao_cli', 'app', 'current', 'doubao.exe');
}

/** 探测 doubao.exe（默认位置存在即命中） */
export function probeDoubaoCli(): string | null {
	try {
		const def = defaultDoubaoExe();
		if (fs.existsSync(def)) return def;
	} catch {
		// 无权限忽略
	}
	return null;
}

export class DoubaoBackend implements AgentBackend {
	readonly name = 'doubao';
	readonly capabilities: AgentBackendCapabilities = {
		streaming: false,
		permissionRequests: false,
		sessionReplay: false,
	};

	/** view 会话键（newSession 占位 ID 或 loadSession 登记的云端真 ID）→ 云端真 ID */
	private realIds = new Map<string, string>();
	/** 会话键 → 进行中的一轮进程（cancel 按 key 杀进程树） */
	private running = new Map<string, ChildProcess>();
	/** 正在伪流式推送动画中的会话键（cancel 可打断动画） */
	private animating = new Set<string>();
	/** 已请求取消的会话键（close/动画结束时消费，resolve 'cancelled'） */
	private cancelling = new Set<string>();

	constructor(private opts: DoubaoOptions, private handlers: DoubaoHandlers = {}) {}

	private log(line: string): void {
		if (!this.opts.debugLogPath) return;
		try {
			fs.appendFileSync(this.opts.debugLogPath, `[${new Date().toISOString()}] ${line}\n`);
		} catch {
			// 调试日志失败不影响主流程
		}
	}

	/**
	 * 豆包无显式建会话命令：发本地占位 ID，首轮 -p 时由 stderr session 事件回填云端真 ID，
	 * 后续轮自动改用 --resume 续聊（view 层无感知，tab.sessionId 始终是占位 ID）。
	 */
	async newSession(): Promise<string> {
		return 'dbp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
	}

	/** 会话键对应的云端真 ID（AgentBackend.getRealSessionId；首轮 stderr 回填后可得，未回填返回原值） */
	getRealSessionId(sessionId: string): string {
		return this.realIds.get(sessionId) ?? sessionId;
	}

	/**
	 * 载入即登记：豆包会话存云端，无独立 load 动作（无重放通知），续接在下一轮 prompt
	 * 经 --resume 实现；失效会话在下一轮以错误形式暴露，由 view 软续接兜底。
	 */
	async loadSession(sessionId: string): Promise<void> {
		this.realIds.set(sessionId, sessionId);
	}

	/** 豆包每轮独立进程、无 daemon 占用：no-op */
	async closeSession(): Promise<void> {
		// no-op
	}

	/** 从 blocks 提取纯文本（图片已由 view 层内联为 base64 data URI 文本，与 ACP 路径同构） */
	private blocksToText(blocks: PromptBlock[]): string {
		return blocks
			.map((b) => (typeof b.text === 'string' ? b.text : ''))
			.filter(Boolean)
			.join('\n\n');
	}

	/**
	 * 解析实际启动目标：.exe 直启；.cmd/.bat wrapper（npm 全局装法）优先升级为原生
	 * doubao.exe（固定落点探测，绕开 cmd /c 转义与 8191 字符限制）；探测不到时回退 cmd /c 包装保底。
	 */
	private resolveSpawnTarget(): { exe: string; wrap: boolean } {
		const p = this.opts.cliPath;
		if (/\.(cmd|bat)$/i.test(p)) {
			const native = defaultDoubaoExe();
			try {
				if (fs.existsSync(native)) {
					this.log(`cliPath=${p} 为 npm wrapper，已自动升级为原生 exe：${native}`);
					return { exe: native, wrap: false };
				}
			} catch {
				// 探测失败走 cmd 包装
			}
			this.log(`cliPath=${p} 为 npm wrapper 且未找到原生 exe，回退 cmd /c 包装（长文本受限）`);
			return { exe: p, wrap: true };
		}
		return { exe: p, wrap: false };
	}

	prompt(sessionId: string, blocks: PromptBlock[]): Promise<string> {
		const text = this.blocksToText(blocks);
		if (!text.trim()) return Promise.reject(new Error('豆包后端收到空提示词'));
		const realId = this.realIds.get(sessionId);
		const args: string[] = ['-C', this.opts.cwd];
		if (realId) args.push('--resume', realId);
		if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode);
		if (this.opts.effort) args.push('--effort', this.opts.effort);
		if (this.opts.model) args.push('--model', this.opts.model);
		args.push('-p', text);

		return new Promise<string>((resolve, reject) => {
			let child: ChildProcess;
			try {
				const { exe, wrap } = this.resolveSpawnTarget();
				if (wrap) {
					// 保底路径：npm wrapper 经 cmd /c 启动（多行长文本受 8191 字符限制）
					const comspec =
					process.env.ComSpec && fs.existsSync(process.env.ComSpec)
				? process.env.ComSpec
				: 'C:\\Windows\\System32\\cmd.exe';
					this.log(`spawn(cmd /c) ${exe}`);
					child = spawn(comspec, ['/c', exe, ...args], {
						cwd: this.opts.cwd,
							windowsHide: true,
							stdio: ['ignore', 'pipe', 'pipe'],
					});
					} else {
				// exe 直启（Node args 数组原样传递）；stdin 关闭——无交互通道
					this.log(`spawn(direct) ${exe}`);
					child = spawn(exe, args, {
					cwd: this.opts.cwd,
				windowsHide: true,
				  stdio: ['ignore', 'pipe', 'pipe'],
				 });
				}
			} catch (e) {
				reject(e instanceof Error ? e : new Error(String(e)));
				return;
			}
			this.running.set(sessionId, child);

			let out = '';
			let stderrTail = '';
			let sidSeen = '';
			child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
			child.stderr?.on('data', (c: Buffer) => {
				const chunk = c.toString('utf8');
				stderrTail = (stderrTail + chunk).slice(-2000);
				for (const line of chunk.split('\n')) {
					const t = line.trim();
					if (!t) continue;
					this.log(`stderr: ${t.slice(0, 500)}`);
					// session 事件：{"type":"session","session_id":"3845xxx…"}
					try {
						const obj = JSON.parse(t) as { type?: string; session_id?: string };
						if (obj.type === 'session' && obj.session_id) sidSeen = obj.session_id;
					} catch {
						// 非 JSON 行（版本提示等噪音）忽略
					}
				}
			});
			child.on('error', (e) => {
				this.running.delete(sessionId);
				this.animating.delete(sessionId);
				this.cancelling.delete(sessionId);
				reject(e);
			});
			child.on('close', (code) => {
				this.running.delete(sessionId);
				this.log(`close code=${code} sid=${sidSeen || '(无)'} outLen=${out.length}`);
				// 用户取消（taskkill 或动画期打断）：按 ACP 语义 resolve 'cancelled'
				if (this.cancelling.delete(sessionId)) {
					resolve('cancelled');
					return;
				}
				if (code !== 0) {
					reject(new Error(`豆包进程退出（码 ${code}）\n${stderrTail.slice(-500)}`));
					return;
				}
				const answer = out.replace(/\r\n/g, '\n').trim();
				if (!answer) {
					// exit 0 也可能出错（--list 同款 internal_error 实测 exit 0）：文本识别兜底
					const m = stderrTail.match(/(internal_error|invalid_arguments)[^\n]*/i);
					reject(new Error(m ? m[0] : `豆包无输出\n${stderrTail.slice(-500)}`));
					return;
				}
				// 首轮回填云端真 ID（后续轮 --resume）；resume 轮 sidSeen 应等于 realId，不覆盖
				if (sidSeen && !realId) {
				 this.realIds.set(sessionId, sidSeen);
				 // 连聊修复：view 轮末会把 tab.sessionId 替换为云端真 ID（S3 本地索引用），
				 // 下一轮 prompt 传来的是真 ID 本身——补真 ID→真 ID 自映射，否则查不到映射
				 // → 不带 --resume → 每轮开新会话、上下文全丢
				 this.realIds.set(sidSeen, sidSeen);
				}
				// 伪流式：整轮正文拆 chunk 渐推，复用 view 打字机动画；取消可打断
				void this.pushChunks(sessionId, answer).then(() => {
					if (this.cancelling.delete(sessionId)) resolve('cancelled');
					else resolve('end_turn');
				});
			});
		});
	}

	/** 整轮正文拆 chunk 渐推（模拟流式）：chunk 数上限 48、间隔 40ms，动画最长约 2s */
	private async pushChunks(sessionId: string, text: string): Promise<void> {
		this.animating.add(sessionId);
		try {
			const chunks = Math.min(48, Math.max(1, Math.ceil(text.length / 160)));
			const size = Math.ceil(text.length / chunks);
			for (let i = 0; i < text.length; i += size) {
				this.handlers.onUpdate?.(sessionId, {
					sessionUpdate: 'agent_message_chunk',
					content: { text: text.slice(i, i + size) },
				});
				await new Promise((r) => window.setTimeout(r, 40));
				if (this.cancelling.has(sessionId)) break;
			}
		} finally {
			this.animating.delete(sessionId);
		}
	}

	cancelSession(sessionId: string): void {
		// 无进行中的一轮（view 防抖重复调用/迟到点击）：不动 cancelling，防误伤下一轮
		if (!this.running.has(sessionId) && !this.animating.has(sessionId)) return;
		this.cancelling.add(sessionId);
		const child = this.running.get(sessionId);
		if (child?.pid && child.exitCode === null) {
			// cmd /c 孙进程经验沿用：taskkill /T 杀整棵进程树（豆包可能再派生子进程）
			try {
				spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
			} catch {
				// 已退出：close 回调走正常收尾
			}
		}
	}

	/** 视图关闭/参数重启：杀掉全部进行中的轮次进程 */
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
