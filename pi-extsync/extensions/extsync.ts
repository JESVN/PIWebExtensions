/**
 * pi-extsync — 在 pi / pi-web 里一键同步本仓库（PIWebExtensions）的扩展
 *
 * 本扩展是一层「薄壳」：真正的同步逻辑在仓库的 tools/pi-sync.mjs 里，
 * 这里只负责解析动作、弹确认框、调用脚本，并把结果落到聊天区。
 *
 * 设计约束见 DESIGN.md：
 *  - 只用 ctx.ui.select() / confirm() / notify()，绝不用 ctx.ui.custom()
 *  - 只做「用户显式要求」的同步；模型不得自行触发（见 promptGuidelines）
 *  - 不重启 pm2、不改 settings.json；改完提示用户 /reload
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

type ActionId = "sync" | "pull" | "uninstall" | "status";

const ACTIONS: ActionId[] = ["sync", "pull", "uninstall", "status"];
const ACTION_LABEL: Record<ActionId, string> = {
  sync: "同步（安装 / 更新全部扩展）",
  pull: "拉取并同步（git pull --ff-only）",
  status: "查看状态（只读）",
  uninstall: "卸载全部扩展",
};
const COMMAND_LABEL: Record<string, string> = {
  sync: "同步",
  pull: "拉取并同步",
  uninstall: "卸载",
  status: "状态",
};
const ACTION_ROW_LABEL: Record<string, string> = {
  install: "安装",
  update: "更新",
  unchanged: "已就绪",
  remove: "卸载",
  conflict: "冲突",
};
const ENGINE_RELATIVE = path.join("tools", "pi-sync.mjs");

/** 本扩展绑定的仓库根：优先 PI_SYNC_BIN 的上级目录；否则从本文件位置往上两级 */
function locateRepo(): string | undefined {
  const override = process.env.PI_SYNC_BIN?.trim();
  if (override) return path.resolve(path.dirname(override), "..");
  try {
    const here = fs.realpathSync(fileURLToPath(import.meta.url));
    return path.resolve(path.dirname(here), "..", "..");
  } catch {
    return undefined;
  }
}

/** 定位同步脚本：优先 PI_SYNC_BIN；否则取仓库根下的 tools/pi-sync.mjs */
function findEngine(): string | undefined {
  const override = process.env.PI_SYNC_BIN?.trim();
  if (override) return fs.existsSync(override) ? override : undefined;
  const repo = locateRepo();
  if (!repo) return undefined;
  const candidate = path.join(repo, ENGINE_RELATIVE);
  return fs.existsSync(candidate) ? candidate : undefined;
}

/** 仓库名：用于文案消歧（同步的是本扩展所在仓库，与当前工作目录无关） */
function repoName(): string {
  const repo = locateRepo();
  return repo ? path.basename(repo) : "本扩展所在仓库";
}

/** 确认文案必须点名仓库名，否则在别的目录敲命令时会以为是同步当前项目 */
function confirmHint(action: Exclude<ActionId, "status">): string {
  const name = repoName();
  return {
    sync: `将把「${name}」仓库里的扩展软链到 agent 的 extensions 目录；不会删除任何真实文件。继续？`,
    pull: `将先对「${name}」仓库执行 git pull --ff-only（工作区不干净会自动跳过），再同步扩展。继续？`,
    uninstall: `将移除本工具管理的全部软链（仅限「${name}」仓库相关的软链）；仓库文件与其它扩展不受影响。继续？`,
  }[action];
}

interface EngineResult {
  report?: any;
  error?: string;
}

function runEngine(engine: string, action: ActionId, extra: string[] = []): EngineResult {
  const result = spawnSync(process.execPath, [engine, action, "--json", ...extra], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) return { error: `无法执行同步脚本：${result.error.message}` };

  const stdout = result.stdout ?? "";
  try {
    return { report: JSON.parse(stdout) };
  } catch {
    const detail = (result.stderr || stdout).trim().slice(0, 400);
    const code = result.status ?? "未知";
    return { error: `同步脚本没有返回可解析的结果（退出码 ${code}）${detail ? `：${detail}` : ""}` };
  }
}

function render(report: any): string {
  const label = COMMAND_LABEL[report?.command] ?? report?.command ?? "同步";
  const lines: string[] = [`**扩展${label}**${report?.dryRun ? "（dry-run，未落盘）" : ""}`];
  if (report?.repo) lines.push("", `同步对象：\`${report.repo}\`（与当前工作目录无关）`);

  if (report?.pull) lines.push("", `git pull：${report.pull.ok ? "✅" : "⚠️"} ${report.pull.message}`);

  const rows: any[] = Array.isArray(report?.actions) ? report.actions : [];
  const changed = rows.filter((row) => row.type !== "unchanged");
  if (rows.length > 0 && changed.length === 0) {
    lines.push("", `全部 ${rows.length} 个扩展均已就绪。`);
  } else if (changed.length > 0) {
    lines.push("", "| 动作 | 名称 | 说明 |", "| --- | --- | --- |");
    for (const row of changed) {
      const note = row.reason || row.package || (row.type === "remove" ? "受管软链" : "—");
      lines.push(`| ${ACTION_ROW_LABEL[row.type] ?? row.type} | ${row.name} | ${note} |`);
    }
  } else {
    lines.push("", "没有需要处理的条目。");
  }

  const conflicts: any[] = Array.isArray(report?.conflicts) ? report.conflicts : [];
  for (const conflict of conflicts) lines.push("", `⚠️ 冲突：${conflict.name} — ${conflict.reason}`);
  for (const warning of report?.warnings ?? []) lines.push("", `⚠️ ${warning}`);
  for (const error of report?.errors ?? []) lines.push("", `❌ ${error}`);

  if (report?.ok && report?.command !== "status") {
    lines.push("", "改完请执行 `/reload`（或新开会话）让扩展生效。");
  }
  return lines.join("\n");
}

