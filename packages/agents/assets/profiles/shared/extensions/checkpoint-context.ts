// checkpoint-context：为重试与提供商接管注入恢复上下文（设计 §7.4/§10）。
// 仅读取 AI_DEVFLOW_CHECKPOINT_PATH（必须在本次 attempt session 目录内、≤256KiB），校验
// { completed, incomplete, uncertain, changedFiles, diffSummary, checkpoint } 后在 before_agent_start
// 注入系统提示。PiRunner 在 spawn 前以 0600 写该 JSON；新尝试绝不读取前一 Pi 私有 session。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const MAX_BYTES = 256 * 1024;

interface CheckpointPayload {
  completed?: unknown;
  incomplete?: unknown;
  uncertain?: unknown;
  changedFiles?: unknown;
  diffSummary?: unknown;
  checkpoint?: unknown;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const raw = process.env.AI_DEVFLOW_CHECKPOINT_PATH;
    if (!raw) return;
    const path = resolve(raw);
    const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (sessionDir && !path.startsWith(resolve(sessionDir) + sep)) return; // 必须在本尝试 session 内
    if (!existsSync(path)) return;
    try {
      if (statSync(path).size > MAX_BYTES) return;
    } catch {
      return;
    }
    let data: CheckpointPayload;
    try {
      data = JSON.parse(readFileSync(path, "utf8")) as CheckpointPayload;
    } catch {
      return;
    }
    const block = [
      "【恢复上下文（来自应用检查点；文件系统与 Git diff 是最终事实源，先验证现状再继续）】",
      `已完成：${JSON.stringify(data.completed ?? [])}`,
      `未完成：${JSON.stringify(data.incomplete ?? [])}`,
      `不确定（必须先检查工作区/进程/测试状态）：${JSON.stringify(data.uncertain ?? [])}`,
      `已知文件变化：${JSON.stringify(data.changedFiles ?? [])}`,
      `最近 diff 摘要：${typeof data.diffSummary === "string" ? data.diffSummary : ""}`,
      `调度器检查点：${JSON.stringify(data.checkpoint ?? null)}`,
    ].join("\n");
    const ev = event as { systemPrompt?: string } | undefined;
    if (ev && typeof ev.systemPrompt === "string") {
      ev.systemPrompt += `\n\n${block}`;
    }
  });
}
