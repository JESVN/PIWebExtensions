# pi-extsync 设计说明与契约

> 本文件是本项目的**权威契约**：动作语义、菜单文案、确认矩阵、报告结构都以这里为准，
> 变更前先改本文件并说明理由。
>
> 用户向说明见 [README.md](README.md)；开发流程与硬性约束见 [AGENTS.md](AGENTS.md)；版本历史见 [CHANGELOG.md](CHANGELOG.md)。
> 以下内核行为基于 pi-coding-agent 0.87.1（pi-web 0.9.3）实测。

---

## 要解决的问题

这个仓库是「一个子目录 = 一个扩展」的 monorepo。pi 从 `<agent-dir>/extensions/` 加载扩展，
所以每台机器都要把仓库里的扩展一个一个链接过去。手工维护的问题：

- 新增扩展要记得补链；删除 / 改名扩展后旧链会残留成悬空软链；
- 每台机器状态不一致，很难确认「这台机器到底装了哪些」；
- 卸载时要自己一个个找出来删，容易误删用户自己的扩展。

本工具把这步变成一次幂等操作：**仓库里有什么，机器上就有什么**。

## 机制与取舍

### 用「按文件软链」，而不是整目录软链

内核 `discoverExtensionsInDir()` 接受 `isSymbolicLink()` 的条目，所以两种软链理论上都行。
但本仓库每个包的 `package.json` 是 `"pi": { "extensions": ["./extensions"] }`——指向的是**目录**。
实测（内核 0.87.1）：

| 软链形态 | 结果 |
|---|---|
| `<extensions>/question.ts` → 仓库文件 | ✅ 加载成功（当前生产用法） |
| `<extensions>/pi-question` → 仓库包目录（manifest 指向目录） | ❌ `Cannot find module '.../extensions/pi-question/extensions'` |
| `<extensions>/pkg` → 包目录（manifest 指向**文件**） | ✅ 加载成功 |

即：整目录软链只有在 manifest 指向文件时才成立，而仓库约定是目录式声明。因此本工具
**展开目录式声明、按文件建链**，与内核发现规则（不递归、只看一层 `.ts/.js`）保持一致。

### 不改 `settings.json` 的 `packages` / `extensions`

那会写用户配置，且同样有「目录路径交给模块加载器」的坑；软链方案不写任何配置文件，改完即可用，
回滚就是删链。仓库根 [`AGENTS.md`](../AGENTS.md) 也明确要求不动 `settings.json`。

### 归属判定：无状态

不维护 manifest / 状态文件，只按一条规则识别「受管条目」：

> `<agent-dir>/extensions/` 下，**是软链**，且 `path.resolve(读到的链接目标)` **落在本仓库目录内**。

好处：幂等、可跨机器、仓库搬家后旧链仍能被识别并清理（链接目标字符串仍指向旧仓库路径时除外，
那种情况会退化为「外来软链」，默认报冲突、加 `--force` 覆盖）。
用户自己指向别处的软链天然不受影响。

## 动作契约

| 动作 | 行为 | 是否弹确认 |
|---|---|---|
| `sync` | 对每个目标文件：无则建链（install）、指向旧仓库路径则重链（update）、已正确则不动（unchanged）；受管但已不在仓库的条目删除（remove） | 命令 `/extsync sync` 不弹；模型工具 `ext_sync` **弹**；`--dry-run` 前先弹一次 |
| `pull` | 先 `git pull --ff-only`，再走 `sync` | 同上 |
| `uninstall` | 移除全部受管软链，不删仓库文件 | **总是**弹确认 |
| `status` | 只读，返回将要发生的改动（install/update/unchanged/remove/conflict），不落盘 | 不弹 |

### 冲突策略

| 情况 | 行为 |
|---|---|
| 同名位置是真实文件 / 目录 | 报冲突、跳过；`--force` 也不删真实文件 |
| 同名位置是指向别处的软链（含用户自己的） | 默认报冲突、跳过；`--force` 才覆盖 |
| 两个扩展产出同名文件（如都有 `foo.ts`） | 记为错误、跳过该名 |
| 仓库已删除、但机器上还留着的受管软链 | 自动清理（remove） |

### 菜单与文案（契约）

`/extsync` 不带参数时的选项，顺序固定：

1. `同步（安装 / 更新全部扩展）` → `sync`
2. `拉取并同步（git pull --ff-only）` → `pull`
3. `查看状态（只读）` → `status`
4. `卸载全部扩展` → `uninstall`

