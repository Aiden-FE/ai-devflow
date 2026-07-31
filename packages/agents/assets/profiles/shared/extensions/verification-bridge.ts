// verification-bridge：注册宿主端验证工具 ai_devflow_run_verification。
// - 背景：reviewer(test 专家)沙箱 PATH 白名单不含用户级工具链（nvm/volta/fnm/pnpm under $HOME），
//   且 reviewer 运行在 git worktree（无 node_modules）；execution-policy 又拦截直接解释器
//   (node/vitest/eslint) 与任意包管理器 wrapper。因此 reviewer 无法亲自重跑测试，只能依赖 coder
//   声明的构建产物，无法真正履行测试职责。
// - 方案（用户选定「宿主端验证桥」）：工具在子进程内通过 Node IPC 向父进程发请求
//   { kind:'verification_request', toolUseId, command }；宿主（PiRunner）在原始项目仓库
//   （非 worktree）用真实 PATH 执行受限白名单命令（pnpm test/typecheck/lint 等），返回脱敏输出。
// - 沙箱保持只读：reviewer 仍不可写文件、不可逃逸 PATH；宿主执行不暴露凭证，输出经 redactText 脱敏。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const pending = new Map<string, (result: unknown) => void>();

// 监听父进程回灌的验证结果（模块加载时注册一次）。子进程未启用 IPC 时无 process.on，安全跳过。
if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("message", (msg: unknown) => {
    if (
      msg
      && typeof msg === "object"
      && (msg as { kind?: string }).kind === "verification_result"
    ) {
      const m = msg as { toolUseId: string; result: unknown };
      const resolve = pending.get(m.toolUseId);
      if (resolve) {
        pending.delete(m.toolUseId);
        resolve(m.result);
      }
    }
  });
}

const COMMAND_DESCRIPTION =
  "在宿主环境（原始项目仓库，非 worktree）真实运行测试/类型检查/lint，返回脱敏输出。" +
  "用于 reviewer 在沙箱无法访问项目工具链时亲自重跑验证。command 取值：test | typecheck | lint。";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ai_devflow_run_verification",
    label: "Run host verification",
    description: COMMAND_DESCRIPTION,
    parameters: Type.Object({
      command: Type.Union(
        [Type.Literal("test"), Type.Literal("typecheck"), Type.Literal("lint")],
        { description: "验证命令：test=运行测试套件；typecheck=TypeScript 类型检查；lint=ESLint" },
      ),
      scope: Type.Optional(
        Type.String({
          description:
            "可选包过滤器（pnpm --filter 语法），如 '@ai-devflow/agents'。不填则在仓库根运行 workspace 级命令。",
        }),
      ),
    }),
    async execute(id, input) {
      // 子进程未启用 IPC 时（process.send 不存在）：无法请求宿主执行，返回错误说明，避免永久阻塞。
      if (typeof process === "undefined" || typeof process.send !== "function") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                command: input.command,
                error: "verification bridge unavailable: host IPC channel not enabled",
              }),
            },
          ],
          details: { input, ok: false },
          isError: true,
        };
      }
      process.send({ kind: "verification_request", toolUseId: id, payload: input });
      const result = await new Promise<unknown>((resolve) => {
        pending.set(id, resolve);
      });
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return {
        content: [{ type: "text", text }],
        details: { input, result },
      };
    },
  });
}
