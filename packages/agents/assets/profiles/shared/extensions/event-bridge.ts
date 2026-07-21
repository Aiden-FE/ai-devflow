// event-bridge：注册两个内部工具（设计 §7.4），输出可映射的稳定事件。
// - ai_devflow_interaction：澄清/确认。被调用后，supervisor 在工具结果落入 JSONL 后终止本次 Pi
//   进程并把任务交还现有 awaiting_input 流程。
// - ai_devflow_report_result：结构化完成（summary/verification/changedFiles/unresolved）。
// 这两个工具对四角色都必须启用（--tools 并集），非用户可配置。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ai_devflow_interaction",
    label: "Request user interaction",
    description: "Pause for a required clarification or confirmation.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("clarification"), Type.Literal("confirmation")]),
      title: Type.String(),
      detail: Type.String(),
    }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: JSON.stringify({ aiDevflowInteraction: input }) }], details: input };
    },
  });

  pi.registerTool({
    name: "ai_devflow_report_result",
    label: "Report final result",
    description: "Report the verified final result exactly once.",
    parameters: Type.Object({
      summary: Type.String(),
      verification: Type.Array(Type.String()),
      changedFiles: Type.Array(Type.String()),
      unresolved: Type.Array(Type.String()),
    }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: JSON.stringify({ aiDevflowResult: input }) }], details: input };
    },
  });
}
