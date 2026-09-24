// pi-question 冒烟测试
//
// 不安装、不修改任何用户数据：直接用「内核自带的 loader」加载真实的
// extensions/question.ts（与 pi/pi-web 生产加载路径一致），并 mock ctx.ui
// 逐个跑 DESIGN.md 的「返回契约」分支。
//
// 运行（必须给 PI_KERNEL_DIR，仓库不内置任何本机路径）：
//   PI_KERNEL_DIR=/path/to/@earendil-works/pi-coding-agent node test/smoke.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// 不内置任何本机绝对路径：用 PI_KERNEL_DIR 指向内核安装目录
const KERNEL = process.env.PI_KERNEL_DIR;
if (!KERNEL) {
  console.error(
    "缺少 PI_KERNEL_DIR 环境变量。\n" +
      "请指向 pi 内核包（含 dist/core/extensions/loader.js），例如：\n" +
      "  PI_KERNEL_DIR=\"<pi-web 安装目录>/node_modules/@earendil-works/pi-coding-agent\" node test/smoke.mjs",
  );
  process.exit(1);
}
const EXT = fileURLToPath(new URL("../extensions/question.ts", import.meta.url));

const { loadExtensions } = await import(`${KERNEL}/dist/core/extensions/loader.js`);

const CANCEL = "用户取消了提问。不要臆测答案，如有必要请改用其它方式或在正文中简短询问。";
const OTHER = "其他（我来输入）";

const loaded = await loadExtensions([EXT], fileURLToPath(new URL("..", import.meta.url)));
assert.deepEqual(loaded.errors, [], "extension must load without errors");
const ext = loaded.extensions[0];
assert.ok(ext, "extension must be created");
const tool = ext.tools.get("question")?.definition;
assert.ok(tool, "question tool must be registered");
assert.equal(tool.executionMode, "sequential");
assert.ok(tool.promptSnippet, "promptSnippet must be set so the tool appears in Available tools");
assert.ok(
  tool.promptGuidelines?.some((g) => g.includes("question")),
  "guideline must name the tool",
);

const makeCtx = (hasUI, select, input) => ({
  hasUI,
  mode: "rpc",
  ui: {
    select: select ?? (async () => undefined),
    input: input ?? (async () => undefined),
  },
});
const call = (params, ctx, signal) => tool.execute("t1", params, signal, undefined, ctx);

// 1) 无 UI（如 pi -p）
{
  const r = await call({ question: "Q", options: [{ label: "A" }] }, makeCtx(false));
  assert.equal(r.details.reason, "no-ui");
  assert.equal(r.content[0].text, "当前运行模式没有可用的交互界面，无法向用户提问。");
}

// 2) options 为空
{
  const r = await call({ question: "Q", options: [] }, makeCtx(true));
  assert.equal(r.details.reason, "no-options");
  assert.equal(r.content[0].text, "错误：options 不能为空。");
}

// 3) 选中带 description 的选项 → 展示文本映射回原始 label，返回纯净答案
{
  let seenChoices;
  const ctx = makeCtx(true, async (_title, choices) => {
    seenChoices = choices;
    return choices[1];
  });
  const r = await call(
    { question: "Q", options: [{ label: "A" }, { label: "B", description: "desc B" }] },
    ctx,
  );
  assert.deepEqual(seenChoices, ["A", "**B** — desc B", OTHER]);
  assert.equal(r.content[0].text, "B");
  assert.equal(r.details.reason, "selected");
  assert.equal(r.details.wasCustom, false);
  assert.deepEqual(r.details.options, ["A", "B"]);
}

// 4) allowOther=false → 不出现「其他」
{
  let seenChoices;
  const ctx = makeCtx(true, async (_title, choices) => {
    seenChoices = choices;
    return "A";
  });
  const r = await call({ question: "Q", options: [{ label: "A" }], allowOther: false }, ctx);
  assert.deepEqual(seenChoices, ["A"]);
  assert.equal(r.details.reason, "selected");
}

// 5) 选「其他」→ 自由输入（已 trim），并带上回退提示 placeholder
{
  let seenTitle;
  let seenPlaceholder;
  const ctx = makeCtx(
    true,
    async () => OTHER,
    async (title, placeholder) => {
      seenTitle = title;
      seenPlaceholder = placeholder;
      return "  我的想法  ";
    },
  );
  const r = await call({ question: "Q", options: [{ label: "A" }] }, ctx);
  assert.equal(seenTitle, "Q");
  assert.equal(seenPlaceholder, "输入答案后回车；按 Esc 或「取消」返回选项列表");
  assert.equal(r.content[0].text, "我的想法");
  assert.equal(r.details.reason, "custom");
  assert.equal(r.details.wasCustom, true);
}

// 6) 选项层取消
{
  const r1 = await call(
    { question: "Q", options: [{ label: "A" }] },
    makeCtx(true, async () => undefined),
  );
  assert.equal(r1.details.reason, "cancelled");
  assert.equal(r1.content[0].text, CANCEL);
}

// 7) 输入层取消 → 回退到选项列表（不当作取消），随后选中 B
{
  let selects = 0;
  const ctx = makeCtx(
    true,
    async () => (++selects === 1 ? OTHER : "B"),
    async () => undefined,
  );
  const r = await call({ question: "Q", options: [{ label: "A" }, { label: "B" }] }, ctx);
  assert.equal(selects, 2, "输入层取消后必须重新弹出选项列表");
  assert.equal(r.content[0].text, "B");
  assert.equal(r.details.reason, "selected");
}

// 8) 输入层空白提交 → 回退；再选「其他」并真正输入 → custom
{
  let inputs = 0;
  const ctx = makeCtx(
    true,
    async () => OTHER,
    async () => (++inputs === 1 ? "   " : "  我的想法  "),
  );
  const r = await call({ question: "Q", options: [{ label: "A" }] }, ctx);
  assert.equal(inputs, 2, "空白提交后必须重新弹出输入框");
  assert.equal(r.content[0].text, "我的想法");
  assert.equal(r.details.reason, "custom");
}

// 9) 回退之后仍在选项层取消 → 才是真正的 cancelled
{
  let selects = 0;
  const ctx = makeCtx(
    true,
    async () => (++selects === 1 ? OTHER : undefined),
    async () => undefined,
  );
  const r = await call({ question: "Q", options: [{ label: "A" }] }, ctx);
  assert.equal(selects, 2);
  assert.equal(r.details.reason, "cancelled");
  assert.equal(r.content[0].text, CANCEL);
}

// 10) 传入 signal（Stop 中断）→ 对话框立即返回 undefined，按取消处理，不得回退
{
  const ac = new AbortController();
  ac.abort();
  const seen = [];
  const ctx = makeCtx(true, async (_title, _choices, opts) => {
    seen.push(opts?.signal);
    return undefined;
  });
  const r = await call({ question: "Q", options: [{ label: "A" }] }, ctx, ac.signal);
  assert.equal(seen[0], ac.signal, "signal 必须透传给 ctx.ui.select");
  assert.equal(r.details.reason, "cancelled");
}

// 11) 兜底：输入层一直空提交时，最多回退 MAX_BACKS+1 次后按取消处理（MAX_BACKS = 20）
{
  let selects = 0;
  const ctx = makeCtx(
    true,
    async () => {
      selects += 1;
      return OTHER;
    },
    async () => undefined,
  );
  const r = await call({ question: "Q", options: [{ label: "A" }] }, ctx);
  assert.equal(selects, 21);
  assert.equal(r.details.reason, "cancelled");
}

console.log("smoke: all 11 scenarios passed");
