// event-bridge：注册两个内部工具（设计 §7.4），输出可映射的稳定事件。
// - ai_devflow_interaction：澄清/确认。被调用后，supervisor 在工具结果落入 JSONL 后终止本次 Pi
//   进程并把任务交还现有 awaiting_input 流程。
// - ai_devflow_report_result：结构化完成（summary/verification/changedFiles/unresolved）。
// 这两个工具对四角色都必须启用（--tools 并集），非用户可配置。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const nonEmpty = Type.String({ minLength: 1 });
const strings = Type.Array(Type.String());
const nonEmptyStrings = Type.Array(nonEmpty, { minItems: 1 });
const knowledgeType = Type.Union([
  Type.Literal("context"),
  Type.Literal("adr"),
  Type.Literal("feature"),
  Type.Literal("runbook"),
  Type.Literal("product"),
  Type.Literal("ux"),
]);
const candidate = Type.Object({
  type: knowledgeType,
  summary: nonEmpty,
  evidence: nonEmptyStrings,
  suggestedTarget: Type.Optional(Type.String()),
  reuseScenario: nonEmpty,
});
const assessment = Type.Union([
  Type.Object({
    verdict: Type.Literal("none"),
    reason: nonEmpty,
    evidence: nonEmptyStrings,
  }),
  Type.Object({
    verdict: Type.Literal("valuable"),
    candidates: Type.Array(candidate, { minItems: 1 }),
  }),
]);
const finding = Type.Object({
  id: nonEmpty,
  severity: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
  code: Type.String(),
  path: Type.Optional(Type.String()),
  knowledgeId: Type.Optional(Type.String()),
  message: Type.String(),
  evidence: strings,
});

const payloadByKind = {
  task_review: Type.Object({
    kind: Type.Literal("task_review"),
    review: Type.Object({
      pass: Type.Boolean(),
      summary: nonEmpty,
      feedback: Type.Optional(Type.String()),
      checks: Type.Optional(strings),
    }),
    knowledgeAssessment: assessment,
  }),
  knowledge_initialization: Type.Object({
    kind: Type.Literal("knowledge_initialization"),
    changedPaths: strings,
    knowledgeIds: strings,
  }),
  knowledge_audit: Type.Object({
    kind: Type.Literal("knowledge_audit"),
    findings: Type.Array(finding),
  }),
  knowledge_repair: Type.Object({
    kind: Type.Literal("knowledge_repair"),
    changedPaths: strings,
    knowledgeIds: strings,
    resolvedFindingIds: strings,
  }),
  knowledge_deposition: Type.Object({
    kind: Type.Literal("knowledge_deposition"),
    changedPaths: strings,
    knowledgeIds: strings,
    candidateKnowledge: Type.Array(Type.Object({
      candidateIndex: Type.Integer({ minimum: 0 }),
      knowledgeId: nonEmpty,
    })),
    assessment,
  }),
  iteration_changelog: Type.Object({
    kind: Type.Literal("iteration_changelog"),
    changedPaths: strings,
    coveredTaskIds: strings,
  }),
} as const;

type PayloadKind = keyof typeof payloadByKind;

function reportParameters() {
  const resultKind = process.env.AI_DEVFLOW_RESULT_KIND ?? "";
  const payload = resultKind === "task_execution"
    ? undefined
    : payloadByKind[resultKind as PayloadKind];
  return Type.Object({
    summary: nonEmpty,
    verification: Type.Array(Type.String()),
    changedFiles: Type.Array(Type.String()),
    unresolved: Type.Array(Type.String()),
    ...(payload ? { payload } : {}),
    knowledgeReads: Type.Optional(
      Type.Array(
        Type.Object({
          knowledgeId: Type.String(),
          path: Type.String(),
          reason: Type.String(),
          chars: Type.Number(),
        }),
      ),
    ),
  });
}

export default function (pi: ExtensionAPI) {
  // 工具层防御：Pi 不强制校验 TypeBox schema，模型可能省略 payload 字段。
  // 在 tool_call 钩子主动校验 payload 存在性，缺失则 block 并提示模型补全后重试（turn 内纠正），
  // 避免流转到宿主层 validateExpertCompletion 才终止整个 run（task_result 失败退回待开发）。
  const expectedKind = process.env.AI_DEVFLOW_RESULT_KIND ?? "";
  const requiresPayload = expectedKind !== "" && expectedKind !== "task_execution";
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "ai_devflow_report_result") return;
    if (requiresPayload) {
      const input = event.input as { payload?: unknown } | undefined;
      if (!input || input.payload === undefined || input.payload === null) {
        return {
          block: true,
          reason: `ai_devflow_report_result 缺少 payload 字段：当前 resultKind=${expectedKind}，必须携带 ${expectedKind} 结构化载荷（payload 参数）。请补全 payload 后重新调用。`,
        };
      }
      // payload 必须是对象（结构化载荷）：模型常误把 payload 当成 JSON 字符串或数组传入。
      // 仅 typeof==='object' && !==null && !Array.isArray 才是合法的判别对象，否则会在宿主层
      // validateKnowledgeAgentPayload 触发「payload 必须是对象」并终止整个 run（task_result 失败退回待开发），
      // 在此 block 可让模型在同一 turn 内纠正后重试。
      const p = input.payload;
      if (typeof p !== 'object' || p === null || Array.isArray(p)) {
        const actual = Array.isArray(p) ? 'array' : typeof p;
        return {
          block: true,
          reason: `ai_devflow_report_result 的 payload 必须是 ${expectedKind} 对象（当前为 ${actual}）。请直接传入结构化对象（例如 { kind: "${expectedKind}", ... }），不要序列化为字符串或用数组包裹。`,
        };
      }
    }
    return undefined;
  });

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
    parameters: reportParameters(),
    async execute(_id, input) {
      return { content: [{ type: "text", text: JSON.stringify({ aiDevflowResult: input }) }], details: input };
    },
  });
}
