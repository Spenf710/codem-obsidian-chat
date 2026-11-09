// ===== Agent 后端抽象层（豆包集成 S1，2026-11-09）=====
// 上层调用点（view.ts）一律面向本接口；具体实现：
//  - AcpClient（acp-client.ts）：CodeM ACP 长驻双向流实现（本接口形状即按其公开面设计）
//  - DoubaoBackend（doubao-backend.ts，S2 待建）：豆包 CLI 每轮 `-p` 单次调用实现
// S1 目标「ACP 零回归」：接口与 AcpClient 公开方法完全同构，调用点仅改类型引用。

/** 提示词内容块（与 ACP session/prompt 同构：text / image{data,mimeType}） */
export type PromptBlock = Record<string, unknown>;

/** 后端能力声明：上层按能力条件渲染，降级决策收敛于此（豆包三项均 false） */
export interface AgentBackendCapabilities {
	/** 是否有真流式推送（session/update delta 逐段到达） */
	streaming: boolean;
	/** 是否有反向权限请求（session/request_permission 逐条确认 UI） */
	permissionRequests: boolean;
	/** 是否能重放历史会话正文（loadSession 重放 / 磁盘 jsonl 回显） */
	sessionReplay: boolean;
}

/**
 * Agent 后端接口。prompt 返回 stopReason 字符串（ACP 语义：end_turn / cancelled…），
 * 豆包后端映射到同一词表：进程正常退出 = end_turn，taskkill 取消 = cancelled。
 * 会话 ID 由 newSession 分配；DoubaoBackend 首轮后才拿到云端真 ID，见其实现注释。
 */
export interface AgentBackend {
	readonly name: string;
	readonly capabilities: AgentBackendCapabilities;
	/** 新建会话，返回 sessionId */
	newSession(): Promise<string>;
	/** 发送一轮对话（content blocks），resolve 值为 stopReason */
	prompt(sessionId: string, blocks: PromptBlock[]): Promise<string>;
	/** 载入历史会话（豆包对应 --resume 语义），载入后可继续 prompt */
	loadSession(sessionId: string, cwd?: string): Promise<void>;
	/** 释放会话（豆包为 no-op：每轮独立进程，无 daemon 占用） */
	closeSession(sessionId: string): Promise<void>;
	/** 取消该会话进行中的一轮 */
	cancelSession(sessionId: string): void;
	/** 杀掉后端进程 / 释放资源 */
	stop(): void;
}
