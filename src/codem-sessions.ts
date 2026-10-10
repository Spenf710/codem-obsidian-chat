import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ===== CodeM 会话数据层（移植自猛士驾驶舱 codemScanner，精简版） =====
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

/** 扫描 CodeM/Claude 技能目录：~/.claude/skills、~/.codem/skills、managed 下各层 skills 子目录 */
export async function listCodemSkills(): Promise<SkillInfo[]> {
	const home = os.homedir();
	const roots = [path.join(home, '.claude', 'skills'), path.join(home, '.codem', 'skills')];
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
			if (map.has(d)) continue;
			let description = '';
			try {
				const head = (await fs.promises.readFile(skillMd, 'utf8')).slice(0, 800);
				const m = head.match(/^---\s*\n([\s\S]*?)\n---/);
				if (m) {
					description = (m[1].match(/^description:\s*(.+)$/m)?.[1] ?? '')
						.replace(/^["']|["']$/g, '')
						.slice(0, 100);
				}
			} catch {
				// 读取失败只留名字
			}
			map.set(d, { name: d, description });
		}
	}
	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
