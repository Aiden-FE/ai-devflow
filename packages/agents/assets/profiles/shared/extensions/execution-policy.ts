// execution-policy：拦截工具调用，实施路径/命令/角色权限/敏感文件规则（设计 §7.4/§10.7）。
// 返回稳定的 block reason（policy:* 前缀），使 Main 翻译器把策略拦截归为 task_result 而非 provider 失败。
// 规则要点：
// - 写工具路径规范化（最近存在父目录 realpath）后必须落在 AI_DEVFLOW_WORKTREE 内；禁止符号链接逃逸、
//   .env*、凭证存储、staged 运行时与 profile/session 策略文件。
// - 所有角色禁止递归删除与系统级/全局安装。
// - reviewer：edit/write 全禁；bash 仅允许只读/验证命令（git diff/status/show/log、grep/rg/find/ls/pwd 等），
//   拒绝重定向/命令替换/后台/链接/tee/变更型 git/安装/shell 逃逸。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

const ROLE = process.env.AI_DEVFLOW_ROLE ?? "";
const WORKTREE = process.env.AI_DEVFLOW_WORKTREE ?? "";

function nearestRealpath(p: string): string {
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return realpathSync(cur);
}

function isWithin(root: string, target: string): boolean {
  if (!root) return false;
  const r = realpathSync(root);
  return target === r || target.startsWith(r + sep);
}

const SENSITIVE = [".env", "credentials", "runtime-manifest.json", "settings.json", "system.md", "models.json"];
const READ_ONLY_FIRST = ["git", "grep", "rg", "find", "ls", "pwd", "cat", "head", "tail", "wc", "diff", "stat", "file"];
const GIT_READ_ONLY = ["diff", "status", "show", "log", "ls-files", "rev-parse", "branch", "config"];
const DANGEROUS = ["rm -rf", "rm -fr", "sudo", "mkfs", "dd if=", ":(){", "shutdown", "reboot", "format ", "del /f"];
const PKG_INSTALL = ["npm install", "npm i ", "pnpm install", "pnpm add", "yarn add", "pip install", "pip3 install", "brew install", "apt install", "apt-get", "cargo install", "go install"];

function firstToken(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] ?? "";
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const name = event.toolName;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const isReviewer = ROLE === "reviewer";

    if (isReviewer && (name === "write" || name === "edit")) {
      return { block: true, reason: "policy:reviewer-read-only: reviewer 角色禁止写文件" };
    }

    if (name === "write" || name === "edit") {
      const raw = typeof input.path === "string" ? input.path : "";
      if (!raw) return { block: true, reason: "policy:missing-path: 缺少写入路径" };
      const real = resolve(nearestRealpath(raw), raw.split(sep).pop() ?? "");
      if (!isWithin(WORKTREE, real)) {
        return { block: true, reason: "policy:outside-worktree: 禁止写出任务工作区或符号链接逃逸" };
      }
      const lower = real.toLowerCase();
      if (SENSITIVE.some((s) => lower.includes(s))) {
        return { block: true, reason: "policy:sensitive-file: 禁止修改敏感/凭证/策略文件" };
      }
    }

    if (name === "bash") {
      const cmd = typeof input.command === "string" ? input.command : "";
      const low = cmd.toLowerCase();
      for (const d of DANGEROUS) {
        if (low.includes(d)) return { block: true, reason: `policy:dangerous-command: 禁止破坏性命令 (${d.trim()})` };
      }
      for (const p of PKG_INSTALL) {
        if (low.includes(p)) return { block: true, reason: "policy:install-forbidden: 禁止系统级/全局安装" };
      }
      const isGit = /^git\b/.test(cmd.trim());
      if (!isGit && /[;&|`]|\$\(|>>?|<|\btee\b/.test(cmd)) {
        return { block: true, reason: "policy:shell-escape: 禁止重定向/命令替换/链接/后台执行" };
      }
      if (isReviewer) {
        const first = firstToken(cmd);
        if (isGit) {
          const sub = cmd.trim().split(/\s+/)[1] ?? "";
          if (!GIT_READ_ONLY.includes(sub)) {
            return { block: true, reason: `policy:git-mutation: 审查仅允许只读 git (${GIT_READ_ONLY.join("/")})` };
          }
        } else if (!READ_ONLY_FIRST.includes(first)) {
          return { block: true, reason: "policy:reviewer-bash-allowlist: 审查 bash 仅允许只读/验证命令" };
        }
      }
    }
    return undefined;
  });
}
