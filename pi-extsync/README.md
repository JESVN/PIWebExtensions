# pi-extsync

> 仓库：<https://github.com/JESVN/PIWebExtensions>（子目录 `pi-extsync/`）· 许可：[MIT](LICENSE)

一条命令把**[本仓库](../../)里的全部 pi 扩展**装进当前机器的 agent 扩展目录，并清理已经从仓库里删掉的扩展。

典型场景：机器 A 改扩展 → `git push`；机器 B `git pull` 后跑一次同步，仓库里有什么扩展，机器 B 就有什么扩展。

| 入口 | 用法 | 结果落点 |
|---|---|---|
| 斜杠命令 `/extsync` | 输入框敲 `/extsync`（不带参数会弹菜单） | 结果以自定义消息落到聊天区 |
| 工具 `ext_sync` | 直接说「同步一下扩展」「卸载全部扩展」 | 聊天区的工具卡片 |
| 命令行 | `node tools/pi-sync.mjs sync` | 终端输出 |

支持的四个动作：

| 动作 | 说明 |
|---|---|
| `sync` | 安装 / 更新仓库里的全部扩展到 `<agent-dir>/extensions/` |
| `pull` | 先 `git pull --ff-only`（工作区不干净会自动跳过），再 `sync` |
| `uninstall` | 移除本工具管理的全部软链（**不会**删除仓库文件） |
| `status` | 只读查看当前状态与将要发生的改动 |

## 为什么需要它

pi 从 `<agent-dir>/extensions/` 加载扩展，而这个仓库是「一个子目录 = 一个扩展」的 monorepo。
手工维护一堆软链既容易漏，也不会在扩展被删除时自动清理。本工具把这步变成一次幂等操作。

## 安装

pi 从 `<agent-dir>/extensions/` 加载扩展。`<agent-dir>` 默认是 `~/.pi/agent`，可用环境变量 `PI_CODING_AGENT_DIR` 覆盖。

`pi-extsync` 需要与仓库克隆一起使用（它调用仓库里的 `tools/pi-sync.mjs`）。下面三条途径**任选其一，不要混用**。**以下命令都在本仓库根目录执行。**

### 途径 1：一键同步整个仓库（推荐）

```bash
node tools/pi-sync.mjs sync
```

这条命令会把仓库里所有扩展（含 `pi-extsync` 自己）软链进 `<agent-dir>/extensions/`，并清理仓库中已删除的扩展 —— **新机器上首次安装走这条最省事**，装完才有一键 `/extsync` 可用。

### 途径 2：软链本扩展（开发期）

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)/pi-extsync/extensions/extsync.ts" ~/.pi/agent/extensions/extsync.ts
```

### 途径 3：作为本地 pi 包安装（长期）

```bash
pi install "$(pwd)/pi-extsync"   # 读仓库路径，不复制；会写用户 settings
```

### 生效与卸载

- **生效**：新开会话会自动加载；**已经开着的会话**要执行内置 `/reload`。不要重启 pi-web。
- **卸载**：途径 1 用 `node tools/pi-sync.mjs uninstall`；途径 2 删掉 `~/.pi/agent/extensions/extsync.ts`；途径 3 用 `pi remove "$(pwd)/pi-extsync"`。
- **验证**：新会话里敲 `/extsync status`（只读），应列出仓库里的扩展与当前状态。

## 安全边界

本工具只动 `<agent-dir>/extensions/`，并且严格遵守：

- **只管理自己建的软链**：判定标准是「软链 + 解析后落在本仓库内」。用户自己放的软链、真实文件、
  指向别处的软链**一律不碰**。
- **绝不覆盖真实文件**：同名位置若已有真实文件/目录，只报冲突并跳过（`--force` 也不会删真实文件，
  只用于覆盖指向别处的软链）。
- **不重启任何进程**：不碰 pm2、不碰 `settings.json` / `models.json` / `auth.json` / `sessions/`。
  改完提示你 `/reload` 或新开会话。
- **`git pull` 保守**：只做 `--ff-only`，工作区有未提交改动就直接跳过并告警，绝不 stash / 强拉。
- **幂等**：重复执行没有副作用；先 `--dry-run` 看计划再动手。

## 命令行

```bash
node tools/pi-sync.mjs [sync|pull|uninstall|status] [选项]

--repo <dir>       仓库根目录（默认从脚本位置推断）
--agent-dir <dir>  agent 目录（默认 $PI_CODING_AGENT_DIR 或 ~/.pi/agent）
--dry-run          只打印将要做的改动，不落盘
--force            覆盖指向别处的同名软链（真实文件仍拒绝）
--json             输出机器可读 JSON（扩展壳依赖此格式）
```

## 已知限制

- **仅 Linux / macOS**：Windows 建软链需要额外权限，本工具直接报错退出。
- **需要仓库克隆**：扩展壳按自身位置向上找 `tools/pi-sync.mjs`；用 `PI_SYNC_BIN` 可指定别的脚本路径。
  因此本扩展不适合单独发布到 npm。
- 同一扩展不要既用软链、又用 `pi install` 包安装，否则会重复注册工具。

## 测试

```bash
PI_KERNEL_DIR="<pi-web 安装目录>/node_modules/@earendil-works/pi-coding-agent" node test/smoke.mjs
```

用临时仓库 + 临时 agent 目录，覆盖引擎与扩展壳共 19 个场景，全离线、不碰用户数据。
