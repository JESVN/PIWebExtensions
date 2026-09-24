// pi-extsync 冒烟测试
//
// 全离线、不碰用户数据：
//  1) 直接测核心引擎 tools/pi-sync.mjs（临时仓库 + 临时 agent 目录）
//  2) 用「内核自带的 loader」加载真实的 extensions/extsync.ts（与生产加载路径一致），
//     mock ctx.ui，真正 fork 出脚本跑通 status / sync / uninstall 等分支。
//
// 运行（必须给 PI_KERNEL_DIR，仓库不内置任何本机路径）：
//   PI_KERNEL_DIR=/path/to/@earendil-works/pi-coding-agent node test/smoke.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KERNEL = process.env.PI_KERNEL_DIR;
if (!KERNEL) {
  console.error(
    "缺少 PI_KERNEL_DIR 环境变量。\n" +
      "请指向 pi 内核包（含 dist/core/extensions/loader.js），例如：\n" +
      '  PI_KERNEL_DIR="<pi-web 安装目录>/node_modules/@earendil-works/pi-coding-agent" node test/smoke.mjs',
  );
  process.exit(1);
}

const EXT = fileURLToPath(new URL("../extensions/extsync.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../..", import.meta.url)); // 真实仓库根
const ENGINE = path.join(REPO, "tools", "pi-sync.mjs");

const engine = await import(`${ENGINE}?t=${Date.now()}`);

// 全部临时目录：模拟仓库与 agent 目录，绝不触碰用户数据
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extsync-test-"));
const FAKE_REPO = path.join(TMP, "repo");
const AGENT_DIR = path.join(TMP, "agent");
const AGENT_EXT = path.join(AGENT_DIR, "extensions");
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
delete process.env.PI_SYNC_BIN;

const write = (rel, content) => {
  const full = path.join(FAKE_REPO, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
const pkg = (name, extensions) =>
  JSON.stringify({ name, pi: { extensions } }, null, 2);

// 造一个假仓库：alpha 目录式声明两个文件，beta 文件式声明一个，noise 无 pi 字段
write("pi-alpha/package.json", pkg("pi-alpha", ["./extensions"]));
write("pi-alpha/extensions/alpha.ts", "export default () => {};");
write("pi-alpha/extensions/extra.js", "export default () => {};");
write("pi-beta/package.json", pkg("pi-beta", ["./extensions/beta.ts"]));
write("pi-beta/extensions/beta.ts", "export default () => {};");
write("noise/package.json", JSON.stringify({ name: "noise" }));
write("noise/index.ts", "export default () => {};");

// ---- 1) 引擎：发现扩展 --------------------------------------------------------
{
  const { packages, errors } = engine.discoverExtensions(FAKE_REPO);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    packages.map((p) => p.package),
    ["pi-alpha", "pi-beta"],
    "只应发现声明了 pi.extensions 的包，且按名字排序",
  );
  assert.deepEqual(
    packages[0].files.map((f) => path.basename(f)),
    ["alpha.ts", "extra.js"],
    "目录式声明要展开成其下的 .ts/.js",
  );
}

// ---- 2) 引擎：空目标 → 计划为安装 ---------------------------------------------
{
  const plan = engine.planSync({ repo: FAKE_REPO, agentDir: AGENT_DIR });
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    plan.actions.map((a) => `${a.type}:${a.name}`),
    ["install:alpha.ts", "install:beta.ts", "install:extra.js"],
  );

  const dry = engine.applyPlan(plan, { dryRun: true });
  assert.ok(dry.every((a) => a.status === "dry-run"));
  assert.ok(!fs.existsSync(AGENT_EXT), "dry-run 不得建目录");
}

// ---- 3) 引擎：落盘 + 幂等 ------------------------------------------------------
{
  const applied = engine.applyPlan(engine.planSync({ repo: FAKE_REPO, agentDir: AGENT_DIR }));
  assert.ok(applied.every((a) => a.status === "done"));
  for (const name of ["alpha.ts", "beta.ts", "extra.js"]) {
    const link = path.join(AGENT_EXT, name);
    const stat = fs.lstatSync(link);
    assert.ok(stat.isSymbolicLink(), `${name} 必须是软链`);
    assert.ok(!path.isAbsolute(fs.readlinkSync(link)), `${name} 必须是相对软链`);
    assert.ok(fs.statSync(link).isFile(), `${name} 必须能解析到真实文件`);
  }
  const again = engine.planSync({ repo: FAKE_REPO, agentDir: AGENT_DIR });
  assert.ok(again.actions.every((a) => a.type === "unchanged"), "重复执行必须全部已就绪");
}