function send(pi: ExtensionAPI, text: string, details: unknown) {
  try {
    pi.sendMessage(
      { customType: "pi-extsync", content: [{ type: "text", text }], display: true, details },
      {},
    );
  } catch {
    // 旧内核不支持自定义消息时退化为纯通知
  }
}

async function resolveAction(
  args: string,
  ctx: ExtensionContext,
): Promise<{ action: ActionId; dryRun: boolean } | undefined> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const dryRun = tokens.includes("--dry-run");
  const head = tokens.find((token) => !token.startsWith("-"));

  if (head) {
    if ((ACTIONS as string[]).includes(head)) return { action: head as ActionId, dryRun };
    ctx.ui.notify(`未知动作：${head}。可用：${ACTIONS.join(" / ")}`, "error");
    return undefined;
  }
  if (!ctx.hasUI) return undefined;

  const choices = ACTIONS.map((action) => ACTION_LABEL[action]);
  const picked = await ctx.ui.select(`扩展同步 · ${repoName()}`, choices);
  if (picked === undefined) return undefined;
  const action = ACTIONS[choices.indexOf(picked)];
  return action ? { action, dryRun } : undefined;
}

export default function extSyncExtension(pi: ExtensionAPI) {
  async function perform(
    action: ActionId,
    ctx: ExtensionContext,
    opts: { confirm: boolean; dryRun?: boolean },
  ) {
    const engine = findEngine();
    if (!engine) {
      const text = "找不到 `tools/pi-sync.mjs`。本扩展需要与本仓库克隆一起使用（可用 `PI_SYNC_BIN` 指定脚本路径）。";
      send(pi, text, { ok: false, reason: "no-engine" });
      ctx.ui.notify("找不到同步脚本 tools/pi-sync.mjs", "error");
      return;
    }

    if (opts.confirm && action !== "status") {
      const ok = await ctx.ui.confirm(`扩展${COMMAND_LABEL[action]}`, confirmHint(action));
      if (!ok) {
        ctx.ui.notify("已取消", "info");
        return;
      }
    }

    const result = runEngine(engine, action, opts.dryRun ? ["--dry-run"] : []);
    const text = result.report ? render(result.report) : `扩展同步失败：${result.error}`;
    send(pi, text, result.report ?? { ok: false, error: result.error });
    const ok = result.report?.ok === true;
    ctx.ui.notify(ok ? `扩展${COMMAND_LABEL[action]}完成` : "扩展同步未完成，详见聊天区", ok ? "info" : "error");
  }

  try {
    pi.registerCommand("extsync", {
      description: `同步「${repoName()}」仓库的扩展到 agent 扩展目录（含卸载与状态查看）`,
      handler: async (args: string, ctx: ExtensionContext) => {
        const parsed = await resolveAction(args, ctx);
        if (!parsed) return;
        await perform(parsed.action, ctx, { confirm: parsed.action === "uninstall", dryRun: parsed.dryRun });
      },
    });
  } catch {
    // 旧内核可能不支持命令注册：不影响 ext_sync 工具
  }

  pi.registerTool({
    name: "ext_sync",
    label: "Extension Sync",
    description: `同步「${repoName()}」仓库（本扩展所在仓库，与当前工作目录无关）里的 pi 扩展：安装 / 更新到 agent 的 extensions 目录、清理已删除的扩展、或卸载全部；也可只读查看状态。仅当用户明确要求同步 / 卸载 / 查看扩展时才调用。`,
    parameters: Type.Object({
      action: Type.String({
        description: `动作：${ACTIONS.join(" / ")}（status 只读；uninstall 会移除本工具管理的软链）`,
      }),
      dryRun: Type.Optional(
        Type.Boolean({ description: "只报告将要发生的改动，不落盘；默认 false" }),
      ),
    }),
    executionMode: "sequential",
    promptSnippet: `Sync or uninstall the ${repoName()} repo's pi extensions into the agent extensions directory`,
    promptGuidelines: [
      `Use ext_sync only when the user explicitly asks to sync, reload, uninstall, or inspect the ${repoName()} repo's pi extensions; never call it on your own initiative.`,
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = String(params.action ?? "").trim() as ActionId;
      if (!ACTIONS.includes(action)) {
        return {
          content: [{ type: "text", text: `未知动作：${params.action}。可用：${ACTIONS.join(" / ")}。` }],
          details: { ok: false, reason: "bad-action" },
        };
      }
      if (action !== "status" && !ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "当前运行模式没有可用的交互界面，无法确认扩展变更；只读的 `status` 仍然可用。",
            },
          ],
          details: { ok: false, reason: "no-ui" },
        };
      }

      const engine = findEngine();
      if (!engine) {
        return {
          content: [
            {
              type: "text",
              text: "找不到 `tools/pi-sync.mjs`。本扩展需要与本仓库克隆一起使用（可用 `PI_SYNC_BIN` 指定脚本路径）。",
            },
          ],
          details: { ok: false, reason: "no-engine" },
        };
      }

      if (action !== "status") {
        const ok = await ctx.ui.confirm(`扩展${COMMAND_LABEL[action]}`, confirmHint(action));
        if (!ok) {
          return {
            content: [{ type: "text", text: "用户取消了扩展同步。" }],
            details: { ok: false, reason: "cancelled" },
          };
        }
      }

      const result = runEngine(engine, action, params.dryRun ? ["--dry-run"] : []);
      return {
        content: [{ type: "text", text: result.report ? render(result.report) : `扩展同步失败：${result.error}` }],
        details: result.report ?? { ok: false, error: result.error },
      };
    },
  });
}
