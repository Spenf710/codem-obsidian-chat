import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ===== CodeM 会话数据层（jsonl 会话文件解析，精简版） =====
// 数据源：~/.codem/sessions/<hash>/<sessionId>.jsonl（文件名即 sessionId，ACP session/load 可直接续接）
// 事件类型：header / user_message / user_invocation / turn_response / tool_call / tool_result

export interface SessionCard {
	sessionId: string;
	filePath: string;
	firstPrompt: string;
	startTime: string;
	lastTime: string;
	userTurns: number;
	toolCalls: number;
	cwd: string;
	/** header.session_source：bot=飞书 / tui=终端 / 空=旧版 */
	source: string;
}

export type TurnRole = 'user' | 'assistant' | 'tool';
export interface TurnBlock {
	kind: 'text' | 'thinking' | 'tool_use' | 'tool_result';
	label?: string;
	content: string;
}
export interface Turn {
	role: TurnRole;
	blocks: TurnBlock[];
	timestamp: string;
}

function sessionsRoot(): string {
	return path.join(os.homedir(), '.codem', 'sessions');
}

const cache = new Map<string, { size: number; mtimeMs: number; card: SessionCard | null }>();

/** 系统注入的消息前缀（skill 定义/system-reminder 等，不是用户真实输入） */
const SYSTEM_INJECT = [
	'<system-reminder>',
	'<command-name>',
	'<skill-instructions',
	'Base directory for this skill',
	'The following skill was loaded',
];

function extractText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map((x) => (typeof x === 'string' ? x : ((x as { text?: string })?.text ?? ''))).join('');
	}
	return '';
}

/** 飞书 IM 入参包裹 → 抽【原文】 */
function extractImOriginal(text: string): string {
	if (!text.includes('飞书 IM 输入：')) return '';
	const m = text.match(/【原文】\s*([\s\S]*?)(?=\n\s*【上下文】|$)/);
	return m ? m[1].trim() : '';
}

function parseJsonlLines(filePath: string, onLine: (obj: Record<string, unknown>, at: string) => void): Promise<void> {
	return new Promise((resolve) => {
		const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
		let buf = '';
		stream.on('data', (chunk: string) => {
			buf += chunk;
			const lines = buf.split('\n');
			buf = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const obj = JSON.parse(line);
					onLine(obj, typeof obj.at === 'string' ? obj.at : '');
				} catch {
					// 坏行跳过
				}
			}
		});
		stream.on('end', () => {
			if (buf.trim()) {
				try {
					onLine(JSON.parse(buf), '');
				} catch {
					// ignore
				}
			}
			resolve();
		});
		stream.on('error', () => resolve());
	});
}

/**
 * 快扫单个 jsonl 建卡片元信息：只读文件头 64KB（header + 首问必在其中），
 * 替代原先的全量流式解析——34 个会话的首次扫描从秒级降到毫秒级。
 * 轮数不在此统计（改由 history.jsonl 计数），lastTime 用文件 mtime。
 */
