// requirement-bridge：注册需求生成步骤专用工具。
// - ai_devflow_propose_requirement：当需求已足够清晰时，AI 调用此工具生成结构化需求草稿
//   （标题/描述/验收标准/优先级）。工具结果经 supervisor 事件流回传给 UI 填入表单，
//   由用户最终确认「创建」才持久化。取代旧「生成需求草稿」按钮的不可控触发。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ai_devflow_propose_requirement",
    label: "Propose requirement draft",
    description: "当需求已足够清晰时，调用此工具生成结构化需求草稿（标题/描述/验收标准/优先级）。",
    parameters: Type.Object({
      title: Type.String({ description: "简洁的需求标题（名词短语）" }),
      description: Type.String({ description: "需求描述（背景、目标、范围）" }),
      acceptance: Type.String({ description: "验收标准 / 门禁条件（可检验的完成定义）" }),
      priority: Type.Union(
        [Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")],
        { description: "优先级" },
      ),
    }),
    async execute(_id, input) {
      return {
        content: [{ type: "text", text: JSON.stringify({ aiDevflowRequirementProposal: input }) }],
        details: input,
      };
    },
  });
}
