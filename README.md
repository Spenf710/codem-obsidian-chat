# CodeM Chat

Embed CodeM (Feishu AI coding agent) into Obsidian as a sidebar chat. Your vault becomes the agent's working directory.

将 CodeM（飞书 AI 研发智能体）嵌入 Obsidian 侧边栏，获得流畅的 AI 结对对话体验。

## Features

- **ACP protocol streaming**: JSON-RPC over stdio, replies render character by character with live thinking and tool-call cards
- **Multi-session tabs**: run several sessions in parallel in one view; each tab has a three-color status light (idle / running / done)
- **Session history**: scans local CodeM sessions (`~/.codem/sessions`), replays any past conversation and resumes it natively; falls back to snapshot context when a session is held by another client
- **AI session titles**: a Chinese title is generated from your first exchange
- **`/` skills**: lists CodeM and local skills, searchable by Chinese description
- **`@` references**: fuzzy search or drill-down browse; `[[note]]` and `[[folder]]` contents are injected into context
- **Image paste**: paste screenshots from the clipboard (base64 inline, decoded by CodeM)
- **Permission levels**: Request approval / Approve for me (auto-approve read-only tools) / Full access — one-click switch at the composer, with icons matching the CodeM client
- **Input history & drop**: recall the last 50 prompts with ↑/↓ in an empty input, Ctrl/Cmd+Enter to send, drag-and-drop images
- **Turn navigation**: floating buttons jump between user turns in long conversations
- **Reliability**: permission watchdog (auto-decline after 5 min), RPC timeouts, per-tab error status light
- **Prompt queue**: queue messages while the agent is busy — per-tab ownership, reorder, edit, Steer (stop current turn and send next)
- **Session management**: archive / sort / time-group history, tab state persistence across Obsidian restarts, session source labels (Feishu / terminal / client)
- **Message actions**: copy / edit-resend / quote / regenerate / retry on hover
- **In-session search**: Ctrl+Shift+F with match highlighting and count navigation
- **Checkpoint rollback**: revert file changes recorded in CodeM snapshots (terminal / Feishu sessions; ACP sessions don't record snapshots)
- **Smart composer**: permission levels, intelligence level and Plan mode wired to CodeM CLI flags

## Prerequisites

- **Windows 10/11** (the plugin launches CodeM CLI via `cmd /c`)
- [Obsidian](https://obsidian.md) 1.7.2 or later
- The CodeM CLI installed and logged in (`codem` on PATH, or configure the path in plugin settings)

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

The plugin runs entirely on your machine. It reads `~/.codem/sessions` and `~/.codem/history.jsonl` for session history, and generates titles via your local CodeM CLI. Prompts are sent only to the CodeM backend configured by your own CodeM login; the plugin has no telemetry.

## Development

```bash
npm install     # install dependencies
npm run dev     # build with inline sourcemaps
npm run build   # production build
```

## License

[MIT](LICENSE)

## 致谢

- 布局与交互设计参考 Claudian（Obsidian AI 对话插件）的设计思路：侧边栏对话视图、多会话 Tab、流式渲染。
- **Ye Wei**: co-author. UI and interaction design informed by his CodeM Chat fork — input history, Ctrl+Enter, drag-and-drop images, permission levels; tool card coloring, code block decoration, two-column diff, live readout, approval banner, and failure classification.