async function buildCard(sessionId: string, filePath: string, counts: Map<string, number>): Promise<SessionCard | null> {
	let firstPrompt = '';
	let cwd = '';
	let source = '';
	try {
		const fh = await fs.promises.open(filePath, 'r');
		const buf = Buffer.alloc(65536);
		const { bytesRead } = await fh.read(buf, 0, 65536, 0);
		await fh.close();
		const text = buf.toString('utf8', 0, bytesRead);
		// v1.0.14：真字段是 jsonl header 事件行的 session_source（bot=飞书/tui=终端/app=客户端/subagent=子代理）；
		// v1.0.11~13 曾误读 wrapper json 的 taskSource（buildCard 处理的是 .jsonl，该字段不在其中）——恢复原读取
		if (/^sess_feishu/.test(sessionId)) source = 'bot'; // 旧版飞书会话按文件名兑底
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			let obj: Record<string, unknown>;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}
			const t = obj.type as string;
			if (t === 'header') {
				if (typeof obj.cwd === 'string' && !cwd) cwd = obj.cwd;
				// v1.0.14：恢复 session_source 读取（jsonl header 事件行原生字段，v1.0.11 误删）
				if (typeof obj.session_source === 'string') source = obj.session_source;
			} else if (t === 'user_message') {
				const raw = extractText(obj.content);
				if (raw && !SYSTEM_INJECT.some((s) => raw.startsWith(s))) {
					firstPrompt = (extractImOriginal(raw) || raw).slice(0, 80);
					break;
				}
			} else if (t === 'user_invocation') {
				const input = obj.input as { kind?: string; content?: string; name?: string } | undefined;
				firstPrompt = input?.kind === 'skill' ? `/${input.name}` : (input?.content ?? '').slice(0, 80);
				break;
			}
		}
	} catch {
		return null;
	}
	if (!firstPrompt) return null; // 空会话（仅 header 占位）或异常文件不进列表
	// 标题生成的无头任务会话不进列表
	if (firstPrompt.startsWith('[标题生成]')) return null;
	// 软续接快照会话：首问显示 [本次问题] 部分
	if (firstPrompt.startsWith('[背景]')) {
		const m2 = firstPrompt.match(/\[本次问题\]\s*([\s\S]*)/);
		if (m2?.[1].trim()) firstPrompt = m2[1].trim();
		else return null;
	}
	let st: fs.Stats;
	try {
		st = await fs.promises.stat(filePath);
	} catch {
		return null;
	}
	return {
		sessionId,
		filePath,
		firstPrompt,
		startTime: '',
		lastTime: new Date(st.mtimeMs).toISOString(),
		userTurns: counts.get(sessionId) ?? 0,
		toolCalls: 0,
		cwd,
		source,
	};
}

/** 从 ~/.codem/history.jsonl 统计各会话输入轮数（单文件顺序读，快） */
async function loadHistoryCounts(): Promise<Map<string, number>> {
	const map = new Map<string, number>();
	const p = path.join(os.homedir(), '.codem', 'history.jsonl');
	try {
		const st = await fs.promises.stat(p);
		if (st.size > 20 * 1024 * 1024) return map; // 超大 history 跳过计数
		const data = await fs.promises.readFile(p, 'utf8');
		for (const line of data.split('\n')) {
			if (!line.trim()) continue;
			try {
				const sid = (JSON.parse(line) as { session_id?: string }).session_id;
				if (typeof sid === 'string' && sid) map.set(sid, (map.get(sid) ?? 0) + 1);
			} catch {
				// 坏行跳过
			}
		}
	} catch {
		// 无 history 文件
	}
	return map;
}

/** 扫描 ~/.codem/sessions 下全部 jsonl 会话（hash 子目录 + 顶层），按最后活跃倒序 */
export async function listCodemSessions(): Promise<SessionCard[]> {
	const root = sessionsRoot();
	let entries: string[];
	try {
		entries = await fs.promises.readdir(root);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const d of entries) {
		const p = path.join(root, d);
		let st: fs.Stats;
		try {
			st = await fs.promises.stat(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			for (const f of await fs.promises.readdir(p).catch(() => [])) {
				if (f.endsWith('.jsonl')) files.push(path.join(p, f));
			}
		} else if (d.endsWith('.jsonl')) {
			files.push(p);
		}
	}
	const counts = await loadHistoryCounts();
	const cards: SessionCard[] = [];
	for (const filePath of files) {
		const sessionId = path.basename(filePath).replace(/\.jsonl$/, '');
		let st: fs.Stats;
		try {
			st = await fs.promises.stat(filePath);
		} catch {
			continue;
		}
		const c = cache.get(filePath);
		let card: SessionCard | null;
		if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) {
			card = c.card;
		} else {
			card = await buildCard(sessionId, filePath, counts);
			cache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, card });
		}
		if (card) cards.push(card);
	}
	cards.sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
	return cards;
}

