// 开源卫生自检：扫描「将被发布的内容」（git 已跟踪的文件）里有没有
// 本机/机房/凭据类信息。只读，不做任何修改。
//
//   node tools/check-hygiene.mjs            # 只查 git 已跟踪的文件（推荐）
//   node tools/check-hygiene.mjs --all      # 连未跟踪的文件一起查
//
// 命中即退出码 1。确有必要保留的（如上游 GitHub 链接）请加进 ALLOWED_HOSTS。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const includeUntracked = process.argv.includes("--all");

// 二进制/资源文件跳过（人工过目即可）
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz",
  ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".mp4", ".mov", ".lock",
]);

const ALLOWED_HOSTS = new Set([
  "github.com", "raw.githubusercontent.com", "objects.githubusercontent.com",
  "npmjs.com", "www.npmjs.com", "registry.npmjs.org", "nodejs.org",
  "opencode.ai", "pi.dev", "earendil-works.com",
]);

// 只看这些 TLD，避免把 ctx.ui / type.object / loader.js 这类点号标识符当成域名
const TLDS = new Set([
  "com", "org", "net", "io", "dev", "ai", "cn", "asia", "top", "xyz",
  "club", "cc", "me", "info", "biz", "site", "tech", "online", "app",
]);

const RULES = [
  // 测试用假密钥约定以 sk-test- 开头，不视为泄露
  { name: "疑似 API key / token", re: /\bsk-(?!test-)[A-Za-z0-9_-]{12,}/g },
  { name: "Bearer 字面量密钥", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  {
    name: "内联赋值的密钥字面量",
    re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd)\b["']?\s*[:=]\s*["'][A-Za-z0-9._-]{12,}["']/gi,
  },
  { name: "IPv4 地址", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { name: "本机绝对路径", re: /(?:^|[^A-Za-z0-9])\/(?:root|home|Users|opt|srv|AIProjects|mnt|var\/www)\//g },
];

function listFiles() {
  let tracked = [];
  try {
    tracked = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch {
    console.error("不是 git 仓库或 git 不可用；请用 --all 或先 git init。");
    process.exit(1);
  }
  if (!includeUntracked) return tracked;

  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else out.push(path.relative(ROOT, full));
    }
    return out;
  };
  return [...new Set([...tracked, ...walk(ROOT)])];
}

const findings = [];
const hostHits = new Map();

function checkHosts(file, text) {
  for (const m of text.matchAll(/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)) {
    const host = m[0].toLowerCase();
    const tld = host.slice(host.lastIndexOf(".") + 1);
    if (!TLDS.has(tld)) continue;
    if (ALLOWED_HOSTS.has(host)) continue;
    // 形如 foo.com/bar 的路径前缀只保留主机部分
    const bare = host.split("/")[0];
    if (ALLOWED_HOSTS.has(bare)) continue;
    if (!hostHits.has(bare)) hostHits.set(bare, { file, line: lineOf(text, m.index) });
  }
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const suppressed = (line) => line.includes("hygiene-ignore");

for (const rel of listFiles()) {
  if (SKIP_EXT.has(path.extname(rel).toLowerCase())) continue;
  if (rel === "tools/check-hygiene.mjs") continue; // 本脚本自身含规则字面量
  const full = path.join(ROOT, rel);
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // 二进制

  const lines = text.split("\n");
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const line = lineOf(text, m.index);
      if (suppressed(lines[line - 1] ?? "")) continue;
      findings.push({ file: rel, line, rule: rule.name, hit: m[0].slice(0, 80) });
    }
  }
  checkHosts(rel, text);
}

for (const [host, where] of hostHits) {
  const lineText = fs.readFileSync(path.join(ROOT, where.file), "utf8").split("\n")[where.line - 1] ?? "";
  if (suppressed(lineText)) continue;
  findings.push({ file: where.file, line: where.line, rule: "非白名单域名/主机", hit: host });
}

if (findings.length === 0) {
  console.log(`hygiene: clean (${listFiles().length} files scanned)`);
  process.exit(0);
}

console.error(`hygiene: ${findings.length} 处待确认\n`);
for (const f of findings) {
  console.error(`  ${f.file}${f.line ? `:${f.line}` : ""}  [${f.rule}]  ${f.hit}`);
}
console.error("\n处理方式：改成占位符 / 删除；确有必要（如上游链接）则加进本脚本的 ALLOWED_HOSTS。");
process.exit(1);
