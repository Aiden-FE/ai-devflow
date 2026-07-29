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
