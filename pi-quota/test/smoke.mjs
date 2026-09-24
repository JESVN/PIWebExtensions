// pi-quota 冒烟测试
//
// 不联网、不碰用户数据：用「内核自带的 loader」加载真实的 extensions/quota.ts
// （与 pi/pi-web 生产加载路径一致），并 mock ctx / fetch / 临时 agent 目录，
// 逐个跑分支。
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
const EXT = fileURLToPath(new URL("../extensions/quota.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const { loadExtensions } = await import(`${KERNEL}/dist/core/extensions/loader.js`);

// 用临时 agent 目录承载凭据，绝不读写用户的 ~/.pi/agent
const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-quota-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
delete process.env.OPENCODE_API_KEY;

const FAKE_KEY = "sk-test-opencode-go-000000000000";
const OTHER_KEY = "sk-test-from-registry-000000000";
const modelsPath = path.join(AGENT_DIR, "models.json");
const authPath = path.join(AGENT_DIR, "auth.json");
const writeModels = (key) =>
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: { "opencode-go": { apiKey: key } } }));
const clearCredentials = () => {
  fs.rmSync(modelsPath, { force: true });
  fs.rmSync(authPath, { force: true });
};

const loaded = await loadExtensions([EXT], ROOT);
assert.deepEqual(loaded.errors, [], "extension must load without errors");
const ext = loaded.extensions[0];
assert.ok(ext, "extension must be created");

const tool = ext.tools.get("provider_quota")?.definition;
assert.ok(tool, "provider_quota tool must be registered");
assert.equal(tool.executionMode, "sequential");
assert.ok(
  tool.promptGuidelines?.some((g) => g.includes("provider_quota")),
  "guideline must name the tool",
);
assert.ok(ext.commands.get("quota"), "/quota command must be registered");

// ---- 假的 fetch ------------------------------------------------------------
let lastRequest;
const mockFetch = (body, status = 200) => {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url, init };
    return new Response(body, { status });
  };
};
const usageBody = (overrides = {}) =>
  JSON.stringify({
    usage: {
      rolling: { status: "ok", percent: 3, resetsAt: "2026-09-24T01:43:23.982Z" },
      weekly: { status: "ok", percent: 10, resetsAt: "2026-09-28T00:00:00.000Z" },
      monthly: { status: "ok", percent: 71, resetsAt: "2026-10-02T07:32:04.000Z" },
      ...overrides,
    },
  });

const makeCtx = (extra = {}) => ({ cwd: "/tmp", hasUI: true, ui: { notify: () => {} }, ...extra });
const call = (params, ctx = makeCtx()) => tool.execute("t1", params, undefined, undefined, ctx);
const anyResetStamp = /(今天 \d{2}:\d{2})|(\d{2}-\d{2} \d{2}:\d{2})/;

