// task-bridge：注册任务草稿生成步骤专用工具。
// - ai_devflow_propose_task：task_proposer 在需求澄清、代码探索、方案确定后，产出 1 到 N 个可执行
//   的开发任务草稿（含依赖 DAG）。每个任务的 description 必须是切实可行的实施计划。
//   工具结果经 supervisor 事件流回传给主进程，由 executeTextOnRoute 的 tool_execution_end
//   分支捕获并经 onToolResult 上报；主进程再用 taskSchema + validateProposalDag 校验后返回渲染进程。
//   取代旧 task_proposal 的「自由文本 + JSON.parse」路径，避免模型输出未转义引号等导致 JSON 解析失败。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ai_devflow_propose_task",
    label: "Propose task drafts",
    description:
      "在需求已澄清、相关项目逻辑已探索、方案已确定后，一次性产出 1 到 N 个可执行的开发任务草稿（含依赖 DAG）。每个任务的 description 必须是一份切实可行的实施计划（改动范围、实施步骤、关键约定、边界与风险）。结构化草稿只能通过此工具产出，不要在回复正文输出 JSON。",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          draftId: Type.String({ description: "稳定的草稿标识，如 t1、t2，用于 dependsOn 引用" }),
          title: Type.String({ description: "任务标题（动宾结构，简洁，表达该子任务要交付什么）" }),
          description: Type.String({
            description:
              "切实可行的实施计划，是每个子任务的核心交付物：改动范围（要新增/修改/复用哪些文件、模块、函数，写明探索中定位到的真实位置）、实施步骤（按顺序的关键步骤）、关键约定（接口/数据结构/命名/对接方式）、边界与风险（兼容性/异常路径/如何避免破坏现有功能）",
          }),
          role: Type.Union(
            [
              Type.Literal("planner"),
              Type.Literal("coder"),
              Type.Literal("reviewer"),
              Type.Literal("tester"),
            ],
            { description: "任务角色" },
          ),
          dependsOn: Type.Array(Type.String(), {
            description: "依赖的其它 draftId 列表；无依赖则为空数组",
          }),
        }),
        { description: "任务草稿列表（至少 1 个）" },
      ),
    }),
    async execute(_id, input) {
      return {
        content: [{ type: "text", text: JSON.stringify({ aiDevflowTaskProposal: input }) }],
        details: input,
      };
    },
  });
}
