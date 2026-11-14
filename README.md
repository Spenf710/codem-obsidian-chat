# CodeM Chat

Tri-backend AI chat for Obsidian — run **CodeM (Feishu AI coding agent)**, **Doubao CLI** and **Claude Code** side by side in one sidebar chat. Your vault becomes each agent's working directory.

将三个 AI 研发智能体（CodeM / 豆包 CLI / Claude Code）嵌入 Obsidian 侧边栏，同一视图内并行对话、标签页自由切换。

## Features

### v2.0 — Tri-backend simultaneous sessions

- **Three agents, one view**: every tab binds its own backend (CodeM ACP / Doubao CLI / Claude Code) — start a 30-minute Doubao task in one tab and keep chatting with Claude in another. The bottom chip row (backend / model / effort) follows the active tab in real time
- **Doubao CLI backend**: per-turn `-p` invocation with `--resume` session continuity; model & effort chips wired to `--model` / `--effort`; permission levels mapped to `--permission-mode`; long cloud tasks (30–40 min) are no longer killed by the idle watchdog
- **Claude Code backend**: `stream-json` true streaming with live thinking; model tier chip shows real model names resolved from `~/.claude/settings.json` (e.g. `deepseek-flash`); thinking budget chip injects `MAX_THINKING_TOKENS`; sessions resume via `--resume`
- **Full local history for Claude Code**: scans `~/.claude/projects` *and* `~/.claude/archives` (archived sessions included), replays conversations in the real execution order (text → tool call → result interleaved, per-question truncation for huge sessions)
- **Claudian-style nested "Work" collapsible**: while a turn runs, thinking and tool executions live inside a collapsible Work item (shown by default, hide it with one click); on completion it becomes "Completed work (N tools)" and folds away, leaving a clean transcript; tool rows are single-line entries (icon + name + args summary + ✓) that expand to full results
- **Replay input compression**: 20k-char pasted or skill-expanded prompts in terminal/Claudian-style sessions are compressed to the actual question; `<linked_content>` note injections shown as file-name chips
- **Per-backend settings sections**: 💬 CodeM / 🫘 Doubao / 🤖 Claude Code / 🎛️ Common — environment self-check and one-click install per backend
- **Tab restore without masquerade**: reopening Obsidian replays the real history of a restored Claude tab instead of an empty shell that silently resumes the old session

### Core

- **ACP protocol streaming** (CodeM backend): JSON-RPC over stdio, replies render character by character with live thinking and tool-call cards
- **Multi-session tabs**: several sessions in parallel in one view; three-color status light per tab; tab state persists across Obsidian restarts
- **Session history & management**: archive / sort / time-group history, session source labels (Feishu / terminal / client / Doubao / Claude); AI-generated Chinese titles; checkpoint rollback for terminal / Feishu sessions
- **`/` skills & `@` references**: searchable skill list; fuzzy `@note` / `@folder` references with content injection; `[[wikilink]]` citation blocks under replies
- **Image paste**: clipboard screenshots (base64 inline) — ask about a screenshot directly
- **Permission levels**: Request approval / Approve for me / Full access — one-click switch at the composer, mapped per backend
- **Prompt queue**: queue messages while the agent is busy — per-tab ownership, reorder, edit, Steer (stop current turn and send next)
- **Input history & shortcuts**: recall the last 50 prompts with ↑/↓ in an empty input, Ctrl/Cmd+Enter to send, drag-and-drop images
- **Turn navigation & in-session search**: floating buttons jump between user turns; Ctrl+Shift+F with match highlighting
- **Message actions**: copy / edit-resend / quote / regenerate / retry on hover
- **Reliability**: per-backend watchdog (5-min notice; force-finish only for the ACP long connection), RPC timeouts, per-tab error status, friendly error translation table

## Prerequisites

- **Windows 10/11**
- [Obsidian](https://obsidian.md) 1.7.2 or later
- Any **one** of the three backends, installed and logged in:
  - **CodeM CLI** (`codem` on PATH, or configure the path in plugin settings)
  - **Doubao CLI** (`doubao` / `doubao.exe`, npm package `@bytedance/doubao-cli`; one-click install in plugin settings)
  - **Claude Code CLI** (`claude`; model routing follows `~/.claude/settings.json`)
- Node.js 18+ (only if you build from source)

## Install

### From release

1. Download the latest release assets from the [Releases](https://github.com/Spenf710/codem-obsidian-chat/releases) page
2. Copy `main.js`, `manifest.json` and `styles.css` into `<Vault>/.obsidian/plugins/codem-chat/`
3. Enable the plugin in Obsidian (Settings → Community plugins)

### Manual build

```bash
npm install
npm run build
```

## Privacy

The plugin runs entirely on your machine. It reads `~/.codem/sessions`, `~/.claude/projects` and `~/.claude/archives` for session history, and generates titles via the local CodeM CLI. Prompts are sent only to the backend you are logged into; the plugin has no telemetry.

## Development

```bash
npm install     # install dependencies
npm run dev     # build with inline sourcemaps
npm run build   # production build
```

## License

[MIT](LICENSE)

## 致谢

- 布局与交互设计参考 Claudian（Obsidian AI 对话插件）：侧边栏对话视图、多会话 Tab、流式渲染，以及 v2.0 的「工作/已完成工作」嵌套折叠与思考过程展示方式。
- **Ye Wei**: co-author. UI and interaction design informed by his CodeM Chat fork — input history, Ctrl+Enter, drag-and-drop images, permission levels; tool card coloring, code block decoration, two-column diff, live readout, approval banner, and failure classification.