/** 读取单个会话完整轮次（历史回显用） */
export async function readCodemSessionTurns(filePath: string): Promise<Turn[]> {
	const turns: Turn[] = [];
	await parseJsonlLines(filePath, (obj, at) => {
		const t = obj.type as string;
		if (t === 'user_message') {
			const text = extractText(obj.content);
			if (text && !SYSTEM_INJECT.some((s) => text.startsWith(s))) {
				turns.push({ role: 'user', blocks: [{ kind: 'text', content: extractImOriginal(text) || text }], timestamp: at });
			}
		} else if (t === 'user_invocation') {
			const input = obj.input as { kind?: string; content?: string; name?: string } | undefined;
			const kind = input?.kind ?? '';
			const text =
				kind === 'skill'
					? `/${input?.name ?? '技能'}`
					: kind === 'message'
						? extractImOriginal(input?.content ?? '') || (input?.content ?? '').trim()
						: '';
			if (text) turns.push({ role: 'user', blocks: [{ kind: 'text', content: text }], timestamp: at });
		} else if (t === 'turn_response') {
			const content = (obj.response_json as { content?: unknown[] } | undefined)?.content;
			const blocks: TurnBlock[] = [];
			let hasText = false;
			if (Array.isArray(content)) {
				for (const b of content as Array<Record<string, unknown>>) {
					if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
						blocks.push({ kind: 'thinking', content: b.thinking });
					} else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
						hasText = true;
						blocks.push({ kind: 'text', content: b.text });
					} else if (b?.type === 'tool_use') {
						const name = typeof b.name === 'string' ? b.name : '工具';
						const summary = (b.input as { summary?: string })?.summary;
						if (name === 'final_answer' && summary?.trim()) {
							hasText = true;
							blocks.push({ kind: 'text', content: summary });
						} else {
							const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}, null, 2);
							blocks.push({ kind: 'tool_use', label: name, content: input.slice(0, 2000) });
						}
					}
				}
			}
			// 纯思考中间轮跳过，只回显有最终文本的轮
			if (hasText) turns.push({ role: 'assistant', blocks, timestamp: at });
		} else if (t === 'tool_call') {
			const name = typeof obj.name === 'string' ? obj.name : typeof obj.tool_name === 'string' ? obj.tool_name : '工具';
			const input = obj.input ?? obj.request_json;
			turns.push({
				role: 'tool',
				blocks: [
					{
						kind: 'tool_use',
						label: name,
						content: typeof input === 'string' ? input.slice(0, 2000) : JSON.stringify(input ?? {}, null, 2).slice(0, 2000),
					},
				],
				timestamp: at,
			});
		} else if (t === 'tool_result') {
			let content = '';
			const c = obj.content;
			if (typeof c === 'string') content = c;
			else if (Array.isArray(c)) content = c.map((x: unknown) => (typeof x === 'string' ? x : ((x as { text?: string })?.text ?? ''))).join('');
			else if (c && typeof c === 'object' && typeof (c as { standard_input?: string }).standard_input === 'string')
				content = (c as { standard_input: string }).standard_input;
			if (content.trim()) {
				turns.push({ role: 'tool', blocks: [{ kind: 'tool_result', content: content.slice(0, 3000) }], timestamp: at });
			}
		}
	});
	return turns;
}

// ===== 技能扫描（/ 菜单数据源） =====

export interface SkillInfo {
	name: string;
	description: string;
}