// ---- 4) 引擎：仓库删除扩展 → 清理残留 -----------------------------------------
{
  fs.rmSync(path.join(FAKE_REPO, "pi-beta"), { recursive: true, force: true });
  const plan = engine.planSync({ repo: FAKE_REPO, agentDir: AGENT_DIR });
  const removal = plan.actions.find((a) => a.type === "remove");
  assert.equal(removal?.name, "beta.ts");
  engine.applyPlan(plan);
  assert.ok(!fs.existsSync(path.join(AGENT_EXT, "beta.ts")), "残留软链必须被清掉");
}

// ---- 5) 引擎：真实文件占位 → 冲突，且绝不覆盖 ---------------------------------
{
  const guard = path.join(AGENT_EXT, "alpha.ts");
  fs.rmSync(guard, { force: true });
  fs.writeFileSync(guard, "user data");
  const plan = engine.planSync({ repo: FAKE_REPO, agentDir: AGENT_DIR, force: true });
  assert.equal(plan.conflicts[0]?.name, "alpha.ts");
  assert.ok(plan.conflicts[0].reason.includes("真实文件"), plan.conflicts[0].reason);
  assert.ok(!plan.actions.some((a) => a.name === "alpha.ts"), "冲突项不得进入动作列表");
  engine.applyPlan(plan);
  assert.equal(fs.readFileSync(guard, "utf8"), "user data", "真实文件必须原样保留");
  fs.rmSync(guard, { force: true });
}

// ---- 6) 引擎：外来软链 -> 默认冲突，--force 才覆盖 ----------------------------
{
  write("pi-gamma/package.json", pkg("pi-gamma", ["./extensions/gamma.ts"]));
  write("pi-gamma/extensions/gamma.ts", "export default () => {};");
  fs.writeFileSync(path.join(TMP, "elsewhere.ts"), "export default () => {};");
  fs.symlinkSync(path.join(TMP, "elsewhere.ts"), path.join(AGENT_EXT, "gamma.ts"));

  const without = engine.planSync({ repo: FAKE_REPO, agentDir: AGENT_DIR });
  assert.equal(without.conflicts[0]?.name, "gamma.ts", "指向别处的软链默认应报冲突");
  const forced = engine.planSync({ repo: FAKE_REPO, agentDir: AGENT_DIR, force: true });
  assert.ok(forced.actions.some((a) => a.type === "update" && a.name === "gamma.ts"));
  engine.applyPlan(forced);
  assert.ok(fs.readlinkSync(path.join(AGENT_EXT, "gamma.ts")).includes("pi-gamma"), "--force 后应改指仓库");
}

// ---- 6b) 引擎：仓库删除扩展 -> 清理残留 ---------------------------------------
{
  fs.rmSync(path.join(FAKE_REPO, "pi-gamma"), { recursive: true, force: true });
  const plan = engine.planSync({ repo: FAKE_REPO, agentDir: AGENT_DIR });
  assert.ok(plan.actions.some((a) => a.type === "remove" && a.name === "gamma.ts"), "删包后应清理 gamma.ts");
  engine.applyPlan(plan);
}

// ---- 7) 引擎：跨包重名 → 报错 --------------------------------------------------
{
  write("pi-dupe/package.json", pkg("pi-dupe", ["./extensions/alpha.ts"]));
  write("pi-dupe/extensions/alpha.ts", "export default () => {};");
  const { errors } = engine.desiredLinks(engine.discoverExtensions(FAKE_REPO).packages);
  assert.ok(errors.some((e) => e.includes("文件名冲突")), errors.join("|"));
  fs.rmSync(path.join(FAKE_REPO, "pi-dupe"), { recursive: true, force: true });
}

