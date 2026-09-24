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

pi 从 `<agent-dir>/extensions/` 加载扩展。`<agent-dir>` 默认是 `~/.pi/agent`，可用环境变量 `PI_CODING_AGENT_DIR` 覆盖。

下面三条途径**任选其一，不要混用**——同一个扩展既软链、又用包安装，会让 `provider_quota` 工具重复注册。**以下命令都在本仓库根目录执行。**

### 途径 1：一键同步整个仓库（推荐）

```bash
node tools/pi-sync.mjs sync
```

把仓库里所有扩展软链进 `<agent-dir>/extensions/`。装好后即可在会话里用 `/extsync` 随时重来（见 [`pi-extsync/`](../pi-extsync/)）。

### 途径 2：软链本扩展（开发期，改代码免复制）

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)/pi-quota/extensions/quota.ts" ~/.pi/agent/extensions/quota.ts
```

### 途径 3：作为 pi 包安装（长期）

```bash
pi install "$(pwd)/pi-quota"   # 会写用户 settings
```

### 生效与卸载

- **生效**：新开会话会自动加载；**已经开着的会话**要执行内置 `/reload`。
  修改已有扩展的代码时，内核按 cwd 缓存模块，仅新建会话可能仍是旧代码，用 `/reload` 最稳。不要重启 pi-web。
- **卸载**：途径 1 用 `node tools/pi-sync.mjs uninstall`；途径 2 删掉 `~/.pi/agent/extensions/quota.ts`；途径 3 用 `pi remove "$(pwd)/pi-quota"`。
- **验证**：新会话里敲 `/quota`，或直接问「查额度」「用量」「还剩多少」。

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
