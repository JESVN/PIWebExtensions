# pi-question 设计说明与契约

> 本文件是本项目的**权威契约**：返回给模型的文案、`details` 结构、选项展示规则与交互语义都以这里为准，
> 变更前先改本文件并说明理由。
>
> 用户向说明见 [README.md](README.md)；开发流程与硬性约束见 [AGENTS.md](AGENTS.md)；版本历史见 [CHANGELOG.md](CHANGELOG.md)。
> 以下行为基于 pi-web v0.9.1（内核 pi-coding-agent 0.85.1，RPC 模式）实测。

---

## 为什么需要这个扩展

- pi 的**内置工具**只有 `read / bash / powershell / edit / write / grep / find / ls`，**没有任何提问工具**，
  于是模型只能把候选选项写进回复正文，让用户打字数数回答。
- pi-web **已经实现了** pi 的扩展 UI 协议（`extension_ui_request` / `extension_ui_response`）：
  `select` 渲染成可点击卡片、`input` 渲染成输入框。缺的不是渲染能力，而是**没有扩展注册过这类工具**。

本扩展补的就是这一环。

## 两条硬约束（各有理由，别好心改坏）

### 1. 只用 `ctx.ui.select()` / `ctx.ui.input()`，禁用 `ctx.ui.custom()`

pi-web 下 `custom()` 不是原生控件，而是**服务端 headless 伪终端**的输出：固定 92 列 × 40 行、
主题退化为 `PlainTextTheme`（完全没有颜色）、**不支持鼠标**。而 `select()` / `input()` 是原生网页弹窗：
自适应尺寸、跟随网页主题、可点击、支持 Markdown。

内核官方示例 `examples/extensions/question.ts`、`questionnaire.ts` 用的是 `custom()`，且带
`ctx.mode !== "tui"` 守卫，在 pi-web 下直接返回 `"Error: UI not available"` —— **不要照抄**。

### 2. 必须设 `promptSnippet`；`promptGuidelines` 必须点名工具

- 内核只把**带 `promptSnippet` 的自定义工具**列入系统提示的 Available tools 段 —— 不设，模型就看不见这个工具。
- pi-web 会把所有非内置扩展工具**自动**加入可用工具，无需改 `settings.json`、无需重启。
- `promptGuidelines` 会被**平铺**进系统提示的 Guidelines 段，**不带工具名前缀**，所以每条都必须点名 `question`。
- 触发文案保持**动作触发式**（"回复中将出现选项 / 候选下一步 / 方向" 即用工具），不要写成"需要用户做具体选择时"：
  后者会给弱模型"这不算具体决策"的自我说服空间（v1.1 的实测结论，见 [CHANGELOG.md](CHANGELOG.md)）。

## 工具接口

| 参数 | 必填 | 说明 |
|---|---|---|
| `question` | ✅ | 问题文本（pi-web 里支持 Markdown） |
| `options` | ✅ | 选项数组，至少 1 个；每项 `label` 必填、`description` 可选 |
| `allowOther` | — | 默认 `true`；`false` 时不提供「其他（我来输入）」 |

其它：参数 schema 用 `typebox` 的 `Type`；`executionMode: "sequential"`（避免并发弹窗互相覆盖）。

### 选项展示文本（契约）

- 有 `description`：`**{label}** — {description}`；无 `description`：`{label}`
- 「其他」固定为 `其他（我来输入）`
- 输入框 `placeholder` 固定为 `输入答案后回车；按 Esc 或「取消」返回选项列表`
- **返回给模型的必须是原始 `label`**：展示文本带 Markdown 记号，直接返回会污染模型输入

### 返回契约

| 场景 | `content[0].text` | `details.reason` |
|---|---|---|
| 选中某选项 | 该选项**原始 label** | `selected` |
| 选「其他」并输入 | 输入原文（trim 后） | `custom` |
| **选项层**取消 / `Stop` 中断 | `用户取消了提问。不要臆测答案，如有必要请改用其它方式或在正文中简短询问。` | `cancelled` |
| 输入层取消 / 空白提交 | 不返回工具结果：重弹选项列表（见「取消 vs 回退」） | — |
| `options` 为空 | `错误：options 不能为空。` | `no-options` |
| 无 UI（如 `pi -p`） | `当前运行模式没有可用的交互界面，无法向用户提问。` | `no-ui` |

```ts
details: {
  question: string;
  answer: string | null;      // 取消时为 null
  reason: "selected" | "custom" | "cancelled" | "no-options" | "no-ui";
  wasCustom?: boolean;
  options?: string[];         // 原始 label 列表，便于回放/调试
}
```

## 交互行为与边界

### 取消 vs 回退

pi-web 的输入框只有「取消 / 提交」两个按钮，扩展**无法往里加自定义按钮**（那需要被禁用的 `custom()`）；
且 `Esc` 与点「取消」在协议层**完全等价**（都是 `{cancelled: true}`），无法区分。于是：

- **选项层**取消 = 真正取消 → 返回取消文案；
- **输入层**取消 / 空白提交 = **回退** → 重新弹一次选项列表（每次 `select()`/`input()` 都是独立的
  `extension_ui_request`，带独立 `id`，因此可以反复弹）。
