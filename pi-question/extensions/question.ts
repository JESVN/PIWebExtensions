/**
 * pi-question — 让模型用「可点击选项」向用户提问
 *
 * 设计约束见 DESIGN.md：
 *  - 只用 ctx.ui.select() / ctx.ui.input()，绝不用 ctx.ui.custom()
 *    （pi-web 下 custom() 是固定 92×40 的无配色终端模拟，体验差）
 *  - 用户取消时 select() 返回 undefined，必须显式告知模型，避免其臆测答案
 *  - 误点「其他（我来输入）」后要能回退：输入层取消/空白 = 重新弹出选项列表，
 *    只有选项层取消（或 Stop 中断）才算真正取消（详见 DESIGN.md 的「返回契约」）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OTHER_LABEL = "其他（我来输入）";
// 提示语只在 pi-web 的输入框里可见（pi TUI 的输入组件忽略 placeholder）
const INPUT_PLACEHOLDER = "输入答案后回车；按 Esc 或「取消」返回选项列表";
// 兜底：异常客户端若一直返回「其他」+ 空输入，最多回退这么多次
const MAX_BACKS = 20;
const CANCEL_TEXT =
  "用户取消了提问。不要臆测答案，如有必要请改用其它方式或在正文中简短询问。";

export default function questionExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "question",
    label: "Question",
    description:
      "向用户提出一个需要决策的问题，并给出可点击的选项。当需要用户选择方案、确认方向或提供偏好时使用；当你打算在正文里列出多个候选方案、下一步或方向时，也应改用本工具。",
    parameters: Type.Object({
      question: Type.String({ description: "要问用户的问题（支持 Markdown）" }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "选项标题（简短）" }),
          description: Type.Optional(Type.String({ description: "选项补充说明（可选）" })),
        }),
        { description: "可选项，至少 1 个" },
      ),
      allowOther: Type.Optional(
        Type.Boolean({ description: "是否允许用户自行输入答案，默认 true" }),
      ),
    }),
    executionMode: "sequential",
    promptSnippet:
      "Ask the user with clickable options instead of listing choices in prose",
    promptGuidelines: [
      "Use question whenever your reply would offer the user choices, candidate next steps, or directions to pick from; never list such options in prose.",
      "Use question even when the request is open-ended: offer the most plausible directions as options instead of asking in plain text.",
    ],

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const options = params.options ?? [];

      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "当前运行模式没有可用的交互界面，无法向用户提问。" }],
          details: { question: params.question, answer: null, reason: "no-ui" },
        };
      }
      if (options.length === 0) {
        return {
          content: [{ type: "text", text: "错误：options 不能为空。" }],
          details: { question: params.question, answer: null, reason: "no-options" },
        };
      }

      const allowOther = params.allowOther !== false;
      const labels = options.map((o) =>
        o.description ? `**${o.label}** — ${o.description}` : o.label,
      );
      const choices = allowOther ? [...labels, OTHER_LABEL] : labels;

      let answer: string | undefined;
      let reason: "selected" | "custom" = "selected";
      let backs = 0;

      // 选「其他」后，输入层的取消/空白视为「回退到选项列表」，而不是取消整次提问
      while (answer === undefined) {
        const picked = await ctx.ui.select(params.question, choices, { signal });
        if (picked === undefined || signal?.aborted) break; // 选项层取消 / Stop 中断

        if (picked !== OTHER_LABEL) {
          // 把展示文本映射回原始 label
          answer = options[choices.indexOf(picked)]?.label ?? picked;
          break;
        }

        const typed = await ctx.ui.input(params.question, INPUT_PLACEHOLDER, { signal });
        if (signal?.aborted) break;
        const trimmed = typed?.trim();
        if (trimmed) {
          answer = trimmed;
          reason = "custom";
        } else if (++backs > MAX_BACKS) {
          break;
        }
        // 否则回到循环开头，重新弹出同一份选项列表
      }

      if (answer === undefined) {
        return {
          content: [{ type: "text", text: CANCEL_TEXT }],
          details: { question: params.question, answer: null, reason: "cancelled" },
        };
      }

      return {
        content: [{ type: "text", text: answer }],
        details: {
          question: params.question,
          answer,
          reason,
          wasCustom: reason === "custom",
          options: options.map((o) => o.label),
        },
      };
    },
  });
}
