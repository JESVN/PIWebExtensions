# pi-quota

> 仓库：<https://github.com/JESVN/PIWebExtensions>（子目录 `pi-quota/`）· 许可：[MIT](LICENSE)

在 **pi** / **pi-web** 的会话里直接查询模型服务商的额度与用量。当前支持 **OpenCode Go**。

| 入口 | 用法 | 结果落点 |
|---|---|---|
| 工具 `provider_quota` | 直接问「查额度」「用量」「还剩多少」 | 聊天区的工具卡片 |
| 斜杠命令 `/quota` | 在输入框敲 `/quota` | 以自定义消息落到聊天区，并弹一条通知 |

输出示例：

| 窗口 | 已用 | 剩余 | 重置 |
| --- | --- | --- | --- |
| 滚动窗口 | 3% | 97% | 今天 09:43 |
| 本周 | 10% | 90% | 09-28 08:00 |
| 本月 | 71% | 29% | 10-02 15:32 |

⚠️ 本月已用 71%，注意剩余可用量。（已用 ≥ 70% 时自动追加这一行）

## 为什么需要它

pi-web `0.9.2` 起内置了「用量」面板，但它只出现在**由 pi-web 自己管理凭据（`auth.json`）**的服务商卡片里：

- `/api/auth/providers` 会**主动隐藏**凭据来自 `models.json` 的服务商
  （`status.source ∈ {models_json_key, models_json_command}` → `continue`）；
- 因此当 key 写在 `models.json` 或环境变量里时，**网页 UI 上没有任何入口**。

本扩展直接调用同一个官方接口，绕开这个限制，并且 pi CLI/TUI 里同样可用。

## 安装

二选一（**不要同时用**，否则工具会重复注册）：

```bash
# 方式一：软链（开发期推荐，改代码免复制）
ln -sfn "$(pwd)/extensions/quota.ts" ~/.pi/agent/extensions/quota.ts

# 方式二：作为 pi 包安装（会写用户 settings）
pi install "$(pwd)"
```

装好后**新开一个会话**才生效——扩展在会话启动时加载。

## 凭据解析顺序

1. `ctx.modelRegistry`（与 pi 内部一致：环境变量 → `auth.json` → `models.json`）
2. 环境变量 `OPENCODE_API_KEY`
3. `<agent-dir>/auth.json` → `["opencode-go"]`
4. `<agent-dir>/models.json` → `providers["opencode-go"].apiKey`

以 `!` 开头的（命令式取密钥）不会被执行，会跳过。`<agent-dir>` 取 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`。

## 测试

```bash
PI_KERNEL_DIR="<pi-web 安装目录>/node_modules/@earendil-works/pi-coding-agent" node test/smoke.mjs
```

冒烟测试用**内核自带的 loader 加载真实的 `extensions/quota.ts`**，并用假的 `ctx` / 假的 `fetch` / 临时
`PI_CODING_AGENT_DIR` 覆盖全部分支，**不联网、不碰用户数据**。仓库不内置任何本机绝对路径。

## 实现要点

- 接口：`GET https://opencode.ai/zen/go/v1/usage`，头 `Authorization: Bearer <key>`，`redirect: "error"`，15s 超时。
- 原始响应形如 `{"usage":{"rolling":{"status":"ok","percent":N,"resetsAt":"..."},"weekly":{...},"monthly":{...}}}`；
  **`percent` 是「已用」百分比**，剩余需要自己算 `100 - percent`。
- 时间统一按 `Asia/Shanghai` 展示，当天显示为「今天 HH:MM」。
- 上游对 Python `urllib` 的 User-Agent 返回 **403**，必须用 node 的 `fetch`（与 pi-web 内部一致）。

## 已知限制

- 只实现了 OpenCode Go；其它服务商（DeepSeek / OpenRouter / Moonshot / MiniMax / Vercel AI Gateway /
  OpenAI Codex）的响应格式各不相同，需要逐个适配。
- 扩展运行在 pi 进程内，会读取本机凭据文件；只从可信来源安装扩展。
- 不建议为了这个功能改用 UI 的「**添加 Provider**」：那会把 key 写进 `auth.json`，与 `models.json` 里的
  key 并存，两者的优先级未经验证，无必要不要改动既有的模型配置。
