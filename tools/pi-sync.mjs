#!/usr/bin/env node
/**
 * pi-sync — 把本仓库里的所有 pi 扩展同步到 <agent-dir>/extensions/
 *
 * 场景：机器 A 改扩展 → git push；机器 B `git pull` 后跑一次本脚本，
 * 仓库里「有」的扩展全部就位，仓库里「没了」的扩展自动清掉。
 *
 * 设计要点（详见 pi-extsync/DESIGN.md）：
 *  - 只碰 <agent-dir>/extensions/，绝不读写 settings.json / models.json / auth.json / sessions/
 *  - 无状态归属判定：只管理「软链 + 解析后落在本仓库内」的条目，用户自己的软链一律不碰
 *  - 幂等：重复执行无副作用；默认不覆盖同名真实文件，也不覆盖指向别处的软链（除非 --force）
 *  - 零第三方运行时依赖；不重启任何进程，改完由用户 /reload 或新开会话
 *
 * 用法：
 *   node tools/pi-sync.mjs [sync|pull|uninstall|status] [选项]
 *   --repo <dir>       仓库根目录，默认从脚本位置推断（<repo>/tools/pi-sync.mjs）
 *   --agent-dir <dir>  agent 目录，默认 $PI_CODING_AGENT_DIR 或 ~/.pi/agent
 *   --dry-run          只打印将要做的改动，不落盘（pull 命令下也不会真的拉取）
 *   --force            允许覆盖「指向别处的同名软链」（真实文件/目录仍拒绝）
 *   --json             机器可读输出（pi-extsync 扩展壳依赖此格式）
 *   -h, --help
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const EXT_RE = /\.(ts|js)$/;
const COMMANDS = new Set(["sync", "pull", "uninstall", "status"]);

const ACTION_LABEL = {
  install: "安装",
  update: "更新",
  unchanged: "已就绪",
  remove: "卸载",
  conflict: "冲突",
};

/** 仓库根目录：本脚本位于 <repo>/tools/ 下 */
export function repoRootFromScript(url = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(url)), "..");
}

