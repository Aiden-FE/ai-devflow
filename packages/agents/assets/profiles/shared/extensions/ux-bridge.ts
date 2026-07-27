// ux-bridge：注册 UX 子咨询工具 ai_devflow_consult_ux。
// - 产品专家在起草需求时识别到 UX 面（界面/交互/可视化/可访问性）时调用此工具，把当前需求上下文发给 UX专家。
// - execute 通过 process.send（Node IPC）向父进程发请求，阻塞等待 UX专家建议后 resolve。
//   机制对称于 ask-bridge：父进程启动一次 UX专家 step-agent run，把结构化建议回灌。
//   依赖 PiProcessSupervisor 的 stdio 含 'ipc' 通道（见 process-supervisor）。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const pending = new Map<string, (advice: unknown) => void>();

// 监听父进程回灌的 UX 建议（模块加载时注册一次）。子进程未启用 IPC 时无 process.on，安全跳过。
if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("message", (msg: unknown) => {
    if (msg && typeof msg === "object" && (msg as { kind?: string }).kind === "consult_ux_result") {
      const m = msg as { toolUseId: string; advice: unknown };
      const resolve = pending.get(m.toolUseId);
      if (resolve) {
        pending.delete(m.toolUseId);
        resolve(m.advice);
      }
    }
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ai_devflow_consult_ux",
    label: "Consult UX expert",
    description:
      "当需求含 UX 面（界面/交互/可视化/可访问性）时调用此工具咨询 UX专家。传入当前需求上下文，UX专家返回结构化建议（交互要点/视觉结构/可访问性/响应式）。无 UX 面的需求不要调用。",
    parameters: Type.Object({
      requirementContext: Type.String({
        description: "当前需求上下文（标题/描述/验收标准 + 已识别的 UX 面），供 UX专家产出针对性建议。",
      }),
    }),
    async execute(id, input) {
      // 子进程未启用 IPC 时（process.send 不存在）：无法向父进程发请求，立即返回空建议，避免永久阻塞。
      if (typeof process === "undefined" || typeof process.send !== "function") {
        return {
          content: [{ type: "text", text: JSON.stringify({ aiDevflowUxAdvice: { advice: "" } }) }],
          details: { input, advice: "" },
        };
      }
      process.send({ kind: "consult_ux", toolUseId: id, payload: input });
      // 阻塞等待父进程回灌 UX专家建议。
      const advice = await new Promise<unknown>((resolve) => {
        pending.set(id, resolve);
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ aiDevflowUxAdvice: { advice } }) }],
        details: { input, advice },
      };
    },
  });
}
