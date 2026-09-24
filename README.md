# PIWebExtensions

为 **[pi-web](https://github.com/agegr/pi-web)** 开发与存放 pi 扩展的 monorepo。**一个子目录 = 一个扩展**（同时是一个可独立安装的 pi 包）。

pi-web 是 [pi coding agent](https://github.com/earendil-works/pi) 的 Web UI。这些扩展补齐 pi-web 与内核缺失的能力，全部是**单文件 TypeScript、零第三方运行时依赖**，便于人工审计——扩展以完整系统权限运行在 pi 进程内。

## 扩展清单

| 扩展 | 提供 | 一句话 |
|---|---|---|
| [`pi-extsync`](pi-extsync/) | 命令 `/extsync` + 工具 `ext_sync` | 一键把本仓库的全部扩展同步进 / 卸出 agent 扩展目录，并清理已删除的扩展 |
| [`pi-question`](pi-question/) | 工具 `question` | 让模型用**可点击选项**向你提问，而不是在正文写 1/2/3 让你打字数数 |
| [`pi-quota`](pi-quota/) | 工具 `provider_quota` + 命令 `/quota` | 在会话里直接查模型服务商额度用量（当前支持 OpenCode Go） |

每个扩展的用法、效果截图与已知限制见其目录下的 `README.md`；契约与设计理由见 `DESIGN.md`。

## 安装

pi 从 `<agent-dir>/extensions/` 加载扩展。`<agent-dir>` 默认是 `~/.pi/agent`，可用环境变量 `PI_CODING_AGENT_DIR` 覆盖。

下面三条途径**任选其一，不要混用**——同一个扩展既软链、又用包安装，会让工具重复注册。**以下命令都在本仓库根目录执行。**

### 途径 1：一键同步整个仓库（推荐）

```bash
node tools/pi-sync.mjs sync
```

它把仓库里所有扩展软链进 `<agent-dir>/extensions/`，并清理仓库中已删除的扩展。装好后即可在会话里用 `/extsync` 随时重来（见 [`pi-extsync/`](pi-extsync/)）。换机器时：`git pull` 后再跑一次这条命令即可。

### 途径 2：软链单个扩展（开发期，改代码免复制）

```bash
mkdir -p ~/.pi/agent/extensions

ln -sfn "$(pwd)/pi-extsync/extensions/extsync.ts"   ~/.pi/agent/extensions/extsync.ts
ln -sfn "$(pwd)/pi-question/extensions/question.ts" ~/.pi/agent/extensions/question.ts
ln -sfn "$(pwd)/pi-quota/extensions/quota.ts"       ~/.pi/agent/extensions/quota.ts
```

（按需只保留你要装的那一行。）

### 途径 3：作为 pi 包安装（长期）

```bash
pi install "$(pwd)/pi-extsync"     # 会写用户 settings
pi install "$(pwd)/pi-question"
pi install "$(pwd)/pi-quota"
```

### 生效与卸载

- **生效**：新开一个会话会自动加载；**已经开着的会话**要执行内置 `/reload`。
  如果改的是**已有扩展的代码**，内核按 cwd 缓存模块，仅新开会话可能仍是旧代码——这种情况用 `/reload`。全程**不要重启 pi-web**。
- **卸载**：途径 1 用 `node tools/pi-sync.mjs uninstall`；途径 2 删掉 `<agent-dir>/extensions/<文件>`；途径 3 用 `pi remove <安装时用的路径>`。
- **验证**：新会话里确认工具/命令已出现，例如敲 `/quota`、`/extsync`，或让模型调用 `question`。

## 开发

1. 读根 [`AGENTS.md`](AGENTS.md)（通用规范：目录约定、硬性约束、**开源卫生**、提交信息规范）。
2. 读目标扩展自己的 `AGENTS.md`（专属约束与验收流程）。
3. 改完跑冒烟测试（测试用内核的扩展加载器加载真实扩展文件，离线可跑）：
   ```bash
   PI_KERNEL_DIR="<pi-web 安装目录>/node_modules/@earendil-works/pi-coding-agent" \
     node pi-question/test/smoke.mjs
   ```
   内核路径不写死在仓库里；用 `pm2 describe pi-web | grep "script path"` 可以反推安装目录。
4. 提交前跑仓库自检（扫 git 已跟踪文件里有无凭据 / 本机路径 / 域名）：
   ```bash
   node tools/check-hygiene.mjs
   ```
5. 多机同步扩展：另一台机器 `git pull` 后跑一次 `node tools/pi-sync.mjs sync`（详见 [`pi-extsync/`](pi-extsync/)）。

## 上游环境（实测版本）

| 上游 | 包 | 实测版本 |
|---|---|---|
| [agegr/pi-web](https://github.com/agegr/pi-web) | `@agegr/pi-web` | 0.9.3（主运行环境） |
| [earendil-works/pi](https://github.com/earendil-works/pi) | `@earendil-works/pi-coding-agent` | 0.87.1（扩展内核） |

扩展只用内核公开的扩展 API，因此对 pi-web 版本不敏感；上表用于说明验证过哪些版本。

## 许可

[MIT](LICENSE)。各扩展目录下也有自己的 `LICENSE`，便于单独发布。
