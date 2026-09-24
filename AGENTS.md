# AGENTS.md — PIWebExtensions

面向在本仓库干活的 AI agent。**本文件只讲「怎么干活」**（跨扩展通用规范）；
每个扩展的契约、设计理由与验收流程写在它自己的 `AGENTS.md` / `DESIGN.md` / `README.md` 里，冲突时以子目录为准。

## 这是什么

为 **[pi-web](https://github.com/agegr/pi-web)** 开发 pi 扩展的 monorepo。**一个子目录 = 一个扩展**（同时是一个可独立安装/发布的 pi 包）。

pi-web 是 [pi coding agent](https://github.com/earendil-works/pi) 的 Web UI。扩展以 TypeScript 单文件注册工具、斜杠命令、事件钩子等能力，由内核用 jiti 免编译加载。

## 目录约定

```
PIWebExtensions/
├── AGENTS.md            ← 本文件：通用规范
├── README.md            ← 用户向：扩展清单与安装方式
├── LICENSE              ← 整仓 MIT
├── .gitignore
└── <扩展名>/
    ├── AGENTS.md        ← 该扩展的专属开发指南（可覆盖本文件的通用条款）
    ├── README.md        ← 用户向说明（含效果截图）
    ├── DESIGN.md        ← 契约与设计理由（涉及模型行为的扩展必须有）
    ├── CHANGELOG.md
    ├── LICENSE
    ├── package.json     ← pi 包元数据
    ├── extensions/      ← 源码（单文件入口，或含 index.ts 的目录）
    ├── test/            ← 冒烟测试（必须能离线跑）
    └── docs/            ← 截图/资源
```

## 新增一个扩展

1. `mkdir <扩展名>`；`package.json` 按下面的模板（`keywords: ["pi-package"]`、`pi.extensions: ["./extensions"]`、
   `peerDependencies` 只放 `@earendil-works/pi-coding-agent` 与 `typebox`）。
2. `extensions/<扩展名>.ts`：`export default function (pi: ExtensionAPI) { ... }`，用 `pi.registerTool()` /
   `pi.registerCommand()` 等注册能力（API 清单见内核 `docs/extensions.md`）。
3. `test/smoke.mjs`：用**内核的扩展加载器**加载真实扩展文件 + mock `ctx`，覆盖全部分支。
   **不得内置本机绝对路径**，内核路径由 `PI_KERNEL_DIR` 环境变量传入，缺变量时打印用法并 `exit 1`。
4. 写 `README.md` / `DESIGN.md` / `CHANGELOG.md` / `LICENSE`（MIT，署名 `<扩展名> contributors`）。
5. 在根 `README.md` 的扩展表登记。
6. 提交（提交信息规范见下）。

## 硬性约束（所有扩展通用）

1. **零第三方运行时依赖**：除 `typebox` 与内核包（由内核 loader 别名解析）外不引入任何依赖 →
   扩展目录下**不要有 `node_modules`**、不要构建步骤（jiti 直接加载 TS）。扩展以完整系统权限运行，越薄越可审计。
2. **不重启 pm2 的 `pi-web`**（会中断该机器上所有会话）。**不改** pi / pi-web 的安装目录。
   **不动** `~/.pi/agent/` 下的 `settings.json` / `models.json` / `auth.json` / `sessions/`；
   需要实验就用**副本目录**（`PI_CODING_AGENT_DIR` 指向临时目录）。
3. **禁用 `ctx.ui.custom()`**：pi-web 下它是固定 92×40、无配色的终端模拟，观感差；
   只用 `ctx.ui.select()` / `confirm()` / `input()` / `notify()`。
4. **面向模型与用户的文案用中文**。注意 `promptGuidelines` 与 `promptSnippet` 会被平铺进系统提示且
   **不带工具名前缀** → 每条必须点名工具名（这类文案保持英文）。
5. 不假设所有环境都有新 API：用 `try/catch` 或特性探测兜底（例如 `ctx.modelRegistry` 在旧内核上可能不存在），
   让扩展在能力缺失时降级而不是整体加载失败。
6. 扩展在**会话启动时加载**：改完代码要**新开一个会话**（或内核支持时用 `/reload`）才生效。

## 开源卫生（本仓库会公开发布，违反即回滚）

1. **禁止真实凭据**：API key、token、口令、cookie、私钥一律不得出现；测试用假值（如 `sk-test-...`）。
2. **禁止机器/机房信息**：公网 IP、域名、内网主机名、端口清单、面板入口、服务器用户名、云厂商实例 ID。
3. **禁止本机绝对路径**：`/root/...`、`/AIProjects/...`、`/opt/...`、`/Users/...` 一律改成占位符 <!-- hygiene-ignore -->
   （`<pi-web 安装目录>`、`~/.pi/agent/extensions/`）或相对路径。
4. **禁止提交** `auth.json` / `models.json` / `settings.json` / `sessions/` / `.env*` /
   浏览器导出的会话 HTML / `*.tgz`（根 `.gitignore` 已拦，但提交前仍要 `git status` 复核）。
5. **提交前自检**（只读、不修改任何东西）：
   ```bash
   node tools/check-hygiene.mjs          # 扫 git 已跟踪的文件（= 将要发布的内容）
   node tools/check-hygiene.mjs --all    # 连未跟踪文件一起扫
   ```
   命中即必须处理。两个例外约定：
   - **测试用假密钥**必须以 `sk-test-` 开头（不看作泄露）；
   - 确需保留的行（如本文件列举的禁用路径、或上游链接）在**同一行**加 `hygiene-ignore` 注释；
     上游域名加进脚本里的 `ALLOWED_HOSTS`。
6. **截图/录屏发布前人工确认**：不得含聊天内容、路径、域名、账单/额度数字、账号信息。
7. 文档里的"环境备忘"只允许写**上游版本号**（pi-web / 内核 / Node），不写机器标识。

## 提交信息规范

中文，格式 `类型: 说明`；类型只取 `feat` `fix` `docs` `design` `chore` `refactor` `test`。一次提交只做一件事。

## 扩展清单

新增扩展后，本表与根 `README.md` 都要登记。

| 目录 | 提供 | 说明 |
|---|---|---|
| [`pi-extsync/`](pi-extsync/) | 命令 `/extsync` + 工具 `ext_sync` | 一键把本仓库的全部扩展同步进 / 卸出 agent 扩展目录（核心引擎在 `tools/pi-sync.mjs`） |
| [`pi-question/`](pi-question/) | 工具 `question` | 用「可点击选项」向用户提问，替代在正文里写 1/2/3 |
| [`pi-quota/`](pi-quota/) | 工具 `provider_quota` + 命令 `/quota` | 查询模型服务商额度用量（当前支持 OpenCode Go） |

## 上游参考（读文档时优先看内核自带的）

- 内核扩展文档：`<pi-web 安装目录>/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- 相关章节：`extensions.md`（扩展 API）、`packages.md`（pi 包与资源声明）、`settings.md#resources`（加载位置）
- 内核示例：同目录 `examples/extensions/`（注意：其中用 `ctx.ui.custom()` 的示例在 pi-web 下不可用）
