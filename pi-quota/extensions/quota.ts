/**
 * pi-quota — 在 pi / pi-web 里查询模型服务商的额度与用量
 *
 * 目前支持：OpenCode Go（https://opencode.ai/zen/go/v1/usage）
 *
 * 背景：pi-web 0.9.2 的「用量」面板只对**由 pi-web 自己管理凭据**（auth.json）的服务商显示；
 * 像本机这样把 key 写在 models.json 里的配置会被 /api/auth/providers 主动隐藏，因此 UI 上无入口。
 * 本扩展直接查同一个官方接口，绕开这个限制。
 *
 * Key 解析顺序：ctx.modelRegistry（与 pi 内部一致）→ 环境变量 → auth.json → models.json
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface ProviderMeta {
  name: string;
  usageUrl: string;
  envVar?: string;
}

const PROVIDERS: Record<string, ProviderMeta> = {
  "opencode-go": {
    name: "OpenCode Go",
    usageUrl: "https://opencode.ai/zen/go/v1/usage",
    envVar: "OPENCODE_API_KEY",
  },
};

const DEFAULT_PROVIDER = "opencode-go";
const WINDOW_LABEL: Record<string, string> = {
  rolling: "滚动窗口",
  weekly: "本周",
  monthly: "本月",
};
const WINDOW_ORDER = ["rolling", "weekly", "monthly"];
const WARN_USED = 70; // 已用百分比达到该值就给出提醒

interface WindowUsage {
  id: string;
  label: string;
  status?: string;
  used?: number;
  resetsAt?: string;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function usableKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // 以 ! 开头的是「命令式取密钥」，本扩展不执行命令
  if (!trimmed || trimmed.startsWith("!")) return undefined;
  return trimmed;
}

function keyFromFiles(provider: string, envVar?: string): { key?: string; from: string } {
  if (envVar) {
    const envKey = usableKey(process.env[envVar]);
    if (envKey) return { key: envKey, from: `环境变量 ${envVar}` };
  }
  const dir = agentDir();

  const auth = readJson(path.join(dir, "auth.json"))?.[provider];
  const authKey = usableKey(
    typeof auth === "string" ? auth : (auth?.key ?? auth?.apiKey ?? auth?.token),
  );
  if (authKey) return { key: authKey, from: "auth.json" };

  const configured = readJson(path.join(dir, "models.json"))?.providers?.[provider];
  const modelsKey = usableKey(configured?.apiKey ?? configured?.api_key);
  if (modelsKey) return { key: modelsKey, from: "models.json" };

  return { from: "none" };
}

async function resolveKey(
  ctx: ExtensionContext,
  provider: string,
  envVar?: string,
): Promise<{ key?: string; from: string }> {
  const registry: any = (ctx as any)?.modelRegistry;
  try {
    if (registry?.getApiKeyForProvider) {
      const key = usableKey(await registry.getApiKeyForProvider(provider));
      if (key) return { key, from: "pi 凭据" };
    }
    if (registry?.getAll && registry?.getApiKeyAndHeaders) {
      const model = (registry.getAll() as any[]).find((m) => m?.provider === provider);
      if (model) {
        const resolved = await registry.getApiKeyAndHeaders(model);
        if (resolved?.ok) {
          const key = usableKey(resolved.apiKey);
          if (key) return { key, from: "pi 凭据" };
        }
      }
    }
  } catch {
    // 旧版 pi 没有 modelRegistry，落到文件解析
  }
  return keyFromFiles(provider, envVar);
}

async function queryUsage(meta: ProviderMeta, key: string): Promise<WindowUsage[]> {
  const response = await fetch(meta.usageUrl, {
    headers: { Authorization: `Bearer ${key}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().slice(0, 200);
    throw new Error(`HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
  }
  const payload = JSON.parse(text);
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object") throw new Error("响应里没有 usage 字段");

  const rows: WindowUsage[] = Object.entries(usage)
    .filter(([, value]) => value && typeof value === "object")
    .map(([id, value]: [string, any]) => ({
      id,
      label: WINDOW_LABEL[id] ?? id,
      status: typeof value.status === "string" ? value.status : undefined,
      used: typeof value.percent === "number" ? value.percent : undefined,
      resetsAt: typeof value.resetsAt === "string" ? value.resetsAt : undefined,
    }));
  if (rows.length === 0) throw new Error("响应里没有可识别的用量窗口");

  return rows.sort((a, b) => {
    const ai = WINDOW_ORDER.indexOf(a.id);
    const bi = WINDOW_ORDER.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

function shanghaiParts(date: Date): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { day: `${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
}

function formatReset(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const target = shanghaiParts(date);
  const today = shanghaiParts(new Date());
  return target.day === today.day ? `今天 ${target.time}` : `${target.day} ${target.time}`;
}

function render(meta: ProviderMeta, rows: WindowUsage[]): string {
  const now = shanghaiParts(new Date());
  const stamp = `${now.day} ${now.time}`;

  const lines = [
    `**${meta.name} 额度**（更新于 ${stamp}）`,
    "",
    "| 窗口 | 已用 | 剩余 | 重置 |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const used = typeof row.used === "number" ? `${row.used}%` : "—";
    const left = typeof row.used === "number" ? `${Math.max(0, 100 - row.used)}%` : "—";
    const label = row.status && row.status !== "ok" ? `${row.label}（${row.status}）` : row.label;
    lines.push(`| ${label} | ${used} | ${left} | ${formatReset(row.resetsAt)} |`);
  }

  const risky = rows.filter((r) => typeof r.used === "number" && r.used >= WARN_USED);
  if (risky.length > 0) {
    lines.push("", `⚠️ ${risky.map((r) => `${r.label}已用 ${r.used}%`).join("、")}，注意剩余可用量。`);
  }
  return lines.join("\n");
}

async function run(
  ctx: ExtensionContext,
  providerId: string,
): Promise<{ text: string; ok: boolean; details: Record<string, unknown> }> {
  const meta = PROVIDERS[providerId];
  if (!meta) {
    return {
      text: `暂不支持 \`${providerId}\`。当前支持：${Object.keys(PROVIDERS)
        .map((id) => `\`${id}\``)
        .join("、")}`,
      ok: false,
      details: { provider: providerId, ok: false, reason: "unsupported" },
    };
  }

  const { key, from } = await resolveKey(ctx, providerId, meta.envVar);
  if (!key) {
    return {
      text: [
        `没找到 ${meta.name} 的 API Key。已尝试：pi 凭据、环境变量 \`${meta.envVar}\`、\`auth.json\`、\`models.json\`。`,
        "",
        `可在 \`${path.join(agentDir(), "models.json")}\` 的 \`providers["${providerId}"].apiKey\` 里配置。`,
      ].join("\n"),
      ok: false,
      details: { provider: providerId, ok: false, reason: "no-key" },
    };
  }

  try {
    const rows = await queryUsage(meta, key);
    return {
      text: `${render(meta, rows)}\n\n_凭据来源：${from}_`,
      ok: true,
      details: { provider: providerId, ok: true, providerName: meta.name, windows: rows, keySource: from },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `查询 ${meta.name} 额度失败：${message}`,
      ok: false,
      details: { provider: providerId, ok: false, reason: "query-failed", error: message },
    };
  }
}

export default function quotaExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "provider_quota",
    label: "Provider Quota",
    description:
      "查询模型服务商的额度与用量（滚动窗口/周/月，含重置时间）。当前支持 OpenCode Go。当用户问「额度」「用量」「还剩多少」「quota」时调用。",
    parameters: Type.Object({
      provider: Type.Optional(
        Type.String({
          description: `服务商 id，默认 ${DEFAULT_PROVIDER}（当前唯一支持值）`,
        }),
      ),
    }),
    executionMode: "sequential",
    promptSnippet: "Query provider quota/usage (OpenCode Go) when the user asks about 额度/用量/quota",
    promptGuidelines: [
      "When the user asks about remaining quota, usage, or 额度 for OpenCode Go, call provider_quota and show the returned table as-is.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      const outcome = await run(ctx, provider);
      return {
        content: [{ type: "text", text: outcome.text }],
        details: outcome.details,
      };
    },
  });

  // 斜杠命令是可选能力：旧版 pi 若不支持也不应影响工具加载
  try {
    pi.registerCommand("quota", {
      description: "查询 OpenCode Go 额度用量",
      handler: async (args, ctx) => {
        const provider = args.trim() || DEFAULT_PROVIDER;
        const outcome = await run(ctx as ExtensionContext, provider);
        // 以自定义消息形式落到会话里，聊天区可见（pi-web 会渲染 role:"custom" 消息）
        try {
          pi.sendMessage(
            {
              customType: "pi-quota",
              content: [{ type: "text", text: outcome.text }],
              display: true,
              details: outcome.details,
            },
            {},
          );
        } catch {
          // 旧版不支持自定义消息时退化为通知
        }
        ctx.ui.notify(outcome.ok ? "额度已更新" : "额度查询失败", outcome.ok ? "info" : "error");
      },
    });
  } catch {
    // 忽略：命令注册失败不影响 provider_quota 工具
  }
}
