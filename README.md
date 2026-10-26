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
- **Permission modes**: 🔒 manual / ✨ smart (auto-approve read-only tools) / 🤖 YOLO — one-click switch at the composer
- **Input history & drop**: recall the last 50 prompts with ↑/↓ in an empty input, Ctrl/Cmd+Enter to send, drag-and-drop images
- **Turn navigation**: floating buttons jump between user turns in long conversations

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

## 📋 待办

> 2026-10-26 整理：对标叶版 v1.19.2（同源平行演化路线）已验证能力 + 用户 UI 反馈。优先级从上到下。

### v0.4.0 可靠性三件套（P0，低成本高收益）✅ 已全部完成（2026-10-26）

- [x] **审批看门狗**：5 分钟超时自动拒绝并 UI 留痕；停止/轮末回收挂起审批回 decline——修掉审批条永久挂死（10-26 崩溃会话真实踩过）
- [x] **error 状态灯**：失败/强制收尾不复用 done（红=失败）；完整六态状态机留待后续
- [x] **ACP 传输层超时**：request() 加默认 300s 超时（session/prompt 除外，由 watchdog 兜底）

### 多会话工作流（P1，适配"常新开会话、单会话 ≤100 轮"的使用模式）

- [ ] **会话持久化**：getState/setState，重启 Obsidian 不丢 tab（10-26 崩溃恢复时全靠手动历史载入）
- [ ] **会话归档/排序/时间分组**：今天/昨天/本周/更早分组 + 归档收纳 + 四种排序
- [ ] **队列面板化**：inputQueue 已有数据结构，补 UI——输入框上方全量列表 + 逐条编辑/删除 + 上限 8 条
- [ ] **命令前缀授权记忆**：按"前两个词"记（如 npm install），比按工具名记忆细一档

### 输入框 UI 对标叶版（P1.5）✅ 已完成（v0.5.0，2026-10-26）

- [x] **输入历史 ↑↓**：输入框空白时调取最近 50 条 prompt（本次会话内有效）
- [x] **Cmd/Ctrl+Enter 发送**：Enter 仍发送、Shift+Enter 换行
- [x] **图片拖拽上传**：拖入输入区即预览（原来仅粘贴）
- [x] **权限模式 chip**：底部按钮一键循环 🔒手动 / ✨智能（只读自动）/ 🤖YOLO；设置项改为初始档位

### 输出界面对标叶版（P1.5）✅ 除消息操作行外已完成（v0.5.0）

- [x] **工具卡分类配色**：bash/edit/search/web 图标分色 + 写操作「⚠ 可写」徽章
- [x] **代码块语言标签 + 复制按钮**（hover 显现）
- [x] **diff 双列视图**：左删除侧/右新增侧，ctx 双列同显
- [ ] **消息 hover 操作行**：复制/编辑重发/重新生成（留待下轮，涉及轮次截断逻辑）
- [x] **运行读数**：轮次头部实时计时，180s 无响应转「⚠ 长时间无响应」
- [x] **审批等待横幅**：消息区顶部常驻「⏸ 等待你批准」，应答/超时后移除（后台 Tab 另有 Notice）
- [x] **工具失败归类**：exit 127/126/124 人话化置顶提示

### 工程方法（随版本持续）

- [ ] **12 条回归自检清单**：每个 request 有无超时 / 停止是否回收挂起 / 失败路径灯是否不同等，每次改动后过一遍
- [ ] **断言式回归测试**：TS 源码写测试比叶版（minified 产物 60+77 断言）容易，优先覆盖队列与权限路径

### 远期（P3，先探针再动工）

- [ ] **checkpoint 回滚**：需探针 CLI checkpoints/rewind 能力（文件真还原 + 对话真回退 + 回滚并重问）
- [ ] **权限三档接 CLI 服务端参数**：需探针 --permission-mode 在当前 CLI 版本行为
- [ ] **i18n / 无障碍**：locale 表 + aria 全覆盖（参照叶版 469 键三语方案）
- [ ] **消息虚拟化**：单会话几百轮再考虑（直接借鉴叶版 claudian-virtualizer 方案与踩坑记录）

## License

[MIT](LICENSE)

## 致谢

- 布局与交互设计参考 Claudian（Obsidian AI 对话插件）的设计思路：侧边栏对话视图、多会话 Tab、流式渲染。
- **叶葳（叶部）**：v0.5.0 的 UI 对标主要参考其 CodeM Chat v1.19.2 分享包——输入框交互（输入历史 / Ctrl+Enter / 拖拽图片 / 权限模式三档）与输出界面（工具卡分类配色 / 代码块装饰 / 双列 diff / 运行读数 / 审批横幅 / 失败归类）的设计与实测结论，已列入合作作者。