- 选项是纯字符串（`ctx.ui.select` 的格式限制），因此这里**不使用** pi-question 的 `**加粗** — 说明` 形式。
- 菜单标题固定为 `扩展同步 · {仓库名}`。
- 取消（`select` 返回 `undefined`）= 什么都不做。
- 确认框标题 `扩展{同步|拉取并同步|卸载}`；取消后通知 `已取消`。
- 完成通知 `扩展{动作}完成` / 失败 `扩展同步未完成，详见聊天区`。

#### 消歧契约（重要）

扩展是**全局安装**的：它出现在所有会话里，而它同步的永远是「本扩展所在仓库」（靠 `import.meta.url` 定位），
**不是当前工作目录所在的项目**。因此所有面向用户的文案必须点名仓库，不得只说「本仓库」：

| 位置 | 契约 |
|---|---|
| `/extsync` 命令描述 | `同步「{仓库名}」仓库的扩展到 agent 扩展目录（含卸载与状态查看）` |
| `ext_sync` 工具描述 | 必须包含仓库名与「与当前工作目录无关」 |
| `select` 菜单标题 | `扩展同步 · {仓库名}` |
| 确认文案 | `将把「{仓库名}」仓库里的扩展…` |
| 结果卡片首行 | `同步对象：\`{仓库绝对路径}\`（与当前工作目录无关）` |
| 找不到脚本 | 只说「需要与本仓库克隆一起使用」，不得写死仓库名 |

`{仓库名}` 取 `locateRepo()` 的 basename（`PI_SYNC_BIN` 覆盖时取其上级目录名）。

### `git pull` 政策

- 先 `git status --porcelain`，非空即跳过（告警，不报错）——不 stash、不 `--force`。
- 只跑 `git pull --ff-only`；失败则记为该次 pull 的 `ok: false`，同步仍然照常进行。
- `--dry-run` 下不会真的 pull。

## 报告结构（CLI `--json` / 工具 `details`）

```jsonc
{
  "ok": true,                 // 无 error、无 conflict、无 failed 动作
  "command": "sync",          // sync | pull | uninstall | status
  "dryRun": false,
  "repo": "...",
  "agentDir": "...",
  "extensionsDir": "...",     // <agent-dir>/extensions
  "pull": { "ok": true, "message": "..." },   // 仅 pull 命令
  "packages": [ { "package": "pi-question", "files": ["pi-question/extensions/question.ts"] } ],
  "actions": [
    { "type": "install|update|unchanged|remove", "name": "question.ts",
      "source": "...", "previous": "...", "package": "pi-question",
      "reason": "...", "status": "done|dry-run|readonly|ok|failed", "error": "..." }
  ],
  "conflicts": [ { "name": "x.ts", "reason": "..." } ],
  "errors": [], "warnings": []
}
```

退出码：`0` 成功（含 status / dry-run）；`1` 有 error / conflict / failed 动作；未知命令也是 `1`。

## 扩展壳的契约

- 工具 `ext_sync(action, dryRun?)`：`action ∈ {sync, pull, uninstall, status}`。
  - 非 `status` 且 `ctx.hasUI === false` → 返回 `no-ui` 文案，**不做任何变更**。
  - 非 `status` → 先 `ctx.ui.confirm`，取消则返回 `cancelled` 文案。
  - 找不到 `tools/pi-sync.mjs`（或 `PI_SYNC_BIN` 指向的文件不存在）→ 返回 `no-engine` 文案（措辞见下表）。
  - 非法 `action` → 返回 `bad-action` 文案。
- 命令 `/extsync [action] [--dry-run]`：带参数直接执行；不带参数弹菜单。
  命令路径下 `sync` / `pull` 不再二次确认（用户已显式输入），只有 `uninstall` 弹确认。
- 模型调用约束：`promptGuidelines` 明确要求「仅在用户显式要求时调用」，避免模型自作主张改用户环境。

### 依赖的内核行为

- `import.meta.url` 在 jiti 加载的扩展里可用（实测）；扩展壳据此 `realpath` 后向上两级定位仓库根。
- 用 `process.execPath` 而不是 `node` 启动子进程，避免依赖 PATH（pi 自带的 node 不一定在 PATH 上）。
- 子进程以 `--json` 交互，扩展壳只解析 JSON，不解析人类文案 → 文案改动不会破坏壳。

## 非目标

- 不做 `settings.json` / `packages` 管理（那是 `pi install` / `pi remove` 的职责）。
- 不处理 npm/git 远端包（本工具只同步**本仓库**这个 monorepo）。
- 不支持 Windows。
- 不自动重启 pi / pi-web；生效方式始终是 `/reload` 或新开会话。
