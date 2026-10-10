import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/**
 * 轻量 markdown 渲染（替代 MarkdownRenderer.render，后者在部分插件上下文静默失败）。
 * marked 解析 + DOMPurify 白名单净化：防 LLM 输出 HTML/脚本注入，代码块内容不二次转义。
 */
export function renderMarkdown(md: string): string {
	return DOMPurify.sanitize(marked.parse(md) as string);
}
