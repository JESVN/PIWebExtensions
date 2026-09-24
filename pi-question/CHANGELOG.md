# 变更记录

版本号指**契约/行为版本**（见 [DESIGN.md](DESIGN.md)），与 `package.json` 的包版本无关。

## v1.2

- **输入层可回退**：误点「其他（我来输入）」后，在输入框按 `Esc`、点「取消」或直接空提交 →
  重新弹出选项列表；只有**选项层**取消才算真正取消。
- 把 `execute` 的 `signal` 透传给 `select()` / `input()`：`Stop` 中断与回退都能识别，点 Stop 不再误弹选项框。
- 兜底 `MAX_BACKS = 20`：连续回退超过上限后按取消处理，避免异常客户端无限弹窗。
- 输入框增加 placeholder 提示可回退（pi TUI 会忽略 placeholder，属已知差异）。

## v1.1

- `description` / `promptGuidelines` / `promptSnippet` 改为**动作触发式**文案，修复弱模型把候选选项写进正文
  而不调用工具的问题；同时补上 `promptSnippet`（内核只把带 snippet 的工具列入 Available tools）。

## v1.0

- 首个可用版本：`question` 工具（可点击选项、`description` 展示、「其他」自由输入、取消语义、非交互降级）。

## 仓库维护

- 2026-09：开源（MIT）。开源前移除部署域名、端口与各机器绝对路径，并重写了 git 历史。