/** 扫描 CodeM 技能目录：~/.agents/skills、~/.codem/skills、managed 下各层 skills 子目录（与 CodeM 运行时加载源一致，不扫 ~/.claude） */
export async function listCodemSkills(): Promise<SkillInfo[]> {
	const home = os.homedir();
	const roots = [path.join(home, '.agents', 'skills'), path.join(home, '.codem', 'skills')];
	const managed = path.join(home, '.codem', 'managed');
	try {
		for (const p of await fs.promises.readdir(managed)) {
			const base = path.join(managed, p);
			try {
				if (!fs.statSync(base).isDirectory()) continue;
			} catch {
				continue;
			}
			roots.push(path.join(base, 'skills'));
			const plugins = path.join(base, 'plugins');
			try {
				for (const pl of await fs.promises.readdir(plugins)) {
					roots.push(path.join(plugins, pl, 'skills'));
				}
			} catch {
				// 无 plugins 目录
			}
		}
	} catch {
		// managed 不存在
	}
	const map = new Map<string, SkillInfo>();
	for (const root of roots) {
		let dirs: string[];
		try {
			dirs = await fs.promises.readdir(root);
		} catch {
			continue;
		}
		for (const d of dirs) {
			const skillMd = path.join(root, d, 'SKILL.md');
			try {
				if (!fs.statSync(skillMd).isFile()) continue;
			} catch {
				continue;
			}
			// 菜单名与去重键统一用 frontmatter 的 name（与 CodeM 运行时注册名一致），缺省回退目录名
			let name = d;
			let description = '';
			try {
				const head = (await fs.promises.readFile(skillMd, 'utf8')).slice(0, 4000);
				const fm = head.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
				if (fm) {
					const lines = fm[1].split(/\r?\n/);
					const nameLine = lines.find((l) => /^name:\s*/.test(l));
					if (nameLine) {
						const v = nameLine.replace(/^name:\s*/, '').replace(/^["']|["']$/g, '').trim();
						if (v) name = v;
					}
					const idx = lines.findIndex((l) => /^description:\s*/.test(l));
					if (idx >= 0) {
						const inline = lines[idx].replace(/^description:\s*/, '').trim();
						if (inline && !/^[|>]/.test(inline)) {
							description = inline.replace(/^["']|["']$/g, '');
						} else {
							// 块标量（| 或 > 开头）：收集后续缩进行，直到下一个顶层键
							const parts: string[] = [];
							for (let j = idx + 1; j < lines.length; j++) {
								if (/^\S/.test(lines[j])) break;
								parts.push(lines[j].trim());
							}
							description = parts.join(' ');
						}
					}
				}
			} catch {
				// 读取失败只留名字
			}
			description = description.slice(0, 100);
			if (map.has(name)) continue;
			map.set(name, { name, description });
		}
	}
	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ===== 豆包会话本地索引（S3：云端会话不落盘，历史面板数据源，存插件 data.json）=====

/** 豆包会话索引条目（key = 云端会话真 ID，由 getRealSessionId 回填） */
export interface DoubaoSessionMeta {
	firstPrompt: string;
	userTurns: number;
	lastTime: string;
	cwd?: string;
}

/** 本地索引 → 历史面板卡片（filePath 空：无本地正文可回显，载入走 --resume 续聊；source 标注后端，Claude 复用同构） */
export function doubaoSessionCards(store: Record<string, DoubaoSessionMeta>, source = 'doubao'): SessionCard[] {
	return Object.entries(store ?? {})
		.filter(([id, m]) => !!id && !!m?.firstPrompt)
		.map(([sessionId, m]) => ({
			sessionId,
			filePath: '',
			firstPrompt: m.firstPrompt.slice(0, 80),
			startTime: '',
			lastTime: m.lastTime || '',
			userTurns: m.userTurns ?? 0,
			toolCalls: 0,
			cwd: m.cwd ?? '',
			source,
		}))
		.sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
}

// ===== Claude 会话全量扫描（CC2：~/.claude/projects 本地落盘，历史面板数据源，2026-11-10）=====

/**
 * 扫描 ~/.claude/projects 下全部 Claude Code 会话（按 cwd 分目录的 <uuid>.jsonl）→ 历史面板卡片。
 * 实测结构：首行 queue-operation{operation:'enqueue',content=用户原文,timestamp}；User/assistant 行含 cwd；
 * 会话 ID 即文件名，--resume 跨进程续聊同口径。插件本地索引作合并兜底（磁盘被清理的记录仍可见）。
 * CC6：并入 ~/.claude/archives 归档目录（Claude Code 自动清理移出的旧会话，行结构同构；📦 前缀标记，仅回显不可续聊）。
 */
export async function claudeSessionCards(extra: Record<string, DoubaoSessionMeta> = {}): Promise<SessionCard[]> {
	const root = path.join(os.homedir(), '.claude', 'projects');
	// CC6：files 带归档标记——projects=活跃会话（--resume 可续聊）；archives=Claude Code 自动清理移出的
	// 旧会话（~/.claude/archives/<uuid>_<日期>.jsonl，行结构同构探针实测，解析器复用；仅回显不可续聊）
	const files: { filePath: string; archived: boolean }[] = [];
	try {
		for (const d of await fs.promises.readdir(root)) {
			const dir = path.join(root, d);
			try {
				if (!(await fs.promises.stat(dir)).isDirectory()) continue;
				for (const f of await fs.promises.readdir(dir)) {
					if (f.endsWith('.jsonl')) files.push({ filePath: path.join(dir, f), archived: false });
				}
			} catch {
				continue;
			}
		}
		// CC6：归档目录并入扫描（2026-11-13 实测 114 个会话，单文件最大 7MB）
		try {
			const archRoot = path.join(os.homedir(), '.claude', 'archives');
			for (const f of await fs.promises.readdir(archRoot)) {
				if (f.endsWith('.jsonl')) files.push({ filePath: path.join(archRoot, f), archived: true });
			}
		} catch {
			// 无归档目录则跳过
		}
	} catch {
		return [];
	}
	const cards: SessionCard[] = [];
	for (const { filePath, archived } of files) {
		// sessionId：projects=<uuid>.jsonl / archives=<uuid>_<日期>.jsonl——UUID 不含下划线，split 通吃两种命名
		const sessionId = path.basename(filePath).replace(/\.jsonl$/, '').split('_')[0];
		if (cards.some((c) => c.sessionId === sessionId)) continue; // projects 与归档去重（防御性，正常不共存）
		let firstPrompt = '';
		let cwd = '';
		try {
			// 快扫文件头 64KB（首问 + cwd 必在其中），同 codem buildCard 性能策略
			const fh = await fs.promises.open(filePath, 'r');
			const buf = Buffer.alloc(65536);
			const { bytesRead } = await fh.read(buf, 0, 65536, 0);
			await fh.close();
			const text = buf.toString('utf8', 0, bytesRead);
			for (const line of text.split('\n')) {
				if (firstPrompt && cwd) break;
				if (!line.trim()) continue;
				let obj: Record<string, unknown>;
				try {
					obj = JSON.parse(line);
				} catch {
					continue;
				}
				if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
				if (firstPrompt) continue;
				if (obj.type === 'queue-operation' && obj.operation === 'enqueue' && typeof obj.content === 'string') {
					firstPrompt = obj.content;
				} else if (obj.type === 'User') {
					// 兜底：无 queue-operation 的会话取 User 行；跳过系统注入（CLAUDE.md 指令/命令包裹）
					const msg = obj.message as { content?: unknown } | undefined;
					const c = msg?.content;
					const t =
						typeof c === 'string'
							? c
							: Array.isArray(c)
								? c.map((b) => (typeof b === 'string' ? b : ((b as { text?: string })?.text ?? ''))).join('')
								: '';
					if (t && !t.startsWith('<')) firstPrompt = t;
				}
			}
		} catch {
			continue;
		}
		if (!firstPrompt) continue; // 空会话不进列表
		let st: fs.Stats;
		try {
			st = await fs.promises.stat(filePath);
		} catch {
			continue;
		}
		cards.push({
			sessionId,
			filePath,
			// 📦 前缀标记归档会话；CC11：首问摘要先压缩（linked_content 拼接全文 → 真实输入），再截 80 字
			firstPrompt: (archived ? '📦 ' : '') + compressClaudeUserInput(firstPrompt).replace(/\s+/g, ' ').slice(0, 80),
			startTime: '',
			lastTime: new Date(st.mtimeMs).toISOString(),
			userTurns: 0,
			toolCalls: 0,
			cwd,
			source: 'claude',
		});
	}
	// 插件本地索引合并兜底：磁盘文件被清理/归档的会话记录仍可列出
	for (const [id, m] of Object.entries(extra ?? {})) {
		if (!id || !m?.firstPrompt || cards.some((c) => c.sessionId === id)) continue;
		cards.push({
			sessionId: id,
			filePath: '',
			firstPrompt: m.firstPrompt.slice(0, 80),
			startTime: '',
			lastTime: m.lastTime || '',
			userTurns: m.userTurns ?? 0,
			toolCalls: 0,
			cwd: m.cwd ?? '',
			source: 'claude',
		});
	}
	cards.sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
	return cards;
}

// ===== Claude 会话回显解析（CC5：~/.claude/projects jsonl → Turn[]，历史面板回显正文）=====

/**
 * CC11：压缩超长用户输入（回显用）——终端/Claudian 会话的 enqueue 常为拼接全文：
 * linked_content 标签 + 引用展开 + 历史消息 + 末尾真实输入。规则：
 * ① <linked_content path="x"/> → 文件名占位；② 拼接格式取末段「User: 」后的真实输入；
 * ③ 仍超长（终端粘贴日志等）截断加标记。插件自己的会话 enqueue 本就是短输入，原样保留。
 */
function compressClaudeUserInput(text: string): string {
	let s = text;
	// ① 引用笔记标签 → 文件名占位（去标签体，保引用可读）
	s = s.replace(/<linked_content\s+path="([^"]+)"\s*\/??>/g, '［引用笔记：$1］');
	// ② Claudian 历史拼接：多段「User: 真实输入」，末段才是当次输入（其余为回放历史全文）
	if (s.length > 400) {
		const parts = s.split(/\]?\s*User:\s/);
		if (parts.length > 1) s = parts[parts.length - 1];
	}
	// ③ 兜底截断（终端粘贴的安装日志等无分段）
	if (s.length > 400) {
		s = s.slice(0, 400) + `\n…（已压缩显示，原文 ${text.length} 字）`;
	}
	return s.trim();
}

/**
 * 读取 Claude Code 会话完整轮次（历史回显用，CC5/CC10）。
 * 行结构（2026-11-13/14 探针实测）：
 * - queue-operation{operation:'enqueue',content=用户原文,timestamp} → 用户消息
 * - assistant{message:{content:[thinking|text|tool_use 块]}} → 每行独立 turn（CC10：不再合并连续行——
 *   真实执行顺序是 text → 工具 → 结果 → text 穿插，合并会导致正文与工具卡两极分堆）
 * - User 行（message.content 数组）提取 tool_result → 独立 tool turn（渲染层 merged 管线
 *   自动并入前一个 tool_use 卡片，还原「工具卡带结果」的真实形态；仅取 tool_result，
 *   不取 string content——避免与 queue-operation 的用户输入重复计轮）
 * - isSidechain=true 为子代理行跳过；带 attachment 的指令注入行无 message，自然跳过
 * 大会话保护（CC10）：按「问」截断——保留最近 maxTurns 问（每问 user/assistant/tool 全过程），
 * 而非按 turn 数截（独立 turn 后总量 3 倍于问数，按 turn 截会腰斩中间过程）。
 */
export async function readClaudeSessionTurns(filePath: string, maxTurns = 20): Promise<Turn[]> {
	const turns: Turn[] = [];
	const tsOf = (obj: Record<string, unknown>): string =>
		typeof obj.timestamp === 'string' ? obj.timestamp : '';
	await parseJsonlLines(filePath, (obj) => {
		if (obj.isSidechain === true) return; // 子代理
		const t = obj.type as string;
		if (t === 'queue-operation' && obj.operation === 'enqueue') {
			const text = typeof obj.content === 'string' ? obj.content : '';
			if (text.trim() && !text.startsWith('<')) {
				// CC11：超长输入压缩（终端/Claudian 拼接全文 → 只留真实输入 + 文件名占位）
				turns.push({ role: 'user', blocks: [{ kind: 'text', content: compressClaudeUserInput(text) }], timestamp: tsOf(obj) });
			}
		} else if (t === 'assistant') {
			const content = (obj.message as { content?: unknown[] } | undefined)?.content;
			const blocks: TurnBlock[] = [];
			if (Array.isArray(content)) {
				for (const b of content as Array<Record<string, unknown>>) {
					if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
						blocks.push({ kind: 'thinking', content: b.thinking });
					} else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
						blocks.push({ kind: 'text', content: b.text });
					} else if (b?.type === 'tool_use') {
						const name = typeof b.name === 'string' ? b.name : '工具';
						const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}, null, 2);
						blocks.push({ kind: 'tool_use', label: name, content: input.slice(0, 2000) });
					}
				}
			}
			// CC10：每行独立 turn，不再合并——保持 jsonl 行序（真实执行顺序）
			if (blocks.length) turns.push({ role: 'assistant', blocks, timestamp: tsOf(obj) });
		} else if (t === 'User') {
			// CC10：工具结果回传行——提取 tool_result 为独立 tool turn（渲染层并入前一个工具卡）
			const content = (obj.message as { content?: unknown } | undefined)?.content;
			if (!Array.isArray(content)) return;
			for (const b of content as Array<Record<string, unknown>>) {
				if (b?.type !== 'tool_result') continue;
				const c = b.content;
				const rc =
					typeof c === 'string'
						? c
						: Array.isArray(c)
							? c.map((x: unknown) => (typeof x === 'string' ? x : ((x as { text?: string })?.text ?? ''))).join('')
							: '';
				if (rc.trim()) {
						turns.push({ role: 'tool', blocks: [{ kind: 'tool_result', content: rc.slice(0, 3000) }], timestamp: tsOf(obj) });
					}
			}
		}
	});
	// CC10：按「问」截断——从尾部倒数第 (maxTurns+1) 个 user turn 处截掉更早过程（保留该问完整链路）
	if (turns.length) {
		let questions = 0;
		let cut = 0;
		for (let i = turns.length - 1; i >= 0; i--) {
			if (turns[i].role !== 'user') continue;
			questions++;
			if (questions > maxTurns) {
				cut = i + 1;
				break;
			}
		}
		return cut > 0 ? turns.slice(cut) : turns;
	}
	return turns;
}

/** CC7：按 sessionId 定位 Claude 会话文件（projects 活跃 + archives 归档，两处扫描）——tab 恢复回显用 */
export async function findClaudeSessionFile(sessionId: string): Promise<string> {
	if (!sessionId) return '';
	const home = os.homedir();
	// projects/<cwdDir>/<sessionId>.jsonl（活跃会话，按 cwd 子目录扫）
	try {
		const root = path.join(home, '.claude', 'projects');
		for (const d of await fs.promises.readdir(root)) {
			const p = path.join(root, d, sessionId + '.jsonl');
			try {
				if ((await fs.promises.stat(p)).isFile()) return p;
			} catch {
				continue;
			}
		}
	} catch {
		// 无目录则继续试归档
	}
	// archives/<sessionId>_<日期>.jsonl（归档会话，前缀匹配）
	try {
		const arch = path.join(home, '.claude', 'archives');
		for (const f of await fs.promises.readdir(arch)) {
			if (f.startsWith(sessionId) && f.endsWith('.jsonl')) return path.join(arch, f);
		}
	} catch {
		// 无归档目录
	}
	return '';
}
