# PIWebExtensions

为 **[pi-web](https://github.com/agegr/pi-web)** 开发与存放 pi 扩展的 monorepo。**一个子目录 = 一个扩展**（同时是一个可独立安装的 pi 包）。

pi-web 是 [pi coding agent](https://github.com/earendil-works/pi) 的 Web UI。这些扩展补齐 pi-web 与内核缺失的能力，全部是**单文件 TypeScript、零第三方运行时依赖**，便于人工审计——扩展以完整系统权限运行在 pi 进程内。

## 扩展清单

| 扩展 | 提供 | 一句话 |
|---|---|---|
| [`pi-question`](pi-question/) | 工具 `question` | 让模型用**可点击选项**向你提问，而不是在正文写 1/2/3 让你打字数数 |
| [`pi-quota`](pi-quota/) | 工具 `provider_quota` + 命令 `/quota` | 在会话里直接查模型服务商额度用量（当前支持 OpenCode Go） |

每个扩展的用法、效果截图与已知限制见其目录下的 `README.md`；契约与设计理由见 `DESIGN.md`。

## 安装

pi 会从 `<agent-dir>/extensions/` 加载扩展，支持直接放 TypeScript 文件或用软链指向本仓库：

```bash
# 方式一：软链（开发期推荐，改代码免复制）
ln -sfn "$(pwd)/pi-question/extensions/question.ts" ~/.pi/agent/extensions/question.ts
ln -sfn "$(pwd)/pi-quota/extensions/quota.ts"       ~/.pi/agent/extensions/quota.ts

# 方式二：作为 pi 包安装（会写用户 settings）
pi install "$(pwd)/pi-question"
pi install "$(pwd)/pi-quota"
```

两种方式**不要同时用**，否则同名工具会重复注册。装好后**新开一个会话**即生效。

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

## 上游环境（实测版本）

| 上游 | 包 | 实测版本 |
|---|---|---|
| [agegr/pi-web](https://github.com/agegr/pi-web) | `@agegr/pi-web` | 0.9.3（主运行环境） |
| [earendil-works/pi](https://github.com/earendil-works/pi) | `@earendil-works/pi-coding-agent` | 0.87.1（扩展内核） |

扩展只用内核公开的扩展 API，因此对 pi-web 版本不敏感；上表用于说明验证过哪些版本。

## 许可

[MIT](LICENSE)。各扩展目录下也有自己的 `LICENSE`，便于单独发布。