- 代价：想彻底取消要在选项层再取消一次（最多按两次 `Esc`），但**不会误取消** —— 换来的是「误点『其他』」的成本极低。

### `Stop` 与回退必须区分

`Stop` 与「输入层取消」同样得到 `undefined`，若无脑回退，用户点了 Stop 反而会再弹一个选择框。
因此把 `execute` 的 `signal` 作为 `opts.signal` 传给 `select()` / `input()`：中断时对话框立即 `resolve(undefined)`，
扩展再检查 `signal.aborted` → 直接取消，**不回退**（内核 RPC 与 TUI 两处实现都支持 `signal`）。

### 边界与降级

| 情况 | 行为 |
|---|---|
| 选项 label 重复 | 允许；映射回 label 时取第一个匹配 |
| label 超长 / 含换行 | 不截断（pi-web 卡片会自动换行） |
| 选项很多（>10） | 不分页（弹窗可滚动） |
| 输入含中文 / 表情 | 无需特殊处理（pi-web 输入框已处理 IME）；**不要**自行拦截按键 |
| 回退次数过多（异常客户端） | 兜底 `MAX_BACKS = 20`，超过后按取消处理，避免无限弹窗 |
| `ctx.hasUI === false` | 返回 `no-ui` 文案，**不要**抛异常 |
| pi TUI（`ctx.mode === "tui"`） | `select()` 渲染为终端列表，选项是纯字符串，因此会看到 `**标题** — 描述` 的原始 Markdown 记号（可接受）；输入框不显示 `placeholder` |

## 实现

实现即 [`extensions/question.ts`](extensions/question.ts)：单文件、约 120 行、零第三方运行时依赖。
本文件**不再复制代码**（此前复制一份会与真实实现漂移）。

## 验收脚本（一条消息跑完 4 个场景）

`question` 由模型调用，用户无法自己「再次调用」，所以要让模型**连续问 4 轮**：

> 请连续调用 4 次 `question` 工具，选项每次都固定给「要，写测试」和「不用，先跑通」，4 次的问题依次为：
> 「复验 1/4：要不要顺便写单元测试？」「复验 2/4：要不要顺便写单元测试？」「复验 3/4：要不要顺便写单元测试？」「复验 4/4：要不要顺便写单元测试？」。
> 规则：我回答完一轮，你立刻发起下一轮提问（题目里的 x/4 就是轮次）；4 轮问完之前不要停下来总结，也不要臆测我的选择；
> 4 轮都结束后，把每次收到的工具返回**原文**逐条列出来（标注第几次），不要改写。

| 轮次 | 你的操作 | 模型应收到 |
|---|---|---|
| 1 | 点「不用，先跑通」 | `不用，先跑通`（原始 label，不含展示用 Markdown） |
| 2 | 「其他」→ 输入「先跑通再补测试」→ 回车 | `先跑通再补测试`（中文 IME 正常） |
| 3 | 「其他」→ 确认能看到 placeholder → 按 `Esc`（或取消 / 空提交）→ **应弹回选项卡片** → 点「要，写测试」 | `要，写测试` |
| 4 | 在选项卡片上按 `Esc`（或点取消） | 取消文案；模型须明说取消、不臆测 |

常见偏差：模型只问 1 轮就总结（发「继续，按脚本把第 2~4 轮问完」）；第 3 轮 `Esc` 后对话框直接消失
= 跑的还是旧代码（回 pi-web 执行 `/reload`）；第 3 轮能回退但返回的不是原始 label = 回归 bug。

其他检查项：

- 带 `description` 的选项，卡片上应能看到描述文本；
- 非交互降级（需 pi CLI + 已配置模型）：`pi -p --no-session "请调用 question 工具向我提问，选项给 A、B"`
  → 应返回 `no-ui` 文案而不是崩溃；
- 扩展不触发任何网络请求、不写任何文件、不改用户配置。

## 参考资料

| 内容 | 位置 |
|---|---|
| 扩展开发 / RPC 扩展 UI 协议 / 打包规范 | `<内核>/docs/extensions.md`、`docs/rpc.md`、`docs/packages.md` |
| 最小 `select()` 范式 | `<内核>/examples/extensions/permission-gate.ts` |
| 官方提问示例（**用 `custom()`，不要照抄**） | `<内核>/examples/extensions/question.ts`、`questionnaire.ts` |
| pi-web 渲染实现（参考，不需改动） | `components/ChatWindow.tsx`（`ExtensionDialog`）、`lib/rpc-manager.ts` |

其中 `<内核>` = `<pi-web 安装目录>/node_modules/@earendil-works/pi-coding-agent`。

## 后续想法

以下都不在实现范围内，有需要请开 Issue 讨论：

- 多问题问卷（连续多次 `select()` 模拟，避免 `custom()`）
- 超时自动取消（`select(..., { timeout })`，内核已支持）
- pi TUI 下不显示 Markdown 记号（按 `ctx.mode` 分支格式化 label）
- 数字键直选（需先验证 pi-web 的 `select` 是否支持）