/** agent 目录：尊重 PI_CODING_AGENT_DIR，否则 ~/.pi/agent */
export function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isFileLike(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 扫描仓库里声明的扩展：遍历一级子目录，读 package.json 的 pi.extensions，
 * 目录形式的声明展开成它下面的 .ts/.js（与内核 loader 的发现规则一致，不递归）。
 */
export function discoverExtensions(repo) {
  const packages = [];
  const errors = [];

  let entries;
  try {
    entries = fs.readdirSync(repo, { withFileTypes: true });
  } catch {
    return { packages, errors: [`无法读取仓库目录：${repo}`] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(repo, entry.name);
    const pkgPath = path.join(dir, "package.json");
    if (!isFileLike(pkgPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      errors.push(`${entry.name}/package.json 不是合法 JSON，已跳过`);
      continue;
    }

    const declared = manifest?.pi?.extensions;
    if (!Array.isArray(declared) || declared.length === 0) continue;

    const files = [];
    for (const item of declared) {
      if (typeof item !== "string" || !item.trim()) continue;
      const target = path.resolve(dir, item);
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        for (const child of fs.readdirSync(target, { withFileTypes: true })) {
          if (child.name.startsWith(".") || child.name === "node_modules") continue;
          const childPath = path.join(target, child.name);
          if (EXT_RE.test(child.name) && isFileLike(childPath)) files.push(childPath);
        }
      } else if (EXT_RE.test(target) && isFileLike(target)) {
        files.push(target);
      }
    }

    if (files.length === 0) {
      errors.push(`${entry.name} 的 pi.extensions 没解析出可加载的 .ts/.js，已跳过`);
      continue;
    }
    packages.push({
      package: manifest.name || entry.name,
      dir,
      files: [...new Set(files)].sort(),
    });
  }

  packages.sort((a, b) => a.package.localeCompare(b.package));
  return { packages, errors };
}

/** 把各扩展的文件摊平成「目标文件名 → 源文件」，并检查跨包重名 */
export function desiredLinks(packages) {
  const links = new Map();
  const errors = [];
  for (const pkg of packages) {
    for (const source of pkg.files) {
      const name = path.basename(source);
      const prev = links.get(name);
      if (prev && prev.source !== source) {
        errors.push(`文件名冲突：${name} 同时来自 ${prev.package} 与 ${pkg.package}`);
        continue;
      }
      links.set(name, { name, source, package: pkg.package });
    }
  }
  return { links, errors };
}

/** 扫描 <agent-dir>/extensions/ 现状；只判定「软链 + 落在仓库内」为受管 */
export function scanTarget(agentExtDir, repo) {
  const existing = new Map();
  if (!fs.existsSync(agentExtDir)) return { dirExists: false, existing };

  for (const entry of fs.readdirSync(agentExtDir, { withFileTypes: true })) {
    const full = path.join(agentExtDir, entry.name);
    const info = { name: entry.name, path: full, kind: "other", link: undefined, resolved: undefined, owned: false };
    if (entry.isSymbolicLink()) {
      info.kind = "symlink";
      try {
        info.link = fs.readlinkSync(full);
      } catch {
        info.link = undefined;
      }
      info.resolved = info.link ? path.resolve(agentExtDir, info.link) : undefined;
      info.owned = Boolean(info.resolved && isUnder(info.resolved, repo));
    } else if (entry.isDirectory()) {
      info.kind = "directory";
    } else {
      info.kind = "file";
    }
    existing.set(entry.name, info);
  }
  return { dirExists: true, existing };
}

/** 计算计划：不改盘，纯函数 */
export function planSync({ repo, agentDir, force = false, uninstall = false }) {
  const agentExtDir = path.join(agentDir, "extensions");
  const { packages, errors: discoveryErrors } = discoverExtensions(repo);
  const { links, errors: nameErrors } = desiredLinks(packages);
  const { existing } = scanTarget(agentExtDir, repo);

  const actions = [];
  const conflicts = [];
  const errors = [...discoveryErrors, ...nameErrors];

  if (uninstall) {
    for (const info of existing.values()) {
      if (info.kind === "symlink" && info.owned) {
        actions.push({ type: "remove", name: info.name, source: info.resolved, package: undefined });
      }
    }
    actions.sort((a, b) => a.name.localeCompare(b.name));
    return { agentExtDir, packages, actions, conflicts, errors };
  }

  for (const link of links.values()) {
    const current = existing.get(link.name);
    if (!current) {
      actions.push({ type: "install", name: link.name, source: link.source, package: link.package });
      continue;
    }
    if (current.kind === "symlink" && current.resolved === link.source) {
      actions.push({ type: "unchanged", name: link.name, source: link.source, package: link.package });
      continue;
    }
    if (current.kind === "symlink" && current.owned) {
      actions.push({
        type: "update",
        name: link.name,
        source: link.source,
        previous: current.resolved,
        package: link.package,
      });
      continue;
    }
    if (current.kind === "symlink" && force) {
      actions.push({
        type: "update",
        name: link.name,
        source: link.source,
        previous: current.resolved,
        package: link.package,
        reason: "覆盖指向别处的同名软链",
      });
      continue;
    }
    conflicts.push({
      name: link.name,
      reason:
        current.kind === "symlink"
          ? "同名软链指向别处（加 --force 可覆盖）"
          : `同名真实${current.kind === "directory" ? "目录" : "文件"}占位，需人工处理`,
    });
  }

  // 仓库里已不存在的受管残留 → 清理
  for (const info of existing.values()) {
    if (info.kind === "symlink" && info.owned && !links.has(info.name)) {
      actions.push({ type: "remove", name: info.name, source: info.resolved, package: undefined, reason: "仓库中已删除，清理残留" });
    }
  }

  actions.sort((a, b) => a.name.localeCompare(b.name));
  return { agentExtDir, packages, actions, conflicts, errors };
}

/** 落盘；dry-run 时只标注不执行 */
export function applyPlan(plan, { dryRun = false } = {}) {
  const changed = plan.actions.some((a) => a.type !== "unchanged");
  if (!dryRun && changed) fs.mkdirSync(plan.agentExtDir, { recursive: true });

  const applied = [];
  for (const action of plan.actions) {
    if (action.type === "unchanged") {
      applied.push({ ...action, status: "ok" });
      continue;
    }
    if (dryRun) {
      applied.push({ ...action, status: "dry-run" });
      continue;
    }
    const dest = path.join(plan.agentExtDir, action.name);
    try {
      if (action.type === "remove") {
        fs.rmSync(dest, { force: true });
      } else {
        fs.rmSync(dest, { force: true });
        fs.symlinkSync(path.relative(plan.agentExtDir, action.source), dest);
      }
      applied.push({ ...action, status: "done" });
    } catch (error) {
      applied.push({ ...action, status: "failed", error: String(error?.message ?? error) });
    }
  }
  return applied;
}

/** git pull --ff-only；工作区不干净就拒绝，绝不 stash/强拉 */
export function gitPull(repo) {
  const run = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const probe = run(["rev-parse", "--is-inside-work-tree"]);
  if (probe.status !== 0) return { ok: false, message: "不是 git 仓库，已跳过 git pull" };

  const dirty = run(["status", "--porcelain"]);
  if (dirty.status !== 0) return { ok: false, message: "无法读取 git 状态，已跳过 git pull" };
  if (dirty.stdout.trim()) {
    return { ok: false, message: "工作区有未提交改动，已跳过 git pull（请先提交或 stash）" };
  }

  const pull = run(["pull", "--ff-only"]);
  const output = `${pull.stdout}${pull.stderr}`.trim();
  if (pull.status !== 0) return { ok: false, message: `git pull 失败：${output || "未知错误"}` };
  return { ok: true, message: output || "已经是最新版本" };
}

/** 组装一份完整报告（引擎的唯一出口，CLI 与扩展壳都消费它） */
export function execute(options = {}) {
  const repo = path.resolve(options.repo || repoRootFromScript());
  const agentDir = path.resolve(options.agentDir || defaultAgentDir());
  const command = COMMANDS.has(options.command) ? options.command : "sync";
  const dryRun = Boolean(options.dryRun);

  const report = {
    ok: true,
    command,
    dryRun,
    repo,
    agentDir,
    extensionsDir: path.join(agentDir, "extensions"),
    pull: undefined,
    packages: [],
    actions: [],
    conflicts: [],
    errors: [],
    warnings: [],
  };

  if (process.platform === "win32") {
    report.errors.push("Windows 下创建符号链接需要管理员权限或开发者模式，暂不支持");
    report.ok = false;
    return report;
  }

  if (command === "pull") {
    report.pull = dryRun ? { ok: true, message: "dry-run：不会真的执行 git pull" } : gitPull(repo);
    if (!report.pull.ok) report.warnings.push(report.pull.message);
  }

  const plan = planSync({ repo, agentDir, force: Boolean(options.force), uninstall: command === "uninstall" });
  report.packages = plan.packages.map((p) => ({
    package: p.package,
    files: p.files.map((f) => path.relative(repo, f)),
  }));
  report.conflicts = plan.conflicts;
  report.errors.push(...plan.errors);

  report.actions = command === "status" ? plan.actions.map((a) => ({ ...a, status: "readonly" })) : applyPlan(plan, { dryRun });

  const failed = report.actions.filter((a) => a.status === "failed");
  for (const action of failed) report.errors.push(`${action.name}：${action.error}`);
  report.ok = report.errors.length === 0 && report.conflicts.length === 0 && failed.length === 0;
  return report;
}

export function renderReport(report) {
  const lines = [];
  const title = { sync: "同步", pull: "拉取并同步", uninstall: "卸载", status: "状态" }[report.command] ?? report.command;
  lines.push(`扩展${title}${report.dryRun ? "（dry-run，未落盘）" : ""}`);
  lines.push(`  仓库：${report.repo}`);
  lines.push(`  目标：${report.extensionsDir}`);
  if (report.pull) lines.push(`  git pull：${report.pull.ok ? "" : "⚠️ "}${report.pull.message}`);

  if (report.actions.length === 0) {
    lines.push("", "没有需要处理的条目。");
  } else {
    lines.push("", "| 动作 | 名称 | 说明 |", "| --- | --- | --- |");
    for (const action of report.actions) {
      const label = ACTION_LABEL[action.type] ?? action.type;
      const fallback = report.command === "uninstall" ? "受管软链" : "仓库中已删除";
      const note = action.reason || action.package || (action.type === "remove" ? fallback : "");
      lines.push(`| ${label} | ${action.name} | ${note || "—"} |`);
    }
  }

  const counts = {};
  for (const action of report.actions) {
    const key = ACTION_LABEL[action.type] ?? action.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  lines.push("");
  lines.push(`扩展包 ${report.packages.length} 个 · ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join("、") || "无动作"}`);

  for (const conflict of report.conflicts) lines.push(`⚠️ 冲突：${conflict.name} — ${conflict.reason}`);
  for (const warning of report.warnings) lines.push(`⚠️ ${warning}`);
  for (const error of report.errors) lines.push(`❌ ${error}`);
  if (report.ok && report.command !== "status") lines.push("", "改完请在会话里执行 /reload（或新开会话）让扩展生效。");
  return lines.join("\n");
}

const HELP = `用法：node tools/pi-sync.mjs [sync|pull|uninstall|status] [选项]

命令：
  sync        同步：安装/更新仓库里的全部扩展（默认）
  pull        先 git pull --ff-only，再 sync
  uninstall   卸载：移除本工具管理的全部软链（不删仓库文件）
  status      只读：查看当前状态与将要发生的改动

选项：
  --repo <dir>       仓库根目录（默认从脚本位置推断）
  --agent-dir <dir>  agent 目录（默认 $PI_CODING_AGENT_DIR 或 ~/.pi/agent）
  --dry-run          只打印不改动
  --force            覆盖指向别处的同名软链（真实文件/目录仍拒绝）
  --json             输出机器可读 JSON
  -h, --help         显示本帮助`;

export function parseArgs(argv) {
  const options = { command: "sync", json: false };
  let sawCommand = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--repo") options.repo = argv[++i];
    else if (arg === "--agent-dir") options.agentDir = argv[++i];
    else if (!arg.startsWith("-") && !sawCommand && COMMANDS.has(arg)) {
      options.command = arg;
      sawCommand = true;
    } else if (!arg.startsWith("-") && !sawCommand) {
      options.unknown = arg;
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (options.unknown) {
    process.stderr.write(`未知命令：${options.unknown}\n\n${HELP}\n`);
    process.exitCode = 1;
    return;
  }
  const report = execute(options);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${renderReport(report)}\n`);

  if (!report.ok) process.exitCode = 1;
  else if (report.actions.some((a) => a.status === "dry-run")) process.exitCode = 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
