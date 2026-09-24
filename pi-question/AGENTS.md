# AGENTS.md — pi-question 开发指南

面向在本仓库干活的 AI agent。通用规范见 [根 AGENTS.md](../AGENTS.md)。**本文件只讲这个扩展特有的部分**：
契约与设计理由见 [DESIGN.md](DESIGN.md)，用户向说明见 [README.md](README.md)，版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 项目速览

- 唯一功能：注册 `question` 工具，让模型在 pi-web 里弹「可点击选项」的对话框，而不是在正文写 1/2/3。
- 主环境 pi-web（`ctx.mode === "rpc"`）；次环境 pi CLI/TUI。
- 改代码只改 `extensions/question.ts`（单文件、约 120 行、零第三方运行时依赖）；测试是 `test/smoke.mjs`。

## 改完怎么验证

1. **冒烟测试**（用内核 loader 加载真实扩展 + mock `ctx.ui`，覆盖 11 个分支）：
   ```bash
   PI_KERNEL_DIR="<pi-web 安装目录>/node_modules/@earendil-works/pi-coding-agent" node test/smoke.mjs
   ```
   仓库**不内置任何本机绝对路径**，必须传 `PI_KERNEL_DIR`；找不到内核时用 `pm2 describe pi-web`
   （script path 去掉 `/bin/...` 即安装目录）。
2. **安装**（三条途径任选其一，不要混用；命令都在**仓库根目录**执行）：
   ```bash
   mkdir -p ~/.pi/agent/extensions
   node tools/pi-sync.mjs sync                                                              # 推荐：整仓一键
   ln -sfn "$(pwd)/pi-question/extensions/question.ts" ~/.pi/agent/extensions/question.ts   # 或：只软链本扩展
   pi install "$(pwd)/pi-question"                                                          # 或：作为本地 pi 包（写用户 settings）
   ```
   （三条不要同时用，否则 `question` 会重复注册。）
3. **生效**：新开会话会自动加载；**已经开着的会话执行内置 `/reload`**。内核有按 cwd 的模块缓存，
   改代码后**只新建会话可能仍是旧代码** → 用 `/reload`。然后按 [DESIGN.md](DESIGN.md) 的「验收脚本」做 4 轮手工核对（需要用户在场点弹窗）。
4. **卸载**：删 `~/.pi/agent/extensions/question.ts`，或 `pi remove "$(pwd)/pi-question"`，或整仓 `node tools/pi-sync.mjs uninstall`。

## 硬性约束

1. 禁用 `ctx.ui.custom()`（pi-web 下是固定 92×40、无配色的终端模拟）；也不要照抄内核示例
   `examples/extensions/question*.ts`（它们用 `custom()`，在 pi-web 下直接失败）。
2. 不引入第三方运行时依赖；不改 `package.json` 里 `pi.extensions` 的指向（必须是目录 `./extensions`）。
3. 不重启 pm2 的 `pi-web`（会中断所有会话）；不改 pi / pi-web 的安装目录；不动 `~/.pi/agent` 下的
   `settings.json` / `models.json` / `auth.json` / `sessions/`。
4. 不改 [DESIGN.md](DESIGN.md) 里的契约（返回文案、`details` 结构、展示文本规则、取消/回退语义）；
   确需变更时先改 DESIGN 并说明理由。
5. 提交信息用中文，格式 `类型: 说明`，类型只取 `feat` `fix` `docs` `design` `chore` `refactor` `test`。

## 代码约定

- 单文件、可人工审计（扩展拥有完整系统权限）；跨文件重复的只有契约，改契约先改 DESIGN。
- 扩展由 **jiti** 加载，TS 免编译；`typebox` 与内核包由 loader 别名解析 → 包内**不需要 node_modules**，
  也**不要**为此新增构建步骤。
- `promptGuidelines` 会被平铺进系统提示且**不带工具名前缀** → 每条必须点名 `question`（保持英文）。
- 返回给模型前必须把**展示文本映射回原始 `label`**；取消 / 回退 / `signal` 语义见 DESIGN 的「返回契约」。
- 面向模型与用户的文案用中文。

## 在新机器上首次安装（可选）

1. 在 pi-web 侧边栏用**目录选择器**选中本仓库根目录，否则该目录建会话会 Access denied；
2. 按上面「改完怎么验证」跑冒烟测试 → 装软链 → `/reload`。

## 环境备忘（源机器实测值，仅供本机参考，不要写进代码）

pi-web v0.9.3（pm2 应用名 `pi-web`，**勿重启**）｜内核 pi-coding-agent 0.87.1｜pi CLI 0.83.0｜Node v22.23.1

> 手工验收（DESIGN.md 的 4 轮脚本）是在 pi-web v0.9.1 + 内核 0.85.1 上完成的；
> 升级到 0.9.3 / 0.87.1 后已重跑 `test/smoke.mjs` 与内核 loader 加载验证（`errors` 为空），手工验收未重做。
