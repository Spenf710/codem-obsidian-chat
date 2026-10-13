# CodeM Chat · Obsidian Sidebar Chat for CodeM

Embed CodeM (Feishu AI coding agent) into Obsidian as a sidebar chat. Your vault becomes the agent's working directory.

将 CodeM（飞书 AI 研发智能体）嵌入 Obsidian 侧边栏，获得流畅的 AI 结对对话体验：流式回复、思考过程、工具调用、会话回溯，全部在笔记库里完成。

![screenshot placeholder]

## Features / 功能

- **ACP 协议长连接**：JSON-RPC over stdio 双向通信，实时流式输出（回复逐字渲染、思考过程实时展开）
- **多会话 Tab**：单视图内多个会话并行执行，每个 Tab 三色灯指示状态（灰=静默 / 黄=执行中 / 绿=完成）
- **会话历史追溯**：扫描 CodeM 本地会话（`~/.codem/sessions`），一键载入回显并原生续接；跨端占用时自动降级为快照续聊
- **AI 会话标题**：首轮对话结束后自动生成中文标题
- **`/` 技能**：列出 CodeM 及本地技能，支持中文描述检索
- **`@` 引用**：全局检索或目录钻取，`[[笔记]]` 与 `[[文件夹]]` 内容自动注入上下文
- **图片粘贴**：剪贴板截图直接粘贴发送（base64 内嵌，CodeM 端识图）
- **YOLO 模式**：一键切换工具权限自动批准
- **轮次导航**：侧边悬浮按钮组在多轮长对话中快速定位每一轮提问

## Prerequisites / 前置要求

- **Windows 10/11**（当前版本仅支持 Windows：CodeM CLI 以 `codem.cmd` 形态发行，插件经 `cmd /c` 启动、`taskkill` 结束进程树）
- Obsidian ≥ 1.5.0（desktop only，依赖本地进程）
- 已安装并登录 CodeM CLI（`~/.codem/bin/codem.cmd`，支持在设置中自定义路径）
- Node.js（用于启动 CodeM CLI，支持在设置中指定目录，默认自动探测）

## Install / 安装

1. 下载 `main.js`、`styles.css`、`manifest.json` 放入你的 Vault：

```
<Vault>/.obsidian/plugins/codem-chat/
```

2. 在 Obsidian 设置 → 第三方插件中启用 **CodeM Chat**。
3. 打开右侧边栏的消息图标，开始对话。

## Privacy Notes / 隐私说明

- 插件仅在本机运行：读取 `~/.codem/sessions` 与 `~/.codem/history.jsonl` 用于会话追溯；生成标题通过本机 CodeM CLI 完成
- 不包含任何遥测；对话内容仅流向你配置的 CodeM 服务
- 排障日志写入插件目录 `debug.log`（已被 git 忽略），可随时删除

## Development / 开发

```bash
npm install
npm run build   # 类型检查 + esbuild 产物输出 main.js
```

## Acknowledgements / 致谢

交互设计参考了 Claudian（Obsidian 社区插件）的设计思路：侧边栏聊天布局、多会话 Tab、权限确认交互。特此致谢。

## License

MIT
