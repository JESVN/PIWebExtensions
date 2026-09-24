# AGENTS.md — pi-extsync 开发指南

面向在本仓库干活的 AI agent。通用规范见[根 AGENTS.md](../AGENTS.md)。**本文件只讲这个扩展特有的部分**：
契约与设计理由见 [DESIGN.md](DESIGN.md)，用户向说明见 [README.md](README.md)，版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 项目速览

- 功能：把本仓库的全部扩展一键同步到 `<agent-dir>/extensions/`（含卸载与状态查看）。
- **代码分两层，别把逻辑写串**：
  - `../tools/pi-sync.mjs`：**核心引擎**（仓库级脚本，纯 Node、零依赖、可独立 CLI 运行）。
  - `extensions/extsync.ts`：**薄壳**，只做「解析动作 → 弹确认 → 子进程调用引擎 → 渲染结果」。
- 主环境 pi-web（`ctx.mode === "rpc"`）；pi CLI/TUI 同样可用。

## 改完怎么验证

1. **冒烟测试**（临时仓库 + 临时 agent 目录 + 内核 loader + 真实 fork 引擎，全离线）：
   ```bash
   PI_KERNEL_DIR="<pi-web 安装目录>/node_modules/@earendil-works/pi-coding-agent" node test/smoke.mjs
   ```
   仓库**不内置任何本机绝对路径**，必须传 `PI_KERNEL_DIR`；用它反推安装目录：
   `pm2 describe pi-web | grep "script path"`（script path 去掉 `/bin/...` 即安装目录）。
2. **手工验证引擎**（务必用临时目录，别拿真实 `~/.pi/agent` 当试验场）：
   ```bash
   node tools/pi-sync.mjs status --repo . --agent-dir /tmp/pi-sync-demo
   node tools/pi-sync.mjs sync   --repo . --agent-dir /tmp/pi-sync-demo --dry-run
   ```
3. **安装**（二选一，不要同时用）：
   ```bash
   ln -sfn "$(pwd)/extensions/extsync.ts" ~/.pi/agent/extensions/extsync.ts   # 开发期
   pi install "$(pwd)"                                                        # 正式（本地路径，不复制）
   ```
4. **生效**：改完执行内置 `/reload`，或新开会话。

## 硬性约束

1. 禁用 `ctx.ui.custom()`；只用 `select()` / `confirm()` / `notify()`。
2. 不引入第三方运行时依赖；`package.json` 的 `pi.extensions` 保持目录形式 `./extensions`。
3. **只碰 `<agent-dir>/extensions/`**：不写 `settings.json` / `models.json` / `auth.json` / `sessions/`；
   不重启 pm2 的 `pi-web`；不改 pi / pi-web 安装目录。
4. **归属判定只能靠「软链 + 落在本仓库内」**（见 DESIGN.md）。不要引入状态/manifest 文件，
   也不要放宽到「看起来像扩展名的文件」——否则会误删用户自己的扩展。
5. **冲突一律不覆盖真实文件**；`--force` 的语义仅限于覆盖指向别处的软链，别扩大。
6. `git pull` 只允许 `--ff-only`，工作区脏就跳过；绝不 stash / 强拉 / rebase。
7. 提交信息用中文，格式 `类型: 说明`，类型只取 `feat` `fix` `docs` `design` `chore` `refactor` `test`。

## 代码约定

- 引擎里所有副作用集中在 `applyPlan()`；`planSync()` 必须是纯函数（测试依赖这条）。
- 引擎的对外出口只有 `execute()`；文案渲染放 `renderReport()`，别让 shell 依赖人类文案
  （扩展壳走 `--json`）。
- 扩展壳用 `process.execPath` 起子进程（不要写死 `node`）；子进程结果必须是可解析 JSON，
  解析失败要给出「退出码 + stderr 摘要」的可诊断信息。
- 面向模型与用户的文案用中文；`promptGuidelines` / `promptSnippet` 会被平铺进系统提示且
  **不带工具名前缀** → 必须点名 `ext_sync`，保持英文。
- 新动作要**同时**改：引擎 `COMMANDS`、扩展壳 `ACTIONS` / 文案表、DESIGN.md 契约、`test/smoke.mjs`。

## 环境备忘（源机器实测值，仅供本机参考，不要写进代码）

pi-web v0.9.3（pm2 应用名 `pi-web`，**勿重启**）｜内核 pi-coding-agent 0.87.1｜pi CLI 0.83.0｜Node v22.23.1
