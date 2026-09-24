# AGENTS.md — pi-quota 开发指南

面向在本仓库干活的 AI agent。通用规范见 [根 AGENTS.md](../AGENTS.md)；用户向说明见 [README.md](README.md)；
版本历史见 [CHANGELOG.md](CHANGELOG.md)。**本文件只讲这个扩展特有的部分。**

## 项目速览

- 唯一功能：注册 `provider_quota` 工具与 `/quota` 斜杠命令，查询模型服务商额度用量（当前只支持 OpenCode Go）。
- 主环境 pi-web（`ctx.mode === "rpc"`）；pi CLI/TUI 同样可用。
- 改代码只改 `extensions/quota.ts`（单文件、零第三方运行时依赖）；测试是 `test/smoke.mjs`。

## 改完怎么验证

1. **冒烟测试**（用内核 loader 加载真实扩展 + mock `ctx`/`fetch`/临时 agent 目录，全离线）：
   ```bash
   PI_KERNEL_DIR="<pi-web 安装目录>/node_modules/@earendil-works/pi-coding-agent" node test/smoke.mjs
   ```
   仓库**不内置任何本机绝对路径**，必须传 `PI_KERNEL_DIR`；用它反推安装目录：
   `pm2 describe pi-web | grep "script path"`（script path 去掉 `/bin/...` 即安装目录）。
2. **安装**（三条途径任选其一，不要混用；命令都在**仓库根目录**执行）：
   ```bash
   mkdir -p ~/.pi/agent/extensions
   node tools/pi-sync.mjs sync                                                        # 推荐：整仓一键
   ln -sfn "$(pwd)/pi-quota/extensions/quota.ts" ~/.pi/agent/extensions/quota.ts       # 或：只软链本扩展
   pi install "$(pwd)/pi-quota"                                                        # 或：作为本地 pi 包（写用户 settings）
   ```
   （不要混用，否则 `provider_quota` 会重复注册。）
3. **生效**：新开会话会自动加载；**已经开着的会话执行内置 `/reload`**。内核按 cwd 缓存模块，
   改代码后**只新建会话可能仍是旧代码**。敲 `/quota`，或在对话里问「查额度」。
4. **卸载**：删 `~/.pi/agent/extensions/quota.ts`，或 `pi remove "$(pwd)/pi-quota"`，或整仓 `node tools/pi-sync.mjs uninstall`。

## 硬性约束

1. **不改上游接口语义**：`percent` 是「已用」百分比；剩余由本扩展计算。若上游改了响应结构，
   先用 node `fetch` 实探一次，再改 `queryUsage()`，并在 CHANGELOG 说明。
2. **不额外引入依赖**：`typebox` 与内核包由内核 loader 别名解析 → 本目录**不要有 `node_modules`**、
   不要加构建步骤。
3. **不重启 pm2 的 `pi-web`**；不改 pi / pi-web 安装目录；不动 `~/.pi/agent/` 下的
   `settings.json` / `models.json` / `auth.json` / `sessions/`（测试一律用临时 `PI_CODING_AGENT_DIR`）。
4. **不要把 key 打印出来**：只允许打印长度/前缀（参见 `test/smoke.mjs` 的做法）。
5. **不要建议用户改用 UI 的「添加 Provider」** 来让面板出现：那会新增一份 `auth.json` 凭据、
   与 `models.json` 并存，优先级未经验证（详见 README 的「已知限制」）。
6. 提交信息用中文，格式 `类型: 说明`，类型只取 `feat` `fix` `docs` `design` `chore` `refactor` `test`。

## 代码约定

- 单文件、可人工审计（扩展拥有完整系统权限）。
- 新能力的入口都要**优雅降级**：例如 `ctx.modelRegistry` 在旧内核上可能不存在（已用 `try/catch` 兜底），
  `pi.registerCommand()` 在旧内核上可能不可用（已包在 `try/catch` 里，失败不影响工具加载）。
- 面向模型与用户的文案用中文；`promptGuidelines` / `promptSnippet` 会被平铺进系统提示且**不带工具名前缀**
  → 必须点名 `provider_quota`，保持英文。
- 新增服务商时：加进 `PROVIDERS` 表并**同时**补 `test/smoke.mjs` 的分支；响应结构差异大时单独写解析函数。

## 环境备忘（源机器实测值，仅供本机参考，不要写进代码）

pi-web v0.9.3（pm2 应用名 `pi-web`，**勿重启**）｜内核 pi-coding-agent 0.87.1｜pi CLI 0.83.0｜Node v22.23.1
