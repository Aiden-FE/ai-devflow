// ask-bridge：注册交互式问答工具 ai_devflow_ask。
// - AI 在需要向用户澄清多个问题时调用此工具：支持多 tab（分组）、每问单选/多选/自由描述，统一提交。
// - execute 通过 process.send（Node IPC）向父进程发请求，阻塞等待答案后 resolve。
//   依赖 PiProcessSupervisor 的 stdio 含 'ipc' 通道（见 process-supervisor 改造）。
//   监听父进程回灌的 { kind:'ask_answer', toolUseId, answers } 后 resolve 对应 Promise。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const pending = new Map<string, (answer: unknown) => void>();

// 监听父进程回灌的答案（模块加载时注册一次）。子进程未启用 IPC 时无 process.on，安全跳过。
if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("message", (msg: unknown) => {
    if (msg && typeof msg === "object" && (msg as { kind?: string }).kind === "ask_answer") {
      const m = msg as { toolUseId: string; answers: unknown };
      const resolve = pending.get(m.toolUseId);
      if (resolve) {
        pending.delete(m.toolUseId);
        resolve(m.answers);
      }
    }
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ai_devflow_ask",
    label: "Ask user structured questions",
    description:
      "当需要向用户澄清多个问题时调用此工具：支持多个 tab（分组）、每个问题可为单选/多选/自由描述，用户统一提交后返回答案。一次调用收集一组相关问题，避免逐条往返。",
    parameters: Type.Object({
      tabs: Type.Array(
        Type.Object({
          id: Type.String({ description: "tab 标识" }),
          title: Type.String({ description: "tab 标题" }),
          questions: Type.Array(
            Type.Object({
              id: Type.String({ description: "问题标识" }),
              kind: Type.Union(
                [Type.Literal("single"), Type.Literal("multi"), Type.Literal("text")],
                { description: "single=单选，multi=多选，text=自由描述" },
              ),
              question: Type.String({ description: "问题文本" }),
              options: Type.Optional(
                Type.Array(
                  Type.Object({
                    value: Type.String(),
                    label: Type.String(),
                  }),
                  { description: "选项列表（single/multi 必填，text 可选作为占位提示）" },
                ),
              ),
              required: Type.Optional(Type.Boolean({ description: "是否必答" })),
            }),
            { minItems: 1 },
          ),
        }),
        { minItems: 1, description: "问题分组（tab）列表" },
      ),
    }),
    async execute(id, input) {
      // 通过 Node IPC 向父进程发请求。子进程未启用 IPC 时 process.send 不存在，工具退化为「无答案」返回。
      if (typeof process !== "undefined" && typeof process.send === "function") {
        process.send({ kind: "ask", toolUseId: id, payload: input });
      }
      // 阻塞等待父进程回灌答案。
      const answers = await new Promise<unknown>((resolve) => {
        pending.set(id, resolve);
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ aiDevflowAsk: input, answers }) }],
        details: { input, answers },
      };
    },
  });
}
