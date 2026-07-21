// structured-result：要求结束时输出结构化结果（设计 §7.4）。
// 跟踪 ai_devflow_report_result 调用：拒绝第二次调用；agent_end 时若未上报则发出稳定诊断。
// Main 进程的 PiJsonEventTranslator 是最终权威（缺少合法结构化结果即 protocol failure）；
// 本扩展是运行在 Pi 内的次级守卫与提示。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let reported = false;

  pi.on("tool_call", async (event) => {
    if (event.toolName === "ai_devflow_report_result") {
      if (reported) {
        return { block: true, reason: "policy:double-report: 结构化结果只能上报一次" };
      }
      reported = true;
    }
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!reported) {
      ctx?.ui?.notify?.("ai-devflow: 结束前必须调用 ai_devflow_report_result 上报结构化结果", "warn");
    }
  });
}