// 1) 成功路径：key 来自 models.json，表格与提醒行齐全
{
  writeModels(FAKE_KEY);
  mockFetch(usageBody());
  const r = await call({});
  assert.equal(r.details.ok, true);
  assert.equal(r.details.keySource, "models.json");
  assert.equal(lastRequest.url, "https://opencode.ai/zen/go/v1/usage");
  assert.equal(lastRequest.init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(lastRequest.init.redirect, "error");
  const text = r.content[0].text;
  for (const part of ["滚动窗口", "本周", "本月", "3%", "97%", "10%", "71%", "29%"]) {
    assert.ok(text.includes(part), `table must contain ${part}`);
  }
  assert.match(text, anyResetStamp, "reset time must be formatted");
  assert.ok(text.includes("⚠️ 本月已用 71%"), "high usage must add a warning line");
  assert.ok(!text.includes("⚠️ 本周"), "low usage must not warn");
  assert.ok(!text.includes(FAKE_KEY), "key must never leak into output");
}

// 2) 默认 provider 就是 opencode-go（不传参数）
{
  const r = await call({}, makeCtx());
  assert.equal(r.details.provider, "opencode-go");
}

// 3) 优先用 ctx.modelRegistry（与 pi 内部一致）
{
  writeModels(FAKE_KEY); // 文件里是旧值，registry 给新值 → 必须用 registry
  mockFetch(usageBody());
  const ctx = makeCtx({
    modelRegistry: { getApiKeyForProvider: async () => OTHER_KEY },
  });
  const r = await call({}, ctx);
  assert.equal(r.details.keySource, "pi 凭据");
  assert.equal(lastRequest.init.headers.Authorization, `Bearer ${OTHER_KEY}`);
}

// 4) 旧内核没有 modelRegistry 也不能炸（已在上面的用例覆盖）→ 这里验证兜底链
{
  mockFetch(usageBody());
  const ctx = makeCtx({ modelRegistry: { getApiKeyForProvider: async () => undefined } });
  const r = await call({}, ctx);
  assert.equal(r.details.keySource, "models.json", "registry 拿不到时必须回落到文件");
}

// 5) 环境变量优先于文件
{
  writeModels(FAKE_KEY);
  process.env.OPENCODE_API_KEY = OTHER_KEY;
  mockFetch(usageBody());
  const r = await call({});
  assert.equal(r.details.keySource, "环境变量 OPENCODE_API_KEY");
  assert.equal(lastRequest.init.headers.Authorization, `Bearer ${OTHER_KEY}`);
  delete process.env.OPENCODE_API_KEY;
}

// 6) auth.json 次优先于 models.json
{
  writeModels(FAKE_KEY);
  fs.writeFileSync(authPath, JSON.stringify({ "opencode-go": { type: "api_key", key: OTHER_KEY } }));
  mockFetch(usageBody());
  const r = await call({});
  assert.equal(r.details.keySource, "auth.json");
  clearCredentials();
}

// 7) 以 ! 开头的命令式密钥必须跳过
{
  writeModels("!security find-generic-password -ws opencode-go");
  mockFetch(usageBody());
  const r = await call({});
  assert.equal(r.details.reason, "no-key");
  clearCredentials();
}

// 8) 完全没有凭据
{
  clearCredentials();
  const r = await call({});
  assert.equal(r.details.ok, false);
  assert.equal(r.details.reason, "no-key");
  assert.ok(r.content[0].text.includes("没找到"));
  assert.ok(r.content[0].text.includes("OPENCODE_API_KEY"));
}

// 9) 不支持的服务商
{
  const r = await call({ provider: "deepseek" });
  assert.equal(r.details.reason, "unsupported");
  assert.ok(r.content[0].text.includes("deepseek"));
  assert.ok(r.content[0].text.includes("opencode-go"));
}

// 10) 上游报错
{
  writeModels(FAKE_KEY);
  mockFetch("upstream exploded", 500);
  const r = await call({});
  assert.equal(r.details.reason, "query-failed");
  assert.ok(r.content[0].text.includes("HTTP 500"), r.content[0].text);
}

// 11) 响应结构不对
{
  mockFetch(JSON.stringify({ foo: 1 }));
  const r = await call({});
  assert.equal(r.details.reason, "query-failed");
  assert.ok(r.content[0].text.includes("usage"));
}

// 12) status 非 ok 的窗口要带出状态
{
  writeModels(FAKE_KEY);
  mockFetch(usageBody({ rolling: { status: "exhausted", percent: 100, resetsAt: "2026-09-24T01:43:23.982Z" } }));
  const r = await call({});
  assert.equal(r.details.ok, true);
  assert.ok(r.content[0].text.includes("滚动窗口（exhausted）"), r.content[0].text);
  assert.ok(r.content[0].text.includes("⚠️ 滚动窗口已用 100%"));
}

// 13) /quota 命令：跑通并通知
{
  writeModels(FAKE_KEY);
  mockFetch(usageBody());
  const notified = [];
  const ctx = makeCtx({ ui: { notify: (message, type) => notified.push([message, type]) } });
  await ext.commands.get("quota").handler("", ctx);
  assert.deepEqual(notified[0], ["额度已更新", "info"]);

  const bad = [];
  const ctx2 = makeCtx({ ui: { notify: (message, type) => bad.push([message, type]) } });
  await ext.commands.get("quota").handler("deepseek", ctx2);
  assert.deepEqual(bad[0], ["额度查询失败", "error"]);
}

// 14) 开源卫生：扩展源码里不得出现本机绝对路径 / 疑似密钥
{
  const source = fs.readFileSync(EXT, "utf8");
  for (const pattern of [/\/(root|home|Users|opt|AIProjects|srv)\//, /sk-[A-Za-z0-9]{10,}/, /\d{1,3}(\.\d{1,3}){3}/]) {
    assert.ok(!pattern.test(source), `source must not contain ${pattern}`);
  }
}

fs.rmSync(AGENT_DIR, { recursive: true, force: true });
console.log("smoke: all 14 scenarios passed");