// ---- 8) 引擎：uninstall 只删受管软链 -------------------------------------------
{
  const userLink = path.join(AGENT_EXT, "user-owned.ts");
  fs.symlinkSync(path.join(TMP, "elsewhere.ts"), userLink);
  const report = engine.execute({
    command: "uninstall",
    repo: FAKE_REPO,
    agentDir: AGENT_DIR,
    force: false,
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.ok(!fs.existsSync(path.join(AGENT_EXT, "alpha.ts")), "受管软链应被移除");
  assert.ok(!fs.existsSync(path.join(AGENT_EXT, "extra.js")), "受管软链应被移除");
  assert.ok(fs.lstatSync(userLink).isSymbolicLink(), "非受管软链必须保留");
  fs.rmSync(userLink, { force: true });

  const after = engine.planSync({ repo: FAKE_REPO, agentDir: AGENT_DIR });
  assert.ok(after.actions.every((a) => a.type === "install"), "卸载后应回到全新安装状态");
}

// ---- 9) 引擎：git pull 在非 git 仓库上安全跳过 ---------------------------------
{
  const pulled = engine.gitPull(FAKE_REPO);
  assert.equal(pulled.ok, false);
  assert.ok(pulled.message.includes("git"), pulled.message);
  const report = engine.execute({ command: "pull", repo: FAKE_REPO, agentDir: AGENT_DIR });
  assert.equal(report.pull.ok, false);
  assert.ok(report.warnings.length > 0, "跳过 git pull 要给出告警");
}

// ---- 10) 扩展壳：用内核 loader 加载真实文件 ------------------------------------
const { loadExtensions } = await import(`${KERNEL}/dist/core/extensions/loader.js`);
const loaded = await loadExtensions([EXT], REPO);
assert.deepEqual(loaded.errors, [], "extension must load without errors");
const ext = loaded.extensions[0];
assert.ok(ext, "extension must be created");

const tool = ext.tools.get("ext_sync")?.definition;
assert.ok(tool, "ext_sync tool must be registered");
assert.equal(tool.executionMode, "sequential");
assert.ok(tool.promptSnippet, "promptSnippet must be set so the tool appears in Available tools");
assert.ok(
  tool.promptGuidelines?.some((g) => g.includes("ext_sync")),
  "guideline must name the tool",
);
assert.ok(ext.commands.get("extsync"), "/extsync command must be registered");
// 文案消歧：必须点名本扩展所在仓库，避免在别的目录敲命令时误解
assert.ok(
  ext.commands.get("extsync").description.includes("PIWebExtensions"),
  "/extsync 描述必须点名仓库",
);
assert.ok(tool.description.includes("PIWebExtensions"), "ext_sync 描述必须点名仓库");
assert.ok(tool.description.includes("工作目录"), "ext_sync 描述必须声明与工作目录无关");

const messages = [];
const makeCtx = ({ hasUI = true, confirm = true, select, notify = () => {} } = {}) => ({
  hasUI,
  mode: "rpc",
  ui: {
    confirm: async () => confirm,
    select,
    notify: (message, type) => {
      messages.push([message, type]);
      notify(message, type);
    },
  },
});
const call = (params, ctx) => tool.execute("t1", params, undefined, undefined, ctx);

// ---- 11) 扩展壳：status 只读，落到真实仓库 ------------------------------------
{
  const r = await call({ action: "status" }, makeCtx());
  assert.equal(r.details.ok, true, JSON.stringify(r.details.errors));
  assert.deepEqual(
    r.details.packages.map((p) => p.package).sort(),
    ["pi-extsync", "pi-question", "pi-quota"],
    "应发现本仓库的三个扩展",
  );
  assert.ok(r.content[0].text.includes("同步对象"), "输出必须标出同步对象");
  assert.ok(r.content[0].text.includes("工作目录无关"), "输出必须声明与工作目录无关");
  assert.ok(!fs.existsSync(path.join(AGENT_EXT, "question.ts")), "status 不得建软链");
}

// ---- 12) 扩展壳：sync --dry-run 不落盘，但已获确认 ----------------------------
{
  const confirmed = [];
  const ctx = makeCtx();
  ctx.ui.confirm = async (title, message) => {
    confirmed.push([title, message]);
    return true;
  };
  const r = await call({ action: "sync", dryRun: true }, ctx);
  assert.equal(r.details.ok, true, JSON.stringify(r.details.errors));
  assert.equal(r.details.dryRun, true);
  assert.equal(confirmed.length, 1, "sync 需要一次确认");
  assert.ok(confirmed[0][1].includes("继续"), confirmed[0][1]);
  assert.ok(confirmed[0][1].includes("PIWebExtensions"), "确认文案必须点名仓库");
  assert.ok(!fs.existsSync(path.join(AGENT_EXT, "question.ts")), "dry-run 不得落盘");
}

// ---- 13) 扩展壳：sync 真正装好全部扩展 ----------------------------------------
{
  const r = await call({ action: "sync" }, makeCtx());
  assert.equal(r.details.ok, true, JSON.stringify(r.details.errors));
  for (const name of ["question.ts", "quota.ts", "extsync.ts"]) {
    assert.ok(fs.lstatSync(path.join(AGENT_EXT, name)).isSymbolicLink(), `${name} 应已装好`);
  }
  assert.ok(r.content[0].text.includes("/reload"), "同步后必须提示 reload");

  // 再跑一次 → 全部已就绪
  const again = await call({ action: "sync" }, makeCtx());
  assert.ok(again.content[0].text.includes("均已就绪"), again.content[0].text);
}

// ---- 14) 扩展壳：uninstall 取消 → 什么都不做 ----------------------------------
{
  const r = await call({ action: "uninstall" }, makeCtx({ confirm: false }));
  assert.equal(r.details.reason, "cancelled");
  assert.ok(fs.existsSync(path.join(AGENT_EXT, "question.ts")), "取消后软链必须还在");
}

// ---- 15) 扩展壳：uninstall 确认 → 移除受管软链 --------------------------------
{
  const r = await call({ action: "uninstall" }, makeCtx({ confirm: true }));
  assert.equal(r.details.ok, true, JSON.stringify(r.details.errors));
  assert.ok(!fs.existsSync(path.join(AGENT_EXT, "question.ts")), "确认后软链必须移除");
}

// ---- 16) 扩展壳：无 UI 时只放行 status -----------------------------------------
{
  const r1 = await call({ action: "sync" }, makeCtx({ hasUI: false }));
  assert.equal(r1.details.reason, "no-ui");
  const r2 = await call({ action: "status" }, makeCtx({ hasUI: false }));
  assert.equal(r2.details.ok, true);
}

// ---- 17) 扩展壳：非法动作 / 找不到脚本 -----------------------------------------
{
  const bad = await call({ action: "bogus" }, makeCtx());
  assert.equal(bad.details.reason, "bad-action");

  process.env.PI_SYNC_BIN = path.join(TMP, "nope.mjs");
  const missing = await call({ action: "status" }, makeCtx());
  assert.equal(missing.details.reason, "no-engine");
  assert.ok(missing.content[0].text.includes("pi-sync.mjs"));
  delete process.env.PI_SYNC_BIN;
}

// ---- 18) /extsync 命令：选择菜单 + 参数直传 -----------------------------------
{
  const seen = [];
  const select = async (_title, options) => {
    seen.push(options);
    return options.find((o) => o.includes("查看状态"));
  };
  const ctx = makeCtx({ select });
  await ext.commands.get("extsync").handler("", ctx);
  assert.ok(seen[0].length >= 4, "菜单应有同步/拉取/状态/卸载");
  assert.ok(messages.at(-1)?.[0].includes("状态"), messages.at(-1)?.[0]);

  const bad = [];
  const ctx2 = makeCtx({ notify: (message, type) => bad.push([message, type]) });
  await ext.commands.get("extsync").handler("frobnicate", ctx2);
  assert.deepEqual(bad.at(-1)[1], "error");

  // uninstall 走命令时也要求确认
  let confirmations = 0;
  const ctx3 = makeCtx({
    confirm: true,
    notify: () => {},
  });
  ctx3.ui.confirm = async () => {
    confirmations += 1;
    return false;
  };
  await ext.commands.get("extsync").handler("uninstall", ctx3);
  assert.equal(confirmations, 1, "命令行卸载也要确认");
  assert.equal(messages.at(-1)?.[0], "已取消");
}

// ---- 19) 开源卫生：源码里不得出现本机绝对路径 / 疑似密钥 -----------------------
{
  for (const file of [EXT, ENGINE]) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of [/\/(root|home|Users|opt|AIProjects|srv)\//, /sk-[A-Za-z0-9]{10,}/, /\d{1,3}(\.\d{1,3}){3}/]) {
      assert.ok(!pattern.test(source), `${path.basename(file)} must not contain ${pattern}`);
    }
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("smoke: all 19 scenarios passed");
