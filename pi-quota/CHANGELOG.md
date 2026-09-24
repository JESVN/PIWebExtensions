# Changelog

本项目遵循「一个版本一段说明」的简记法；类型用 `新增 / 修复 / 变更 / 文档 / 内部`。

## 0.1.0 — 2026-09-24

### 新增

- 工具 `provider_quota`：查询模型服务商额度用量（滚动窗口 / 周 / 月，含重置时间），
  已用 ≥ 70% 时自动追加提醒行。
- 斜杠命令 `/quota`：结果以自定义消息落到聊天区，并弹一条通知（旧内核不支持自定义消息时降级为纯通知）。
- 凭据解析顺序：`ctx.modelRegistry` → `OPENCODE_API_KEY` → `auth.json` → `models.json`；
  跳过以 `!` 开头的命令式密钥。
- 冒烟测试 `test/smoke.mjs`：用内核 loader 加载真实扩展，mock `ctx`/`fetch`/临时 agent 目录，全离线。

### 背景

pi-web 0.9.2 内置的「用量」面板只对由 pi-web 管理凭据（`auth.json`）的服务商显示；
凭据来自 `models.json` 的服务商会被 `/api/auth/providers` 主动隐藏，UI 上没有入口。本扩展补齐该能力。

### 已知限制

- 目前只支持 OpenCode Go；其它服务商响应格式不同，需要逐个适配。
