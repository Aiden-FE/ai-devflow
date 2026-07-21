"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name15 in all)
    __defProp(target, name15, { get: all[name15], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../packages/core/src/types.ts
var init_types = __esm({
  "../../packages/core/src/types.ts"() {
    "use strict";
  }
});

// ../../packages/core/src/state-machine.ts
function isLegalTransition(from, to) {
  if (from === to) return false;
  const targets = LEGAL_TRANSITIONS_STRICT[from] ?? [];
  return targets.includes(to);
}
function legalTargets(from) {
  return [...LEGAL_TRANSITIONS_STRICT[from] ?? []];
}
function isTerminal(status) {
  return status === "archived";
}
function illegalTransitions() {
  const out = [];
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (!isLegalTransition(from, to)) out.push({ from, to });
    }
  }
  return out;
}
var ALL_STATUSES, LEGAL_TRANSITIONS, LEGAL_TRANSITIONS_STRICT;
var init_state_machine = __esm({
  "../../packages/core/src/state-machine.ts"() {
    "use strict";
    ALL_STATUSES = [
      "backlog",
      "ready",
      "in_progress",
      "awaiting_input",
      "in_review",
      "archived"
    ];
    LEGAL_TRANSITIONS = {
      backlog: ["ready"],
      ready: ["in_progress", "backlog"],
      in_progress: ["awaiting_input", "in_review", "ready"],
      awaiting_input: ["in_progress", "in_review", "backlog"],
      in_review: ["in_progress", "awaiting_input", "archived"],
      archived: []
    };
    LEGAL_TRANSITIONS_STRICT = {
      backlog: ["ready"],
      ready: ["in_progress", "backlog"],
      in_progress: ["awaiting_input", "in_review", "ready"],
      awaiting_input: ["in_progress", "in_review", "backlog"],
      in_review: ["in_progress", "awaiting_input", "archived"],
      archived: []
    };
  }
});

// ../../packages/core/src/gates.ts
function canTransition(task, target, ctx) {
  const reasons = [];
  if (isTerminal(task.status)) {
    return { ok: false, reasons: ["\u4EFB\u52A1\u5DF2\u5F52\u6863\uFF0C\u4E0D\u53EF\u518D\u8FC1\u79FB"] };
  }
  if (!isLegalTransition(task.status, target)) {
    return {
      ok: false,
      reasons: [`\u975E\u6CD5\u8FC1\u79FB\uFF1A${task.status} -> ${target}`]
    };
  }
  const gate = STATUS_GATES[target];
  if (gate) {
    const r = gate(ctx);
    if (!r.ok) reasons.push(...r.reasons);
  }
  if (target === "in_review" && task.status !== "awaiting_input" && !ctx.hasArtifacts) {
    reasons.push("\u8FDB\u5165\u6D4B\u8BD5\u4E2D\u524D\u9700\u6709\u6267\u884C\u4EA7\u7269");
  }
  if (target === "archived") {
    if (ctx.testPassed !== true) reasons.push("\u5F52\u6863\u524D\u9700\u6D4B\u8BD5\u901A\u8FC7");
    if (ctx.auditOk !== true) reasons.push("\u5F52\u6863\u524D\u9700\u72B6\u6001\u5BA1\u8BA1\u901A\u8FC7");
  }
  if (target === "in_progress" && task.status === "ready" && !ctx.hasAgentAssigned) {
    reasons.push("\u5F00\u59CB\u6267\u884C\u524D\u9700\u5206\u914D Agent");
  }
  if (target === "ready" && !ctx.hasAcceptance) {
    reasons.push("\u8FDB\u5165\u5F85\u5F00\u53D1\u524D\u9700\u6709\u9A8C\u6536\u6807\u51C6");
  }
  if (task.status === "awaiting_input" && (target === "in_progress" || target === "in_review") && !ctx.hasUserAnswer) {
    reasons.push("\u4ECE\u5F85\u6C9F\u901A\u6062\u590D\u524D\u9700\u6709\u7528\u6237\u56DE\u7B54");
  }
  return { ok: reasons.length === 0, reasons };
}
function validateTransition(task, target, ctx) {
  const r = canTransition(task, target, ctx);
  return { allowed: r.ok, reasons: r.reasons };
}
function canReturnToDev(ctx) {
  if (ctx.testFailedWithEvidence !== true) {
    return { ok: false, reasons: ["\u6D4B\u8BD5\u5931\u8D25\u9000\u56DE\u5F00\u53D1\u9700\u9644\u5931\u8D25\u8BC1\u636E"] };
  }
  return { ok: true, reasons: [] };
}
function canArchiveRequirement(tasks) {
  if (tasks.length === 0) {
    return { ok: false, reasons: ["\u9700\u6C42\u4E0B\u65E0\u5B50\u4EFB\u52A1\uFF0C\u65E0\u6CD5\u9A8C\u6536\u5F52\u6863"] };
  }
  if (!tasks.every((t) => t.status === "archived")) {
    const pending = tasks.filter((t) => t.status !== "archived").length;
    return { ok: false, reasons: [`\u8FD8\u6709 ${pending} \u4E2A\u5B50\u4EFB\u52A1\u672A\u5B8C\u6210\uFF08\u9700\u5168\u90E8\u5F52\u6863\uFF09`] };
  }
  return { ok: true, reasons: [] };
}
function checkTaskDependencies(predecessors) {
  const blockedBy = predecessors.filter((p) => p.status !== "in_review" && p.status !== "archived");
  if (blockedBy.length === 0) {
    return { ok: true, reasons: [], blockedBy: [] };
  }
  return {
    ok: false,
    reasons: [`\u524D\u7F6E\u4EFB\u52A1\u672A\u5B8C\u6210\uFF1A${blockedBy.map((b) => b.title).join("\u3001")}`],
    blockedBy
  };
}
var STATUS_GATES;
var init_gates = __esm({
  "../../packages/core/src/gates.ts"() {
    "use strict";
    init_state_machine();
    STATUS_GATES = {
      archived: (ctx) => ({
        ok: ctx.testPassed === true && ctx.auditOk === true,
        reasons: ctx.testPassed === true && ctx.auditOk === true ? [] : ["\u5F52\u6863\u9700\u6D4B\u8BD5\u901A\u8FC7\u4E14\u5BA1\u8BA1\u901A\u8FC7"]
      })
    };
  }
});

// ../../packages/core/src/timeout.ts
function computeTriggerAt(statusChangedAt, minutes) {
  return statusChangedAt + Math.max(0, minutes) * 6e4;
}
function ruleApplies(rule, task) {
  if (!rule.enabled) return false;
  if (rule.status !== task.status) return false;
  if (rule.projectId && rule.projectId !== task.projectId) return false;
  return true;
}
function applicableRules(rules, task) {
  return rules.filter((r) => ruleApplies(r, task));
}
function nextTrigger(rules, task, now3) {
  const apps = applicableRules(rules, task);
  if (apps.length === 0) return null;
  let best = null;
  for (const r of apps) {
    const triggerAt = computeTriggerAt(task.statusChangedAt, r.minutes);
    const overdue = triggerAt <= now3;
    if (!best || triggerAt < best.triggerAt) {
      best = { ruleId: r.id, triggerAt, overdue };
    }
  }
  return best;
}
function findOverdue(rules, tasks, now3) {
  const out = [];
  for (const task of tasks) {
    for (const rule of applicableRules(rules, task)) {
      const triggerAt = computeTriggerAt(task.statusChangedAt, rule.minutes);
      if (triggerAt <= now3) out.push({ taskId: task.id, ruleId: rule.id, triggerAt });
    }
  }
  return out;
}
var init_timeout = __esm({
  "../../packages/core/src/timeout.ts"() {
    "use strict";
  }
});

// ../../packages/core/src/webhook.ts
function buildWebhookPayload(event, task, detail, t = 0) {
  return { event, task, t, detail };
}
function canonicalStringify(obj) {
  return JSON.stringify(sortKeys(obj));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeys(value[k]);
    }
    return out;
  }
  return value;
}
function encoders() {
  return { TextEncoder: globalThis.TextEncoder };
}
async function signBody(secret, body) {
  const { TextEncoder: TextEncoder2 } = encoders();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder2().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder2().encode(body));
  return toHex(new Uint8Array(sig));
}
async function signPayload(secret, payload) {
  const body = canonicalStringify(payload);
  const hex = await signBody(secret, body);
  return { body, signature: `sha256=${hex}`, header: WEBHOOK_SIGNATURE_HEADER };
}
async function verifySignature(secret, body, signature) {
  const expected = await signBody(secret, body);
  const incoming = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  return constantTimeEqual(expected, incoming.toLowerCase());
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
var WEBHOOK_SIGNATURE_HEADER;
var init_webhook = __esm({
  "../../packages/core/src/webhook.ts"() {
    "use strict";
    WEBHOOK_SIGNATURE_HEADER = "X-AiDevflow-Signature";
  }
});

// ../../packages/core/src/cli.ts
function stripAnsi(input) {
  return input.replace(ANSI_RE, "").replace(OTHER_CTRL_RE, "");
}
function normalizeNewlines(input) {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function collapseCarriage(input) {
  return input.split("\n").map((line) => {
    const parts = line.split("\r");
    return parts[parts.length - 1] ?? "";
  }).join("\n");
}
function standardizeCliOutput(raw) {
  const cleaned = collapseCarriage(normalizeNewlines(stripAnsi(raw)));
  const lines = cleaned.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.map((l) => ({ level: inferLevel(l), text: l }));
}
function inferLevel(line) {
  const lower = line.toLowerCase();
  if (/\b(error|err|failed|failure|fatal|panic)\b/.test(lower)) return "error";
  if (/\b(warn|warning|deprecat)\b/.test(lower)) return "warn";
  return "info";
}
function summarizeOutput(raw, maxLen = 200) {
  const lines = standardizeCliOutput(raw);
  if (lines.length === 0) return "";
  const last = lines[lines.length - 1].text;
  if (last.length <= maxLen) return last;
  return last.slice(0, maxLen - 1) + "\u2026";
}
var ANSI_RE, OTHER_CTRL_RE;
var init_cli = __esm({
  "../../packages/core/src/cli.ts"() {
    "use strict";
    ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
    OTHER_CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
  }
});

// ../../packages/core/src/retry.ts
function backoffDelay(policy, attempt, jitterFactor = 0) {
  const exp = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1))
  );
  const jitter = Math.round(exp * jitterFactor);
  return Math.max(0, Math.min(policy.maxDelayMs, exp + jitter));
}
function decideRetry(policy, attempt, recoverable) {
  if (!recoverable) {
    return { retry: false, delayMs: 0, reason: "\u9519\u8BEF\u4E0D\u53EF\u6062\u590D\uFF0C\u4E0D\u91CD\u8BD5" };
  }
  if (attempt >= policy.maxAttempts) {
    return { retry: false, delayMs: 0, reason: `\u5DF2\u8FBE\u6700\u5927\u5C1D\u8BD5\u6B21\u6570 ${policy.maxAttempts}` };
  }
  const delay2 = policy.backoff ? backoffDelay(policy, attempt + 1) : policy.baseDelayMs;
  return { retry: true, delayMs: delay2, reason: `\u7B2C ${attempt + 1} \u6B21\u5C1D\u8BD5\uFF0C\u5EF6\u8FDF ${delay2}ms` };
}
function planRecovery(execution, taskStatus, processAlive, lastStageIndex) {
  if (execution.status === "succeeded" || execution.status === "canceled") {
    return { kind: "noop", reason: "\u6267\u884C\u5DF2\u7ED3\u675F" };
  }
  if (execution.status === "failed") {
    return { kind: "noop", reason: "\u6267\u884C\u5DF2\u5931\u8D25\uFF0C\u7B49\u5F85\u663E\u5F0F\u91CD\u8BD5" };
  }
  if (taskStatus === "awaiting_input") {
    return { kind: "wait", reason: "\u4EFB\u52A1\u5F85\u6C9F\u901A\uFF0C\u7B49\u5F85\u7528\u6237\u56DE\u7B54\u540E\u4ECE\u68C0\u67E5\u70B9\u6062\u590D" };
  }
  if (execution.status === "paused") {
    return { kind: "wait", reason: "\u6267\u884C\u5DF2\u6682\u505C\uFF0C\u7B49\u5F85\u7528\u6237\u6062\u590D" };
  }
  if (processAlive) {
    return { kind: "resume", fromStageIndex: lastStageIndex };
  }
  return { kind: "fail", reason: "\u91CD\u542F\u540E\u53D1\u73B0\u8FD0\u884C\u4E2D\u4EFB\u52A1\u5B50\u8FDB\u7A0B\u5DF2\u6B7B\uFF0C\u6807\u8BB0\u5931\u8D25" };
}
var DEFAULT_RETRY_POLICY;
var init_retry = __esm({
  "../../packages/core/src/retry.ts"() {
    "use strict";
    DEFAULT_RETRY_POLICY = {
      maxAttempts: 3,
      baseDelayMs: 1e3,
      maxDelayMs: 3e4,
      backoff: true
    };
  }
});

// ../../packages/core/src/sanitize.ts
function validateProjectName(name15) {
  const errors = [];
  const trimmed = name15.trim();
  if (trimmed.length === 0) errors.push("\u9879\u76EE\u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (trimmed.length > 120) errors.push("\u9879\u76EE\u540D\u8FC7\u957F\uFF08>120\uFF09");
  if (/[<>]/.test(trimmed)) errors.push("\u9879\u76EE\u540D\u542B\u975E\u6CD5\u5B57\u7B26 < \u6216 >");
  return { ok: errors.length === 0, errors };
}
function validateLocalPath(path) {
  const errors = [];
  if (path.trim().length === 0) errors.push("\u8DEF\u5F84\u4E0D\u80FD\u4E3A\u7A7A");
  if (!path.startsWith("/")) errors.push("\u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84");
  if (path.includes("\n")) errors.push("\u8DEF\u5F84\u542B\u6362\u884C");
  return { ok: errors.length === 0, errors };
}
function validateWebhookUrl(url) {
  const errors = [];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, errors: ["URL \u683C\u5F0F\u975E\u6CD5"] };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    errors.push("\u4EC5\u652F\u6301 http/https");
  }
  return { ok: errors.length === 0, errors };
}
function validateMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, errors: ["\u5206\u949F\u6570\u5FC5\u987B\u4E3A\u6B63\u6570"] };
  }
  if (minutes > 60 * 24 * 30) {
    return { ok: false, errors: ["\u5206\u949F\u6570\u8FC7\u5927"] };
  }
  return { ok: true, errors: [] };
}
function validatePrompt(prompt) {
  if (prompt.trim().length === 0) return { ok: false, errors: ["\u63D0\u793A\u8BCD\u4E0D\u80FD\u4E3A\u7A7A"] };
  if (prompt.length > 5e4) return { ok: false, errors: ["\u63D0\u793A\u8BCD\u8FC7\u957F"] };
  return { ok: true, errors: [] };
}
function redactText(input) {
  let out = input;
  for (const { re: re2, replacement } of SENSITIVE_PATTERNS) {
    out = out.replace(re2, replacement);
  }
  return out;
}
function redactObject(obj) {
  return redactDeep(obj);
}
function redactDeep(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_FIELDS.has(k.toLowerCase())) {
        out[k] = typeof v === "string" && v.length > 0 ? "***" : v;
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out;
  }
  return value;
}
function validateAll(inputs) {
  const errors = [];
  if (inputs.name !== void 0) errors.push(...validateProjectName(inputs.name).errors);
  if (inputs.path !== void 0) errors.push(...validateLocalPath(inputs.path).errors);
  return { ok: errors.length === 0, errors };
}
var SENSITIVE_FIELDS, SENSITIVE_PATTERNS;
var init_sanitize = __esm({
  "../../packages/core/src/sanitize.ts"() {
    "use strict";
    SENSITIVE_FIELDS = /* @__PURE__ */ new Set([
      "secret",
      "token",
      "apikey",
      "api_key",
      "password",
      "passwd",
      "authorization",
      "auth",
      "webhooksecret",
      "privatekey",
      "credential"
    ]);
    SENSITIVE_PATTERNS = [
      { re: /sk-[A-Za-z0-9_\-]{16,}/g, replacement: "sk-***" },
      { re: /Bearer\s+[A-Za-z0-9._\-]{8,}/gi, replacement: "Bearer ***" },
      { re: /AKIA[0-9A-Z]{12,}/g, replacement: "AKIA***" },
      { re: /[A-Za-z0-9_\-]{32,}/g, replacement: "***" }
      // 长 hex/base64 串
    ];
  }
});

// ../../packages/core/src/audit.ts
function auditTask(task, ctx) {
  const out = [];
  const t = (severity, message) => out.push({ taskId: task.id, severity, message });
  if (task.status === "in_progress" || task.status === "in_review") {
    if (!ctx.worktreeExists) t("warn", "\u4EFB\u52A1\u8FDB\u884C\u4E2D\u4F46 worktree \u4E0D\u5B58\u5728");
    if (!ctx.hasExecutionRecord) t("warn", "\u4EFB\u52A1\u8FDB\u884C\u4E2D\u4F46\u65E0\u6267\u884C\u8BB0\u5F55");
  }
  if (task.status === "in_review") {
    if (ctx.hasTestResult === false) t("warn", "\u6D4B\u8BD5\u4E2D\u4F46\u65E0\u6D4B\u8BD5\u7ED3\u679C");
    if (ctx.testPassed === void 0) t("info", "\u6D4B\u8BD5\u4E2D\u4F46\u6D4B\u8BD5\u7ED3\u679C\u672A\u77E5");
  }
  if (task.status === "archived") {
    if (ctx.testPassed !== true) t("error", "\u5DF2\u5F52\u6863\u4F46\u6D4B\u8BD5\u672A\u901A\u8FC7");
    if (!ctx.hasArtifacts) t("warn", "\u5DF2\u5F52\u6863\u4F46\u65E0\u4EA7\u7269");
  }
  if (task.status === "awaiting_input" && task.pausedFrom !== "in_review" && !ctx.hasCheckpoint) {
    t("error", "\u5F85\u6C9F\u901A\u4F46\u65E0\u68C0\u67E5\u70B9\uFF0C\u65E0\u6CD5\u6062\u590D");
  }
  if (task.status === "backlog" && ctx.hasExecutionRecord) {
    t("info", "\u9700\u6C42\u6C60\u4E2D\u5B58\u5728\u5386\u53F2\u6267\u884C\u8BB0\u5F55");
  }
  return out;
}
function auditOk(findings) {
  return !findings.some((f) => f.severity === "error");
}
var init_audit = __esm({
  "../../packages/core/src/audit.ts"() {
    "use strict";
  }
});

// ../../packages/core/src/index.ts
var src_exports = {};
__export(src_exports, {
  ALL_STATUSES: () => ALL_STATUSES,
  DEFAULT_RETRY_POLICY: () => DEFAULT_RETRY_POLICY,
  LEGAL_TRANSITIONS: () => LEGAL_TRANSITIONS,
  LEGAL_TRANSITIONS_STRICT: () => LEGAL_TRANSITIONS_STRICT,
  SENSITIVE_FIELDS: () => SENSITIVE_FIELDS,
  WEBHOOK_SIGNATURE_HEADER: () => WEBHOOK_SIGNATURE_HEADER,
  applicableRules: () => applicableRules,
  auditOk: () => auditOk,
  auditTask: () => auditTask,
  backoffDelay: () => backoffDelay,
  buildWebhookPayload: () => buildWebhookPayload,
  canArchiveRequirement: () => canArchiveRequirement,
  canReturnToDev: () => canReturnToDev,
  canTransition: () => canTransition,
  canonicalStringify: () => canonicalStringify,
  checkTaskDependencies: () => checkTaskDependencies,
  collapseCarriage: () => collapseCarriage,
  computeTriggerAt: () => computeTriggerAt,
  decideRetry: () => decideRetry,
  defaultAgentForRole: () => defaultAgentForRole,
  findOverdue: () => findOverdue,
  illegalTransitions: () => illegalTransitions,
  inferLevel: () => inferLevel,
  isLegalTransition: () => isLegalTransition,
  isTerminal: () => isTerminal,
  legalTargets: () => legalTargets,
  nextTrigger: () => nextTrigger,
  normalizeNewlines: () => normalizeNewlines,
  now: () => now,
  planRecovery: () => planRecovery,
  randomId: () => randomId,
  redactObject: () => redactObject,
  redactText: () => redactText,
  ruleApplies: () => ruleApplies,
  signBody: () => signBody,
  signPayload: () => signPayload,
  standardizeCliOutput: () => standardizeCliOutput,
  stripAnsi: () => stripAnsi,
  summarizeOutput: () => summarizeOutput,
  validateAll: () => validateAll,
  validateLocalPath: () => validateLocalPath,
  validateMinutes: () => validateMinutes,
  validateProjectName: () => validateProjectName,
  validatePrompt: () => validatePrompt,
  validateTransition: () => validateTransition,
  validateWebhookUrl: () => validateWebhookUrl,
  verifySignature: () => verifySignature
});
function randomId() {
  return globalThis.crypto.randomUUID();
}
function now() {
  return Date.now();
}
function defaultAgentForRole(role) {
  switch (role) {
    case "planner":
      return "claude_code";
    case "coder":
      return "claude_code";
    case "reviewer":
      return "codex";
    case "tester":
      return "codex";
  }
}
var init_src = __esm({
  "../../packages/core/src/index.ts"() {
    "use strict";
    init_types();
    init_state_machine();
    init_gates();
    init_timeout();
    init_webhook();
    init_cli();
    init_retry();
    init_sanitize();
    init_audit();
  }
});

// ../../node_modules/.pnpm/secure-json-parse@2.7.0/node_modules/secure-json-parse/index.js
var require_secure_json_parse = __commonJS({
  "../../node_modules/.pnpm/secure-json-parse@2.7.0/node_modules/secure-json-parse/index.js"(exports2, module2) {
    "use strict";
    var hasBuffer = typeof Buffer !== "undefined";
    var suspectProtoRx = /"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:/;
    var suspectConstructorRx = /"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:/;
    function _parse(text, reviver, options) {
      if (options == null) {
        if (reviver !== null && typeof reviver === "object") {
          options = reviver;
          reviver = void 0;
        }
      }
      if (hasBuffer && Buffer.isBuffer(text)) {
        text = text.toString();
      }
      if (text && text.charCodeAt(0) === 65279) {
        text = text.slice(1);
      }
      const obj = JSON.parse(text, reviver);
      if (obj === null || typeof obj !== "object") {
        return obj;
      }
      const protoAction = options && options.protoAction || "error";
      const constructorAction = options && options.constructorAction || "error";
      if (protoAction === "ignore" && constructorAction === "ignore") {
        return obj;
      }
      if (protoAction !== "ignore" && constructorAction !== "ignore") {
        if (suspectProtoRx.test(text) === false && suspectConstructorRx.test(text) === false) {
          return obj;
        }
      } else if (protoAction !== "ignore" && constructorAction === "ignore") {
        if (suspectProtoRx.test(text) === false) {
          return obj;
        }
      } else {
        if (suspectConstructorRx.test(text) === false) {
          return obj;
        }
      }
      return filter(obj, { protoAction, constructorAction, safe: options && options.safe });
    }
    function filter(obj, { protoAction = "error", constructorAction = "error", safe } = {}) {
      let next = [obj];
      while (next.length) {
        const nodes = next;
        next = [];
        for (const node of nodes) {
          if (protoAction !== "ignore" && Object.prototype.hasOwnProperty.call(node, "__proto__")) {
            if (safe === true) {
              return null;
            } else if (protoAction === "error") {
              throw new SyntaxError("Object contains forbidden prototype property");
            }
            delete node.__proto__;
          }
          if (constructorAction !== "ignore" && Object.prototype.hasOwnProperty.call(node, "constructor") && Object.prototype.hasOwnProperty.call(node.constructor, "prototype")) {
            if (safe === true) {
              return null;
            } else if (constructorAction === "error") {
              throw new SyntaxError("Object contains forbidden prototype property");
            }
            delete node.constructor;
          }
          for (const key in node) {
            const value = node[key];
            if (value && typeof value === "object") {
              next.push(value);
            }
          }
        }
      }
      return obj;
    }
    function parse(text, reviver, options) {
      const stackTraceLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 0;
      try {
        return _parse(text, reviver, options);
      } finally {
        Error.stackTraceLimit = stackTraceLimit;
      }
    }
    function safeParse(text, reviver) {
      const stackTraceLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 0;
      try {
        return _parse(text, reviver, { safe: true });
      } catch (_e) {
        return null;
      } finally {
        Error.stackTraceLimit = stackTraceLimit;
      }
    }
    module2.exports = parse;
    module2.exports.default = parse;
    module2.exports.parse = parse;
    module2.exports.safeParse = safeParse;
    module2.exports.scan = filter;
  }
});

// electron/main.ts
var import_electron5 = require("electron");
var import_node_path4 = require("node:path");
var import_node_fs2 = require("node:fs");

// electron/services.ts
var import_electron2 = require("electron");
var import_node_path2 = require("node:path");

// ../../packages/persistence/src/db.ts
var import_node_module = require("node:module");

// ../../packages/persistence/src/migrations.ts
var MIGRATIONS = [
  {
    version: 1,
    description: "initial schema",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        settings_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS iterations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_iterations_project ON iterations(project_id);

      CREATE TABLE IF NOT EXISTS requirements (
        id TEXT PRIMARY KEY,
        iteration_id TEXT NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium',
        acceptance TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requirements_iteration ON requirements(iteration_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
        iteration_id TEXT NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'backlog',
        agent_type TEXT,
        role TEXT NOT NULL DEFAULT 'coder',
        stages_json TEXT NOT NULL DEFAULT '[]',
        current_stage INTEGER NOT NULL DEFAULT 0,
        status_changed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        worktree_path TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_iteration ON tasks(iteration_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

      CREATE TABLE IF NOT EXISTS execution_records (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        agent_type TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        summary TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_exec_task ON execution_records(task_id);

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        stage_id TEXT NOT NULL,
        stage_index INTEGER NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id);

      CREATE TABLE IF NOT EXISTS log_entries (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL REFERENCES execution_records(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'info',
        text TEXT NOT NULL,
        t INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_task ON log_entries(task_id);
      CREATE INDEX IF NOT EXISTS idx_logs_exec ON log_entries(execution_id);

      CREATE TABLE IF NOT EXISTS pending_questions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        asked_at INTEGER NOT NULL,
        answered_at INTEGER,
        answer TEXT
      );

      CREATE TABLE IF NOT EXISTS notification_rules (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        status TEXT NOT NULL,
        minutes INTEGER NOT NULL,
        channels_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notif_deliv_rule_task ON notification_deliveries(rule_id, task_id);

      CREATE TABLE IF NOT EXISTS webhook_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL REFERENCES webhook_configs(id) ON DELETE CASCADE,
        task_id TEXT,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        status INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        sent_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        response_snippet TEXT,
        ok INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_deliv ON webhook_deliveries(webhook_id);

      CREATE TABLE IF NOT EXISTS credentials (
        key TEXT PRIMARY KEY,
        value_enc TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `
  },
  {
    version: 2,
    description: "add archived_at for traceability",
    sql: `
      ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
    `
  },
  {
    version: 3,
    description: "requirement archive + task paused_from (\u5F85\u6C9F\u901A\u6682\u505C\u6765\u6E90)",
    sql: `
      ALTER TABLE requirements ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE requirements ADD COLUMN archived_at INTEGER;
      ALTER TABLE tasks ADD COLUMN paused_from TEXT;
    `
  },
  {
    version: 4,
    description: "task serial dependencies (depends_on)",
    sql: `
      ALTER TABLE tasks ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    version: 5,
    description: "purge legacy thinking_tokens log spam (suppressed in parser since)",
    sql: `
      DELETE FROM log_entries WHERE text = 'system: thinking_tokens';
    `
  }
];

// ../../packages/persistence/src/db.ts
var import_meta = {};
var _require = typeof require !== "undefined" ? require : (0, import_node_module.createRequire)(import_meta.url);
var { DatabaseSync: DatabaseSyncCtor } = _require("node:sqlite");
function openDatabase(path) {
  const db = new DatabaseSyncCtor(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const current = getCurrentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version(version, applied_at) VALUES (?, ?)").run(
        m.version,
        Date.now()
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
function getCurrentVersion(db) {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
  return row?.v ?? 0;
}

// ../../packages/persistence/src/repositories.ts
function parseJSON(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
function mapProject(r) {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    defaultBranch: r.default_branch,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    settings: parseJSON(r.settings_json, {})
  };
}
function mapIteration(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    version: r.version,
    status: r.status,
    createdAt: r.created_at
  };
}
function mapRequirement(r) {
  return {
    id: r.id,
    iterationId: r.iteration_id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    acceptance: r.acceptance,
    createdAt: r.created_at,
    archived: r.archived === 1,
    archivedAt: r.archived_at ?? void 0
  };
}
function mapTask(r) {
  return {
    id: r.id,
    requirementId: r.requirement_id,
    iterationId: r.iteration_id,
    projectId: r.project_id,
    title: r.title,
    description: r.description,
    status: r.status,
    agentType: r.agent_type ?? void 0,
    role: r.role,
    stages: parseJSON(r.stages_json, []),
    currentStage: r.current_stage,
    statusChangedAt: r.status_changed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    worktreePath: r.worktree_path ?? void 0,
    retryCount: r.retry_count,
    pausedFrom: r.paused_from ?? void 0,
    dependsOn: parseJSON(r.depends_on_json, []).filter(Boolean)
  };
}
function mapExecution(r) {
  return {
    id: r.id,
    taskId: r.task_id,
    attempt: r.attempt,
    agentType: r.agent_type,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? void 0,
    status: r.status,
    summary: r.summary ?? void 0
  };
}
function mapCheckpoint(r) {
  return {
    id: r.id,
    taskId: r.task_id,
    stageId: r.stage_id,
    stageIndex: r.stage_index,
    context: r.context,
    createdAt: r.created_at
  };
}
function mapLog(r) {
  return {
    id: r.id,
    taskId: r.task_id,
    executionId: r.execution_id,
    level: r.level,
    text: r.text,
    t: r.t
  };
}
function mapNotificationRule(r) {
  return {
    id: r.id,
    projectId: r.project_id ?? void 0,
    status: r.status,
    minutes: r.minutes,
    channels: parseJSON(r.channels_json, []),
    enabled: r.enabled === 1
  };
}
function mapNotificationDelivery(r) {
  return {
    id: r.id,
    ruleId: r.rule_id,
    taskId: r.task_id,
    channel: r.channel,
    sentAt: r.sent_at,
    status: r.status,
    detail: r.detail ?? void 0
  };
}
function mapWebhookConfig(r) {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    secret: r.secret_enc,
    // 调用方负责加解密；DB 存密文
    events: parseJSON(r.events_json, []),
    enabled: r.enabled === 1,
    createdAt: r.created_at
  };
}
function mapWebhookDelivery(r) {
  return {
    id: r.id,
    webhookId: r.webhook_id,
    taskId: r.task_id ?? void 0,
    event: r.event,
    payload: r.payload,
    status: r.status,
    attempt: r.attempt,
    sentAt: r.sent_at,
    durationMs: r.duration_ms,
    responseSnippet: r.response_snippet ?? void 0,
    ok: r.ok === 1
  };
}
function createRepositories(db) {
  return {
    projects: projectsRepo(db),
    iterations: iterationsRepo(db),
    requirements: requirementsRepo(db),
    tasks: tasksRepo(db),
    executions: executionsRepo(db),
    checkpoints: checkpointsRepo(db),
    logs: logsRepo(db),
    pendingQuestions: pendingQuestionsRepo(db),
    notificationRules: notificationRulesRepo(db),
    notificationDeliveries: notificationDeliveriesRepo(db),
    webhookConfigs: webhookConfigsRepo(db),
    webhookDeliveries: webhookDeliveriesRepo(db),
    credentials: credentialsRepo(db)
  };
}
function projectsRepo(db) {
  return {
    insert(p) {
      db.prepare(
        `INSERT INTO projects(id,name,path,default_branch,created_at,updated_at,settings_json)
         VALUES(?,?,?,?,?,?,?)`
      ).run(p.id, p.name, p.path, p.defaultBranch, p.createdAt, p.updatedAt, JSON.stringify(p.settings));
    },
    get(id) {
      const r = db.prepare("SELECT * FROM projects WHERE id=?").get(id);
      return r ? mapProject(r) : void 0;
    },
    list() {
      return db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all().map(mapProject);
    },
    update(p) {
      db.prepare(
        `UPDATE projects SET name=?,path=?,default_branch=?,updated_at=?,settings_json=? WHERE id=?`
      ).run(p.name, p.path, p.defaultBranch, p.updatedAt, JSON.stringify(p.settings), p.id);
    },
    updateSettings(id, settings) {
      db.prepare("UPDATE projects SET settings_json=?, updated_at=? WHERE id=?").run(
        JSON.stringify(settings),
        Date.now(),
        id
      );
    },
    delete(id) {
      db.prepare("DELETE FROM projects WHERE id=?").run(id);
    }
  };
}
function iterationsRepo(db) {
  return {
    insert(i) {
      db.prepare(
        `INSERT INTO iterations(id,project_id,name,version,status,created_at) VALUES(?,?,?,?,?,?)`
      ).run(i.id, i.projectId, i.name, i.version, i.status, i.createdAt);
    },
    get(id) {
      const r = db.prepare("SELECT * FROM iterations WHERE id=?").get(id);
      return r ? mapIteration(r) : void 0;
    },
    listByProject(projectId) {
      return db.prepare("SELECT * FROM iterations WHERE project_id=? ORDER BY created_at DESC").all(projectId).map(mapIteration);
    },
    archive(id) {
      db.prepare("UPDATE iterations SET status='archived' WHERE id=?").run(id);
    }
  };
}
function requirementsRepo(db) {
  return {
    insert(r) {
      db.prepare(
        `INSERT INTO requirements(id,iteration_id,title,description,priority,acceptance,created_at,archived)
         VALUES(?,?,?,?,?,?,?,?)`
      ).run(r.id, r.iterationId, r.title, r.description, r.priority, r.acceptance, r.createdAt, r.archived ? 1 : 0);
    },
    get(id) {
      const r = db.prepare("SELECT * FROM requirements WHERE id=?").get(id);
      return r ? mapRequirement(r) : void 0;
    },
    listByIteration(iterationId) {
      return db.prepare("SELECT * FROM requirements WHERE iteration_id=? ORDER BY created_at ASC").all(iterationId).map(mapRequirement);
    },
    update(r) {
      db.prepare(
        `UPDATE requirements SET title=?,description=?,priority=?,acceptance=?,archived=? WHERE id=?`
      ).run(r.title, r.description, r.priority, r.acceptance, r.archived ? 1 : 0, r.id);
    },
    archive(id, at) {
      db.prepare("UPDATE requirements SET archived=1, archived_at=? WHERE id=?").run(at, id);
    }
  };
}
function tasksRepo(db) {
  return {
    insert(t) {
      db.prepare(
        `INSERT INTO tasks(id,requirement_id,iteration_id,project_id,title,description,status,agent_type,role,
           stages_json,current_stage,status_changed_at,created_at,updated_at,worktree_path,retry_count,paused_from,depends_on_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        t.id,
        t.requirementId,
        t.iterationId,
        t.projectId,
        t.title,
        t.description,
        t.status,
        t.agentType ?? null,
        t.role,
        JSON.stringify(t.stages),
        t.currentStage,
        t.statusChangedAt,
        t.createdAt,
        t.updatedAt,
        t.worktreePath ?? null,
        t.retryCount,
        t.pausedFrom ?? null,
        JSON.stringify(t.dependsOn ?? [])
      );
    },
    get(id) {
      const r = db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
      return r ? mapTask(r) : void 0;
    },
    list() {
      return db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all().map(mapTask);
    },
    listByIteration(iterationId) {
      return db.prepare("SELECT * FROM tasks WHERE iteration_id=? ORDER BY created_at ASC").all(iterationId).map(mapTask);
    },
    listByProject(projectId) {
      return db.prepare("SELECT * FROM tasks WHERE project_id=? ORDER BY updated_at DESC").all(projectId).map(mapTask);
    },
    listByRequirement(requirementId) {
      return db.prepare("SELECT * FROM tasks WHERE requirement_id=? ORDER BY created_at ASC").all(requirementId).map(mapTask);
    },
    listByStatus(status) {
      return db.prepare("SELECT * FROM tasks WHERE status=?").all(status).map(mapTask);
    },
    listRecoverable() {
      return db.prepare("SELECT * FROM tasks WHERE status IN ('in_progress','awaiting_input')").all().map(mapTask);
    },
    update(t) {
      db.prepare(
        `UPDATE tasks SET title=?,description=?,status=?,agent_type=?,role=?,stages_json=?,current_stage=?,
           status_changed_at=?,updated_at=?,worktree_path=?,retry_count=?,paused_from=?,depends_on_json=? WHERE id=?`
      ).run(
        t.title,
        t.description,
        t.status,
        t.agentType ?? null,
        t.role,
        JSON.stringify(t.stages),
        t.currentStage,
        t.statusChangedAt,
        t.updatedAt,
        t.worktreePath ?? null,
        t.retryCount,
        t.pausedFrom ?? null,
        JSON.stringify(t.dependsOn ?? []),
        t.id
      );
    },
    updateStatus(id, status, at) {
      let pausedFrom = null;
      if (status === "awaiting_input") {
        const cur = db.prepare("SELECT status FROM tasks WHERE id=?").get(id);
        pausedFrom = cur?.status ?? null;
      }
      const extra = status === "archived" ? ", archived_at=?" : "";
      const stmt = db.prepare(
        `UPDATE tasks SET status=?, status_changed_at=?, updated_at=?, paused_from=?${extra} WHERE id=?`
      );
      if (status === "archived") stmt.run(status, at, at, pausedFrom, at, id);
      else stmt.run(status, at, at, pausedFrom, id);
    },
    assignAgent(id, agentType) {
      db.prepare("UPDATE tasks SET agent_type=?, updated_at=? WHERE id=?").run(agentType, Date.now(), id);
    },
    setWorktree(id, path) {
      db.prepare("UPDATE tasks SET worktree_path=?, updated_at=? WHERE id=?").run(path ?? null, Date.now(), id);
    },
    incRetry(id) {
      db.prepare("UPDATE tasks SET retry_count=retry_count+1, updated_at=? WHERE id=?").run(Date.now(), id);
    },
    delete(id) {
      db.prepare("DELETE FROM tasks WHERE id=?").run(id);
    }
  };
}
function executionsRepo(db) {
  return {
    insert(e) {
      db.prepare(
        `INSERT INTO execution_records(id,task_id,attempt,agent_type,started_at,ended_at,status,summary)
         VALUES(?,?,?,?,?,?,?,?)`
      ).run(e.id, e.taskId, e.attempt, e.agentType, e.startedAt, e.endedAt ?? null, e.status, e.summary ?? null);
    },
    update(e) {
      db.prepare(
        `UPDATE execution_records SET attempt=?,ended_at=?,status=?,summary=? WHERE id=?`
      ).run(e.attempt, e.endedAt ?? null, e.status, e.summary ?? null, e.id);
    },
    listByTask(taskId) {
      return db.prepare("SELECT * FROM execution_records WHERE task_id=? ORDER BY started_at DESC").all(taskId).map(mapExecution);
    },
    getLatest(taskId) {
      const r = db.prepare("SELECT * FROM execution_records WHERE task_id=? ORDER BY started_at DESC LIMIT 1").get(taskId);
      return r ? mapExecution(r) : void 0;
    }
  };
}
function checkpointsRepo(db) {
  return {
    upsert(c) {
      db.prepare(
        `INSERT INTO checkpoints(id,task_id,stage_id,stage_index,context,created_at)
         VALUES(?,?,?,?,?,?)`
      ).run(c.id, c.taskId, c.stageId, c.stageIndex, c.context, c.createdAt);
    },
    getLatest(taskId) {
      const r = db.prepare("SELECT * FROM checkpoints WHERE task_id=? ORDER BY created_at DESC LIMIT 1").get(taskId);
      return r ? mapCheckpoint(r) : void 0;
    },
    listByTask(taskId) {
      return db.prepare("SELECT * FROM checkpoints WHERE task_id=? ORDER BY created_at ASC").all(taskId).map(mapCheckpoint);
    }
  };
}
function logsRepo(db) {
  return {
    insert(l) {
      db.prepare(
        `INSERT INTO log_entries(id,task_id,execution_id,level,text,t) VALUES(?,?,?,?,?,?)`
      ).run(l.id, l.taskId, l.executionId, l.level, l.text, l.t);
    },
    listByTask(taskId, limit = 1e3) {
      return db.prepare("SELECT * FROM (SELECT * FROM log_entries WHERE task_id=? ORDER BY t DESC LIMIT ?) ORDER BY t ASC").all(taskId, limit).map(mapLog);
    },
    listByExecution(executionId) {
      return db.prepare("SELECT * FROM log_entries WHERE execution_id=? ORDER BY t ASC").all(executionId).map(mapLog);
    }
  };
}
function pendingQuestionsRepo(db) {
  return {
    upsert(q) {
      db.prepare(
        `INSERT INTO pending_questions(task_id,question,context,asked_at,answered_at,answer)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET question=excluded.question, context=excluded.context,
           asked_at=excluded.asked_at, answered_at=NULL, answer=NULL`
      ).run(q.taskId, q.question, q.context, q.askedAt, null, null);
    },
    get(taskId) {
      const r = db.prepare("SELECT * FROM pending_questions WHERE task_id=?").get(taskId);
      if (!r) return void 0;
      return {
        taskId: r.task_id,
        question: r.question,
        context: r.context,
        askedAt: r.asked_at,
        answeredAt: r.answered_at ?? void 0,
        answer: r.answer ?? void 0
      };
    },
    answer(taskId, answer, at) {
      db.prepare("UPDATE pending_questions SET answer=?, answered_at=? WHERE task_id=?").run(answer, at, taskId);
    },
    delete(taskId) {
      db.prepare("DELETE FROM pending_questions WHERE task_id=?").run(taskId);
    }
  };
}
function notificationRulesRepo(db) {
  return {
    insert(r) {
      db.prepare(
        `INSERT INTO notification_rules(id,project_id,status,minutes,channels_json,enabled)
         VALUES(?,?,?,?,?,?)`
      ).run(r.id, r.projectId ?? null, r.status, r.minutes, JSON.stringify(r.channels), r.enabled ? 1 : 0);
    },
    list() {
      return db.prepare("SELECT * FROM notification_rules").all().map(mapNotificationRule);
    },
    listByProject(projectId) {
      return db.prepare("SELECT * FROM notification_rules WHERE project_id IS NULL OR project_id=?").all(projectId).map(mapNotificationRule);
    },
    update(r) {
      db.prepare("UPDATE notification_rules SET project_id=?,status=?,minutes=?,channels_json=?,enabled=? WHERE id=?").run(
        r.projectId ?? null,
        r.status,
        r.minutes,
        JSON.stringify(r.channels),
        r.enabled ? 1 : 0,
        r.id
      );
    },
    delete(id) {
      db.prepare("DELETE FROM notification_rules WHERE id=?").run(id);
    }
  };
}
function notificationDeliveriesRepo(db) {
  return {
    insert(d) {
      db.prepare(
        `INSERT INTO notification_deliveries(id,rule_id,task_id,channel,sent_at,status,detail)
         VALUES(?,?,?,?,?,?,?)`
      ).run(d.id, d.ruleId, d.taskId, d.channel, d.sentAt, d.status, d.detail ?? null);
    },
    exists(ruleId, taskId, channel2) {
      const r = db.prepare(
        "SELECT 1 AS x FROM notification_deliveries WHERE rule_id=? AND task_id=? AND channel=? LIMIT 1"
      ).get(ruleId, taskId, channel2);
      return !!r;
    },
    listByTask(taskId) {
      return db.prepare("SELECT * FROM notification_deliveries WHERE task_id=? ORDER BY sent_at DESC").all(taskId).map(mapNotificationDelivery);
    }
  };
}
function webhookConfigsRepo(db) {
  return {
    insert(w) {
      db.prepare(
        `INSERT INTO webhook_configs(id,name,url,secret_enc,events_json,enabled,created_at)
         VALUES(?,?,?,?,?,?,?)`
      ).run(w.id, w.name, w.url, w.secret, JSON.stringify(w.events), w.enabled ? 1 : 0, w.createdAt);
    },
    get(id) {
      const r = db.prepare("SELECT * FROM webhook_configs WHERE id=?").get(id);
      return r ? mapWebhookConfig(r) : void 0;
    },
    list() {
      return db.prepare("SELECT * FROM webhook_configs ORDER BY created_at DESC").all().map(mapWebhookConfig);
    },
    update(w) {
      db.prepare("UPDATE webhook_configs SET name=?,url=?,secret_enc=?,events_json=?,enabled=? WHERE id=?").run(
        w.name,
        w.url,
        w.secret,
        JSON.stringify(w.events),
        w.enabled ? 1 : 0,
        w.id
      );
    },
    delete(id) {
      db.prepare("DELETE FROM webhook_configs WHERE id=?").run(id);
    }
  };
}
function webhookDeliveriesRepo(db) {
  return {
    insert(d) {
      db.prepare(
        `INSERT INTO webhook_deliveries(id,webhook_id,task_id,event,payload,status,attempt,sent_at,duration_ms,response_snippet,ok)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      ).run(d.id, d.webhookId, d.taskId ?? null, d.event, d.payload, d.status, d.attempt, d.sentAt, d.durationMs, d.responseSnippet ?? null, d.ok ? 1 : 0);
    },
    listByWebhook(webhookId, limit = 100) {
      return db.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id=? ORDER BY sent_at DESC LIMIT ?").all(webhookId, limit).map(mapWebhookDelivery);
    }
  };
}
function credentialsRepo(db) {
  return {
    upsert(key, encryptedValue) {
      db.prepare(
        "INSERT INTO credentials(key,value_enc,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_enc=excluded.value_enc, updated_at=excluded.updated_at"
      ).run(key, encryptedValue, Date.now());
    },
    get(key) {
      const r = db.prepare("SELECT value_enc FROM credentials WHERE key=?").get(key);
      return r?.value_enc;
    },
    delete(key) {
      db.prepare("DELETE FROM credentials WHERE key=?").run(key);
    }
  };
}

// ../../packages/agents/src/detect.ts
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");
var execFileP = (0, import_node_util.promisify)(import_node_child_process.execFile);
async function detectByCommand(agentType, command, versionArgs = ["--version"]) {
  try {
    const { stdout, stderr } = await execFileP(command, versionArgs, {
      timeout: 1e4,
      env: process.env
    });
    const out = (stdout || stderr).trim();
    const firstLine = out.split("\n")[0] ?? "";
    return {
      agentType,
      available: true,
      version: firstLine || out || void 0,
      path: command
    };
  } catch (err) {
    const e = err;
    if (e.code === "ENOENT") {
      return {
        agentType,
        available: false,
        reason: `\u672A\u627E\u5230\u53EF\u6267\u884C\u6587\u4EF6 "${command}"\uFF08ENOENT\uFF09\u3002\u8BF7\u786E\u8BA4\u5DF2\u5B89\u88C5\u5E76\u4F4D\u4E8E PATH \u4E2D\u3002`
      };
    }
    return {
      agentType,
      available: false,
      reason: `\u68C0\u6D4B\u5931\u8D25\uFF1A${e.message}`
    };
  }
}

// ../../packages/agents/src/process-runner.ts
var import_node_child_process2 = require("node:child_process");
function spawnAgentProcess(opts) {
  const child = (0, import_node_child_process2.spawn)(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (child.stdin) {
    if (opts.input !== void 0) {
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  }
  const stdoutLines = lineStream(child.stdout);
  const stderrLines = lineStream(child.stderr);
  async function* merged() {
    const queue = [];
    let waiters = [];
    let done = false;
    const push = (l) => {
      queue.push(l);
      const w = waiters.shift();
      if (w) w();
    };
    (async () => {
      try {
        for await (const l of stdoutLines) push({ stream: "stdout", text: l });
      } catch {
      }
    })();
    (async () => {
      try {
        for await (const l of stderrLines) push({ stream: "stderr", text: l });
      } catch {
      }
    })();
    child.once("exit", () => {
      done = true;
      waiters.forEach((w) => w());
      waiters = [];
    });
    while (true) {
      if (queue.length > 0) yield queue.shift();
      else if (done) return;
      else await new Promise((resolve) => waiters.push(resolve));
    }
  }
  let exitInfo = null;
  const exitWaiters = [];
  child.once("exit", (code, signal) => {
    exitInfo = { exitCode: code, signal };
    exitWaiters.splice(0).forEach((w) => w(exitInfo));
  });
  return {
    pid: child.pid,
    lines: merged(),
    async cancel() {
      if (!child.killed) {
        child.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
        if (!child.killed) child.kill("SIGKILL");
      }
    },
    done() {
      if (exitInfo) return Promise.resolve(exitInfo);
      return new Promise((resolve) => exitWaiters.push(resolve));
    }
  };
}
async function* lineStream(stream) {
  if (!stream) return;
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) yield line;
    }
  }
  if (buffer.length > 0) yield buffer;
}

// ../../packages/agents/src/adapters/base.ts
function eventsFromProcess(spawned, parseLine, opts) {
  return async function* () {
    const collected = [];
    for await (const line of spawned.lines) {
      collected.push(line.text);
      for (const ev of parseLine(line)) yield ev;
    }
    const { exitCode } = await spawned.done();
    if (exitCode === 0) {
      yield {
        type: "done",
        summary: opts.successSummary(collected),
        t: Date.now()
      };
    } else {
      yield {
        type: "error",
        message: `\u8FDB\u7A0B\u9000\u51FA\u7801 ${exitCode}`,
        recoverable: exitCode !== null && exitCode > 0,
        t: Date.now()
      };
    }
  }();
}
function logEventsFromLine(line) {
  if (line.stream === "stderr") {
    return [{ type: "log", level: "warn", text: line.text, t: Date.now() }];
  }
  return [{ type: "log", level: "info", text: line.text, t: Date.now() }];
}
function buildRun(spawned, parseLine, successSummary) {
  return {
    pid: spawned.pid,
    cancel: () => spawned.cancel(),
    done: async () => {
      const { exitCode } = await spawned.done();
      return { exitCode, ok: exitCode === 0 };
    },
    events: eventsFromProcess(spawned, parseLine, { successSummary })
  };
}

// ../../packages/agents/src/adapters/claude-code.ts
var DEFAULT_CMD = "claude";
var ClaudeCodeAdapter = class {
  constructor(opts = {}) {
    this.opts = opts;
  }
  id = "claude_code";
  detect() {
    return detectByCommand("claude_code", this.opts.executable ?? DEFAULT_CMD, ["--version"]);
  }
  async run(req) {
    let prompt = req.prompt;
    if (req.resumeFrom || req.userInput) {
      prompt = `[\u7528\u6237\u56DE\u7B54] ${req.userInput ?? ""}
[\u539F\u4E0A\u4E0B\u6587] ${req.resumeFrom?.context ?? ""}

${req.prompt}`;
    }
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      ...this.opts.extraArgs ?? []
    ];
    const spawned = spawnAgentProcess({
      command: this.opts.executable ?? DEFAULT_CMD,
      args,
      cwd: req.cwd,
      env: { ...this.opts.env, ...req.env }
    });
    return buildRun(
      spawned,
      (line) => parseClaudeLine(line),
      (lines) => summarizeClaude(lines)
    );
  }
};
function parseClaudeLine(line) {
  if (line.stream === "stderr") {
    return [{ type: "log", level: "warn", text: line.text, t: Date.now() }];
  }
  let obj;
  try {
    obj = JSON.parse(line.text);
  } catch {
    return logEventsFromLine(line);
  }
  const t = Date.now();
  const type = obj.type;
  if (type === "assistant") {
    const content = obj.message?.content;
    if (!Array.isArray(content)) return [];
    const events = [];
    for (const c of content) {
      const ctype = c.type;
      if (ctype === "text") {
        const text = c.text;
        if (text) events.push({ type: "log", level: "info", text, t });
      } else if (ctype === "tool_use") {
        const name15 = c.name ?? "";
        const input = c.input ?? {};
        const path = input.file_path ?? input.path;
        if (path) {
          const action = name15 === "Write" ? "create" : name15 === "Edit" || name15 === "MultiEdit" ? "modify" : "modify";
          events.push({ type: "file_change", path, action, t });
          events.push({ type: "log", level: "info", text: `${name15} ${path}`, t });
        } else {
          events.push({ type: "log", level: "info", text: `tool: ${name15 || "unknown"}`, t });
        }
      }
    }
    return events;
  }
  if (type === "tool_use") {
    const input = obj.input ?? {};
    const path = input.file_path ?? input.path;
    if (path) {
      const name15 = obj.name ?? "";
      const action = name15 === "Write" ? "create" : name15 === "Edit" || name15 === "MultiEdit" ? "modify" : "modify";
      return [
        { type: "file_change", path, action, t },
        { type: "log", level: "info", text: `${name15} ${path}`, t }
      ];
    }
    return [{ type: "log", level: "info", text: `tool: ${obj.name ?? "unknown"}`, t }];
  }
  if (type === "result") {
    const text = obj.result ?? JSON.stringify(obj);
    return [{ type: "log", level: "info", text: `result: ${text.slice(0, 500)}`, t }];
  }
  if (type === "system") {
    const subtype = obj.subtype;
    if (subtype === "thinking_tokens") return [];
    return [{ type: "log", level: "info", text: `system: ${subtype ?? ""}`, t }];
  }
  return [{ type: "log", level: "info", text: line.text, t }];
}
function summarizeClaude(lines) {
  const last = lines.filter((l) => !l.startsWith("{")).slice(-1)[0];
  return last ?? `claude \u6267\u884C\u5B8C\u6210\uFF0C\u5171 ${lines.length} \u884C\u8F93\u51FA`;
}

// ../../packages/agents/src/adapters/codex.ts
var DEFAULT_CMD2 = "codex";
var CodexAdapter = class {
  constructor(opts = {}) {
    this.opts = opts;
  }
  id = "codex";
  detect() {
    return detectByCommand("codex", this.opts.executable ?? DEFAULT_CMD2, ["--version"]);
  }
  async run(req) {
    let prompt = req.prompt;
    if (req.resumeFrom || req.userInput) {
      prompt = `[\u7528\u6237\u56DE\u7B54] ${req.userInput ?? ""}
[\u539F\u4E0A\u4E0B\u6587] ${req.resumeFrom?.context ?? ""}

${req.prompt}`;
    }
    const args = [
      "exec",
      "--sandbox",
      this.opts.sandbox ?? "workspace-write",
      ...this.opts.extraArgs ?? [],
      prompt
    ];
    const spawned = spawnAgentProcess({
      command: this.opts.executable ?? DEFAULT_CMD2,
      args,
      cwd: req.cwd,
      env: { ...this.opts.env, ...req.env }
    });
    return buildRun(
      spawned,
      (line) => parseCodexLine(line),
      (lines) => lines.slice(-1)[0] ?? `codex \u6267\u884C\u5B8C\u6210\uFF0C\u5171 ${lines.length} \u884C`
    );
  }
};
function parseCodexLine(line) {
  const text = line.text;
  const t = Date.now();
  if (line.stream === "stderr" || /\b(error|failed|panic)\b/i.test(text)) {
    return [{ type: "log", level: "error", text, t }];
  }
  const m = /(?:applying patch to|editing|wrote|created|updated)\s+(?:file\s+)?([^\s].+)/i.exec(text);
  if (m && m[1]) {
    return [
      { type: "file_change", path: m[1].replace(/['"`]/g, ""), action: "modify", t },
      { type: "log", level: "info", text, t }
    ];
  }
  return logEventsFromLine(line);
}

// ../../packages/agents/src/adapters/pi.ts
var DEFAULT_CMD3 = "pi";
var PiAdapter = class _PiAdapter {
  constructor(opts = {}) {
    this.opts = opts;
  }
  id = "pi";
  detect() {
    return detectByCommand("pi", this.opts.executable ?? DEFAULT_CMD3, ["--version"]);
  }
  async run(req) {
    const det = await this.detect();
    let spawned;
    const opts = this.opts;
    const events = async function* () {
      if (!det.available) {
        yield {
          type: "error",
          message: `Pi \u4E0D\u53EF\u7528\uFF1A${det.reason ?? "\u672A\u5B89\u88C5"}\u3002${_PiAdapter.verificationSteps()}`,
          recoverable: false,
          t: Date.now()
        };
        return;
      }
      spawned = spawnAgentProcess({
        command: opts.executable ?? DEFAULT_CMD3,
        args: [...opts.extraArgs ?? [], req.prompt],
        cwd: req.cwd,
        env: { ...opts.env, ...req.env }
      });
      for await (const line of spawned.lines) {
        for (const ev of logEventsFromLine(line)) yield ev;
      }
      const { exitCode } = await spawned.done();
      if (exitCode === 0) {
        yield { type: "done", summary: "pi \u6267\u884C\u5B8C\u6210", t: Date.now() };
      } else {
        yield { type: "error", message: `pi \u9000\u51FA\u7801 ${exitCode}`, recoverable: true, t: Date.now() };
      }
    }();
    return {
      pid: spawned?.pid,
      cancel: async () => {
        await spawned?.cancel();
      },
      done: async () => {
        let ok = false;
        for await (const ev of events) {
          if (ev.type === "done") ok = true;
        }
        return { exitCode: ok ? 0 : 1, ok };
      },
      events
    };
  }
  static verificationSteps() {
    return [
      "\u9A8C\u6536\u6B65\u9AA4\uFF1A",
      "1. \u5B89\u88C5 Pi CLI\uFF08\u6309 Pi \u5B98\u65B9\u6587\u6863\uFF0C\u4F8B\u5982\u5B98\u65B9\u5B89\u88C5\u811A\u672C\u6216\u5305\u7BA1\u7406\u5668\u547D\u4EE4\uFF09\u3002",
      "2. \u8FD0\u884C `pi --version` \u786E\u8BA4\u53EF\u7528\uFF0C\u4E14 `which pi` \u80FD\u5B9A\u4F4D\u53EF\u6267\u884C\u6587\u4EF6\u3002",
      "3. \u91CD\u65B0\u6253\u5F00 ai-devflow\uFF0C\u8BBE\u7F6E\u9875\u201C\u68C0\u6D4B Agent\u201D\u5E94\u663E\u793A Pi \u53EF\u7528\u3002",
      "4. \u5728\u4EFB\u52A1\u4E2D\u5206\u6D3E Pi \u6267\u884C\u4E00\u4E2A\u5C0F\u4EFB\u52A1\uFF08\u5982\u5728 cwd \u6253\u5370\u6807\u8BB0\u4E32\uFF09\uFF0C\u786E\u8BA4\u4EA7\u751F done \u4E8B\u4EF6\u4E0E\u65E5\u5FD7\u3002"
    ].join(" ");
  }
};

// ../../packages/agents/src/adapters/test.ts
var ControllableTestAdapter = class {
  constructor(opts = {}) {
    this.opts = opts;
  }
  id = "test";
  async detect() {
    return { agentType: "test", available: true, version: "test-1.0", path: "builtin" };
  }
  async run(req) {
    const specs = this.resolveScript(req);
    let cancelled = false;
    let exhausted = false;
    const events = async function* () {
      for (const spec of specs) {
        if (cancelled) return;
        if (spec.delayMs && spec.delayMs > 0) {
          await new Promise((resolve) => {
            const t = setTimeout(resolve, spec.delayMs);
            t.unref?.();
          });
        }
        if (cancelled) return;
        const { delayMs: _omit, ...ev } = spec;
        yield ev;
      }
      exhausted = true;
    }();
    return {
      pid: void 0,
      cancel: async () => {
        cancelled = true;
      },
      done: async () => {
        for await (const _ev of events) {
        }
        return { exitCode: cancelled ? null : 0, ok: !cancelled && exhausted };
      },
      events
    };
  }
  resolveScript(req) {
    const envVar = req.userInput ? this.opts.envVar ?? "AI_DEVFLOW_TEST_RESUME_CONTROL" : this.opts.envVar ?? "AI_DEVFLOW_TEST_CONTROL";
    const raw = process.env[envVar];
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
      }
    }
    if (this.opts.script) return this.opts.script(req);
    if (req.userInput) return [{ type: "done", summary: "resumed", t: 0 }];
    return [
      { type: "log", level: "info", text: "\u6D4B\u8BD5\u9002\u914D\u5668\uFF1A\u672A\u914D\u7F6E\u811A\u672C\uFF08AI_DEVFLOW_TEST_CONTROL\uFF09\uFF0C\u6A21\u62DF\u5B8C\u6210", t: 0 },
      { type: "done", summary: "test adapter no-op done", t: 0 }
    ];
  }
};

// ../../packages/agents/src/registry.ts
var AgentRegistry = class {
  map = /* @__PURE__ */ new Map();
  register(adapter) {
    this.map.set(adapter.id, adapter);
  }
  get(type) {
    return this.map.get(type);
  }
  require(type) {
    const a = this.map.get(type);
    if (!a) throw new Error(`\u672A\u6CE8\u518C\u7684 Agent \u7C7B\u578B\uFF1A${type}`);
    return a;
  }
  list() {
    return [...this.map.values()];
  }
  has(type) {
    return this.map.has(type);
  }
};
function createDefaultRegistry(opts = {}) {
  const reg = new AgentRegistry();
  reg.register(new ClaudeCodeAdapter({ extraArgs: opts.claudeExtraArgs }));
  reg.register(new CodexAdapter());
  reg.register(new PiAdapter());
  reg.register(new ControllableTestAdapter());
  return reg;
}

// ../../packages/scheduler/src/orchestrator.ts
var import_node_events = require("node:events");
init_src();

// ../../packages/scheduler/src/worktree.ts
var import_node_child_process3 = require("node:child_process");
var import_node_util2 = require("node:util");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var exec = (0, import_node_util2.promisify)(import_node_child_process3.execFile);
var WorktreeError = class extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
};
async function git(cwd, args) {
  try {
    return await exec("git", args, { cwd, env: process.env });
  } catch (err) {
    const e = err;
    throw new WorktreeError(
      `git ${args.join(" ")} \u5931\u8D25\uFF1A${e.stderr?.trim() || e.message}`,
      diagnoseGitError(args, e.stderr || e.message || "")
    );
  }
}
function diagnoseGitError(args, stderr) {
  if (/not a git repository/i.test(stderr)) return "\u76EE\u6807\u8DEF\u5F84\u4E0D\u662F Git \u4ED3\u5E93";
  if (/already exists/i.test(stderr) && args.includes("worktree")) return "worktree \u8DEF\u5F84\u5DF2\u5B58\u5728\uFF0C\u6E05\u7406\u540E\u91CD\u8BD5";
  if (/no commits yet/i.test(stderr)) return "\u4ED3\u5E93\u5C1A\u65E0\u63D0\u4EA4\uFF0C\u65E0\u6CD5\u521B\u5EFA worktree";
  return void 0;
}
async function isGitRepo(path) {
  try {
    await git(path, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}
async function currentBranch(path) {
  const { stdout } = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}
async function isValidCommit(repoPath, ref) {
  try {
    await exec("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}
async function resolveBase(repoPath, preferred) {
  if (preferred && await isValidCommit(repoPath, preferred)) {
    return preferred;
  }
  try {
    const { stdout } = await exec("git", ["branch", "--show-current"], { cwd: repoPath });
    const branch = stdout.trim();
    if (branch && await isValidCommit(repoPath, branch)) {
      return branch;
    }
  } catch {
  }
  try {
    const { stdout } = await exec("git", ["branch", "--format=%(refname:short)"], { cwd: repoPath });
    const branches = stdout.trim().split("\n").map((b) => b.trim()).filter(Boolean);
    for (const b of branches) {
      if (await isValidCommit(repoPath, b)) {
        return b;
      }
    }
  } catch {
  }
  if (await isValidCommit(repoPath, "HEAD")) {
    return "HEAD";
  }
  throw new WorktreeError(
    "\u4ED3\u5E93\u6CA1\u6709\u53EF\u7528\u7684\u63D0\u4EA4\uFF0C\u65E0\u6CD5\u521B\u5EFA worktree",
    "\u8BF7\u5148\u521B\u5EFA\u81F3\u5C11\u4E00\u4E2A\u521D\u59CB\u63D0\u4EA4\uFF08git commit\uFF09\u540E\u518D\u542F\u52A8\u4EFB\u52A1"
  );
}
async function createWorktree(opts) {
  if (!await isGitRepo(opts.repoPath)) {
    throw new WorktreeError(`\u4E0D\u662F Git \u4ED3\u5E93\uFF1A${opts.repoPath}`, "\u8BF7\u786E\u8BA4\u9879\u76EE\u8DEF\u5F84\u6307\u5411\u4E00\u4E2A Git \u5DE5\u4F5C\u533A");
  }
  const branch = opts.branchName ?? `ai-devflow/${opts.id}`;
  const base = await resolveBase(opts.repoPath, opts.baseBranch);
  const wtPath = (0, import_node_path.join)(opts.baseDir, opts.id);
  await (0, import_promises.mkdir)(opts.baseDir, { recursive: true });
  try {
    await (0, import_promises.access)(wtPath);
    await (0, import_promises.rm)(wtPath, { recursive: true, force: true });
  } catch {
  }
  await git(opts.repoPath, ["worktree", "add", "-b", branch, wtPath, base]);
  return { path: wtPath, branch };
}
async function mergeWorktreeBranch(opts) {
  const cur = await currentBranch(opts.repoPath).catch(() => "");
  if (cur && cur !== opts.defaultBranch) {
    return { merged: false, reason: `\u9879\u76EE\u5DE5\u4F5C\u533A\u5F53\u524D\u5728 ${cur} \u5206\u652F\uFF0C\u672A\u81EA\u52A8\u5408\u5E76\u5230 ${opts.defaultBranch}` };
  }
  try {
    try {
      await git(opts.repoPath, ["merge", "--ff-only", opts.branchName]);
    } catch {
      await git(opts.repoPath, ["merge", "--no-ff", "-m", `merge: ${opts.branchName}`, opts.branchName]);
    }
    return { merged: true };
  } catch (err) {
    await git(opts.repoPath, ["merge", "--abort"]).catch(() => {
    });
    const e = err;
    return { merged: false, reason: e.hint ? `${e.message}\uFF08${e.hint}\uFF09` : e.message };
  }
}
async function removeWorktree(opts) {
  try {
    await git(opts.repoPath, ["worktree", "remove", "--force", opts.worktreePath]);
  } catch {
    await (0, import_promises.rm)(opts.worktreePath, { recursive: true, force: true });
  }
  await git(opts.repoPath, ["worktree", "prune"]).catch(() => {
  });
  if (opts.branchName && !opts.keepBranch) {
    await git(opts.repoPath, ["branch", "-D", opts.branchName]).catch(() => {
    });
  }
}

// ../../packages/scheduler/src/semaphore.ts
var Semaphore = class {
  permits;
  waiters = [];
  constructor(permits) {
    this.permits = Math.max(1, permits);
  }
  async acquire() {
    if (this.permits > 0) {
      this.permits--;
      return this.release.bind(this);
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.permits--;
    return this.release.bind(this);
  }
  release() {
    this.permits++;
    const next = this.waiters.shift();
    if (next) {
      this.permits--;
      next();
    }
  }
  get available() {
    return this.permits;
  }
};

// ../../packages/scheduler/src/orchestrator.ts
var IMPLICIT_STAGE_ID = "__main__";
var Orchestrator = class extends import_node_events.EventEmitter {
  constructor(repos, registry, opts) {
    super();
    this.repos = repos;
    this.registry = registry;
    this.opts = opts;
    this.sem = new Semaphore(opts.maxConcurrent ?? 2);
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.autoRetry = opts.autoRetry ?? true;
  }
  sem;
  runs = /* @__PURE__ */ new Map();
  retryPolicy;
  autoRetry;
  /** 启动任务：分派 Agent、创建 worktree、运行流水线。 */
  async start(taskId, init) {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw new Error(`\u4EFB\u52A1\u4E0D\u5B58\u5728\uFF1A${taskId}`);
    if (this.runs.has(taskId)) throw new Error(`\u4EFB\u52A1\u5DF2\u5728\u8FD0\u884C\uFF1A${taskId}`);
    const project = this.repos.projects.get(task.projectId);
    if (!project) throw new Error(`\u9879\u76EE\u4E0D\u5B58\u5728\uFF1A${task.projectId}`);
    if (!init && task.dependsOn && task.dependsOn.length > 0) {
      const predecessors = task.dependsOn.map((id) => this.repos.tasks.get(id)).filter((t) => !!t);
      const dep = checkTaskDependencies(predecessors.map((p) => ({ id: p.id, title: p.title, status: p.status })));
      if (!dep.ok) throw new Error(`\u65E0\u6CD5\u542F\u52A8\u4EFB\u52A1\uFF1A${dep.reasons.join("; ")}`);
    }
    if (!task.agentType) {
      const agentType = await this.resolveDefaultAgent(task, project);
      this.repos.tasks.assignAgent(task.id, agentType);
      task.agentType = agentType;
    }
    if (task.status !== "in_progress") {
      const gate = canTransition(task, "in_progress", {
        hasAcceptance: true,
        hasAgentAssigned: !!task.agentType,
        hasUserAnswer: !!init?.userInput,
        hasArtifacts: false
      });
      if (!gate.ok && task.status !== "awaiting_input") {
        throw new Error(`\u65E0\u6CD5\u542F\u52A8\u4EFB\u52A1\uFF1A${gate.reasons.join("; ")}`);
      }
      this.transition(task, "in_progress");
    }
    const release = await this.sem.acquire();
    try {
      await this.runPipeline(task, project, init);
    } catch (err) {
      this.emit("task-error", { taskId, error: err.message });
      const attempt = task.retryCount + 1;
      this.handleFailure(task, err, attempt);
    } finally {
      release();
      this.runs.delete(taskId);
    }
  }
  /** 运行流水线各阶段。 */
  async runPipeline(task, project, init) {
    const stages = task.stages.length > 0 ? task.stages : [{ id: IMPLICIT_STAGE_ID, name: "\u6267\u884C", role: task.role }];
    const startStage = init?.resumeFrom?.stageIndex ?? task.currentStage ?? 0;
    const agentType = this.resolveAgentType(task, project);
    if (!task.agentType) {
      this.repos.tasks.assignAgent(task.id, agentType);
      task.agentType = agentType;
    }
    const execution = {
      id: randomId(),
      taskId: task.id,
      attempt: (this.repos.executions.getLatest(task.id)?.attempt ?? 0) + 1,
      agentType,
      startedAt: now(),
      status: "running"
    };
    this.repos.executions.insert(execution);
    this.log(execution, "info", `\u542F\u52A8 Agent ${agentType}\uFF08\u7B2C ${execution.attempt} \u6B21\u5C1D\u8BD5\uFF09`);
    let worktreePath = task.worktreePath;
    if (!worktreePath) {
      try {
        this.log(execution, "info", `\u521B\u5EFA Git worktree\uFF08\u57FA\u7840\u5206\u652F ${project.defaultBranch}\uFF09\u2026`);
        const handle = await createWorktree({
          repoPath: project.path,
          baseDir: this.opts.worktreesBaseDir,
          id: task.id,
          baseBranch: project.defaultBranch
        });
        worktreePath = handle.path;
        this.repos.tasks.setWorktree(task.id, worktreePath);
        task.worktreePath = worktreePath;
      } catch (err) {
        const msg = err instanceof WorktreeError ? `${err.message}${err.hint ? "\uFF08" + err.hint + "\uFF09" : ""}` : err.message;
        this.log(execution, "error", `worktree \u521B\u5EFA\u5931\u8D25\uFF1A${msg}`);
        throw err;
      }
    }
    for (let i = startStage; i < stages.length; i++) {
      const stage = stages[i];
      if (this.isCanceled(task.id)) {
        this.markExecution(execution, "canceled", "\u7528\u6237\u53D6\u6D88");
        return;
      }
      if (stage.dependsOn && stage.dependsOn.length > 0) {
        for (const dep of stage.dependsOn) {
          const depCp = this.repos.checkpoints.listByTask(task.id).find((c) => c.stageId === dep);
          if (!depCp) {
            this.log(execution, "error", `\u9636\u6BB5 ${stage.id} \u4F9D\u8D56 ${dep} \u7684\u68C0\u67E5\u70B9\u4E0D\u5B58\u5728`);
            throw new Error(`\u9636\u6BB5\u4F9D\u8D56\u672A\u6EE1\u8DB3\uFF1A${dep}`);
          }
        }
      }
      task.currentStage = i;
      this.repos.tasks.update(task);
      const prompt = this.buildPrompt(task, stage);
      const run = await this.registry.require(agentType).run({
        taskId: task.id,
        prompt,
        cwd: worktreePath,
        resumeFrom: i === startStage ? init?.resumeFrom : void 0,
        userInput: i === startStage ? init?.userInput : void 0
      });
      this.runs.set(task.id, { run, canceled: false });
      let stageDone = false;
      let askedUser = false;
      try {
        for await (const ev of run.events) {
          if (this.isCanceled(task.id)) {
            await run.cancel();
            break;
          }
          await this.handleEvent(task, execution, ev);
          if (ev.type === "ask_user") {
            askedUser = true;
            this.recordCheckpoint(task, stage, i, ev);
            this.transition(task, "awaiting_input");
            await run.cancel();
            break;
          }
          if (ev.type === "done") {
            stageDone = true;
          }
          if (ev.type === "error") {
            throw new Error(ev.message);
          }
        }
      } finally {
        this.runs.delete(task.id);
      }
      if (askedUser) return;
      if (!stageDone) {
        if (this.isCanceled(task.id)) {
          this.markExecution(execution, "canceled", "\u7528\u6237\u53D6\u6D88");
          return;
        }
        throw new Error(`\u9636\u6BB5 ${stage.id} \u672A\u5B8C\u6210`);
      }
      this.recordCheckpoint(task, stage, i, { type: "status", stage: stage.id, detail: "done", t: now() });
      execution.status = "succeeded";
      execution.endedAt = now();
      execution.summary = `${stage.name} \u5B8C\u6210`;
      this.repos.executions.update(execution);
    }
    const branchName = `ai-devflow/${task.id}`;
    const mergeRes = await mergeWorktreeBranch({
      repoPath: project.path,
      branchName,
      defaultBranch: project.defaultBranch
    });
    if (mergeRes.merged) {
      this.log(execution, "info", `\u5DF2\u5408\u5E76\u5230 ${project.defaultBranch}\uFF0C\u4EA7\u51FA\u5DF2\u843D\u5165\u4E3B\u9879\u76EE`);
    } else {
      this.log(execution, "warn", `\u672A\u81EA\u52A8\u5408\u5E76\uFF1A${mergeRes.reason}\uFF08\u5DE5\u4F5C\u4FDD\u7559\u5728\u5206\u652F ${branchName}\uFF09`);
    }
    this.transition(task, "in_review");
  }
  async handleEvent(task, execution, ev) {
    this.emit("task-event", { taskId: task.id, event: ev });
    const t = now();
    switch (ev.type) {
      case "log":
      case "file_change":
      case "test_result": {
        const text = ev.type === "log" ? ev.text : ev.type === "file_change" ? `[file:${ev.action}] ${ev.path}` : `[test:${ev.passed ? "pass" : "fail"}] ${ev.summary}`;
        const level = ev.type === "test_result" ? ev.passed ? "info" : "error" : ev.type === "log" ? ev.level : "info";
        const entry = { id: randomId(), taskId: task.id, executionId: execution.id, level, text, t };
        this.repos.logs.insert(entry);
        this.emit("log", entry);
        break;
      }
      case "ask_user": {
        this.repos.pendingQuestions.upsert({
          taskId: task.id,
          question: ev.question,
          context: ev.context,
          askedAt: t
        });
        break;
      }
      case "status":
        break;
      case "done":
        execution.summary = ev.summary;
        break;
      case "error": {
        execution.summary = ev.message;
        const entry = { id: randomId(), taskId: task.id, executionId: execution.id, level: "error", text: `[agent error] ${ev.message}`, t };
        this.repos.logs.insert(entry);
        this.emit("log", entry);
        break;
      }
    }
  }
  /** 写一条任务日志并转发给 Renderer。 */
  log(execution, level, text) {
    const entry = { id: randomId(), taskId: execution.taskId, executionId: execution.id, level, text, t: now() };
    this.repos.logs.insert(entry);
    this.emit("log", entry);
  }
  recordCheckpoint(task, stage, stageIndex, ev) {
    const cp = {
      id: randomId(),
      taskId: task.id,
      stageId: stage.id,
      stageIndex,
      context: ev.type === "ask_user" ? ev.context : "",
      createdAt: now()
    };
    this.repos.checkpoints.upsert(cp);
  }
  /** 用户回答后从检查点恢复。 */
  async resume(taskId, userInput) {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw new Error(`\u4EFB\u52A1\u4E0D\u5B58\u5728\uFF1A${taskId}`);
    if (task.status !== "awaiting_input") throw new Error(`\u4EFB\u52A1\u4E0D\u5728\u5F85\u6C9F\u901A\u72B6\u6001\uFF1A${task.status}`);
    this.repos.pendingQuestions.answer(taskId, userInput, now());
    const cp = this.repos.checkpoints.getLatest(taskId);
    this.transition(task, "in_progress", { hasUserAnswer: true });
    await this.start(taskId, { resumeFrom: cp ?? void 0, userInput });
  }
  /** 取消任务。 */
  async cancel(taskId) {
    const entry = this.runs.get(taskId);
    if (entry) {
      entry.canceled = true;
      await entry.run.cancel();
    } else {
      this.runs.set(taskId, { run: { events: async function* () {
      }(), cancel: async () => {
      }, done: async () => ({ exitCode: null, ok: false }) }, canceled: true });
    }
    const task = this.repos.tasks.get(taskId);
    if (task && task.status !== "archived") {
      if (canTransition(task, "ready", { hasAcceptance: true, hasAgentAssigned: !!task.agentType, hasArtifacts: false }).ok) {
        this.transition(task, "ready");
      }
    }
    this.emit("task-canceled", { taskId });
  }
  /** 显式重试。 */
  async retry(taskId) {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw new Error(`\u4EFB\u52A1\u4E0D\u5B58\u5728\uFF1A${taskId}`);
    this.repos.tasks.incRetry(taskId);
    task.retryCount += 1;
    if (canTransition(task, "ready", { hasAcceptance: true, hasAgentAssigned: !!task.agentType, hasArtifacts: false }).ok) {
      this.transition(task, "ready");
    }
    await this.start(taskId);
  }
  isCanceled(taskId) {
    return this.runs.get(taskId)?.canceled ?? false;
  }
  handleFailure(task, err, attempt) {
    const decision = decideRetry(this.retryPolicy, attempt, this.autoRetry);
    const latest = this.repos.executions.getLatest(task.id);
    if (latest) {
      this.markExecution(latest, "failed", err.message);
      this.log(latest, "error", `\u5931\u8D25\uFF08\u7B2C ${attempt} \u6B21\uFF09\uFF1A${err.message}`);
    }
    if (decision.retry && this.autoRetry) {
      if (latest) this.log(latest, "warn", `\u5C06\u5728 ${decision.delayMs}ms \u540E\u91CD\u8BD5\uFF08\u7B2C ${attempt + 1} \u6B21\uFF09`);
      this.emit("task-retry", { taskId: task.id, delayMs: decision.delayMs, reason: decision.reason });
      setTimeout(() => {
        this.repos.tasks.incRetry(task.id);
        this.start(task.id).catch((e) => this.emit("task-error", { taskId: task.id, error: e.message }));
      }, decision.delayMs).unref?.();
    } else {
      if (canTransition(task, "ready", { hasAcceptance: true, hasAgentAssigned: !!task.agentType, hasArtifacts: false }).ok) {
        this.transition(task, "ready");
      }
      if (latest) this.log(latest, "error", `\u5DF2\u8FBE\u6700\u5927\u91CD\u8BD5\u6B21\u6570\uFF0C\u4EFB\u52A1\u9000\u56DE\u5F85\u5F00\u53D1\uFF1A${err.message}`);
      this.emit("task-failed", { taskId: task.id, error: err.message });
    }
  }
  markExecution(exec2, status, summary) {
    exec2.status = status;
    exec2.endedAt = now();
    exec2.summary = summary;
    this.repos.executions.update(exec2);
  }
  transition(task, target, ctx) {
    const gate = canTransition(task, target, {
      hasAcceptance: true,
      hasAgentAssigned: !!task.agentType,
      hasArtifacts: true,
      testPassed: target === "archived" ? true : void 0,
      auditOk: target === "archived" ? true : void 0,
      hasUserAnswer: false,
      ...ctx
    });
    if (!gate.ok) {
      this.emit("task-error", { taskId: task.id, error: `\u72B6\u6001\u8FC1\u79FB\u88AB\u95E8\u7981\u62D2\u7EDD\uFF1A${gate.reasons.join("; ")}` });
      throw new Error(`\u72B6\u6001\u8FC1\u79FB\u88AB\u95E8\u7981\u62D2\u7EDD\uFF1A${gate.reasons.join("; ")}`);
    }
    this.repos.tasks.updateStatus(task.id, target, now());
    task.status = target;
    task.statusChangedAt = now();
    this.emit("task-status", { taskId: task.id, status: target });
  }
  resolveAgentType(task, project) {
    if (task.agentType) return task.agentType;
    const roleOverride = project.settings.agentRoles?.[task.role];
    if (roleOverride) return roleOverride;
    return defaultAgentForRole(task.role);
  }
  /**
   * 解析默认 Agent：按“角色覆盖 > claude_code > codex > pi”顺序检测首个可用适配器。
   * 不含 'test'（测试适配器需显式指定）。无可用适配器时抛出清晰错误。
   */
  async resolveDefaultAgent(task, project) {
    const roleOverride = project.settings.agentRoles?.[task.role];
    const candidates = [];
    if (roleOverride) candidates.push(roleOverride);
    for (const t of ["claude_code", "codex", "pi"]) {
      if (!candidates.includes(t)) candidates.push(t);
    }
    for (const t of candidates) {
      const adapter = this.registry.get(t);
      if (!adapter) continue;
      try {
        const det = await adapter.detect();
        if (det.available) return t;
      } catch {
      }
    }
    throw new Error(
      "\u6CA1\u6709\u53EF\u7528\u7684 Agent \u6865\u63A5\u5668\uFF1A\u672A\u68C0\u6D4B\u5230 claude/codex/pi\u3002\u8BF7\u5B89\u88C5\u5176\u4E2D\u4E4B\u4E00\u5E76\u91CD\u542F\uFF0C\u6216\u5728\u521B\u5EFA\u4EFB\u52A1\u65F6\u663E\u5F0F\u6307\u5B9A\u201C\u6D4B\u8BD5\u9002\u914D\u5668\u201D\u3002"
    );
  }
  buildPrompt(task, stage) {
    return `\u3010\u9636\u6BB5\u3011${stage.name}
\u3010\u4EFB\u52A1\u3011${task.title}
\u3010\u63CF\u8FF0\u3011${task.description || "(\u65E0)"}
\u8BF7\u5728\u5F53\u524D\u4ED3\u5E93\u5DE5\u4F5C\u533A\u5B8C\u6210\u8BE5\u9636\u6BB5\u5DE5\u4F5C\u3002`;
  }
  /** 应用重启后恢复：扫描运行中/待沟通任务。 */
  async recover() {
    const tasks = this.repos.tasks.listRecoverable();
    const recovered = [];
    const failed = [];
    const awaiting = [];
    for (const task of tasks) {
      if (task.status === "awaiting_input") {
        awaiting.push(task.id);
        this.emit("task-awaiting", { taskId: task.id });
        continue;
      }
      const latest = this.repos.executions.getLatest(task.id);
      if (latest && latest.status === "running") {
        this.markExecution(latest, "failed", "\u5E94\u7528\u91CD\u542F\uFF0C\u5B50\u8FDB\u7A0B\u5DF2\u7EC8\u6B62");
      }
      if (canTransition(task, "ready", { hasAcceptance: true, hasAgentAssigned: !!task.agentType, hasArtifacts: false }).ok) {
        this.transition(task, "ready");
      }
      failed.push(task.id);
      this.emit("task-recovered-failed", { taskId: task.id });
    }
    return { recovered, failed, awaiting };
  }
  /** 清理任务的 worktree（成功归档后或手动清理）。 */
  async cleanupWorktree(taskId, opts) {
    const task = this.repos.tasks.get(taskId);
    if (!task?.worktreePath) return;
    const project = this.repos.projects.get(task.projectId);
    if (project) {
      await removeWorktree({
        repoPath: project.path,
        worktreePath: task.worktreePath,
        branchName: `ai-devflow/${task.id}`,
        keepBranch: opts?.keepBranch
      }).catch(() => {
      });
    }
    this.repos.tasks.setWorktree(taskId, void 0);
  }
};

// ../../packages/notifications/src/engine.ts
init_src();
init_src();

// ../../packages/notifications/src/notifier.ts
function deepLinkForTask(taskId) {
  return `ai-devflow://task/${taskId}`;
}

// ../../packages/notifications/src/engine.ts
var TIMEOUT_EVENT = "task.timeout";
var TimeoutEngine = class {
  constructor(repos, notifier, webhooks, opts = {}) {
    this.repos = repos;
    this.notifier = notifier;
    this.webhooks = webhooks;
    this.opts = opts;
  }
  timer;
  start() {
    const interval = this.opts.intervalMs ?? 3e4;
    this.timer = setInterval(() => {
      this.tick(now()).catch((e) => {
        console.error("[timeout-engine] tick error:", e.message);
      });
    }, interval);
    this.timer.unref?.();
    this.tick(now()).catch(() => {
    });
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = void 0;
  }
  async tick(nowMs) {
    const rules = this.repos.notificationRules.list().filter((r) => r.enabled);
    if (rules.length === 0) return { fired: 0 };
    const tasks = this.repos.tasks.list();
    const overdue = findOverdue(rules, tasks, nowMs);
    let fired = 0;
    for (const { taskId, ruleId } of overdue) {
      const rule = rules.find((r) => r.id === ruleId);
      const task = tasks.find((t) => t.id === taskId);
      if (!rule || !task) continue;
      fired += await this.fireForTask(rule, task);
    }
    return { fired };
  }
  async fireForTask(rule, task) {
    let n = 0;
    for (const channel2 of rule.channels) {
      if (this.repos.notificationDeliveries.exists(rule.id, task.id, channel2)) continue;
      if (channel2 === "desktop") {
        try {
          await this.notifier.notify({
            title: `\u4EFB\u52A1\u8D85\u65F6 \xB7 ${task.status}`,
            body: task.title,
            taskId: task.id,
            deepLink: deepLinkForTask(task.id)
          });
          this.recordDelivery(rule.id, task.id, "desktop", "sent", void 0);
        } catch (e) {
          this.recordDelivery(rule.id, task.id, "desktop", "failed", e.message);
        }
        n++;
      } else if (channel2 === "webhook") {
        const configs = this.repos.webhookConfigs.list().filter(
          (w) => w.enabled && (w.events.includes(TIMEOUT_EVENT) || w.events.includes("*"))
        );
        if (configs.length === 0) {
          this.recordDelivery(rule.id, task.id, "webhook", "suppressed", "\u65E0\u542F\u7528\u7684 webhook");
          continue;
        }
        let anyOk = false;
        for (const cfg of configs) {
          const res = await this.webhooks.deliver(cfg, TIMEOUT_EVENT, {
            id: task.id,
            title: task.title,
            status: task.status,
            projectId: task.projectId,
            iterationId: task.iterationId
          }, { ruleId: rule.id, minutes: rule.minutes });
          if (res.ok) anyOk = true;
        }
        this.recordDelivery(rule.id, task.id, "webhook", anyOk ? "sent" : "failed", anyOk ? void 0 : "\u6240\u6709 webhook \u6295\u9012\u5931\u8D25");
        n++;
      }
    }
    return n;
  }
  recordDelivery(ruleId, taskId, channel2, status, detail) {
    this.repos.notificationDeliveries.insert({
      id: randomId(),
      ruleId,
      taskId,
      channel: channel2,
      sentAt: now(),
      status,
      detail
    });
  }
};

// ../../packages/notifications/src/webhook.ts
init_src();
var WebhookSender = class {
  constructor(repos, opts = {}) {
    this.repos = repos;
    this.opts = opts;
  }
  async deliver(config, event, task, detail) {
    const payload = buildWebhookPayload(event, task, detail, now());
    const { body, signature, header } = await signPayload(config.secret, payload);
    const maxAttempts = this.opts.maxAttempts ?? 3;
    const timeoutMs = this.opts.timeoutMs ?? 1e4;
    const baseDelay = this.opts.baseDelayMs ?? 1e3;
    let lastError;
    let lastStatus = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t0 = now();
      let ok = false;
      let status = 0;
      let snippet = "";
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(config.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [header]: signature,
            "user-agent": "ai-devflow/1.0"
          },
          body,
          signal: ctrl.signal
        });
        clearTimeout(timer);
        status = res.status;
        ok = res.ok;
        snippet = redactText(await res.text().catch(() => "")).slice(0, 500);
      } catch (err) {
        lastError = err.message;
        status = 0;
        snippet = redactText(lastError).slice(0, 500);
      }
      lastStatus = status;
      const delivery = {
        id: randomId(),
        webhookId: config.id,
        taskId: task.id,
        event,
        payload: body,
        status,
        attempt,
        sentAt: now(),
        durationMs: now() - t0,
        responseSnippet: snippet,
        ok
      };
      this.repos.webhookDeliveries.insert(delivery);
      if (ok) return { ok: true, status, attempts: attempt };
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt - 1)));
      }
    }
    return { ok: false, status: lastStatus, attempts: maxAttempts, lastError };
  }
  /** 测试投递：用配置发送一个 webhook.test 事件，返回结果（不进入重试退避的长等待）。 */
  async test(config) {
    return this.deliver(
      config,
      "webhook.test",
      { id: "test", title: "\u6D4B\u8BD5\u6295\u9012", status: "backlog", projectId: "", iterationId: "" },
      { note: "manual test" }
    );
  }
  /** 验证给定 body 与签名是否匹配（用于接收方自检或文档）。 */
  static async verify(secret, body, signature) {
    const { verifySignature: verifySignature2 } = await Promise.resolve().then(() => (init_src(), src_exports));
    return verifySignature2(secret, body, signature);
  }
};

// electron/credentials.ts
var import_electron = require("electron");
function encryptSecret(plain) {
  if (!import_electron.safeStorage.isEncryptionAvailable()) {
    return "b64:" + Buffer.from(plain, "utf8").toString("base64");
  }
  return "enc:" + import_electron.safeStorage.encryptString(plain).toString("base64");
}
function decryptSecret(stored) {
  if (stored.startsWith("enc:")) {
    if (!import_electron.safeStorage.isEncryptionAvailable()) {
      throw new Error("\u5BC6\u94A5\u5DF2\u52A0\u5BC6\u4F46\u5F53\u524D\u73AF\u5883\u65E0\u6CD5\u89E3\u5BC6\uFF08safeStorage \u4E0D\u53EF\u7528\uFF09");
    }
    return import_electron.safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
  }
  if (stored.startsWith("b64:")) {
    return Buffer.from(stored.slice(4), "base64").toString("utf8");
  }
  return stored;
}

// electron/services.ts
function createServices(notifier) {
  const userData = import_electron2.app.getPath("userData");
  const dbPath = (0, import_node_path2.join)(userData, "ai-devflow.db");
  const worktreesBaseDir = (0, import_node_path2.join)(userData, "worktrees");
  const db = openDatabase(dbPath);
  const repos = createRepositories(db);
  const registry = createDefaultRegistry({ claudeExtraArgs: ["--permission-mode", "bypassPermissions"] });
  const orchestrator = new Orchestrator(repos, registry, { worktreesBaseDir, maxConcurrent: 2, autoRetry: true });
  const webhooks = new WebhookSender(repos, { maxAttempts: 3, timeoutMs: 1e4, baseDelayMs: 1e3 });
  const timeoutEngine = new TimeoutEngine(repos, notifier, webhooks, { intervalMs: 3e4 });
  return {
    repos,
    registry,
    orchestrator,
    timeoutEngine,
    webhooks,
    dbPath,
    worktreesBaseDir,
    encryptSecret,
    decryptSecret
  };
}

// electron/ipc.ts
var import_electron3 = require("electron");
var import_node_fs = require("node:fs");
var import_node_path3 = require("node:path");
var import_node_child_process4 = require("node:child_process");
init_src();

// ../../node_modules/.pnpm/@ai-sdk+provider@1.0.0/node_modules/@ai-sdk/provider/dist/index.mjs
var marker = "vercel.ai.error";
var symbol = Symbol.for(marker);
var _a;
var _AISDKError = class _AISDKError2 extends Error {
  /**
   * Creates an AI SDK Error.
   *
   * @param {Object} params - The parameters for creating the error.
   * @param {string} params.name - The name of the error.
   * @param {string} params.message - The error message.
   * @param {unknown} [params.cause] - The underlying cause of the error.
   */
  constructor({
    name: name142,
    message,
    cause
  }) {
    super(message);
    this[_a] = true;
    this.name = name142;
    this.cause = cause;
  }
  /**
   * Checks if the given error is an AI SDK Error.
   * @param {unknown} error - The error to check.
   * @returns {boolean} True if the error is an AI SDK Error, false otherwise.
   */
  static isInstance(error) {
    return _AISDKError2.hasMarker(error, marker);
  }
  static hasMarker(error, marker152) {
    const markerSymbol = Symbol.for(marker152);
    return error != null && typeof error === "object" && markerSymbol in error && typeof error[markerSymbol] === "boolean" && error[markerSymbol] === true;
  }
};
_a = symbol;
var AISDKError = _AISDKError;
var name = "AI_APICallError";
var marker2 = `vercel.ai.error.${name}`;
var symbol2 = Symbol.for(marker2);
var _a2;
var APICallError = class extends AISDKError {
  constructor({
    message,
    url,
    requestBodyValues,
    statusCode,
    responseHeaders,
    responseBody,
    cause,
    isRetryable = statusCode != null && (statusCode === 408 || // request timeout
    statusCode === 409 || // conflict
    statusCode === 429 || // too many requests
    statusCode >= 500),
    // server error
    data
  }) {
    super({ name, message, cause });
    this[_a2] = true;
    this.url = url;
    this.requestBodyValues = requestBodyValues;
    this.statusCode = statusCode;
    this.responseHeaders = responseHeaders;
    this.responseBody = responseBody;
    this.isRetryable = isRetryable;
    this.data = data;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker2);
  }
};
_a2 = symbol2;
var name2 = "AI_EmptyResponseBodyError";
var marker3 = `vercel.ai.error.${name2}`;
var symbol3 = Symbol.for(marker3);
var _a3;
var EmptyResponseBodyError = class extends AISDKError {
  // used in isInstance
  constructor({ message = "Empty response body" } = {}) {
    super({ name: name2, message });
    this[_a3] = true;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker3);
  }
};
_a3 = symbol3;
function getErrorMessage(error) {
  if (error == null) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return JSON.stringify(error);
}
var name3 = "AI_InvalidArgumentError";
var marker4 = `vercel.ai.error.${name3}`;
var symbol4 = Symbol.for(marker4);
var _a4;
var InvalidArgumentError = class extends AISDKError {
  constructor({
    message,
    cause,
    argument
  }) {
    super({ name: name3, message, cause });
    this[_a4] = true;
    this.argument = argument;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker4);
  }
};
_a4 = symbol4;
var name4 = "AI_InvalidPromptError";
var marker5 = `vercel.ai.error.${name4}`;
var symbol5 = Symbol.for(marker5);
var _a5;
var InvalidPromptError = class extends AISDKError {
  constructor({
    prompt,
    message,
    cause
  }) {
    super({ name: name4, message: `Invalid prompt: ${message}`, cause });
    this[_a5] = true;
    this.prompt = prompt;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker5);
  }
};
_a5 = symbol5;
var name5 = "AI_InvalidResponseDataError";
var marker6 = `vercel.ai.error.${name5}`;
var symbol6 = Symbol.for(marker6);
var _a6;
var InvalidResponseDataError = class extends AISDKError {
  constructor({
    data,
    message = `Invalid response data: ${JSON.stringify(data)}.`
  }) {
    super({ name: name5, message });
    this[_a6] = true;
    this.data = data;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker6);
  }
};
_a6 = symbol6;
var name6 = "AI_JSONParseError";
var marker7 = `vercel.ai.error.${name6}`;
var symbol7 = Symbol.for(marker7);
var _a7;
var JSONParseError = class extends AISDKError {
  constructor({ text, cause }) {
    super({
      name: name6,
      message: `JSON parsing failed: Text: ${text}.
Error message: ${getErrorMessage(cause)}`,
      cause
    });
    this[_a7] = true;
    this.text = text;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker7);
  }
};
_a7 = symbol7;
var name7 = "AI_LoadAPIKeyError";
var marker8 = `vercel.ai.error.${name7}`;
var symbol8 = Symbol.for(marker8);
var _a8;
var LoadAPIKeyError = class extends AISDKError {
  // used in isInstance
  constructor({ message }) {
    super({ name: name7, message });
    this[_a8] = true;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker8);
  }
};
_a8 = symbol8;
var name8 = "AI_LoadSettingError";
var marker9 = `vercel.ai.error.${name8}`;
var symbol9 = Symbol.for(marker9);
var _a9;
_a9 = symbol9;
var name9 = "AI_NoContentGeneratedError";
var marker10 = `vercel.ai.error.${name9}`;
var symbol10 = Symbol.for(marker10);
var _a10;
_a10 = symbol10;
var name10 = "AI_NoSuchModelError";
var marker11 = `vercel.ai.error.${name10}`;
var symbol11 = Symbol.for(marker11);
var _a11;
var NoSuchModelError = class extends AISDKError {
  constructor({
    errorName = name10,
    modelId,
    modelType,
    message = `No such ${modelType}: ${modelId}`
  }) {
    super({ name: errorName, message });
    this[_a11] = true;
    this.modelId = modelId;
    this.modelType = modelType;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker11);
  }
};
_a11 = symbol11;
var name11 = "AI_TooManyEmbeddingValuesForCallError";
var marker12 = `vercel.ai.error.${name11}`;
var symbol12 = Symbol.for(marker12);
var _a12;
var TooManyEmbeddingValuesForCallError = class extends AISDKError {
  constructor(options) {
    super({
      name: name11,
      message: `Too many values for a single embedding call. The ${options.provider} model "${options.modelId}" can only embed up to ${options.maxEmbeddingsPerCall} values per call, but ${options.values.length} values were provided.`
    });
    this[_a12] = true;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.maxEmbeddingsPerCall = options.maxEmbeddingsPerCall;
    this.values = options.values;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker12);
  }
};
_a12 = symbol12;
var name12 = "AI_TypeValidationError";
var marker13 = `vercel.ai.error.${name12}`;
var symbol13 = Symbol.for(marker13);
var _a13;
var _TypeValidationError = class _TypeValidationError2 extends AISDKError {
  constructor({ value, cause }) {
    super({
      name: name12,
      message: `Type validation failed: Value: ${JSON.stringify(value)}.
Error message: ${getErrorMessage(cause)}`,
      cause
    });
    this[_a13] = true;
    this.value = value;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker13);
  }
  /**
   * Wraps an error into a TypeValidationError.
   * If the cause is already a TypeValidationError with the same value, it returns the cause.
   * Otherwise, it creates a new TypeValidationError.
   *
   * @param {Object} params - The parameters for wrapping the error.
   * @param {unknown} params.value - The value that failed validation.
   * @param {unknown} params.cause - The original error or cause of the validation failure.
   * @returns {TypeValidationError} A TypeValidationError instance.
   */
  static wrap({
    value,
    cause
  }) {
    return _TypeValidationError2.isInstance(cause) && cause.value === value ? cause : new _TypeValidationError2({ value, cause });
  }
};
_a13 = symbol13;
var TypeValidationError = _TypeValidationError;
var name13 = "AI_UnsupportedFunctionalityError";
var marker14 = `vercel.ai.error.${name13}`;
var symbol14 = Symbol.for(marker14);
var _a14;
var UnsupportedFunctionalityError = class extends AISDKError {
  constructor({ functionality }) {
    super({
      name: name13,
      message: `'${functionality}' functionality not supported.`
    });
    this[_a14] = true;
    this.functionality = functionality;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker14);
  }
};
_a14 = symbol14;

// ../../node_modules/.pnpm/nanoid@5.1.16/node_modules/nanoid/non-secure/index.js
var customAlphabet = (alphabet, defaultSize = 21) => {
  return (size = defaultSize) => {
    let id = "";
    let i = size | 0;
    while (i-- > 0) {
      id += alphabet[Math.random() * alphabet.length | 0];
    }
    return id;
  };
};

// ../../node_modules/.pnpm/@ai-sdk+provider-utils@2.0.0_zod@3.23.0/node_modules/@ai-sdk/provider-utils/dist/index.mjs
var import_secure_json_parse = __toESM(require_secure_json_parse(), 1);

// ../../node_modules/.pnpm/eventsource-parser@3.1.0/node_modules/eventsource-parser/dist/index.js
var ParseError = class extends Error {
  constructor(message, options) {
    super(message), this.name = "ParseError", this.type = options.type, this.field = options.field, this.value = options.value, this.line = options.line;
  }
};
var LF = 10;
var CR = 13;
var SPACE = 32;
function noop(_arg) {
}
function createParser(config) {
  if (typeof config == "function")
    throw new TypeError(
      "`config` must be an object, got a function instead. Did you mean `createParser({onEvent: fn})`?"
    );
  const { onEvent = noop, onError = noop, onRetry = noop, onComment, maxBufferSize } = config, pendingFragments = [];
  let pendingFragmentsLength = 0, isFirstChunk = true, id, data = "", dataLines = 0, eventType, terminated = false;
  function feed(chunk) {
    if (terminated)
      throw new Error(
        "Cannot feed parser: it was terminated after exceeding the configured max buffer size. Call `reset()` to resume parsing."
      );
    if (isFirstChunk && (isFirstChunk = false, chunk.charCodeAt(0) === 239 && chunk.charCodeAt(1) === 187 && chunk.charCodeAt(2) === 191 && (chunk = chunk.slice(3))), pendingFragments.length === 0) {
      const trailing2 = processLines(chunk);
      trailing2 !== "" && (pendingFragments.push(trailing2), pendingFragmentsLength = trailing2.length), checkBufferSize();
      return;
    }
    if (chunk.indexOf(`
`) === -1 && chunk.indexOf("\r") === -1) {
      pendingFragments.push(chunk), pendingFragmentsLength += chunk.length, checkBufferSize();
      return;
    }
    pendingFragments.push(chunk);
    const input = pendingFragments.join("");
    pendingFragments.length = 0, pendingFragmentsLength = 0;
    const trailing = processLines(input);
    trailing !== "" && (pendingFragments.push(trailing), pendingFragmentsLength = trailing.length), checkBufferSize();
  }
  function checkBufferSize() {
    maxBufferSize !== void 0 && (pendingFragmentsLength + data.length <= maxBufferSize || (terminated = true, pendingFragments.length = 0, pendingFragmentsLength = 0, id = void 0, data = "", dataLines = 0, eventType = void 0, onError(
      new ParseError(`Buffered data exceeded max buffer size of ${maxBufferSize} characters`, {
        type: "max-buffer-size-exceeded"
      })
    )));
  }
  function processLines(chunk) {
    let searchIndex = 0;
    if (chunk.indexOf("\r") === -1) {
      let lfIndex = chunk.indexOf(`
`, searchIndex);
      for (; lfIndex !== -1; ) {
        if (searchIndex === lfIndex) {
          dataLines > 0 && onEvent({ id, event: eventType, data }), id = void 0, data = "", dataLines = 0, eventType = void 0, searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
          continue;
        }
        const firstCharCode = chunk.charCodeAt(searchIndex);
        if (isDataPrefix(chunk, searchIndex, firstCharCode)) {
          const valueStart = chunk.charCodeAt(searchIndex + 5) === SPACE ? searchIndex + 6 : searchIndex + 5, value = chunk.slice(valueStart, lfIndex);
          if (dataLines === 0 && chunk.charCodeAt(lfIndex + 1) === LF) {
            onEvent({ id, event: eventType, data: value }), id = void 0, data = "", eventType = void 0, searchIndex = lfIndex + 2, lfIndex = chunk.indexOf(`
`, searchIndex);
            continue;
          }
          data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
        } else isEventPrefix(chunk, searchIndex, firstCharCode) ? eventType = chunk.slice(
          chunk.charCodeAt(searchIndex + 6) === SPACE ? searchIndex + 7 : searchIndex + 6,
          lfIndex
        ) || void 0 : parseLine(chunk, searchIndex, lfIndex);
        searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
      }
      return chunk.slice(searchIndex);
    }
    for (; searchIndex < chunk.length; ) {
      const crIndex = chunk.indexOf("\r", searchIndex), lfIndex = chunk.indexOf(`
`, searchIndex);
      let lineEnd = -1;
      if (crIndex !== -1 && lfIndex !== -1 ? lineEnd = crIndex < lfIndex ? crIndex : lfIndex : crIndex !== -1 ? crIndex === chunk.length - 1 ? lineEnd = -1 : lineEnd = crIndex : lfIndex !== -1 && (lineEnd = lfIndex), lineEnd === -1)
        break;
      parseLine(chunk, searchIndex, lineEnd), searchIndex = lineEnd + 1, chunk.charCodeAt(searchIndex - 1) === CR && chunk.charCodeAt(searchIndex) === LF && searchIndex++;
    }
    return chunk.slice(searchIndex);
  }
  function parseLine(chunk, start, end) {
    if (start === end) {
      dispatchEvent();
      return;
    }
    const firstCharCode = chunk.charCodeAt(start);
    if (isDataPrefix(chunk, start, firstCharCode)) {
      const valueStart = chunk.charCodeAt(start + 5) === SPACE ? start + 6 : start + 5, value2 = chunk.slice(valueStart, end);
      data = dataLines === 0 ? value2 : `${data}
${value2}`, dataLines++;
      return;
    }
    if (isEventPrefix(chunk, start, firstCharCode)) {
      eventType = chunk.slice(chunk.charCodeAt(start + 6) === SPACE ? start + 7 : start + 6, end) || void 0;
      return;
    }
    if (firstCharCode === 105 && chunk.charCodeAt(start + 1) === 100 && chunk.charCodeAt(start + 2) === 58) {
      const value2 = chunk.slice(chunk.charCodeAt(start + 3) === SPACE ? start + 4 : start + 3, end);
      id = value2.includes("\0") ? void 0 : value2;
      return;
    }
    if (firstCharCode === 58) {
      if (onComment) {
        const line2 = chunk.slice(start, end);
        onComment(line2.slice(chunk.charCodeAt(start + 1) === SPACE ? 2 : 1));
      }
      return;
    }
    const line = chunk.slice(start, end), fieldSeparatorIndex = line.indexOf(":");
    if (fieldSeparatorIndex === -1) {
      processField(line, "", line);
      return;
    }
    const field = line.slice(0, fieldSeparatorIndex), offset = line.charCodeAt(fieldSeparatorIndex + 1) === SPACE ? 2 : 1, value = line.slice(fieldSeparatorIndex + offset);
    processField(field, value, line);
  }
  function processField(field, value, line) {
    switch (field) {
      case "event":
        eventType = value || void 0;
        break;
      case "data":
        data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
        break;
      case "id":
        id = value.includes("\0") ? void 0 : value;
        break;
      case "retry":
        /^\d+$/.test(value) ? onRetry(parseInt(value, 10)) : onError(
          new ParseError(`Invalid \`retry\` value: "${value}"`, {
            type: "invalid-retry",
            value,
            line
          })
        );
        break;
      default:
        onError(
          new ParseError(
            `Unknown field "${field.length > 20 ? `${field.slice(0, 20)}\u2026` : field}"`,
            { type: "unknown-field", field, value, line }
          )
        );
        break;
    }
  }
  function dispatchEvent() {
    dataLines > 0 && onEvent({
      id,
      event: eventType,
      data
    }), id = void 0, data = "", dataLines = 0, eventType = void 0;
  }
  function reset(options = {}) {
    if (options.consume && pendingFragments.length > 0) {
      const incompleteLine = pendingFragments.join("");
      parseLine(incompleteLine, 0, incompleteLine.length);
    }
    isFirstChunk = true, id = void 0, data = "", dataLines = 0, eventType = void 0, pendingFragments.length = 0, pendingFragmentsLength = 0, terminated = false;
  }
  return { feed, reset };
}
function isDataPrefix(chunk, i, firstCharCode) {
  return firstCharCode === 100 && chunk.charCodeAt(i + 1) === 97 && chunk.charCodeAt(i + 2) === 116 && chunk.charCodeAt(i + 3) === 97 && chunk.charCodeAt(i + 4) === 58;
}
function isEventPrefix(chunk, i, firstCharCode) {
  return firstCharCode === 101 && chunk.charCodeAt(i + 1) === 118 && chunk.charCodeAt(i + 2) === 101 && chunk.charCodeAt(i + 3) === 110 && chunk.charCodeAt(i + 4) === 116 && chunk.charCodeAt(i + 5) === 58;
}

// ../../node_modules/.pnpm/eventsource-parser@3.1.0/node_modules/eventsource-parser/dist/stream.js
var EventSourceParserStream = class extends TransformStream {
  constructor({ onError, onRetry, onComment, maxBufferSize } = {}) {
    let parser;
    super({
      start(controller) {
        parser = createParser({
          onEvent: (event) => {
            controller.enqueue(event);
          },
          onError(error) {
            typeof onError == "function" && onError(error), (onError === "terminate" || error.type === "max-buffer-size-exceeded") && controller.error(error);
          },
          onRetry,
          onComment,
          maxBufferSize
        });
      },
      transform(chunk) {
        parser.feed(chunk);
      }
    });
  }
};

// ../../node_modules/.pnpm/@ai-sdk+provider-utils@2.0.0_zod@3.23.0/node_modules/@ai-sdk/provider-utils/dist/index.mjs
function combineHeaders(...headers) {
  return headers.reduce(
    (combinedHeaders, currentHeaders) => ({
      ...combinedHeaders,
      ...currentHeaders != null ? currentHeaders : {}
    }),
    {}
  );
}
function convertAsyncIteratorToReadableStream(iterator) {
  return new ReadableStream({
    /**
     * Called when the consumer wants to pull more data from the stream.
     *
     * @param {ReadableStreamDefaultController<T>} controller - The controller to enqueue data into the stream.
     * @returns {Promise<void>}
     */
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    /**
     * Called when the consumer cancels the stream.
     */
    cancel() {
    }
  });
}
function extractResponseHeaders(response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}
var createIdGenerator = ({
  prefix,
  size: defaultSize = 16,
  alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  separator = "-"
} = {}) => {
  const generator = customAlphabet(alphabet, defaultSize);
  if (prefix == null) {
    return generator;
  }
  if (alphabet.includes(separator)) {
    throw new InvalidArgumentError({
      argument: "separator",
      message: `The separator "${separator}" must not be part of the alphabet "${alphabet}".`
    });
  }
  return (size) => `${prefix}${separator}${generator(size)}`;
};
var generateId = createIdGenerator();
function getErrorMessage2(error) {
  if (error == null) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return JSON.stringify(error);
}
function isAbortError(error) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
function loadApiKey({
  apiKey,
  environmentVariableName,
  apiKeyParameterName = "apiKey",
  description
}) {
  if (typeof apiKey === "string") {
    return apiKey;
  }
  if (apiKey != null) {
    throw new LoadAPIKeyError({
      message: `${description} API key must be a string.`
    });
  }
  if (typeof process === "undefined") {
    throw new LoadAPIKeyError({
      message: `${description} API key is missing. Pass it using the '${apiKeyParameterName}' parameter. Environment variables is not supported in this environment.`
    });
  }
  apiKey = process.env[environmentVariableName];
  if (apiKey == null) {
    throw new LoadAPIKeyError({
      message: `${description} API key is missing. Pass it using the '${apiKeyParameterName}' parameter or the ${environmentVariableName} environment variable.`
    });
  }
  if (typeof apiKey !== "string") {
    throw new LoadAPIKeyError({
      message: `${description} API key must be a string. The value of the ${environmentVariableName} environment variable is not a string.`
    });
  }
  return apiKey;
}
var validatorSymbol = Symbol.for("vercel.ai.validator");
function validator(validate) {
  return { [validatorSymbol]: true, validate };
}
function isValidator(value) {
  return typeof value === "object" && value !== null && validatorSymbol in value && value[validatorSymbol] === true && "validate" in value;
}
function asValidator(value) {
  return isValidator(value) ? value : zodValidator(value);
}
function zodValidator(zodSchema2) {
  return validator((value) => {
    const result = zodSchema2.safeParse(value);
    return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
  });
}
function validateTypes({
  value,
  schema: inputSchema
}) {
  const result = safeValidateTypes({ value, schema: inputSchema });
  if (!result.success) {
    throw TypeValidationError.wrap({ value, cause: result.error });
  }
  return result.value;
}
function safeValidateTypes({
  value,
  schema
}) {
  const validator2 = asValidator(schema);
  try {
    if (validator2.validate == null) {
      return { success: true, value };
    }
    const result = validator2.validate(value);
    if (result.success) {
      return result;
    }
    return {
      success: false,
      error: TypeValidationError.wrap({ value, cause: result.error })
    };
  } catch (error) {
    return {
      success: false,
      error: TypeValidationError.wrap({ value, cause: error })
    };
  }
}
function parseJSON2({
  text,
  schema
}) {
  try {
    const value = import_secure_json_parse.default.parse(text);
    if (schema == null) {
      return value;
    }
    return validateTypes({ value, schema });
  } catch (error) {
    if (JSONParseError.isInstance(error) || TypeValidationError.isInstance(error)) {
      throw error;
    }
    throw new JSONParseError({ text, cause: error });
  }
}
function safeParseJSON({
  text,
  schema
}) {
  try {
    const value = import_secure_json_parse.default.parse(text);
    if (schema == null) {
      return {
        success: true,
        value
      };
    }
    return safeValidateTypes({ value, schema });
  } catch (error) {
    return {
      success: false,
      error: JSONParseError.isInstance(error) ? error : new JSONParseError({ text, cause: error })
    };
  }
}
function isParsableJson(input) {
  try {
    import_secure_json_parse.default.parse(input);
    return true;
  } catch (e) {
    return false;
  }
}
function removeUndefinedEntries(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([_key, value]) => value != null)
  );
}
var getOriginalFetch = () => globalThis.fetch;
var postJsonToApi = async ({
  url,
  headers,
  body,
  failedResponseHandler,
  successfulResponseHandler,
  abortSignal,
  fetch: fetch2
}) => postToApi({
  url,
  headers: {
    "Content-Type": "application/json",
    ...headers
  },
  body: {
    content: JSON.stringify(body),
    values: body
  },
  failedResponseHandler,
  successfulResponseHandler,
  abortSignal,
  fetch: fetch2
});
var postToApi = async ({
  url,
  headers = {},
  body,
  successfulResponseHandler,
  failedResponseHandler,
  abortSignal,
  fetch: fetch2 = getOriginalFetch()
}) => {
  try {
    const response = await fetch2(url, {
      method: "POST",
      headers: removeUndefinedEntries(headers),
      body: body.content,
      signal: abortSignal
    });
    const responseHeaders = extractResponseHeaders(response);
    if (!response.ok) {
      let errorInformation;
      try {
        errorInformation = await failedResponseHandler({
          response,
          url,
          requestBodyValues: body.values
        });
      } catch (error) {
        if (isAbortError(error) || APICallError.isInstance(error)) {
          throw error;
        }
        throw new APICallError({
          message: "Failed to process error response",
          cause: error,
          statusCode: response.status,
          url,
          responseHeaders,
          requestBodyValues: body.values
        });
      }
      throw errorInformation.value;
    }
    try {
      return await successfulResponseHandler({
        response,
        url,
        requestBodyValues: body.values
      });
    } catch (error) {
      if (error instanceof Error) {
        if (isAbortError(error) || APICallError.isInstance(error)) {
          throw error;
        }
      }
      throw new APICallError({
        message: "Failed to process successful response",
        cause: error,
        statusCode: response.status,
        url,
        responseHeaders,
        requestBodyValues: body.values
      });
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof TypeError && error.message === "fetch failed") {
      const cause = error.cause;
      if (cause != null) {
        throw new APICallError({
          message: `Cannot connect to API: ${cause.message}`,
          cause,
          url,
          requestBodyValues: body.values,
          isRetryable: true
          // retry when network error
        });
      }
    }
    throw error;
  }
};
var createJsonErrorResponseHandler = ({
  errorSchema,
  errorToMessage,
  isRetryable
}) => async ({ response, url, requestBodyValues }) => {
  const responseBody = await response.text();
  const responseHeaders = extractResponseHeaders(response);
  if (responseBody.trim() === "") {
    return {
      responseHeaders,
      value: new APICallError({
        message: response.statusText,
        url,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        isRetryable: isRetryable == null ? void 0 : isRetryable(response)
      })
    };
  }
  try {
    const parsedError = parseJSON2({
      text: responseBody,
      schema: errorSchema
    });
    return {
      responseHeaders,
      value: new APICallError({
        message: errorToMessage(parsedError),
        url,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        data: parsedError,
        isRetryable: isRetryable == null ? void 0 : isRetryable(response, parsedError)
      })
    };
  } catch (parseError) {
    return {
      responseHeaders,
      value: new APICallError({
        message: response.statusText,
        url,
        requestBodyValues,
        statusCode: response.status,
        responseHeaders,
        responseBody,
        isRetryable: isRetryable == null ? void 0 : isRetryable(response)
      })
    };
  }
};
var createEventSourceResponseHandler = (chunkSchema) => async ({ response }) => {
  const responseHeaders = extractResponseHeaders(response);
  if (response.body == null) {
    throw new EmptyResponseBodyError({});
  }
  return {
    responseHeaders,
    value: response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).pipeThrough(
      new TransformStream({
        transform({ data }, controller) {
          if (data === "[DONE]") {
            return;
          }
          controller.enqueue(
            safeParseJSON({
              text: data,
              schema: chunkSchema
            })
          );
        }
      })
    )
  };
};
var createJsonResponseHandler = (responseSchema) => async ({ response, url, requestBodyValues }) => {
  const responseBody = await response.text();
  const parsedResult = safeParseJSON({
    text: responseBody,
    schema: responseSchema
  });
  const responseHeaders = extractResponseHeaders(response);
  if (!parsedResult.success) {
    throw new APICallError({
      message: "Invalid JSON response",
      cause: parsedResult.error,
      statusCode: response.status,
      responseHeaders,
      responseBody,
      url,
      requestBodyValues
    });
  }
  return {
    responseHeaders,
    value: parsedResult.value
  };
};
var { btoa, atob } = globalThis;
function convertBase64ToUint8Array(base64String) {
  const base64Url = base64String.replace(/-/g, "+").replace(/_/g, "/");
  const latin1string = atob(base64Url);
  return Uint8Array.from(latin1string, (byte) => byte.codePointAt(0));
}
function convertUint8ArrayToBase64(array) {
  let latin1string = "";
  for (let i = 0; i < array.length; i++) {
    latin1string += String.fromCodePoint(array[i]);
  }
  return btoa(latin1string);
}
function withoutTrailingSlash(url) {
  return url == null ? void 0 : url.replace(/\/$/, "");
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/Options.js
var ignoreOverride = Symbol("Let zodToJsonSchema decide on which parser to use");
var defaultOptions = {
  name: void 0,
  $refStrategy: "root",
  basePath: ["#"],
  effectStrategy: "input",
  pipeStrategy: "all",
  dateStrategy: "format:date-time",
  mapStrategy: "entries",
  removeAdditionalStrategy: "passthrough",
  definitionPath: "definitions",
  target: "jsonSchema7",
  strictUnions: false,
  definitions: {},
  errorMessages: false,
  markdownDescription: false,
  patternStrategy: "escape",
  applyRegexFlags: false,
  emailStrategy: "format:email",
  base64Strategy: "contentEncoding:base64",
  nameStrategy: "ref"
};
var getDefaultOptions = (options) => typeof options === "string" ? {
  ...defaultOptions,
  name: options
} : {
  ...defaultOptions,
  ...options
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/Refs.js
var getRefs = (options) => {
  const _options = getDefaultOptions(options);
  const currentPath = _options.name !== void 0 ? [..._options.basePath, _options.definitionPath, _options.name] : _options.basePath;
  return {
    ..._options,
    currentPath,
    propertyPath: void 0,
    seen: new Map(Object.entries(_options.definitions).map(([name15, def]) => [
      def._def,
      {
        def: def._def,
        path: [..._options.basePath, _options.definitionPath, name15],
        // Resolution of references will be forced even though seen, so it's ok that the schema is undefined here for now.
        jsonSchema: void 0
      }
    ]))
  };
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/errorMessages.js
function addErrorMessage(res, key, errorMessage, refs) {
  if (!refs?.errorMessages)
    return;
  if (errorMessage) {
    res.errorMessage = {
      ...res.errorMessage,
      [key]: errorMessage
    };
  }
}
function setResponseValueAndErrors(res, key, value, errorMessage, refs) {
  res[key] = value;
  addErrorMessage(res, key, errorMessage, refs);
}

// ../../node_modules/.pnpm/zod@3.23.0/node_modules/zod/lib/index.mjs
var util;
(function(util2) {
  util2.assertEqual = (val) => val;
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  get errors() {
    return this.issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
        fieldErrors[sub.path[0]].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var overrideErrorMap = errorMap;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      ctx.schemaErrorMap,
      overrideMap,
      overrideMap === errorMap ? void 0 : errorMap
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;
function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message === null || message === void 0 ? void 0 : message.message;
})(errorUtil || (errorUtil = {}));
var _ZodEnum_cache;
var _ZodNativeEnum_cache;
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (this._key instanceof Array) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    var _a16, _b;
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message !== null && message !== void 0 ? message : ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: (_a16 = message !== null && message !== void 0 ? message : required_error) !== null && _a16 !== void 0 ? _a16 : ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: (_b = message !== null && message !== void 0 ? message : invalid_type_error) !== null && _b !== void 0 ? _b : ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
  }
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    var _a16;
    const ctx = {
      common: {
        issues: [],
        async: (_a16 = params === null || params === void 0 ? void 0 : params.async) !== null && _a16 !== void 0 ? _a16 : false,
        contextualErrorMap: params === null || params === void 0 ? void 0 : params.errorMap
      },
      path: (params === null || params === void 0 ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params === null || params === void 0 ? void 0 : params.errorMap,
        async: true
      },
      path: (params === null || params === void 0 ? void 0 : params.path) || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this, this._def);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6Regex = /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let regex = `([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d`;
  if (args.precision) {
    regex = `${regex}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    regex = `${regex}(\\.\\d+)?`;
  }
  return regex;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch (_a16) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    var _a16, _b;
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof (options === null || options === void 0 ? void 0 : options.precision) === "undefined" ? null : options === null || options === void 0 ? void 0 : options.precision,
      offset: (_a16 = options === null || options === void 0 ? void 0 : options.offset) !== null && _a16 !== void 0 ? _a16 : false,
      local: (_b = options === null || options === void 0 ? void 0 : options.local) !== null && _b !== void 0 ? _b : false,
      ...errorUtil.errToObj(options === null || options === void 0 ? void 0 : options.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof (options === null || options === void 0 ? void 0 : options.precision) === "undefined" ? null : options === null || options === void 0 ? void 0 : options.precision,
      ...errorUtil.errToObj(options === null || options === void 0 ? void 0 : options.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options === null || options === void 0 ? void 0 : options.position,
      ...errorUtil.errToObj(options === null || options === void 0 ? void 0 : options.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * @deprecated Use z.string().min(1) instead.
   * @see {@link ZodString.min}
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  var _a16;
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: (_a16 = params === null || params === void 0 ? void 0 : params.coerce) !== null && _a16 !== void 0 ? _a16 : false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / Math.pow(10, decCount);
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null, min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: (params === null || params === void 0 ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = BigInt(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.bigint,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  var _a16;
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: (_a16 = params === null || params === void 0 ? void 0 : params.coerce) !== null && _a16 !== void 0 ? _a16 : false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: (params === null || params === void 0 ? void 0 : params.coerce) || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: (params === null || params === void 0 ? void 0 : params.coerce) || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    return this._cached = { shape, keys };
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") ;
      else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          var _a16, _b, _c, _d;
          const defaultError = (_c = (_b = (_a16 = this._def).errorMap) === null || _b === void 0 ? void 0 : _b.call(_a16, issue, ctx).message) !== null && _c !== void 0 ? _c : ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: (_d = errorUtil.errToObj(message).message) !== null && _d !== void 0 ? _d : defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    util.objectKeys(mask).forEach((key) => {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    util.objectKeys(this.shape).forEach((key) => {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    util.objectKeys(this.shape).forEach((key) => {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    util.objectKeys(this.shape).forEach((key) => {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    });
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap(),
          errorMap
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [
          ctx.common.contextualErrorMap,
          ctx.schemaErrorMap,
          getErrorMap(),
          errorMap
        ].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  constructor() {
    super(...arguments);
    _ZodEnum_cache.set(this, void 0);
  }
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!__classPrivateFieldGet(this, _ZodEnum_cache, "f")) {
      __classPrivateFieldSet(this, _ZodEnum_cache, new Set(this._def.values), "f");
    }
    if (!__classPrivateFieldGet(this, _ZodEnum_cache, "f").has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
_ZodEnum_cache = /* @__PURE__ */ new WeakMap();
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  constructor() {
    super(...arguments);
    _ZodNativeEnum_cache.set(this, void 0);
  }
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!__classPrivateFieldGet(this, _ZodNativeEnum_cache, "f")) {
      __classPrivateFieldSet(this, _ZodNativeEnum_cache, new Set(util.getValidEnumValues(this._def.values)), "f");
    }
    if (!__classPrivateFieldGet(this, _ZodNativeEnum_cache, "f").has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
_ZodNativeEnum_cache = /* @__PURE__ */ new WeakMap();
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return base;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return base;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({ status: status.value, value: result }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    if (isValid(result)) {
      result.value = Object.freeze(result.value);
    }
    return result;
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function custom(check, params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      var _a16, _b;
      if (!check(data)) {
        const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
        const _fatal = (_b = (_a16 = p.fatal) !== null && _a16 !== void 0 ? _a16 : fatal) !== null && _b !== void 0 ? _b : true;
        const p2 = typeof p === "string" ? { message: p } : p;
        ctx.addIssue({ code: "custom", ...p2, fatal: _fatal });
      }
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: (arg) => ZodString.create({ ...arg, coerce: true }),
  number: (arg) => ZodNumber.create({ ...arg, coerce: true }),
  boolean: (arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  }),
  bigint: (arg) => ZodBigInt.create({ ...arg, coerce: true }),
  date: (arg) => ZodDate.create({ ...arg, coerce: true })
};
var NEVER = INVALID;
var z = /* @__PURE__ */ Object.freeze({
  __proto__: null,
  defaultErrorMap: errorMap,
  setErrorMap,
  getErrorMap,
  makeIssue,
  EMPTY_PATH,
  addIssueToContext,
  ParseStatus,
  INVALID,
  DIRTY,
  OK,
  isAborted,
  isDirty,
  isValid,
  isAsync,
  get util() {
    return util;
  },
  get objectUtil() {
    return objectUtil;
  },
  ZodParsedType,
  getParsedType,
  ZodType,
  datetimeRegex,
  ZodString,
  ZodNumber,
  ZodBigInt,
  ZodBoolean,
  ZodDate,
  ZodSymbol,
  ZodUndefined,
  ZodNull,
  ZodAny,
  ZodUnknown,
  ZodNever,
  ZodVoid,
  ZodArray,
  ZodObject,
  ZodUnion,
  ZodDiscriminatedUnion,
  ZodIntersection,
  ZodTuple,
  ZodRecord,
  ZodMap,
  ZodSet,
  ZodFunction,
  ZodLazy,
  ZodLiteral,
  ZodEnum,
  ZodNativeEnum,
  ZodPromise,
  ZodEffects,
  ZodTransformer: ZodEffects,
  ZodOptional,
  ZodNullable,
  ZodDefault,
  ZodCatch,
  ZodNaN,
  BRAND,
  ZodBranded,
  ZodPipeline,
  ZodReadonly,
  custom,
  Schema: ZodType,
  ZodSchema: ZodType,
  late,
  get ZodFirstPartyTypeKind() {
    return ZodFirstPartyTypeKind;
  },
  coerce,
  any: anyType,
  array: arrayType,
  bigint: bigIntType,
  boolean: booleanType,
  date: dateType,
  discriminatedUnion: discriminatedUnionType,
  effect: effectsType,
  "enum": enumType,
  "function": functionType,
  "instanceof": instanceOfType,
  intersection: intersectionType,
  lazy: lazyType,
  literal: literalType,
  map: mapType,
  nan: nanType,
  nativeEnum: nativeEnumType,
  never: neverType,
  "null": nullType,
  nullable: nullableType,
  number: numberType,
  object: objectType,
  oboolean,
  onumber,
  optional: optionalType,
  ostring,
  pipeline: pipelineType,
  preprocess: preprocessType,
  promise: promiseType,
  record: recordType,
  set: setType,
  strictObject: strictObjectType,
  string: stringType,
  symbol: symbolType,
  transformer: effectsType,
  tuple: tupleType,
  "undefined": undefinedType,
  union: unionType,
  unknown: unknownType,
  "void": voidType,
  NEVER,
  ZodIssueCode,
  quotelessJson,
  ZodError
});

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/any.js
function parseAnyDef() {
  return {};
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/array.js
function parseArrayDef(def, refs) {
  const res = {
    type: "array"
  };
  if (def.type?._def && def.type?._def?.typeName !== ZodFirstPartyTypeKind.ZodAny) {
    res.items = parseDef(def.type._def, {
      ...refs,
      currentPath: [...refs.currentPath, "items"]
    });
  }
  if (def.minLength) {
    setResponseValueAndErrors(res, "minItems", def.minLength.value, def.minLength.message, refs);
  }
  if (def.maxLength) {
    setResponseValueAndErrors(res, "maxItems", def.maxLength.value, def.maxLength.message, refs);
  }
  if (def.exactLength) {
    setResponseValueAndErrors(res, "minItems", def.exactLength.value, def.exactLength.message, refs);
    setResponseValueAndErrors(res, "maxItems", def.exactLength.value, def.exactLength.message, refs);
  }
  return res;
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/bigint.js
function parseBigintDef(def, refs) {
  const res = {
    type: "integer",
    format: "int64"
  };
  if (!def.checks)
    return res;
  for (const check of def.checks) {
    switch (check.kind) {
      case "min":
        if (refs.target === "jsonSchema7") {
          if (check.inclusive) {
            setResponseValueAndErrors(res, "minimum", check.value, check.message, refs);
          } else {
            setResponseValueAndErrors(res, "exclusiveMinimum", check.value, check.message, refs);
          }
        } else {
          if (!check.inclusive) {
            res.exclusiveMinimum = true;
          }
          setResponseValueAndErrors(res, "minimum", check.value, check.message, refs);
        }
        break;
      case "max":
        if (refs.target === "jsonSchema7") {
          if (check.inclusive) {
            setResponseValueAndErrors(res, "maximum", check.value, check.message, refs);
          } else {
            setResponseValueAndErrors(res, "exclusiveMaximum", check.value, check.message, refs);
          }
        } else {
          if (!check.inclusive) {
            res.exclusiveMaximum = true;
          }
          setResponseValueAndErrors(res, "maximum", check.value, check.message, refs);
        }
        break;
      case "multipleOf":
        setResponseValueAndErrors(res, "multipleOf", check.value, check.message, refs);
        break;
    }
  }
  return res;
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/boolean.js
function parseBooleanDef() {
  return {
    type: "boolean"
  };
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/branded.js
function parseBrandedDef(_def, refs) {
  return parseDef(_def.type._def, refs);
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/catch.js
var parseCatchDef = (def, refs) => {
  return parseDef(def.innerType._def, refs);
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/date.js
function parseDateDef(def, refs, overrideDateStrategy) {
  const strategy = overrideDateStrategy ?? refs.dateStrategy;
  if (Array.isArray(strategy)) {
    return {
      anyOf: strategy.map((item, i) => parseDateDef(def, refs, item))
    };
  }
  switch (strategy) {
    case "string":
    case "format:date-time":
      return {
        type: "string",
        format: "date-time"
      };
    case "format:date":
      return {
        type: "string",
        format: "date"
      };
    case "integer":
      return integerDateParser(def, refs);
  }
}
var integerDateParser = (def, refs) => {
  const res = {
    type: "integer",
    format: "unix-time"
  };
  if (refs.target === "openApi3") {
    return res;
  }
  for (const check of def.checks) {
    switch (check.kind) {
      case "min":
        setResponseValueAndErrors(
          res,
          "minimum",
          check.value,
          // This is in milliseconds
          check.message,
          refs
        );
        break;
      case "max":
        setResponseValueAndErrors(
          res,
          "maximum",
          check.value,
          // This is in milliseconds
          check.message,
          refs
        );
        break;
    }
  }
  return res;
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/default.js
function parseDefaultDef(_def, refs) {
  return {
    ...parseDef(_def.innerType._def, refs),
    default: _def.defaultValue()
  };
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/effects.js
function parseEffectsDef(_def, refs) {
  return refs.effectStrategy === "input" ? parseDef(_def.schema._def, refs) : {};
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/enum.js
function parseEnumDef(def) {
  return {
    type: "string",
    enum: def.values
  };
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/intersection.js
var isJsonSchema7AllOfType = (type) => {
  if ("type" in type && type.type === "string")
    return false;
  return "allOf" in type;
};
function parseIntersectionDef(def, refs) {
  const allOf = [
    parseDef(def.left._def, {
      ...refs,
      currentPath: [...refs.currentPath, "allOf", "0"]
    }),
    parseDef(def.right._def, {
      ...refs,
      currentPath: [...refs.currentPath, "allOf", "1"]
    })
  ].filter((x) => !!x);
  let unevaluatedProperties = refs.target === "jsonSchema2019-09" ? { unevaluatedProperties: false } : void 0;
  const mergedAllOf = [];
  allOf.forEach((schema) => {
    if (isJsonSchema7AllOfType(schema)) {
      mergedAllOf.push(...schema.allOf);
      if (schema.unevaluatedProperties === void 0) {
        unevaluatedProperties = void 0;
      }
    } else {
      let nestedSchema = schema;
      if ("additionalProperties" in schema && schema.additionalProperties === false) {
        const { additionalProperties, ...rest } = schema;
        nestedSchema = rest;
      } else {
        unevaluatedProperties = void 0;
      }
      mergedAllOf.push(nestedSchema);
    }
  });
  return mergedAllOf.length ? {
    allOf: mergedAllOf,
    ...unevaluatedProperties
  } : void 0;
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/literal.js
function parseLiteralDef(def, refs) {
  const parsedType = typeof def.value;
  if (parsedType !== "bigint" && parsedType !== "number" && parsedType !== "boolean" && parsedType !== "string") {
    return {
      type: Array.isArray(def.value) ? "array" : "object"
    };
  }
  if (refs.target === "openApi3") {
    return {
      type: parsedType === "bigint" ? "integer" : parsedType,
      enum: [def.value]
    };
  }
  return {
    type: parsedType === "bigint" ? "integer" : parsedType,
    const: def.value
  };
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/string.js
var emojiRegex2;
var zodPatterns = {
  /**
   * `c` was changed to `[cC]` to replicate /i flag
   */
  cuid: /^[cC][^\s-]{8,}$/,
  cuid2: /^[0-9a-z]+$/,
  ulid: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  /**
   * `a-z` was added to replicate /i flag
   */
  email: /^(?!\.)(?!.*\.\.)([a-zA-Z0-9_'+\-\.]*)[a-zA-Z0-9_+-]@([a-zA-Z0-9][a-zA-Z0-9\-]*\.)+[a-zA-Z]{2,}$/,
  /**
   * Constructed a valid Unicode RegExp
   *
   * Lazily instantiate since this type of regex isn't supported
   * in all envs (e.g. React Native).
   *
   * See:
   * https://github.com/colinhacks/zod/issues/2433
   * Fix in Zod:
   * https://github.com/colinhacks/zod/commit/9340fd51e48576a75adc919bff65dbc4a5d4c99b
   */
  emoji: () => {
    if (emojiRegex2 === void 0) {
      emojiRegex2 = RegExp("^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$", "u");
    }
    return emojiRegex2;
  },
  /**
   * Unused
   */
  uuid: /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/,
  /**
   * Unused
   */
  ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,
  /**
   * Unused
   */
  ipv6: /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/,
  base64: /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/,
  nanoid: /^[a-zA-Z0-9_-]{21}$/
};
function parseStringDef(def, refs) {
  const res = {
    type: "string"
  };
  function processPattern(value) {
    return refs.patternStrategy === "escape" ? escapeNonAlphaNumeric(value) : value;
  }
  if (def.checks) {
    for (const check of def.checks) {
      switch (check.kind) {
        case "min":
          setResponseValueAndErrors(res, "minLength", typeof res.minLength === "number" ? Math.max(res.minLength, check.value) : check.value, check.message, refs);
          break;
        case "max":
          setResponseValueAndErrors(res, "maxLength", typeof res.maxLength === "number" ? Math.min(res.maxLength, check.value) : check.value, check.message, refs);
          break;
        case "email":
          switch (refs.emailStrategy) {
            case "format:email":
              addFormat(res, "email", check.message, refs);
              break;
            case "format:idn-email":
              addFormat(res, "idn-email", check.message, refs);
              break;
            case "pattern:zod":
              addPattern(res, zodPatterns.email, check.message, refs);
              break;
          }
          break;
        case "url":
          addFormat(res, "uri", check.message, refs);
          break;
        case "uuid":
          addFormat(res, "uuid", check.message, refs);
          break;
        case "regex":
          addPattern(res, check.regex, check.message, refs);
          break;
        case "cuid":
          addPattern(res, zodPatterns.cuid, check.message, refs);
          break;
        case "cuid2":
          addPattern(res, zodPatterns.cuid2, check.message, refs);
          break;
        case "startsWith":
          addPattern(res, RegExp(`^${processPattern(check.value)}`), check.message, refs);
          break;
        case "endsWith":
          addPattern(res, RegExp(`${processPattern(check.value)}$`), check.message, refs);
          break;
        case "datetime":
          addFormat(res, "date-time", check.message, refs);
          break;
        case "date":
          addFormat(res, "date", check.message, refs);
          break;
        case "time":
          addFormat(res, "time", check.message, refs);
          break;
        case "duration":
          addFormat(res, "duration", check.message, refs);
          break;
        case "length":
          setResponseValueAndErrors(res, "minLength", typeof res.minLength === "number" ? Math.max(res.minLength, check.value) : check.value, check.message, refs);
          setResponseValueAndErrors(res, "maxLength", typeof res.maxLength === "number" ? Math.min(res.maxLength, check.value) : check.value, check.message, refs);
          break;
        case "includes": {
          addPattern(res, RegExp(processPattern(check.value)), check.message, refs);
          break;
        }
        case "ip": {
          if (check.version !== "v6") {
            addFormat(res, "ipv4", check.message, refs);
          }
          if (check.version !== "v4") {
            addFormat(res, "ipv6", check.message, refs);
          }
          break;
        }
        case "emoji":
          addPattern(res, zodPatterns.emoji, check.message, refs);
          break;
        case "ulid": {
          addPattern(res, zodPatterns.ulid, check.message, refs);
          break;
        }
        case "base64": {
          switch (refs.base64Strategy) {
            case "format:binary": {
              addFormat(res, "binary", check.message, refs);
              break;
            }
            case "contentEncoding:base64": {
              setResponseValueAndErrors(res, "contentEncoding", "base64", check.message, refs);
              break;
            }
            case "pattern:zod": {
              addPattern(res, zodPatterns.base64, check.message, refs);
              break;
            }
          }
          break;
        }
        case "nanoid": {
          addPattern(res, zodPatterns.nanoid, check.message, refs);
        }
        case "toLowerCase":
        case "toUpperCase":
        case "trim":
          break;
        default:
          /* @__PURE__ */ ((_) => {
          })(check);
      }
    }
  }
  return res;
}
var escapeNonAlphaNumeric = (value) => Array.from(value).map((c) => /[a-zA-Z0-9]/.test(c) ? c : `\\${c}`).join("");
var addFormat = (schema, value, message, refs) => {
  if (schema.format || schema.anyOf?.some((x) => x.format)) {
    if (!schema.anyOf) {
      schema.anyOf = [];
    }
    if (schema.format) {
      schema.anyOf.push({
        format: schema.format,
        ...schema.errorMessage && refs.errorMessages && {
          errorMessage: { format: schema.errorMessage.format }
        }
      });
      delete schema.format;
      if (schema.errorMessage) {
        delete schema.errorMessage.format;
        if (Object.keys(schema.errorMessage).length === 0) {
          delete schema.errorMessage;
        }
      }
    }
    schema.anyOf.push({
      format: value,
      ...message && refs.errorMessages && { errorMessage: { format: message } }
    });
  } else {
    setResponseValueAndErrors(schema, "format", value, message, refs);
  }
};
var addPattern = (schema, regex, message, refs) => {
  if (schema.pattern || schema.allOf?.some((x) => x.pattern)) {
    if (!schema.allOf) {
      schema.allOf = [];
    }
    if (schema.pattern) {
      schema.allOf.push({
        pattern: schema.pattern,
        ...schema.errorMessage && refs.errorMessages && {
          errorMessage: { pattern: schema.errorMessage.pattern }
        }
      });
      delete schema.pattern;
      if (schema.errorMessage) {
        delete schema.errorMessage.pattern;
        if (Object.keys(schema.errorMessage).length === 0) {
          delete schema.errorMessage;
        }
      }
    }
    schema.allOf.push({
      pattern: processRegExp(regex, refs),
      ...message && refs.errorMessages && { errorMessage: { pattern: message } }
    });
  } else {
    setResponseValueAndErrors(schema, "pattern", processRegExp(regex, refs), message, refs);
  }
};
var processRegExp = (regexOrFunction, refs) => {
  const regex = typeof regexOrFunction === "function" ? regexOrFunction() : regexOrFunction;
  if (!refs.applyRegexFlags || !regex.flags)
    return regex.source;
  const flags = {
    i: regex.flags.includes("i"),
    m: regex.flags.includes("m"),
    s: regex.flags.includes("s")
    // `.` matches newlines
  };
  const source = flags.i ? regex.source.toLowerCase() : regex.source;
  let pattern = "";
  let isEscaped = false;
  let inCharGroup = false;
  let inCharRange = false;
  for (let i = 0; i < source.length; i++) {
    if (isEscaped) {
      pattern += source[i];
      isEscaped = false;
      continue;
    }
    if (flags.i) {
      if (inCharGroup) {
        if (source[i].match(/[a-z]/)) {
          if (inCharRange) {
            pattern += source[i];
            pattern += `${source[i - 2]}-${source[i]}`.toUpperCase();
            inCharRange = false;
          } else if (source[i + 1] === "-" && source[i + 2]?.match(/[a-z]/)) {
            pattern += source[i];
            inCharRange = true;
          } else {
            pattern += `${source[i]}${source[i].toUpperCase()}`;
          }
          continue;
        }
      } else if (source[i].match(/[a-z]/)) {
        pattern += `[${source[i]}${source[i].toUpperCase()}]`;
        continue;
      }
    }
    if (flags.m) {
      if (source[i] === "^") {
        pattern += `(^|(?<=[\r
]))`;
        continue;
      } else if (source[i] === "$") {
        pattern += `($|(?=[\r
]))`;
        continue;
      }
    }
    if (flags.s && source[i] === ".") {
      pattern += inCharGroup ? `${source[i]}\r
` : `[${source[i]}\r
]`;
      continue;
    }
    pattern += source[i];
    if (source[i] === "\\") {
      isEscaped = true;
    } else if (inCharGroup && source[i] === "]") {
      inCharGroup = false;
    } else if (!inCharGroup && source[i] === "[") {
      inCharGroup = true;
    }
  }
  try {
    const regexTest = new RegExp(pattern);
  } catch {
    console.warn(`Could not convert regex pattern at ${refs.currentPath.join("/")} to a flag-independent form! Falling back to the flag-ignorant source`);
    return regex.source;
  }
  return pattern;
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/record.js
function parseRecordDef(def, refs) {
  if (refs.target === "openApi3" && def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodEnum) {
    return {
      type: "object",
      required: def.keyType._def.values,
      properties: def.keyType._def.values.reduce((acc, key) => ({
        ...acc,
        [key]: parseDef(def.valueType._def, {
          ...refs,
          currentPath: [...refs.currentPath, "properties", key]
        }) ?? {}
      }), {}),
      additionalProperties: false
    };
  }
  const schema = {
    type: "object",
    additionalProperties: parseDef(def.valueType._def, {
      ...refs,
      currentPath: [...refs.currentPath, "additionalProperties"]
    }) ?? {}
  };
  if (refs.target === "openApi3") {
    return schema;
  }
  if (def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodString && def.keyType._def.checks?.length) {
    const { type, ...keyType } = parseStringDef(def.keyType._def, refs);
    return {
      ...schema,
      propertyNames: keyType
    };
  } else if (def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodEnum) {
    return {
      ...schema,
      propertyNames: {
        enum: def.keyType._def.values
      }
    };
  } else if (def.keyType?._def.typeName === ZodFirstPartyTypeKind.ZodBranded && def.keyType._def.type._def.typeName === ZodFirstPartyTypeKind.ZodString && def.keyType._def.type._def.checks?.length) {
    const { type, ...keyType } = parseBrandedDef(def.keyType._def, refs);
    return {
      ...schema,
      propertyNames: keyType
    };
  }
  return schema;
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/map.js
function parseMapDef(def, refs) {
  if (refs.mapStrategy === "record") {
    return parseRecordDef(def, refs);
  }
  const keys = parseDef(def.keyType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "items", "items", "0"]
  }) || {};
  const values = parseDef(def.valueType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "items", "items", "1"]
  }) || {};
  return {
    type: "array",
    maxItems: 125,
    items: {
      type: "array",
      items: [keys, values],
      minItems: 2,
      maxItems: 2
    }
  };
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/nativeEnum.js
function parseNativeEnumDef(def) {
  const object = def.values;
  const actualKeys = Object.keys(def.values).filter((key) => {
    return typeof object[object[key]] !== "number";
  });
  const actualValues = actualKeys.map((key) => object[key]);
  const parsedTypes = Array.from(new Set(actualValues.map((values) => typeof values)));
  return {
    type: parsedTypes.length === 1 ? parsedTypes[0] === "string" ? "string" : "number" : ["string", "number"],
    enum: actualValues
  };
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/never.js
function parseNeverDef() {
  return {
    not: {}
  };
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/null.js
function parseNullDef(refs) {
  return refs.target === "openApi3" ? {
    enum: ["null"],
    nullable: true
  } : {
    type: "null"
  };
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/union.js
var primitiveMappings = {
  ZodString: "string",
  ZodNumber: "number",
  ZodBigInt: "integer",
  ZodBoolean: "boolean",
  ZodNull: "null"
};
function parseUnionDef(def, refs) {
  if (refs.target === "openApi3")
    return asAnyOf(def, refs);
  const options = def.options instanceof Map ? Array.from(def.options.values()) : def.options;
  if (options.every((x) => x._def.typeName in primitiveMappings && (!x._def.checks || !x._def.checks.length))) {
    const types = options.reduce((types2, x) => {
      const type = primitiveMappings[x._def.typeName];
      return type && !types2.includes(type) ? [...types2, type] : types2;
    }, []);
    return {
      type: types.length > 1 ? types : types[0]
    };
  } else if (options.every((x) => x._def.typeName === "ZodLiteral" && !x.description)) {
    const types = options.reduce((acc, x) => {
      const type = typeof x._def.value;
      switch (type) {
        case "string":
        case "number":
        case "boolean":
          return [...acc, type];
        case "bigint":
          return [...acc, "integer"];
        case "object":
          if (x._def.value === null)
            return [...acc, "null"];
        case "symbol":
        case "undefined":
        case "function":
        default:
          return acc;
      }
    }, []);
    if (types.length === options.length) {
      const uniqueTypes = types.filter((x, i, a) => a.indexOf(x) === i);
      return {
        type: uniqueTypes.length > 1 ? uniqueTypes : uniqueTypes[0],
        enum: options.reduce((acc, x) => {
          return acc.includes(x._def.value) ? acc : [...acc, x._def.value];
        }, [])
      };
    }
  } else if (options.every((x) => x._def.typeName === "ZodEnum")) {
    return {
      type: "string",
      enum: options.reduce((acc, x) => [
        ...acc,
        ...x._def.values.filter((x2) => !acc.includes(x2))
      ], [])
    };
  }
  return asAnyOf(def, refs);
}
var asAnyOf = (def, refs) => {
  const anyOf = (def.options instanceof Map ? Array.from(def.options.values()) : def.options).map((x, i) => parseDef(x._def, {
    ...refs,
    currentPath: [...refs.currentPath, "anyOf", `${i}`]
  })).filter((x) => !!x && (!refs.strictUnions || typeof x === "object" && Object.keys(x).length > 0));
  return anyOf.length ? { anyOf } : void 0;
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/nullable.js
function parseNullableDef(def, refs) {
  if (["ZodString", "ZodNumber", "ZodBigInt", "ZodBoolean", "ZodNull"].includes(def.innerType._def.typeName) && (!def.innerType._def.checks || !def.innerType._def.checks.length)) {
    if (refs.target === "openApi3") {
      return {
        type: primitiveMappings[def.innerType._def.typeName],
        nullable: true
      };
    }
    return {
      type: [
        primitiveMappings[def.innerType._def.typeName],
        "null"
      ]
    };
  }
  if (refs.target === "openApi3") {
    const base2 = parseDef(def.innerType._def, {
      ...refs,
      currentPath: [...refs.currentPath]
    });
    if (base2 && "$ref" in base2)
      return { allOf: [base2], nullable: true };
    return base2 && { ...base2, nullable: true };
  }
  const base = parseDef(def.innerType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "anyOf", "0"]
  });
  return base && { anyOf: [base, { type: "null" }] };
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/number.js
function parseNumberDef(def, refs) {
  const res = {
    type: "number"
  };
  if (!def.checks)
    return res;
  for (const check of def.checks) {
    switch (check.kind) {
      case "int":
        res.type = "integer";
        addErrorMessage(res, "type", check.message, refs);
        break;
      case "min":
        if (refs.target === "jsonSchema7") {
          if (check.inclusive) {
            setResponseValueAndErrors(res, "minimum", check.value, check.message, refs);
          } else {
            setResponseValueAndErrors(res, "exclusiveMinimum", check.value, check.message, refs);
          }
        } else {
          if (!check.inclusive) {
            res.exclusiveMinimum = true;
          }
          setResponseValueAndErrors(res, "minimum", check.value, check.message, refs);
        }
        break;
      case "max":
        if (refs.target === "jsonSchema7") {
          if (check.inclusive) {
            setResponseValueAndErrors(res, "maximum", check.value, check.message, refs);
          } else {
            setResponseValueAndErrors(res, "exclusiveMaximum", check.value, check.message, refs);
          }
        } else {
          if (!check.inclusive) {
            res.exclusiveMaximum = true;
          }
          setResponseValueAndErrors(res, "maximum", check.value, check.message, refs);
        }
        break;
      case "multipleOf":
        setResponseValueAndErrors(res, "multipleOf", check.value, check.message, refs);
        break;
    }
  }
  return res;
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/object.js
function decideAdditionalProperties(def, refs) {
  if (refs.removeAdditionalStrategy === "strict") {
    return def.catchall._def.typeName === "ZodNever" ? def.unknownKeys !== "strict" : parseDef(def.catchall._def, {
      ...refs,
      currentPath: [...refs.currentPath, "additionalProperties"]
    }) ?? true;
  } else {
    return def.catchall._def.typeName === "ZodNever" ? def.unknownKeys === "passthrough" : parseDef(def.catchall._def, {
      ...refs,
      currentPath: [...refs.currentPath, "additionalProperties"]
    }) ?? true;
  }
}
function parseObjectDef(def, refs) {
  const result = {
    type: "object",
    ...Object.entries(def.shape()).reduce((acc, [propName, propDef]) => {
      if (propDef === void 0 || propDef._def === void 0)
        return acc;
      const parsedDef = parseDef(propDef._def, {
        ...refs,
        currentPath: [...refs.currentPath, "properties", propName],
        propertyPath: [...refs.currentPath, "properties", propName]
      });
      if (parsedDef === void 0)
        return acc;
      return {
        properties: { ...acc.properties, [propName]: parsedDef },
        required: propDef.isOptional() ? acc.required : [...acc.required, propName]
      };
    }, { properties: {}, required: [] }),
    additionalProperties: decideAdditionalProperties(def, refs)
  };
  if (!result.required.length)
    delete result.required;
  return result;
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/optional.js
var parseOptionalDef = (def, refs) => {
  if (refs.currentPath.toString() === refs.propertyPath?.toString()) {
    return parseDef(def.innerType._def, refs);
  }
  const innerSchema = parseDef(def.innerType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "anyOf", "1"]
  });
  return innerSchema ? {
    anyOf: [
      {
        not: {}
      },
      innerSchema
    ]
  } : {};
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/pipeline.js
var parsePipelineDef = (def, refs) => {
  if (refs.pipeStrategy === "input") {
    return parseDef(def.in._def, refs);
  } else if (refs.pipeStrategy === "output") {
    return parseDef(def.out._def, refs);
  }
  const a = parseDef(def.in._def, {
    ...refs,
    currentPath: [...refs.currentPath, "allOf", "0"]
  });
  const b = parseDef(def.out._def, {
    ...refs,
    currentPath: [...refs.currentPath, "allOf", a ? "1" : "0"]
  });
  return {
    allOf: [a, b].filter((x) => x !== void 0)
  };
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/promise.js
function parsePromiseDef(def, refs) {
  return parseDef(def.type._def, refs);
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/set.js
function parseSetDef(def, refs) {
  const items = parseDef(def.valueType._def, {
    ...refs,
    currentPath: [...refs.currentPath, "items"]
  });
  const schema = {
    type: "array",
    uniqueItems: true,
    items
  };
  if (def.minSize) {
    setResponseValueAndErrors(schema, "minItems", def.minSize.value, def.minSize.message, refs);
  }
  if (def.maxSize) {
    setResponseValueAndErrors(schema, "maxItems", def.maxSize.value, def.maxSize.message, refs);
  }
  return schema;
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/tuple.js
function parseTupleDef(def, refs) {
  if (def.rest) {
    return {
      type: "array",
      minItems: def.items.length,
      items: def.items.map((x, i) => parseDef(x._def, {
        ...refs,
        currentPath: [...refs.currentPath, "items", `${i}`]
      })).reduce((acc, x) => x === void 0 ? acc : [...acc, x], []),
      additionalItems: parseDef(def.rest._def, {
        ...refs,
        currentPath: [...refs.currentPath, "additionalItems"]
      })
    };
  } else {
    return {
      type: "array",
      minItems: def.items.length,
      maxItems: def.items.length,
      items: def.items.map((x, i) => parseDef(x._def, {
        ...refs,
        currentPath: [...refs.currentPath, "items", `${i}`]
      })).reduce((acc, x) => x === void 0 ? acc : [...acc, x], [])
    };
  }
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/undefined.js
function parseUndefinedDef() {
  return {
    not: {}
  };
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/unknown.js
function parseUnknownDef() {
  return {};
}

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parsers/readonly.js
var parseReadonlyDef = (def, refs) => {
  return parseDef(def.innerType._def, refs);
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/parseDef.js
function parseDef(def, refs, forceResolution = false) {
  const seenItem = refs.seen.get(def);
  if (refs.override) {
    const overrideResult = refs.override?.(def, refs, seenItem, forceResolution);
    if (overrideResult !== ignoreOverride) {
      return overrideResult;
    }
  }
  if (seenItem && !forceResolution) {
    const seenSchema = get$ref(seenItem, refs);
    if (seenSchema !== void 0) {
      return seenSchema;
    }
  }
  const newItem = { def, path: refs.currentPath, jsonSchema: void 0 };
  refs.seen.set(def, newItem);
  const jsonSchema2 = selectParser(def, def.typeName, refs);
  if (jsonSchema2) {
    addMeta(def, refs, jsonSchema2);
  }
  newItem.jsonSchema = jsonSchema2;
  return jsonSchema2;
}
var get$ref = (item, refs) => {
  switch (refs.$refStrategy) {
    case "root":
      return { $ref: item.path.join("/") };
    case "relative":
      return { $ref: getRelativePath(refs.currentPath, item.path) };
    case "none":
    case "seen": {
      if (item.path.length < refs.currentPath.length && item.path.every((value, index) => refs.currentPath[index] === value)) {
        console.warn(`Recursive reference detected at ${refs.currentPath.join("/")}! Defaulting to any`);
        return {};
      }
      return refs.$refStrategy === "seen" ? {} : void 0;
    }
  }
};
var getRelativePath = (pathA, pathB) => {
  let i = 0;
  for (; i < pathA.length && i < pathB.length; i++) {
    if (pathA[i] !== pathB[i])
      break;
  }
  return [(pathA.length - i).toString(), ...pathB.slice(i)].join("/");
};
var selectParser = (def, typeName, refs) => {
  switch (typeName) {
    case ZodFirstPartyTypeKind.ZodString:
      return parseStringDef(def, refs);
    case ZodFirstPartyTypeKind.ZodNumber:
      return parseNumberDef(def, refs);
    case ZodFirstPartyTypeKind.ZodObject:
      return parseObjectDef(def, refs);
    case ZodFirstPartyTypeKind.ZodBigInt:
      return parseBigintDef(def, refs);
    case ZodFirstPartyTypeKind.ZodBoolean:
      return parseBooleanDef();
    case ZodFirstPartyTypeKind.ZodDate:
      return parseDateDef(def, refs);
    case ZodFirstPartyTypeKind.ZodUndefined:
      return parseUndefinedDef();
    case ZodFirstPartyTypeKind.ZodNull:
      return parseNullDef(refs);
    case ZodFirstPartyTypeKind.ZodArray:
      return parseArrayDef(def, refs);
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return parseUnionDef(def, refs);
    case ZodFirstPartyTypeKind.ZodIntersection:
      return parseIntersectionDef(def, refs);
    case ZodFirstPartyTypeKind.ZodTuple:
      return parseTupleDef(def, refs);
    case ZodFirstPartyTypeKind.ZodRecord:
      return parseRecordDef(def, refs);
    case ZodFirstPartyTypeKind.ZodLiteral:
      return parseLiteralDef(def, refs);
    case ZodFirstPartyTypeKind.ZodEnum:
      return parseEnumDef(def);
    case ZodFirstPartyTypeKind.ZodNativeEnum:
      return parseNativeEnumDef(def);
    case ZodFirstPartyTypeKind.ZodNullable:
      return parseNullableDef(def, refs);
    case ZodFirstPartyTypeKind.ZodOptional:
      return parseOptionalDef(def, refs);
    case ZodFirstPartyTypeKind.ZodMap:
      return parseMapDef(def, refs);
    case ZodFirstPartyTypeKind.ZodSet:
      return parseSetDef(def, refs);
    case ZodFirstPartyTypeKind.ZodLazy:
      return parseDef(def.getter()._def, refs);
    case ZodFirstPartyTypeKind.ZodPromise:
      return parsePromiseDef(def, refs);
    case ZodFirstPartyTypeKind.ZodNaN:
    case ZodFirstPartyTypeKind.ZodNever:
      return parseNeverDef();
    case ZodFirstPartyTypeKind.ZodEffects:
      return parseEffectsDef(def, refs);
    case ZodFirstPartyTypeKind.ZodAny:
      return parseAnyDef();
    case ZodFirstPartyTypeKind.ZodUnknown:
      return parseUnknownDef();
    case ZodFirstPartyTypeKind.ZodDefault:
      return parseDefaultDef(def, refs);
    case ZodFirstPartyTypeKind.ZodBranded:
      return parseBrandedDef(def, refs);
    case ZodFirstPartyTypeKind.ZodReadonly:
      return parseReadonlyDef(def, refs);
    case ZodFirstPartyTypeKind.ZodCatch:
      return parseCatchDef(def, refs);
    case ZodFirstPartyTypeKind.ZodPipeline:
      return parsePipelineDef(def, refs);
    case ZodFirstPartyTypeKind.ZodFunction:
    case ZodFirstPartyTypeKind.ZodVoid:
    case ZodFirstPartyTypeKind.ZodSymbol:
      return void 0;
    default:
      return /* @__PURE__ */ ((_) => void 0)(typeName);
  }
};
var addMeta = (def, refs, jsonSchema2) => {
  if (def.description) {
    jsonSchema2.description = def.description;
    if (refs.markdownDescription) {
      jsonSchema2.markdownDescription = def.description;
    }
  }
  return jsonSchema2;
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/zodToJsonSchema.js
var zodToJsonSchema = (schema, options) => {
  const refs = getRefs(options);
  const definitions = typeof options === "object" && options.definitions ? Object.entries(options.definitions).reduce((acc, [name16, schema2]) => ({
    ...acc,
    [name16]: parseDef(schema2._def, {
      ...refs,
      currentPath: [...refs.basePath, refs.definitionPath, name16]
    }, true) ?? {}
  }), {}) : void 0;
  const name15 = typeof options === "string" ? options : options?.nameStrategy === "title" ? void 0 : options?.name;
  const main = parseDef(schema._def, name15 === void 0 ? refs : {
    ...refs,
    currentPath: [...refs.basePath, refs.definitionPath, name15]
  }, false) ?? {};
  const title = typeof options === "object" && options.name !== void 0 && options.nameStrategy === "title" ? options.name : void 0;
  if (title !== void 0) {
    main.title = title;
  }
  const combined = name15 === void 0 ? definitions ? {
    ...main,
    [refs.definitionPath]: definitions
  } : main : {
    $ref: [
      ...refs.$refStrategy === "relative" ? [] : refs.basePath,
      refs.definitionPath,
      name15
    ].join("/"),
    [refs.definitionPath]: {
      ...definitions,
      [name15]: main
    }
  };
  if (refs.target === "jsonSchema7") {
    combined.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (refs.target === "jsonSchema2019-09") {
    combined.$schema = "https://json-schema.org/draft/2019-09/schema#";
  }
  return combined;
};

// ../../node_modules/.pnpm/zod-to-json-schema@3.23.5_zod@3.23.0/node_modules/zod-to-json-schema/dist/esm/index.js
var esm_default = zodToJsonSchema;

// ../../node_modules/.pnpm/@ai-sdk+ui-utils@1.0.0_zod@3.23.0/node_modules/@ai-sdk/ui-utils/dist/index.mjs
var textStreamPart = {
  code: "0",
  name: "text",
  parse: (value) => {
    if (typeof value !== "string") {
      throw new Error('"text" parts expect a string value.');
    }
    return { type: "text", value };
  }
};
var errorStreamPart = {
  code: "3",
  name: "error",
  parse: (value) => {
    if (typeof value !== "string") {
      throw new Error('"error" parts expect a string value.');
    }
    return { type: "error", value };
  }
};
var assistantMessageStreamPart = {
  code: "4",
  name: "assistant_message",
  parse: (value) => {
    if (value == null || typeof value !== "object" || !("id" in value) || !("role" in value) || !("content" in value) || typeof value.id !== "string" || typeof value.role !== "string" || value.role !== "assistant" || !Array.isArray(value.content) || !value.content.every(
      (item) => item != null && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && item.text != null && typeof item.text === "object" && "value" in item.text && typeof item.text.value === "string"
    )) {
      throw new Error(
        '"assistant_message" parts expect an object with an "id", "role", and "content" property.'
      );
    }
    return {
      type: "assistant_message",
      value
    };
  }
};
var assistantControlDataStreamPart = {
  code: "5",
  name: "assistant_control_data",
  parse: (value) => {
    if (value == null || typeof value !== "object" || !("threadId" in value) || !("messageId" in value) || typeof value.threadId !== "string" || typeof value.messageId !== "string") {
      throw new Error(
        '"assistant_control_data" parts expect an object with a "threadId" and "messageId" property.'
      );
    }
    return {
      type: "assistant_control_data",
      value: {
        threadId: value.threadId,
        messageId: value.messageId
      }
    };
  }
};
var dataMessageStreamPart = {
  code: "6",
  name: "data_message",
  parse: (value) => {
    if (value == null || typeof value !== "object" || !("role" in value) || !("data" in value) || typeof value.role !== "string" || value.role !== "data") {
      throw new Error(
        '"data_message" parts expect an object with a "role" and "data" property.'
      );
    }
    return {
      type: "data_message",
      value
    };
  }
};
var assistantStreamParts = [
  textStreamPart,
  errorStreamPart,
  assistantMessageStreamPart,
  assistantControlDataStreamPart,
  dataMessageStreamPart
];
var assistantStreamPartsByCode = {
  [textStreamPart.code]: textStreamPart,
  [errorStreamPart.code]: errorStreamPart,
  [assistantMessageStreamPart.code]: assistantMessageStreamPart,
  [assistantControlDataStreamPart.code]: assistantControlDataStreamPart,
  [dataMessageStreamPart.code]: dataMessageStreamPart
};
var StreamStringPrefixes = {
  [textStreamPart.name]: textStreamPart.code,
  [errorStreamPart.name]: errorStreamPart.code,
  [assistantMessageStreamPart.name]: assistantMessageStreamPart.code,
  [assistantControlDataStreamPart.name]: assistantControlDataStreamPart.code,
  [dataMessageStreamPart.name]: dataMessageStreamPart.code
};
var validCodes = assistantStreamParts.map((part) => part.code);
var textStreamPart2 = {
  code: "0",
  name: "text",
  parse: (value) => {
    if (typeof value !== "string") {
      throw new Error('"text" parts expect a string value.');
    }
    return { type: "text", value };
  }
};
var dataStreamPart = {
  code: "2",
  name: "data",
  parse: (value) => {
    if (!Array.isArray(value)) {
      throw new Error('"data" parts expect an array value.');
    }
    return { type: "data", value };
  }
};
var errorStreamPart2 = {
  code: "3",
  name: "error",
  parse: (value) => {
    if (typeof value !== "string") {
      throw new Error('"error" parts expect a string value.');
    }
    return { type: "error", value };
  }
};
var messageAnnotationsStreamPart = {
  code: "8",
  name: "message_annotations",
  parse: (value) => {
    if (!Array.isArray(value)) {
      throw new Error('"message_annotations" parts expect an array value.');
    }
    return { type: "message_annotations", value };
  }
};
var toolCallStreamPart = {
  code: "9",
  name: "tool_call",
  parse: (value) => {
    if (value == null || typeof value !== "object" || !("toolCallId" in value) || typeof value.toolCallId !== "string" || !("toolName" in value) || typeof value.toolName !== "string" || !("args" in value) || typeof value.args !== "object") {
      throw new Error(
        '"tool_call" parts expect an object with a "toolCallId", "toolName", and "args" property.'
      );
    }
    return {
      type: "tool_call",
      value
    };
  }
};
var toolResultStreamPart = {
  code: "a",
  name: "tool_result",
  parse: (value) => {
    if (value == null || typeof value !== "object" || !("toolCallId" in value) || typeof value.toolCallId !== "string" || !("result" in value)) {
      throw new Error(
        '"tool_result" parts expect an object with a "toolCallId" and a "result" property.'
      );
    }
    return {
      type: "tool_result",
      value
    };
  }
};
var toolCallStreamingStartStreamPart = {
  code: "b",
  name: "tool_call_streaming_start",
  parse: (value) => {
    if (value == null || typeof value !== "object" || !("toolCallId" in value) || typeof value.toolCallId !== "string" || !("toolName" in value) || typeof value.toolName !== "string") {
      throw new Error(
        '"tool_call_streaming_start" parts expect an object with a "toolCallId" and "toolName" property.'
      );
    }
    return {
      type: "tool_call_streaming_start",
      value
    };
  }
};
var toolCallDeltaStreamPart = {
  code: "c",
  name: "tool_call_delta",
  parse: (value) => {
    if (value == null || typeof value !== "object" || !("toolCallId" in value) || typeof value.toolCallId !== "string" || !("argsTextDelta" in value) || typeof value.argsTextDelta !== "string") {
      throw new Error(
        '"tool_call_delta" parts expect an object with a "toolCallId" and "argsTextDelta" property.'
      );
    }
    return {
      type: "tool_call_delta",
      value
    };
  }
};
var finishMessageStreamPart = {
  code: "d",
  name: "finish_message",
  parse: (value) => {
    if (value == null || typeof value !== "object" || !("finishReason" in value) || typeof value.finishReason !== "string") {
      throw new Error(
        '"finish_message" parts expect an object with a "finishReason" property.'
      );
    }
    const result = {
      finishReason: value.finishReason
    };
    if ("usage" in value && value.usage != null && typeof value.usage === "object" && "promptTokens" in value.usage && "completionTokens" in value.usage) {
      result.usage = {
        promptTokens: typeof value.usage.promptTokens === "number" ? value.usage.promptTokens : Number.NaN,
        completionTokens: typeof value.usage.completionTokens === "number" ? value.usage.completionTokens : Number.NaN
      };
    }
    return {
      type: "finish_message",
      value: result
    };
  }
};
var finishStepStreamPart = {
  code: "e",
  name: "finish_step",
  parse: (value) => {
    if (value == null || typeof value !== "object" || !("finishReason" in value) || typeof value.finishReason !== "string") {
      throw new Error(
        '"finish_step" parts expect an object with a "finishReason" property.'
      );
    }
    const result = {
      finishReason: value.finishReason,
      isContinued: false
    };
    if ("usage" in value && value.usage != null && typeof value.usage === "object" && "promptTokens" in value.usage && "completionTokens" in value.usage) {
      result.usage = {
        promptTokens: typeof value.usage.promptTokens === "number" ? value.usage.promptTokens : Number.NaN,
        completionTokens: typeof value.usage.completionTokens === "number" ? value.usage.completionTokens : Number.NaN
      };
    }
    if ("isContinued" in value && typeof value.isContinued === "boolean") {
      result.isContinued = value.isContinued;
    }
    return {
      type: "finish_step",
      value: result
    };
  }
};
var dataStreamParts = [
  textStreamPart2,
  dataStreamPart,
  errorStreamPart2,
  messageAnnotationsStreamPart,
  toolCallStreamPart,
  toolResultStreamPart,
  toolCallStreamingStartStreamPart,
  toolCallDeltaStreamPart,
  finishMessageStreamPart,
  finishStepStreamPart
];
var dataStreamPartsByCode = {
  [textStreamPart2.code]: textStreamPart2,
  [dataStreamPart.code]: dataStreamPart,
  [errorStreamPart2.code]: errorStreamPart2,
  [messageAnnotationsStreamPart.code]: messageAnnotationsStreamPart,
  [toolCallStreamPart.code]: toolCallStreamPart,
  [toolResultStreamPart.code]: toolResultStreamPart,
  [toolCallStreamingStartStreamPart.code]: toolCallStreamingStartStreamPart,
  [toolCallDeltaStreamPart.code]: toolCallDeltaStreamPart,
  [finishMessageStreamPart.code]: finishMessageStreamPart,
  [finishStepStreamPart.code]: finishStepStreamPart
};
var DataStreamStringPrefixes = {
  [textStreamPart2.name]: textStreamPart2.code,
  [dataStreamPart.name]: dataStreamPart.code,
  [errorStreamPart2.name]: errorStreamPart2.code,
  [messageAnnotationsStreamPart.name]: messageAnnotationsStreamPart.code,
  [toolCallStreamPart.name]: toolCallStreamPart.code,
  [toolResultStreamPart.name]: toolResultStreamPart.code,
  [toolCallStreamingStartStreamPart.name]: toolCallStreamingStartStreamPart.code,
  [toolCallDeltaStreamPart.name]: toolCallDeltaStreamPart.code,
  [finishMessageStreamPart.name]: finishMessageStreamPart.code,
  [finishStepStreamPart.name]: finishStepStreamPart.code
};
var validCodes2 = dataStreamParts.map((part) => part.code);
function formatDataStreamPart(type, value) {
  const streamPart = dataStreamParts.find((part) => part.name === type);
  if (!streamPart) {
    throw new Error(`Invalid stream part type: ${type}`);
  }
  return `${streamPart.code}:${JSON.stringify(value)}
`;
}
var NEWLINE = "\n".charCodeAt(0);
var NEWLINE2 = "\n".charCodeAt(0);
var schemaSymbol = Symbol.for("vercel.ai.schema");
function jsonSchema(jsonSchema2, {
  validate
} = {}) {
  return {
    [schemaSymbol]: true,
    _type: void 0,
    // should never be used directly
    [validatorSymbol]: true,
    jsonSchema: jsonSchema2,
    validate
  };
}
function isSchema(value) {
  return typeof value === "object" && value !== null && schemaSymbol in value && value[schemaSymbol] === true && "jsonSchema" in value && "validate" in value;
}
function asSchema(schema) {
  return isSchema(schema) ? schema : zodSchema(schema);
}
function zodSchema(zodSchema2) {
  return jsonSchema(
    // we assume that zodToJsonSchema will return a valid JSONSchema7:
    esm_default(zodSchema2),
    {
      validate: (value) => {
        const result = zodSchema2.safeParse(value);
        return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
      }
    }
  );
}

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/platform/node/globalThis.js
var _globalThis = typeof globalThis === "object" ? globalThis : global;

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/version.js
var VERSION = "1.9.0";

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/internal/semver.js
var re = /^(\d+)\.(\d+)\.(\d+)(-(.+))?$/;
function _makeCompatibilityCheck(ownVersion) {
  var acceptedVersions = /* @__PURE__ */ new Set([ownVersion]);
  var rejectedVersions = /* @__PURE__ */ new Set();
  var myVersionMatch = ownVersion.match(re);
  if (!myVersionMatch) {
    return function() {
      return false;
    };
  }
  var ownVersionParsed = {
    major: +myVersionMatch[1],
    minor: +myVersionMatch[2],
    patch: +myVersionMatch[3],
    prerelease: myVersionMatch[4]
  };
  if (ownVersionParsed.prerelease != null) {
    return function isExactmatch(globalVersion) {
      return globalVersion === ownVersion;
    };
  }
  function _reject(v) {
    rejectedVersions.add(v);
    return false;
  }
  function _accept(v) {
    acceptedVersions.add(v);
    return true;
  }
  return function isCompatible2(globalVersion) {
    if (acceptedVersions.has(globalVersion)) {
      return true;
    }
    if (rejectedVersions.has(globalVersion)) {
      return false;
    }
    var globalVersionMatch = globalVersion.match(re);
    if (!globalVersionMatch) {
      return _reject(globalVersion);
    }
    var globalVersionParsed = {
      major: +globalVersionMatch[1],
      minor: +globalVersionMatch[2],
      patch: +globalVersionMatch[3],
      prerelease: globalVersionMatch[4]
    };
    if (globalVersionParsed.prerelease != null) {
      return _reject(globalVersion);
    }
    if (ownVersionParsed.major !== globalVersionParsed.major) {
      return _reject(globalVersion);
    }
    if (ownVersionParsed.major === 0) {
      if (ownVersionParsed.minor === globalVersionParsed.minor && ownVersionParsed.patch <= globalVersionParsed.patch) {
        return _accept(globalVersion);
      }
      return _reject(globalVersion);
    }
    if (ownVersionParsed.minor <= globalVersionParsed.minor) {
      return _accept(globalVersion);
    }
    return _reject(globalVersion);
  };
}
var isCompatible = _makeCompatibilityCheck(VERSION);

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/internal/global-utils.js
var major = VERSION.split(".")[0];
var GLOBAL_OPENTELEMETRY_API_KEY = Symbol.for("opentelemetry.js.api." + major);
var _global = _globalThis;
function registerGlobal(type, instance, diag, allowOverride) {
  var _a16;
  if (allowOverride === void 0) {
    allowOverride = false;
  }
  var api = _global[GLOBAL_OPENTELEMETRY_API_KEY] = (_a16 = _global[GLOBAL_OPENTELEMETRY_API_KEY]) !== null && _a16 !== void 0 ? _a16 : {
    version: VERSION
  };
  if (!allowOverride && api[type]) {
    var err = new Error("@opentelemetry/api: Attempted duplicate registration of API: " + type);
    diag.error(err.stack || err.message);
    return false;
  }
  if (api.version !== VERSION) {
    var err = new Error("@opentelemetry/api: Registration of version v" + api.version + " for " + type + " does not match previously registered API v" + VERSION);
    diag.error(err.stack || err.message);
    return false;
  }
  api[type] = instance;
  diag.debug("@opentelemetry/api: Registered a global for " + type + " v" + VERSION + ".");
  return true;
}
function getGlobal(type) {
  var _a16, _b;
  var globalVersion = (_a16 = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _a16 === void 0 ? void 0 : _a16.version;
  if (!globalVersion || !isCompatible(globalVersion)) {
    return;
  }
  return (_b = _global[GLOBAL_OPENTELEMETRY_API_KEY]) === null || _b === void 0 ? void 0 : _b[type];
}
function unregisterGlobal(type, diag) {
  diag.debug("@opentelemetry/api: Unregistering a global for " + type + " v" + VERSION + ".");
  var api = _global[GLOBAL_OPENTELEMETRY_API_KEY];
  if (api) {
    delete api[type];
  }
}

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/diag/ComponentLogger.js
var __read = function(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
};
var __spreadArray = function(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
    if (ar || !(i in from)) {
      if (!ar) ar = Array.prototype.slice.call(from, 0, i);
      ar[i] = from[i];
    }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
};
var DiagComponentLogger = (
  /** @class */
  function() {
    function DiagComponentLogger2(props) {
      this._namespace = props.namespace || "DiagComponentLogger";
    }
    DiagComponentLogger2.prototype.debug = function() {
      var args = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
      }
      return logProxy("debug", this._namespace, args);
    };
    DiagComponentLogger2.prototype.error = function() {
      var args = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
      }
      return logProxy("error", this._namespace, args);
    };
    DiagComponentLogger2.prototype.info = function() {
      var args = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
      }
      return logProxy("info", this._namespace, args);
    };
    DiagComponentLogger2.prototype.warn = function() {
      var args = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
      }
      return logProxy("warn", this._namespace, args);
    };
    DiagComponentLogger2.prototype.verbose = function() {
      var args = [];
      for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
      }
      return logProxy("verbose", this._namespace, args);
    };
    return DiagComponentLogger2;
  }()
);
function logProxy(funcName, namespace, args) {
  var logger = getGlobal("diag");
  if (!logger) {
    return;
  }
  args.unshift(namespace);
  return logger[funcName].apply(logger, __spreadArray([], __read(args), false));
}

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/diag/types.js
var DiagLogLevel;
(function(DiagLogLevel2) {
  DiagLogLevel2[DiagLogLevel2["NONE"] = 0] = "NONE";
  DiagLogLevel2[DiagLogLevel2["ERROR"] = 30] = "ERROR";
  DiagLogLevel2[DiagLogLevel2["WARN"] = 50] = "WARN";
  DiagLogLevel2[DiagLogLevel2["INFO"] = 60] = "INFO";
  DiagLogLevel2[DiagLogLevel2["DEBUG"] = 70] = "DEBUG";
  DiagLogLevel2[DiagLogLevel2["VERBOSE"] = 80] = "VERBOSE";
  DiagLogLevel2[DiagLogLevel2["ALL"] = 9999] = "ALL";
})(DiagLogLevel || (DiagLogLevel = {}));

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/diag/internal/logLevelLogger.js
function createLogLevelDiagLogger(maxLevel, logger) {
  if (maxLevel < DiagLogLevel.NONE) {
    maxLevel = DiagLogLevel.NONE;
  } else if (maxLevel > DiagLogLevel.ALL) {
    maxLevel = DiagLogLevel.ALL;
  }
  logger = logger || {};
  function _filterFunc(funcName, theLevel) {
    var theFunc = logger[funcName];
    if (typeof theFunc === "function" && maxLevel >= theLevel) {
      return theFunc.bind(logger);
    }
    return function() {
    };
  }
  return {
    error: _filterFunc("error", DiagLogLevel.ERROR),
    warn: _filterFunc("warn", DiagLogLevel.WARN),
    info: _filterFunc("info", DiagLogLevel.INFO),
    debug: _filterFunc("debug", DiagLogLevel.DEBUG),
    verbose: _filterFunc("verbose", DiagLogLevel.VERBOSE)
  };
}

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/api/diag.js
var __read2 = function(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
};
var __spreadArray2 = function(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
    if (ar || !(i in from)) {
      if (!ar) ar = Array.prototype.slice.call(from, 0, i);
      ar[i] = from[i];
    }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
};
var API_NAME = "diag";
var DiagAPI = (
  /** @class */
  function() {
    function DiagAPI2() {
      function _logProxy(funcName) {
        return function() {
          var args = [];
          for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
          }
          var logger = getGlobal("diag");
          if (!logger)
            return;
          return logger[funcName].apply(logger, __spreadArray2([], __read2(args), false));
        };
      }
      var self = this;
      var setLogger = function(logger, optionsOrLogLevel) {
        var _a16, _b, _c;
        if (optionsOrLogLevel === void 0) {
          optionsOrLogLevel = { logLevel: DiagLogLevel.INFO };
        }
        if (logger === self) {
          var err = new Error("Cannot use diag as the logger for itself. Please use a DiagLogger implementation like ConsoleDiagLogger or a custom implementation");
          self.error((_a16 = err.stack) !== null && _a16 !== void 0 ? _a16 : err.message);
          return false;
        }
        if (typeof optionsOrLogLevel === "number") {
          optionsOrLogLevel = {
            logLevel: optionsOrLogLevel
          };
        }
        var oldLogger = getGlobal("diag");
        var newLogger = createLogLevelDiagLogger((_b = optionsOrLogLevel.logLevel) !== null && _b !== void 0 ? _b : DiagLogLevel.INFO, logger);
        if (oldLogger && !optionsOrLogLevel.suppressOverrideMessage) {
          var stack = (_c = new Error().stack) !== null && _c !== void 0 ? _c : "<failed to generate stacktrace>";
          oldLogger.warn("Current logger will be overwritten from " + stack);
          newLogger.warn("Current logger will overwrite one already registered from " + stack);
        }
        return registerGlobal("diag", newLogger, self, true);
      };
      self.setLogger = setLogger;
      self.disable = function() {
        unregisterGlobal(API_NAME, self);
      };
      self.createComponentLogger = function(options) {
        return new DiagComponentLogger(options);
      };
      self.verbose = _logProxy("verbose");
      self.debug = _logProxy("debug");
      self.info = _logProxy("info");
      self.warn = _logProxy("warn");
      self.error = _logProxy("error");
    }
    DiagAPI2.instance = function() {
      if (!this._instance) {
        this._instance = new DiagAPI2();
      }
      return this._instance;
    };
    return DiagAPI2;
  }()
);

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/context/context.js
function createContextKey(description) {
  return Symbol.for(description);
}
var BaseContext = (
  /** @class */
  /* @__PURE__ */ function() {
    function BaseContext2(parentContext) {
      var self = this;
      self._currentContext = parentContext ? new Map(parentContext) : /* @__PURE__ */ new Map();
      self.getValue = function(key) {
        return self._currentContext.get(key);
      };
      self.setValue = function(key, value) {
        var context = new BaseContext2(self._currentContext);
        context._currentContext.set(key, value);
        return context;
      };
      self.deleteValue = function(key) {
        var context = new BaseContext2(self._currentContext);
        context._currentContext.delete(key);
        return context;
      };
    }
    return BaseContext2;
  }()
);
var ROOT_CONTEXT = new BaseContext();

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/context/NoopContextManager.js
var __read3 = function(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
};
var __spreadArray3 = function(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
    if (ar || !(i in from)) {
      if (!ar) ar = Array.prototype.slice.call(from, 0, i);
      ar[i] = from[i];
    }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
};
var NoopContextManager = (
  /** @class */
  function() {
    function NoopContextManager2() {
    }
    NoopContextManager2.prototype.active = function() {
      return ROOT_CONTEXT;
    };
    NoopContextManager2.prototype.with = function(_context, fn, thisArg) {
      var args = [];
      for (var _i = 3; _i < arguments.length; _i++) {
        args[_i - 3] = arguments[_i];
      }
      return fn.call.apply(fn, __spreadArray3([thisArg], __read3(args), false));
    };
    NoopContextManager2.prototype.bind = function(_context, target) {
      return target;
    };
    NoopContextManager2.prototype.enable = function() {
      return this;
    };
    NoopContextManager2.prototype.disable = function() {
      return this;
    };
    return NoopContextManager2;
  }()
);

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/api/context.js
var __read4 = function(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r && !r.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
};
var __spreadArray4 = function(to, from, pack) {
  if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
    if (ar || !(i in from)) {
      if (!ar) ar = Array.prototype.slice.call(from, 0, i);
      ar[i] = from[i];
    }
  }
  return to.concat(ar || Array.prototype.slice.call(from));
};
var API_NAME2 = "context";
var NOOP_CONTEXT_MANAGER = new NoopContextManager();
var ContextAPI = (
  /** @class */
  function() {
    function ContextAPI2() {
    }
    ContextAPI2.getInstance = function() {
      if (!this._instance) {
        this._instance = new ContextAPI2();
      }
      return this._instance;
    };
    ContextAPI2.prototype.setGlobalContextManager = function(contextManager) {
      return registerGlobal(API_NAME2, contextManager, DiagAPI.instance());
    };
    ContextAPI2.prototype.active = function() {
      return this._getContextManager().active();
    };
    ContextAPI2.prototype.with = function(context, fn, thisArg) {
      var _a16;
      var args = [];
      for (var _i = 3; _i < arguments.length; _i++) {
        args[_i - 3] = arguments[_i];
      }
      return (_a16 = this._getContextManager()).with.apply(_a16, __spreadArray4([context, fn, thisArg], __read4(args), false));
    };
    ContextAPI2.prototype.bind = function(context, target) {
      return this._getContextManager().bind(context, target);
    };
    ContextAPI2.prototype._getContextManager = function() {
      return getGlobal(API_NAME2) || NOOP_CONTEXT_MANAGER;
    };
    ContextAPI2.prototype.disable = function() {
      this._getContextManager().disable();
      unregisterGlobal(API_NAME2, DiagAPI.instance());
    };
    return ContextAPI2;
  }()
);

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/trace_flags.js
var TraceFlags;
(function(TraceFlags2) {
  TraceFlags2[TraceFlags2["NONE"] = 0] = "NONE";
  TraceFlags2[TraceFlags2["SAMPLED"] = 1] = "SAMPLED";
})(TraceFlags || (TraceFlags = {}));

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/invalid-span-constants.js
var INVALID_SPANID = "0000000000000000";
var INVALID_TRACEID = "00000000000000000000000000000000";
var INVALID_SPAN_CONTEXT = {
  traceId: INVALID_TRACEID,
  spanId: INVALID_SPANID,
  traceFlags: TraceFlags.NONE
};

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/NonRecordingSpan.js
var NonRecordingSpan = (
  /** @class */
  function() {
    function NonRecordingSpan2(_spanContext) {
      if (_spanContext === void 0) {
        _spanContext = INVALID_SPAN_CONTEXT;
      }
      this._spanContext = _spanContext;
    }
    NonRecordingSpan2.prototype.spanContext = function() {
      return this._spanContext;
    };
    NonRecordingSpan2.prototype.setAttribute = function(_key, _value) {
      return this;
    };
    NonRecordingSpan2.prototype.setAttributes = function(_attributes) {
      return this;
    };
    NonRecordingSpan2.prototype.addEvent = function(_name, _attributes) {
      return this;
    };
    NonRecordingSpan2.prototype.addLink = function(_link) {
      return this;
    };
    NonRecordingSpan2.prototype.addLinks = function(_links) {
      return this;
    };
    NonRecordingSpan2.prototype.setStatus = function(_status) {
      return this;
    };
    NonRecordingSpan2.prototype.updateName = function(_name) {
      return this;
    };
    NonRecordingSpan2.prototype.end = function(_endTime) {
    };
    NonRecordingSpan2.prototype.isRecording = function() {
      return false;
    };
    NonRecordingSpan2.prototype.recordException = function(_exception, _time) {
    };
    return NonRecordingSpan2;
  }()
);

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/context-utils.js
var SPAN_KEY = createContextKey("OpenTelemetry Context Key SPAN");
function getSpan(context) {
  return context.getValue(SPAN_KEY) || void 0;
}
function getActiveSpan() {
  return getSpan(ContextAPI.getInstance().active());
}
function setSpan(context, span) {
  return context.setValue(SPAN_KEY, span);
}
function deleteSpan(context) {
  return context.deleteValue(SPAN_KEY);
}
function setSpanContext(context, spanContext) {
  return setSpan(context, new NonRecordingSpan(spanContext));
}
function getSpanContext(context) {
  var _a16;
  return (_a16 = getSpan(context)) === null || _a16 === void 0 ? void 0 : _a16.spanContext();
}

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/spancontext-utils.js
var VALID_TRACEID_REGEX = /^([0-9a-f]{32})$/i;
var VALID_SPANID_REGEX = /^[0-9a-f]{16}$/i;
function isValidTraceId(traceId) {
  return VALID_TRACEID_REGEX.test(traceId) && traceId !== INVALID_TRACEID;
}
function isValidSpanId(spanId) {
  return VALID_SPANID_REGEX.test(spanId) && spanId !== INVALID_SPANID;
}
function isSpanContextValid(spanContext) {
  return isValidTraceId(spanContext.traceId) && isValidSpanId(spanContext.spanId);
}
function wrapSpanContext(spanContext) {
  return new NonRecordingSpan(spanContext);
}

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/NoopTracer.js
var contextApi = ContextAPI.getInstance();
var NoopTracer = (
  /** @class */
  function() {
    function NoopTracer2() {
    }
    NoopTracer2.prototype.startSpan = function(name15, options, context) {
      if (context === void 0) {
        context = contextApi.active();
      }
      var root = Boolean(options === null || options === void 0 ? void 0 : options.root);
      if (root) {
        return new NonRecordingSpan();
      }
      var parentFromContext = context && getSpanContext(context);
      if (isSpanContext(parentFromContext) && isSpanContextValid(parentFromContext)) {
        return new NonRecordingSpan(parentFromContext);
      } else {
        return new NonRecordingSpan();
      }
    };
    NoopTracer2.prototype.startActiveSpan = function(name15, arg2, arg3, arg4) {
      var opts;
      var ctx;
      var fn;
      if (arguments.length < 2) {
        return;
      } else if (arguments.length === 2) {
        fn = arg2;
      } else if (arguments.length === 3) {
        opts = arg2;
        fn = arg3;
      } else {
        opts = arg2;
        ctx = arg3;
        fn = arg4;
      }
      var parentContext = ctx !== null && ctx !== void 0 ? ctx : contextApi.active();
      var span = this.startSpan(name15, opts, parentContext);
      var contextWithSpanSet = setSpan(parentContext, span);
      return contextApi.with(contextWithSpanSet, fn, void 0, span);
    };
    return NoopTracer2;
  }()
);
function isSpanContext(spanContext) {
  return typeof spanContext === "object" && typeof spanContext["spanId"] === "string" && typeof spanContext["traceId"] === "string" && typeof spanContext["traceFlags"] === "number";
}

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/ProxyTracer.js
var NOOP_TRACER = new NoopTracer();
var ProxyTracer = (
  /** @class */
  function() {
    function ProxyTracer2(_provider, name15, version, options) {
      this._provider = _provider;
      this.name = name15;
      this.version = version;
      this.options = options;
    }
    ProxyTracer2.prototype.startSpan = function(name15, options, context) {
      return this._getTracer().startSpan(name15, options, context);
    };
    ProxyTracer2.prototype.startActiveSpan = function(_name, _options, _context, _fn) {
      var tracer = this._getTracer();
      return Reflect.apply(tracer.startActiveSpan, tracer, arguments);
    };
    ProxyTracer2.prototype._getTracer = function() {
      if (this._delegate) {
        return this._delegate;
      }
      var tracer = this._provider.getDelegateTracer(this.name, this.version, this.options);
      if (!tracer) {
        return NOOP_TRACER;
      }
      this._delegate = tracer;
      return this._delegate;
    };
    return ProxyTracer2;
  }()
);

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/NoopTracerProvider.js
var NoopTracerProvider = (
  /** @class */
  function() {
    function NoopTracerProvider2() {
    }
    NoopTracerProvider2.prototype.getTracer = function(_name, _version, _options) {
      return new NoopTracer();
    };
    return NoopTracerProvider2;
  }()
);

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/ProxyTracerProvider.js
var NOOP_TRACER_PROVIDER = new NoopTracerProvider();
var ProxyTracerProvider = (
  /** @class */
  function() {
    function ProxyTracerProvider2() {
    }
    ProxyTracerProvider2.prototype.getTracer = function(name15, version, options) {
      var _a16;
      return (_a16 = this.getDelegateTracer(name15, version, options)) !== null && _a16 !== void 0 ? _a16 : new ProxyTracer(this, name15, version, options);
    };
    ProxyTracerProvider2.prototype.getDelegate = function() {
      var _a16;
      return (_a16 = this._delegate) !== null && _a16 !== void 0 ? _a16 : NOOP_TRACER_PROVIDER;
    };
    ProxyTracerProvider2.prototype.setDelegate = function(delegate) {
      this._delegate = delegate;
    };
    ProxyTracerProvider2.prototype.getDelegateTracer = function(name15, version, options) {
      var _a16;
      return (_a16 = this._delegate) === null || _a16 === void 0 ? void 0 : _a16.getTracer(name15, version, options);
    };
    return ProxyTracerProvider2;
  }()
);

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace/status.js
var SpanStatusCode;
(function(SpanStatusCode2) {
  SpanStatusCode2[SpanStatusCode2["UNSET"] = 0] = "UNSET";
  SpanStatusCode2[SpanStatusCode2["OK"] = 1] = "OK";
  SpanStatusCode2[SpanStatusCode2["ERROR"] = 2] = "ERROR";
})(SpanStatusCode || (SpanStatusCode = {}));

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/api/trace.js
var API_NAME3 = "trace";
var TraceAPI = (
  /** @class */
  function() {
    function TraceAPI2() {
      this._proxyTracerProvider = new ProxyTracerProvider();
      this.wrapSpanContext = wrapSpanContext;
      this.isSpanContextValid = isSpanContextValid;
      this.deleteSpan = deleteSpan;
      this.getSpan = getSpan;
      this.getActiveSpan = getActiveSpan;
      this.getSpanContext = getSpanContext;
      this.setSpan = setSpan;
      this.setSpanContext = setSpanContext;
    }
    TraceAPI2.getInstance = function() {
      if (!this._instance) {
        this._instance = new TraceAPI2();
      }
      return this._instance;
    };
    TraceAPI2.prototype.setGlobalTracerProvider = function(provider) {
      var success = registerGlobal(API_NAME3, this._proxyTracerProvider, DiagAPI.instance());
      if (success) {
        this._proxyTracerProvider.setDelegate(provider);
      }
      return success;
    };
    TraceAPI2.prototype.getTracerProvider = function() {
      return getGlobal(API_NAME3) || this._proxyTracerProvider;
    };
    TraceAPI2.prototype.getTracer = function(name15, version) {
      return this.getTracerProvider().getTracer(name15, version);
    };
    TraceAPI2.prototype.disable = function() {
      unregisterGlobal(API_NAME3, DiagAPI.instance());
      this._proxyTracerProvider = new ProxyTracerProvider();
    };
    return TraceAPI2;
  }()
);

// ../../node_modules/.pnpm/@opentelemetry+api@1.9.0/node_modules/@opentelemetry/api/build/esm/trace-api.js
var trace = TraceAPI.getInstance();

// ../../node_modules/.pnpm/ai@4.0.0_react@18.3.0_zod@3.23.0/node_modules/ai/dist/index.mjs
var __defProp2 = Object.defineProperty;
var __export2 = (target, all) => {
  for (var name112 in all)
    __defProp2(target, name112, { get: all[name112], enumerable: true });
};
async function delay(delayInMs) {
  return delayInMs === void 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, delayInMs));
}
var name14 = "AI_RetryError";
var marker15 = `vercel.ai.error.${name14}`;
var symbol15 = Symbol.for(marker15);
var _a15;
var RetryError = class extends AISDKError {
  constructor({
    message,
    reason,
    errors
  }) {
    super({ name: name14, message });
    this[_a15] = true;
    this.reason = reason;
    this.errors = errors;
    this.lastError = errors[errors.length - 1];
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker15);
  }
};
_a15 = symbol15;
var retryWithExponentialBackoff = ({
  maxRetries = 2,
  initialDelayInMs = 2e3,
  backoffFactor = 2
} = {}) => async (f) => _retryWithExponentialBackoff(f, {
  maxRetries,
  delayInMs: initialDelayInMs,
  backoffFactor
});
async function _retryWithExponentialBackoff(f, {
  maxRetries,
  delayInMs,
  backoffFactor
}, errors = []) {
  try {
    return await f();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (maxRetries === 0) {
      throw error;
    }
    const errorMessage = getErrorMessage2(error);
    const newErrors = [...errors, error];
    const tryNumber = newErrors.length;
    if (tryNumber > maxRetries) {
      throw new RetryError({
        message: `Failed after ${tryNumber} attempts. Last error: ${errorMessage}`,
        reason: "maxRetriesExceeded",
        errors: newErrors
      });
    }
    if (error instanceof Error && APICallError.isInstance(error) && error.isRetryable === true && tryNumber <= maxRetries) {
      await delay(delayInMs);
      return _retryWithExponentialBackoff(
        f,
        { maxRetries, delayInMs: backoffFactor * delayInMs, backoffFactor },
        newErrors
      );
    }
    if (tryNumber === 1) {
      throw error;
    }
    throw new RetryError({
      message: `Failed after ${tryNumber} attempts with non-retryable error: '${errorMessage}'`,
      reason: "errorNotRetryable",
      errors: newErrors
    });
  }
}
function assembleOperationName({
  operationId,
  telemetry
}) {
  return {
    // standardized operation and resource name:
    "operation.name": `${operationId}${(telemetry == null ? void 0 : telemetry.functionId) != null ? ` ${telemetry.functionId}` : ""}`,
    "resource.name": telemetry == null ? void 0 : telemetry.functionId,
    // detailed, AI SDK specific data:
    "ai.operationId": operationId,
    "ai.telemetry.functionId": telemetry == null ? void 0 : telemetry.functionId
  };
}
function getBaseTelemetryAttributes({
  model,
  settings,
  telemetry,
  headers
}) {
  var _a112;
  return {
    "ai.model.provider": model.provider,
    "ai.model.id": model.modelId,
    // settings:
    ...Object.entries(settings).reduce((attributes, [key, value]) => {
      attributes[`ai.settings.${key}`] = value;
      return attributes;
    }, {}),
    // add metadata as attributes:
    ...Object.entries((_a112 = telemetry == null ? void 0 : telemetry.metadata) != null ? _a112 : {}).reduce(
      (attributes, [key, value]) => {
        attributes[`ai.telemetry.metadata.${key}`] = value;
        return attributes;
      },
      {}
    ),
    // request headers
    ...Object.entries(headers != null ? headers : {}).reduce((attributes, [key, value]) => {
      if (value !== void 0) {
        attributes[`ai.request.headers.${key}`] = value;
      }
      return attributes;
    }, {})
  };
}
var noopTracer = {
  startSpan() {
    return noopSpan;
  },
  startActiveSpan(name112, arg1, arg2, arg3) {
    if (typeof arg1 === "function") {
      return arg1(noopSpan);
    }
    if (typeof arg2 === "function") {
      return arg2(noopSpan);
    }
    if (typeof arg3 === "function") {
      return arg3(noopSpan);
    }
  }
};
var noopSpan = {
  spanContext() {
    return noopSpanContext;
  },
  setAttribute() {
    return this;
  },
  setAttributes() {
    return this;
  },
  addEvent() {
    return this;
  },
  addLink() {
    return this;
  },
  addLinks() {
    return this;
  },
  setStatus() {
    return this;
  },
  updateName() {
    return this;
  },
  end() {
    return this;
  },
  isRecording() {
    return false;
  },
  recordException() {
    return this;
  }
};
var noopSpanContext = {
  traceId: "",
  spanId: "",
  traceFlags: 0
};
function getTracer({
  isEnabled = false,
  tracer
} = {}) {
  if (!isEnabled) {
    return noopTracer;
  }
  if (tracer) {
    return tracer;
  }
  return trace.getTracer("ai");
}
function recordSpan({
  name: name112,
  tracer,
  attributes,
  fn,
  endWhenDone = true
}) {
  return tracer.startActiveSpan(name112, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      if (endWhenDone) {
        span.end();
      }
      return result;
    } catch (error) {
      try {
        if (error instanceof Error) {
          span.recordException({
            name: error.name,
            message: error.message,
            stack: error.stack
          });
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message
          });
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
      } finally {
        span.end();
      }
      throw error;
    }
  });
}
function selectTelemetryAttributes({
  telemetry,
  attributes
}) {
  if ((telemetry == null ? void 0 : telemetry.isEnabled) !== true) {
    return {};
  }
  return Object.entries(attributes).reduce((attributes2, [key, value]) => {
    if (value === void 0) {
      return attributes2;
    }
    if (typeof value === "object" && "input" in value && typeof value.input === "function") {
      if ((telemetry == null ? void 0 : telemetry.recordInputs) === false) {
        return attributes2;
      }
      const result = value.input();
      return result === void 0 ? attributes2 : { ...attributes2, [key]: result };
    }
    if (typeof value === "object" && "output" in value && typeof value.output === "function") {
      if ((telemetry == null ? void 0 : telemetry.recordOutputs) === false) {
        return attributes2;
      }
      const result = value.output();
      return result === void 0 ? attributes2 : { ...attributes2, [key]: result };
    }
    return { ...attributes2, [key]: value };
  }, {});
}
var name22 = "AI_DownloadError";
var marker22 = `vercel.ai.error.${name22}`;
var symbol22 = Symbol.for(marker22);
var _a22;
var DownloadError = class extends AISDKError {
  constructor({
    url,
    statusCode,
    statusText,
    cause,
    message = cause == null ? `Failed to download ${url}: ${statusCode} ${statusText}` : `Failed to download ${url}: ${cause}`
  }) {
    super({ name: name22, message, cause });
    this[_a22] = true;
    this.url = url;
    this.statusCode = statusCode;
    this.statusText = statusText;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker22);
  }
};
_a22 = symbol22;
async function download({
  url,
  fetchImplementation = fetch
}) {
  var _a112;
  const urlText = url.toString();
  try {
    const response = await fetchImplementation(urlText);
    if (!response.ok) {
      throw new DownloadError({
        url: urlText,
        statusCode: response.status,
        statusText: response.statusText
      });
    }
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      mimeType: (_a112 = response.headers.get("content-type")) != null ? _a112 : void 0
    };
  } catch (error) {
    if (DownloadError.isInstance(error)) {
      throw error;
    }
    throw new DownloadError({ url: urlText, cause: error });
  }
}
var mimeTypeSignatures = [
  { mimeType: "image/gif", bytes: [71, 73, 70] },
  { mimeType: "image/png", bytes: [137, 80, 78, 71] },
  { mimeType: "image/jpeg", bytes: [255, 216] },
  { mimeType: "image/webp", bytes: [82, 73, 70, 70] }
];
function detectImageMimeType(image) {
  for (const { bytes, mimeType } of mimeTypeSignatures) {
    if (image.length >= bytes.length && bytes.every((byte, index) => image[index] === byte)) {
      return mimeType;
    }
  }
  return void 0;
}
var name32 = "AI_InvalidDataContentError";
var marker32 = `vercel.ai.error.${name32}`;
var symbol32 = Symbol.for(marker32);
var _a32;
var InvalidDataContentError = class extends AISDKError {
  constructor({
    content,
    cause,
    message = `Invalid data content. Expected a base64 string, Uint8Array, ArrayBuffer, or Buffer, but got ${typeof content}.`
  }) {
    super({ name: name32, message, cause });
    this[_a32] = true;
    this.content = content;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker32);
  }
};
_a32 = symbol32;
var dataContentSchema = z.union([
  z.string(),
  z.instanceof(Uint8Array),
  z.instanceof(ArrayBuffer),
  z.custom(
    // Buffer might not be available in some environments such as CloudFlare:
    (value) => {
      var _a112, _b;
      return (_b = (_a112 = globalThis.Buffer) == null ? void 0 : _a112.isBuffer(value)) != null ? _b : false;
    },
    { message: "Must be a Buffer" }
  )
]);
function convertDataContentToBase64String(content) {
  if (typeof content === "string") {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return convertUint8ArrayToBase64(new Uint8Array(content));
  }
  return convertUint8ArrayToBase64(content);
}
function convertDataContentToUint8Array(content) {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (typeof content === "string") {
    try {
      return convertBase64ToUint8Array(content);
    } catch (error) {
      throw new InvalidDataContentError({
        message: "Invalid data content. Content string is not a base64-encoded media.",
        content,
        cause: error
      });
    }
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  throw new InvalidDataContentError({ content });
}
function convertUint8ArrayToText(uint8Array) {
  try {
    return new TextDecoder().decode(uint8Array);
  } catch (error) {
    throw new Error("Error decoding Uint8Array to text");
  }
}
var name42 = "AI_InvalidMessageRoleError";
var marker42 = `vercel.ai.error.${name42}`;
var symbol42 = Symbol.for(marker42);
var _a42;
var InvalidMessageRoleError = class extends AISDKError {
  constructor({
    role,
    message = `Invalid message role: '${role}'. Must be one of: "system", "user", "assistant", "tool".`
  }) {
    super({ name: name42, message });
    this[_a42] = true;
    this.role = role;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker42);
  }
};
_a42 = symbol42;
function splitDataUrl(dataUrl) {
  try {
    const [header, base64Content] = dataUrl.split(",");
    return {
      mimeType: header.split(";")[0].split(":")[1],
      base64Content
    };
  } catch (error) {
    return {
      mimeType: void 0,
      base64Content: void 0
    };
  }
}
async function convertToLanguageModelPrompt({
  prompt,
  modelSupportsImageUrls = true,
  modelSupportsUrl = () => false,
  downloadImplementation = download
}) {
  const downloadedAssets = await downloadAssets(
    prompt.messages,
    downloadImplementation,
    modelSupportsImageUrls,
    modelSupportsUrl
  );
  return [
    ...prompt.system != null ? [{ role: "system", content: prompt.system }] : [],
    ...prompt.messages.map(
      (message) => convertToLanguageModelMessage(message, downloadedAssets)
    )
  ];
}
function convertToLanguageModelMessage(message, downloadedAssets) {
  const role = message.role;
  switch (role) {
    case "system": {
      return {
        role: "system",
        content: message.content,
        providerMetadata: message.experimental_providerMetadata
      };
    }
    case "user": {
      if (typeof message.content === "string") {
        return {
          role: "user",
          content: [{ type: "text", text: message.content }],
          providerMetadata: message.experimental_providerMetadata
        };
      }
      return {
        role: "user",
        content: message.content.map((part) => convertPartToLanguageModelPart(part, downloadedAssets)).filter((part) => part.type !== "text" || part.text !== ""),
        providerMetadata: message.experimental_providerMetadata
      };
    }
    case "assistant": {
      if (typeof message.content === "string") {
        return {
          role: "assistant",
          content: [{ type: "text", text: message.content }],
          providerMetadata: message.experimental_providerMetadata
        };
      }
      return {
        role: "assistant",
        content: message.content.filter(
          // remove empty text parts:
          (part) => part.type !== "text" || part.text !== ""
        ).map((part) => {
          const { experimental_providerMetadata, ...rest } = part;
          return {
            ...rest,
            providerMetadata: experimental_providerMetadata
          };
        }),
        providerMetadata: message.experimental_providerMetadata
      };
    }
    case "tool": {
      return {
        role: "tool",
        content: message.content.map((part) => ({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.result,
          content: part.experimental_content,
          isError: part.isError,
          providerMetadata: part.experimental_providerMetadata
        })),
        providerMetadata: message.experimental_providerMetadata
      };
    }
    default: {
      const _exhaustiveCheck = role;
      throw new InvalidMessageRoleError({ role: _exhaustiveCheck });
    }
  }
}
async function downloadAssets(messages, downloadImplementation, modelSupportsImageUrls, modelSupportsUrl) {
  const urls = messages.filter((message) => message.role === "user").map((message) => message.content).filter(
    (content) => Array.isArray(content)
  ).flat().filter(
    (part) => part.type === "image" || part.type === "file"
  ).filter(
    (part) => !(part.type === "image" && modelSupportsImageUrls === true)
  ).map((part) => part.type === "image" ? part.image : part.data).map(
    (part) => (
      // support string urls:
      typeof part === "string" && (part.startsWith("http:") || part.startsWith("https:")) ? new URL(part) : part
    )
  ).filter((image) => image instanceof URL).filter((url) => !modelSupportsUrl(url));
  const downloadedImages = await Promise.all(
    urls.map(async (url) => ({
      url,
      data: await downloadImplementation({ url })
    }))
  );
  return Object.fromEntries(
    downloadedImages.map(({ url, data }) => [url.toString(), data])
  );
}
function convertPartToLanguageModelPart(part, downloadedAssets) {
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text,
      providerMetadata: part.experimental_providerMetadata
    };
  }
  let mimeType = part.mimeType;
  let data;
  let content;
  let normalizedData;
  const type = part.type;
  switch (type) {
    case "image":
      data = part.image;
      break;
    case "file":
      data = part.data;
      break;
    default:
      throw new Error(`Unsupported part type: ${type}`);
  }
  try {
    content = typeof data === "string" ? new URL(data) : data;
  } catch (error) {
    content = data;
  }
  if (content instanceof URL) {
    if (content.protocol === "data:") {
      const { mimeType: dataUrlMimeType, base64Content } = splitDataUrl(
        content.toString()
      );
      if (dataUrlMimeType == null || base64Content == null) {
        throw new Error(`Invalid data URL format in part ${type}`);
      }
      mimeType = dataUrlMimeType;
      normalizedData = convertDataContentToUint8Array(base64Content);
    } else {
      const downloadedFile = downloadedAssets[content.toString()];
      if (downloadedFile) {
        normalizedData = downloadedFile.data;
        mimeType != null ? mimeType : mimeType = downloadedFile.mimeType;
      } else {
        normalizedData = content;
      }
    }
  } else {
    normalizedData = convertDataContentToUint8Array(content);
  }
  switch (type) {
    case "image":
      if (mimeType == null && normalizedData instanceof Uint8Array) {
        mimeType = detectImageMimeType(normalizedData);
      }
      return {
        type: "image",
        image: normalizedData,
        mimeType,
        providerMetadata: part.experimental_providerMetadata
      };
    case "file":
      if (mimeType == null) {
        throw new Error(`Mime type is missing for file part`);
      }
      return {
        type: "file",
        data: normalizedData instanceof Uint8Array ? convertDataContentToBase64String(normalizedData) : normalizedData,
        mimeType,
        providerMetadata: part.experimental_providerMetadata
      };
  }
}
var name52 = "AI_InvalidArgumentError";
var marker52 = `vercel.ai.error.${name52}`;
var symbol52 = Symbol.for(marker52);
var _a52;
var InvalidArgumentError2 = class extends AISDKError {
  constructor({
    parameter,
    value,
    message
  }) {
    super({
      name: name52,
      message: `Invalid argument for parameter ${parameter}: ${message}`
    });
    this[_a52] = true;
    this.parameter = parameter;
    this.value = value;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker52);
  }
};
_a52 = symbol52;
function prepareCallSettings({
  maxTokens,
  temperature,
  topP,
  topK,
  presencePenalty,
  frequencyPenalty,
  stopSequences,
  seed,
  maxRetries
}) {
  if (maxTokens != null) {
    if (!Number.isInteger(maxTokens)) {
      throw new InvalidArgumentError2({
        parameter: "maxTokens",
        value: maxTokens,
        message: "maxTokens must be an integer"
      });
    }
    if (maxTokens < 1) {
      throw new InvalidArgumentError2({
        parameter: "maxTokens",
        value: maxTokens,
        message: "maxTokens must be >= 1"
      });
    }
  }
  if (temperature != null) {
    if (typeof temperature !== "number") {
      throw new InvalidArgumentError2({
        parameter: "temperature",
        value: temperature,
        message: "temperature must be a number"
      });
    }
  }
  if (topP != null) {
    if (typeof topP !== "number") {
      throw new InvalidArgumentError2({
        parameter: "topP",
        value: topP,
        message: "topP must be a number"
      });
    }
  }
  if (topK != null) {
    if (typeof topK !== "number") {
      throw new InvalidArgumentError2({
        parameter: "topK",
        value: topK,
        message: "topK must be a number"
      });
    }
  }
  if (presencePenalty != null) {
    if (typeof presencePenalty !== "number") {
      throw new InvalidArgumentError2({
        parameter: "presencePenalty",
        value: presencePenalty,
        message: "presencePenalty must be a number"
      });
    }
  }
  if (frequencyPenalty != null) {
    if (typeof frequencyPenalty !== "number") {
      throw new InvalidArgumentError2({
        parameter: "frequencyPenalty",
        value: frequencyPenalty,
        message: "frequencyPenalty must be a number"
      });
    }
  }
  if (seed != null) {
    if (!Number.isInteger(seed)) {
      throw new InvalidArgumentError2({
        parameter: "seed",
        value: seed,
        message: "seed must be an integer"
      });
    }
  }
  if (maxRetries != null) {
    if (!Number.isInteger(maxRetries)) {
      throw new InvalidArgumentError2({
        parameter: "maxRetries",
        value: maxRetries,
        message: "maxRetries must be an integer"
      });
    }
    if (maxRetries < 0) {
      throw new InvalidArgumentError2({
        parameter: "maxRetries",
        value: maxRetries,
        message: "maxRetries must be >= 0"
      });
    }
  }
  return {
    maxTokens,
    temperature: temperature != null ? temperature : 0,
    topP,
    topK,
    presencePenalty,
    frequencyPenalty,
    stopSequences: stopSequences != null && stopSequences.length > 0 ? stopSequences : void 0,
    seed,
    maxRetries: maxRetries != null ? maxRetries : 2
  };
}
var jsonValueSchema = z.lazy(
  () => z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.record(z.string(), jsonValueSchema),
    z.array(jsonValueSchema)
  ])
);
var providerMetadataSchema = z.record(
  z.string(),
  z.record(z.string(), jsonValueSchema)
);
var toolResultContentSchema = z.array(
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("image"),
      data: z.string(),
      mimeType: z.string().optional()
    })
  ])
);
var textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  experimental_providerMetadata: providerMetadataSchema.optional()
});
var imagePartSchema = z.object({
  type: z.literal("image"),
  image: z.union([dataContentSchema, z.instanceof(URL)]),
  mimeType: z.string().optional(),
  experimental_providerMetadata: providerMetadataSchema.optional()
});
var filePartSchema = z.object({
  type: z.literal("file"),
  data: z.union([dataContentSchema, z.instanceof(URL)]),
  mimeType: z.string(),
  experimental_providerMetadata: providerMetadataSchema.optional()
});
var toolCallPartSchema = z.object({
  type: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown()
});
var toolResultPartSchema = z.object({
  type: z.literal("tool-result"),
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
  content: toolResultContentSchema.optional(),
  isError: z.boolean().optional(),
  experimental_providerMetadata: providerMetadataSchema.optional()
});
var coreSystemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
  experimental_providerMetadata: providerMetadataSchema.optional()
});
var coreUserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.union([
    z.string(),
    z.array(z.union([textPartSchema, imagePartSchema, filePartSchema]))
  ]),
  experimental_providerMetadata: providerMetadataSchema.optional()
});
var coreAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.union([
    z.string(),
    z.array(z.union([textPartSchema, toolCallPartSchema]))
  ]),
  experimental_providerMetadata: providerMetadataSchema.optional()
});
var coreToolMessageSchema = z.object({
  role: z.literal("tool"),
  content: z.array(toolResultPartSchema),
  experimental_providerMetadata: providerMetadataSchema.optional()
});
var coreMessageSchema = z.union([
  coreSystemMessageSchema,
  coreUserMessageSchema,
  coreAssistantMessageSchema,
  coreToolMessageSchema
]);
function detectPromptType(prompt) {
  if (!Array.isArray(prompt)) {
    return "other";
  }
  if (prompt.length === 0) {
    return "messages";
  }
  const characteristics = prompt.map(detectSingleMessageCharacteristics);
  if (characteristics.some((c) => c === "has-ui-specific-parts")) {
    return "ui-messages";
  } else if (characteristics.every(
    (c) => c === "has-core-specific-parts" || c === "message"
  )) {
    return "messages";
  } else {
    return "other";
  }
}
function detectSingleMessageCharacteristics(message) {
  if (typeof message === "object" && message !== null && (message.role === "function" || // UI-only role
  message.role === "data" || // UI-only role
  "toolInvocations" in message || // UI-specific field
  "experimental_attachments" in message)) {
    return "has-ui-specific-parts";
  } else if (typeof message === "object" && message !== null && "content" in message && (Array.isArray(message.content) || // Core messages can have array content
  "experimental_providerMetadata" in message)) {
    return "has-core-specific-parts";
  } else if (typeof message === "object" && message !== null && "role" in message && "content" in message && typeof message.content === "string" && ["system", "user", "assistant", "tool"].includes(message.role)) {
    return "message";
  } else {
    return "other";
  }
}
function attachmentsToParts(attachments) {
  var _a112, _b, _c;
  const parts = [];
  for (const attachment of attachments) {
    let url;
    try {
      url = new URL(attachment.url);
    } catch (error) {
      throw new Error(`Invalid URL: ${attachment.url}`);
    }
    switch (url.protocol) {
      case "http:":
      case "https:": {
        if ((_a112 = attachment.contentType) == null ? void 0 : _a112.startsWith("image/")) {
          parts.push({ type: "image", image: url });
        } else {
          if (!attachment.contentType) {
            throw new Error(
              "If the attachment is not an image, it must specify a content type"
            );
          }
          parts.push({
            type: "file",
            data: url,
            mimeType: attachment.contentType
          });
        }
        break;
      }
      case "data:": {
        let header;
        let base64Content;
        let mimeType;
        try {
          [header, base64Content] = attachment.url.split(",");
          mimeType = header.split(";")[0].split(":")[1];
        } catch (error) {
          throw new Error(`Error processing data URL: ${attachment.url}`);
        }
        if (mimeType == null || base64Content == null) {
          throw new Error(`Invalid data URL format: ${attachment.url}`);
        }
        if ((_b = attachment.contentType) == null ? void 0 : _b.startsWith("image/")) {
          parts.push({
            type: "image",
            image: convertDataContentToUint8Array(base64Content)
          });
        } else if ((_c = attachment.contentType) == null ? void 0 : _c.startsWith("text/")) {
          parts.push({
            type: "text",
            text: convertUint8ArrayToText(
              convertDataContentToUint8Array(base64Content)
            )
          });
        } else {
          if (!attachment.contentType) {
            throw new Error(
              "If the attachment is not an image or text, it must specify a content type"
            );
          }
          parts.push({
            type: "file",
            data: base64Content,
            mimeType: attachment.contentType
          });
        }
        break;
      }
      default: {
        throw new Error(`Unsupported URL protocol: ${url.protocol}`);
      }
    }
  }
  return parts;
}
var name62 = "AI_MessageConversionError";
var marker62 = `vercel.ai.error.${name62}`;
var symbol62 = Symbol.for(marker62);
var _a62;
var MessageConversionError = class extends AISDKError {
  constructor({
    originalMessage,
    message
  }) {
    super({ name: name62, message });
    this[_a62] = true;
    this.originalMessage = originalMessage;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker62);
  }
};
_a62 = symbol62;
function convertToCoreMessages(messages, options) {
  var _a112;
  const tools = (_a112 = options == null ? void 0 : options.tools) != null ? _a112 : {};
  const coreMessages = [];
  for (const message of messages) {
    const { role, content, toolInvocations, experimental_attachments } = message;
    switch (role) {
      case "system": {
        coreMessages.push({
          role: "system",
          content
        });
        break;
      }
      case "user": {
        coreMessages.push({
          role: "user",
          content: experimental_attachments ? [
            { type: "text", text: content },
            ...attachmentsToParts(experimental_attachments)
          ] : content
        });
        break;
      }
      case "assistant": {
        if (toolInvocations == null) {
          coreMessages.push({ role: "assistant", content });
          break;
        }
        coreMessages.push({
          role: "assistant",
          content: [
            { type: "text", text: content },
            ...toolInvocations.map(
              ({ toolCallId, toolName, args }) => ({
                type: "tool-call",
                toolCallId,
                toolName,
                args
              })
            )
          ]
        });
        coreMessages.push({
          role: "tool",
          content: toolInvocations.map((toolInvocation) => {
            if (!("result" in toolInvocation)) {
              throw new MessageConversionError({
                originalMessage: message,
                message: "ToolInvocation must have a result: " + JSON.stringify(toolInvocation)
              });
            }
            const { toolCallId, toolName, result } = toolInvocation;
            const tool2 = tools[toolName];
            return (tool2 == null ? void 0 : tool2.experimental_toToolResultContent) != null ? {
              type: "tool-result",
              toolCallId,
              toolName,
              result: tool2.experimental_toToolResultContent(result),
              experimental_content: tool2.experimental_toToolResultContent(result)
            } : {
              type: "tool-result",
              toolCallId,
              toolName,
              result
            };
          })
        });
        break;
      }
      case "data": {
        break;
      }
      default: {
        const _exhaustiveCheck = role;
        throw new MessageConversionError({
          originalMessage: message,
          message: `Unsupported role: ${_exhaustiveCheck}`
        });
      }
    }
  }
  return coreMessages;
}
function standardizePrompt({
  prompt,
  tools
}) {
  if (prompt.prompt == null && prompt.messages == null) {
    throw new InvalidPromptError({
      prompt,
      message: "prompt or messages must be defined"
    });
  }
  if (prompt.prompt != null && prompt.messages != null) {
    throw new InvalidPromptError({
      prompt,
      message: "prompt and messages cannot be defined at the same time"
    });
  }
  if (prompt.system != null && typeof prompt.system !== "string") {
    throw new InvalidPromptError({
      prompt,
      message: "system must be a string"
    });
  }
  if (prompt.prompt != null) {
    if (typeof prompt.prompt !== "string") {
      throw new InvalidPromptError({
        prompt,
        message: "prompt must be a string"
      });
    }
    return {
      type: "prompt",
      system: prompt.system,
      messages: [
        {
          role: "user",
          content: prompt.prompt
        }
      ]
    };
  }
  if (prompt.messages != null) {
    const promptType = detectPromptType(prompt.messages);
    if (promptType === "other") {
      throw new InvalidPromptError({
        prompt,
        message: "messages must be an array of CoreMessage or UIMessage"
      });
    }
    const messages = promptType === "ui-messages" ? convertToCoreMessages(prompt.messages, {
      tools
    }) : prompt.messages;
    const validationResult = safeValidateTypes({
      value: messages,
      schema: z.array(coreMessageSchema)
    });
    if (!validationResult.success) {
      throw new InvalidPromptError({
        prompt,
        message: "messages must be an array of CoreMessage or UIMessage",
        cause: validationResult.error
      });
    }
    return {
      type: "messages",
      messages,
      system: prompt.system
    };
  }
  throw new Error("unreachable");
}
function calculateLanguageModelUsage({
  promptTokens,
  completionTokens
}) {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  };
}
function prepareResponseHeaders(headers, {
  contentType,
  dataStreamVersion
}) {
  const responseHeaders = new Headers(headers != null ? headers : {});
  if (!responseHeaders.has("Content-Type")) {
    responseHeaders.set("Content-Type", contentType);
  }
  if (dataStreamVersion !== void 0) {
    responseHeaders.set("X-Vercel-AI-Data-Stream", dataStreamVersion);
  }
  return responseHeaders;
}
var name72 = "AI_NoObjectGeneratedError";
var marker72 = `vercel.ai.error.${name72}`;
var symbol72 = Symbol.for(marker72);
var _a72;
_a72 = symbol72;
function createAsyncIterableStream(source, transformer) {
  const transformedStream = source.pipeThrough(
    new TransformStream(transformer)
  );
  transformedStream[Symbol.asyncIterator] = () => {
    const reader = transformedStream.getReader();
    return {
      async next() {
        const { done, value } = await reader.read();
        return done ? { done: true, value: void 0 } : { done: false, value };
      }
    };
  };
  return transformedStream;
}
var originalGenerateId = createIdGenerator({ prefix: "aiobj", size: 24 });
var DelayedPromise = class {
  constructor() {
    this.status = { type: "pending" };
    this._resolve = void 0;
    this._reject = void 0;
  }
  get value() {
    if (this.promise) {
      return this.promise;
    }
    this.promise = new Promise((resolve, reject) => {
      if (this.status.type === "resolved") {
        resolve(this.status.value);
      } else if (this.status.type === "rejected") {
        reject(this.status.error);
      }
      this._resolve = resolve;
      this._reject = reject;
    });
    return this.promise;
  }
  resolve(value) {
    var _a112;
    this.status = { type: "resolved", value };
    if (this.promise) {
      (_a112 = this._resolve) == null ? void 0 : _a112.call(this, value);
    }
  }
  reject(error) {
    var _a112;
    this.status = { type: "rejected", error };
    if (this.promise) {
      (_a112 = this._reject) == null ? void 0 : _a112.call(this, error);
    }
  }
};
function now2() {
  var _a112, _b;
  return (_b = (_a112 = globalThis == null ? void 0 : globalThis.performance) == null ? void 0 : _a112.now()) != null ? _b : Date.now();
}
function prepareOutgoingHttpHeaders(headers, {
  contentType,
  dataStreamVersion
}) {
  const outgoingHeaders = {};
  if (headers != null) {
    for (const [key, value] of Object.entries(headers)) {
      outgoingHeaders[key] = value;
    }
  }
  if (outgoingHeaders["Content-Type"] == null) {
    outgoingHeaders["Content-Type"] = contentType;
  }
  if (dataStreamVersion !== void 0) {
    outgoingHeaders["X-Vercel-AI-Data-Stream"] = dataStreamVersion;
  }
  return outgoingHeaders;
}
function writeToServerResponse({
  response,
  status,
  statusText,
  headers,
  stream
}) {
  response.writeHead(status != null ? status : 200, statusText, headers);
  const reader = stream.getReader();
  const read = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done)
          break;
        response.write(value);
      }
    } catch (error) {
      throw error;
    } finally {
      response.end();
    }
  };
  read();
}
function createResolvablePromise() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve,
    reject
  };
}
function createStitchableStream() {
  let innerStreamReaders = [];
  let controller = null;
  let isClosed = false;
  let waitForNewStream = createResolvablePromise();
  const processPull = async () => {
    if (isClosed && innerStreamReaders.length === 0) {
      controller == null ? void 0 : controller.close();
      return;
    }
    if (innerStreamReaders.length === 0) {
      waitForNewStream = createResolvablePromise();
      await waitForNewStream.promise;
      return processPull();
    }
    try {
      const { value, done } = await innerStreamReaders[0].read();
      if (done) {
        innerStreamReaders.shift();
        if (innerStreamReaders.length > 0) {
          await processPull();
        } else if (isClosed) {
          controller == null ? void 0 : controller.close();
        }
      } else {
        controller == null ? void 0 : controller.enqueue(value);
      }
    } catch (error) {
      controller == null ? void 0 : controller.error(error);
      innerStreamReaders.shift();
      if (isClosed && innerStreamReaders.length === 0) {
        controller == null ? void 0 : controller.close();
      }
    }
  };
  return {
    stream: new ReadableStream({
      start(controllerParam) {
        controller = controllerParam;
      },
      pull: processPull,
      async cancel() {
        for (const reader of innerStreamReaders) {
          await reader.cancel();
        }
        innerStreamReaders = [];
        isClosed = true;
      }
    }),
    addStream: (innerStream) => {
      if (isClosed) {
        throw new Error("Cannot add inner stream: outer stream is closed");
      }
      innerStreamReaders.push(innerStream.getReader());
      waitForNewStream.resolve();
    },
    close: () => {
      isClosed = true;
      waitForNewStream.resolve();
      if (innerStreamReaders.length === 0) {
        controller == null ? void 0 : controller.close();
      }
    }
  };
}
var originalGenerateId2 = createIdGenerator({ prefix: "aiobj", size: 24 });
var name82 = "AI_InvalidToolArgumentsError";
var marker82 = `vercel.ai.error.${name82}`;
var symbol82 = Symbol.for(marker82);
var _a82;
var InvalidToolArgumentsError = class extends AISDKError {
  constructor({
    toolArgs,
    toolName,
    cause,
    message = `Invalid arguments for tool ${toolName}: ${getErrorMessage(
      cause
    )}`
  }) {
    super({ name: name82, message, cause });
    this[_a82] = true;
    this.toolArgs = toolArgs;
    this.toolName = toolName;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker82);
  }
};
_a82 = symbol82;
var name92 = "AI_NoSuchToolError";
var marker92 = `vercel.ai.error.${name92}`;
var symbol92 = Symbol.for(marker92);
var _a92;
var NoSuchToolError = class extends AISDKError {
  constructor({
    toolName,
    availableTools = void 0,
    message = `Model tried to call unavailable tool '${toolName}'. ${availableTools === void 0 ? "No tools are available." : `Available tools: ${availableTools.join(", ")}.`}`
  }) {
    super({ name: name92, message });
    this[_a92] = true;
    this.toolName = toolName;
    this.availableTools = availableTools;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker92);
  }
};
_a92 = symbol92;
function isNonEmptyObject(object) {
  return object != null && Object.keys(object).length > 0;
}
function prepareToolsAndToolChoice({
  tools,
  toolChoice,
  activeTools
}) {
  if (!isNonEmptyObject(tools)) {
    return {
      tools: void 0,
      toolChoice: void 0
    };
  }
  const filteredTools = activeTools != null ? Object.entries(tools).filter(
    ([name112]) => activeTools.includes(name112)
  ) : Object.entries(tools);
  return {
    tools: filteredTools.map(([name112, tool2]) => {
      const toolType = tool2.type;
      switch (toolType) {
        case void 0:
        case "function":
          return {
            type: "function",
            name: name112,
            description: tool2.description,
            parameters: asSchema(tool2.parameters).jsonSchema
          };
        case "provider-defined":
          return {
            type: "provider-defined",
            name: name112,
            id: tool2.id,
            args: tool2.args
          };
        default: {
          const exhaustiveCheck = toolType;
          throw new Error(`Unsupported tool type: ${exhaustiveCheck}`);
        }
      }
    }),
    toolChoice: toolChoice == null ? { type: "auto" } : typeof toolChoice === "string" ? { type: toolChoice } : { type: "tool", toolName: toolChoice.toolName }
  };
}
var lastWhitespaceRegexp = /^([\s\S]*?)(\s+)(\S*)$/;
function splitOnLastWhitespace(text) {
  const match = text.match(lastWhitespaceRegexp);
  return match ? { prefix: match[1], whitespace: match[2], suffix: match[3] } : void 0;
}
function removeTextAfterLastWhitespace(text) {
  const match = splitOnLastWhitespace(text);
  return match ? match.prefix + match.whitespace : text;
}
function parseToolCall({
  toolCall,
  tools
}) {
  const toolName = toolCall.toolName;
  if (tools == null) {
    throw new NoSuchToolError({ toolName: toolCall.toolName });
  }
  const tool2 = tools[toolName];
  if (tool2 == null) {
    throw new NoSuchToolError({
      toolName: toolCall.toolName,
      availableTools: Object.keys(tools)
    });
  }
  const schema = asSchema(tool2.parameters);
  const parseResult = toolCall.args.trim() === "" ? safeValidateTypes({ value: {}, schema }) : safeParseJSON({ text: toolCall.args, schema });
  if (parseResult.success === false) {
    throw new InvalidToolArgumentsError({
      toolName,
      toolArgs: toolCall.args,
      cause: parseResult.error
    });
  }
  return {
    type: "tool-call",
    toolCallId: toolCall.toolCallId,
    toolName,
    args: parseResult.value
  };
}
function toResponseMessages({
  text = "",
  tools,
  toolCalls,
  toolResults
}) {
  const responseMessages = [];
  responseMessages.push({
    role: "assistant",
    content: [{ type: "text", text }, ...toolCalls]
  });
  if (toolResults.length > 0) {
    responseMessages.push({
      role: "tool",
      content: toolResults.map((toolResult) => {
        const tool2 = tools[toolResult.toolName];
        return (tool2 == null ? void 0 : tool2.experimental_toToolResultContent) != null ? {
          type: "tool-result",
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          result: tool2.experimental_toToolResultContent(toolResult.result),
          experimental_content: tool2.experimental_toToolResultContent(
            toolResult.result
          )
        } : {
          type: "tool-result",
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          result: toolResult.result
        };
      })
    });
  }
  return responseMessages;
}
var originalGenerateId3 = createIdGenerator({ prefix: "aitxt", size: 24 });
async function generateText({
  model,
  tools,
  toolChoice,
  system,
  prompt,
  messages,
  maxRetries,
  abortSignal,
  headers,
  maxSteps = 1,
  experimental_continueSteps: continueSteps = false,
  experimental_telemetry: telemetry,
  experimental_providerMetadata: providerMetadata,
  experimental_activeTools: activeTools,
  _internal: {
    generateId: generateId3 = originalGenerateId3,
    currentDate = () => /* @__PURE__ */ new Date()
  } = {},
  onStepFinish,
  ...settings
}) {
  if (maxSteps < 1) {
    throw new InvalidArgumentError2({
      parameter: "maxSteps",
      value: maxSteps,
      message: "maxSteps must be at least 1"
    });
  }
  const baseTelemetryAttributes = getBaseTelemetryAttributes({
    model,
    telemetry,
    headers,
    settings: { ...settings, maxRetries }
  });
  const initialPrompt = standardizePrompt({
    prompt: { system, prompt, messages },
    tools
  });
  const tracer = getTracer(telemetry);
  return recordSpan({
    name: "ai.generateText",
    attributes: selectTelemetryAttributes({
      telemetry,
      attributes: {
        ...assembleOperationName({
          operationId: "ai.generateText",
          telemetry
        }),
        ...baseTelemetryAttributes,
        // specific settings that only make sense on the outer level:
        "ai.prompt": {
          input: () => JSON.stringify({ system, prompt, messages })
        },
        "ai.settings.maxSteps": maxSteps
      }
    }),
    tracer,
    fn: async (span) => {
      var _a112, _b, _c, _d, _e, _f;
      const retry = retryWithExponentialBackoff({ maxRetries });
      const mode = {
        type: "regular",
        ...prepareToolsAndToolChoice({ tools, toolChoice, activeTools })
      };
      const callSettings = prepareCallSettings(settings);
      let currentModelResponse;
      let currentToolCalls = [];
      let currentToolResults = [];
      let stepCount = 0;
      const responseMessages = [];
      let text = "";
      const steps = [];
      const usage = {
        completionTokens: 0,
        promptTokens: 0,
        totalTokens: 0
      };
      let stepType = "initial";
      do {
        if (stepCount === 1) {
          initialPrompt.type = "messages";
        }
        const promptFormat = stepCount === 0 ? initialPrompt.type : "messages";
        const promptMessages = await convertToLanguageModelPrompt({
          prompt: {
            type: promptFormat,
            system: initialPrompt.system,
            messages: [...initialPrompt.messages, ...responseMessages]
          },
          modelSupportsImageUrls: model.supportsImageUrls,
          modelSupportsUrl: model.supportsUrl
        });
        currentModelResponse = await retry(
          () => recordSpan({
            name: "ai.generateText.doGenerate",
            attributes: selectTelemetryAttributes({
              telemetry,
              attributes: {
                ...assembleOperationName({
                  operationId: "ai.generateText.doGenerate",
                  telemetry
                }),
                ...baseTelemetryAttributes,
                "ai.prompt.format": { input: () => promptFormat },
                "ai.prompt.messages": {
                  input: () => JSON.stringify(promptMessages)
                },
                "ai.prompt.tools": {
                  // convert the language model level tools:
                  input: () => {
                    var _a122;
                    return (_a122 = mode.tools) == null ? void 0 : _a122.map((tool2) => JSON.stringify(tool2));
                  }
                },
                "ai.prompt.toolChoice": {
                  input: () => mode.toolChoice != null ? JSON.stringify(mode.toolChoice) : void 0
                },
                // standardized gen-ai llm span attributes:
                "gen_ai.system": model.provider,
                "gen_ai.request.model": model.modelId,
                "gen_ai.request.frequency_penalty": settings.frequencyPenalty,
                "gen_ai.request.max_tokens": settings.maxTokens,
                "gen_ai.request.presence_penalty": settings.presencePenalty,
                "gen_ai.request.stop_sequences": settings.stopSequences,
                "gen_ai.request.temperature": settings.temperature,
                "gen_ai.request.top_k": settings.topK,
                "gen_ai.request.top_p": settings.topP
              }
            }),
            tracer,
            fn: async (span2) => {
              var _a122, _b2, _c2, _d2, _e2, _f2;
              const result = await model.doGenerate({
                mode,
                ...callSettings,
                inputFormat: promptFormat,
                prompt: promptMessages,
                providerMetadata,
                abortSignal,
                headers
              });
              const responseData = {
                id: (_b2 = (_a122 = result.response) == null ? void 0 : _a122.id) != null ? _b2 : generateId3(),
                timestamp: (_d2 = (_c2 = result.response) == null ? void 0 : _c2.timestamp) != null ? _d2 : currentDate(),
                modelId: (_f2 = (_e2 = result.response) == null ? void 0 : _e2.modelId) != null ? _f2 : model.modelId
              };
              span2.setAttributes(
                selectTelemetryAttributes({
                  telemetry,
                  attributes: {
                    "ai.response.finishReason": result.finishReason,
                    "ai.response.text": {
                      output: () => result.text
                    },
                    "ai.response.toolCalls": {
                      output: () => JSON.stringify(result.toolCalls)
                    },
                    "ai.response.id": responseData.id,
                    "ai.response.model": responseData.modelId,
                    "ai.response.timestamp": responseData.timestamp.toISOString(),
                    "ai.usage.promptTokens": result.usage.promptTokens,
                    "ai.usage.completionTokens": result.usage.completionTokens,
                    // standardized gen-ai llm span attributes:
                    "gen_ai.response.finish_reasons": [result.finishReason],
                    "gen_ai.response.id": responseData.id,
                    "gen_ai.response.model": responseData.modelId,
                    "gen_ai.usage.input_tokens": result.usage.promptTokens,
                    "gen_ai.usage.output_tokens": result.usage.completionTokens
                  }
                })
              );
              return { ...result, response: responseData };
            }
          })
        );
        currentToolCalls = ((_a112 = currentModelResponse.toolCalls) != null ? _a112 : []).map(
          (modelToolCall) => parseToolCall({ toolCall: modelToolCall, tools })
        );
        currentToolResults = tools == null ? [] : await executeTools({
          toolCalls: currentToolCalls,
          tools,
          tracer,
          telemetry,
          abortSignal
        });
        const currentUsage = calculateLanguageModelUsage(
          currentModelResponse.usage
        );
        usage.completionTokens += currentUsage.completionTokens;
        usage.promptTokens += currentUsage.promptTokens;
        usage.totalTokens += currentUsage.totalTokens;
        let nextStepType = "done";
        if (++stepCount < maxSteps) {
          if (continueSteps && currentModelResponse.finishReason === "length" && // only use continue when there are no tool calls:
          currentToolCalls.length === 0) {
            nextStepType = "continue";
          } else if (
            // there are tool calls:
            currentToolCalls.length > 0 && // all current tool calls have results:
            currentToolResults.length === currentToolCalls.length
          ) {
            nextStepType = "tool-result";
          }
        }
        const originalText = (_b = currentModelResponse.text) != null ? _b : "";
        const stepTextLeadingWhitespaceTrimmed = stepType === "continue" && // only for continue steps
        text.trimEnd() !== text ? originalText.trimStart() : originalText;
        const stepText = nextStepType === "continue" ? removeTextAfterLastWhitespace(stepTextLeadingWhitespaceTrimmed) : stepTextLeadingWhitespaceTrimmed;
        text = nextStepType === "continue" || stepType === "continue" ? text + stepText : stepText;
        if (stepType === "continue") {
          const lastMessage = responseMessages[responseMessages.length - 1];
          if (typeof lastMessage.content === "string") {
            lastMessage.content += stepText;
          } else {
            lastMessage.content.push({
              text: stepText,
              type: "text"
            });
          }
        } else {
          responseMessages.push(
            ...toResponseMessages({
              text,
              tools: tools != null ? tools : {},
              toolCalls: currentToolCalls,
              toolResults: currentToolResults
            })
          );
        }
        const currentStepResult = {
          stepType,
          text: stepText,
          toolCalls: currentToolCalls,
          toolResults: currentToolResults,
          finishReason: currentModelResponse.finishReason,
          usage: currentUsage,
          warnings: currentModelResponse.warnings,
          logprobs: currentModelResponse.logprobs,
          request: (_c = currentModelResponse.request) != null ? _c : {},
          response: {
            ...currentModelResponse.response,
            headers: (_d = currentModelResponse.rawResponse) == null ? void 0 : _d.headers,
            // deep clone msgs to avoid mutating past messages in multi-step:
            messages: JSON.parse(JSON.stringify(responseMessages))
          },
          experimental_providerMetadata: currentModelResponse.providerMetadata,
          isContinued: nextStepType === "continue"
        };
        steps.push(currentStepResult);
        await (onStepFinish == null ? void 0 : onStepFinish(currentStepResult));
        stepType = nextStepType;
      } while (stepType !== "done");
      span.setAttributes(
        selectTelemetryAttributes({
          telemetry,
          attributes: {
            "ai.response.finishReason": currentModelResponse.finishReason,
            "ai.response.text": {
              output: () => currentModelResponse.text
            },
            "ai.response.toolCalls": {
              output: () => JSON.stringify(currentModelResponse.toolCalls)
            },
            "ai.usage.promptTokens": currentModelResponse.usage.promptTokens,
            "ai.usage.completionTokens": currentModelResponse.usage.completionTokens
          }
        })
      );
      return new DefaultGenerateTextResult({
        text,
        toolCalls: currentToolCalls,
        toolResults: currentToolResults,
        finishReason: currentModelResponse.finishReason,
        usage,
        warnings: currentModelResponse.warnings,
        request: (_e = currentModelResponse.request) != null ? _e : {},
        response: {
          ...currentModelResponse.response,
          headers: (_f = currentModelResponse.rawResponse) == null ? void 0 : _f.headers,
          messages: responseMessages
        },
        logprobs: currentModelResponse.logprobs,
        steps,
        providerMetadata: currentModelResponse.providerMetadata
      });
    }
  });
}
async function executeTools({
  toolCalls,
  tools,
  tracer,
  telemetry,
  abortSignal
}) {
  const toolResults = await Promise.all(
    toolCalls.map(async (toolCall) => {
      const tool2 = tools[toolCall.toolName];
      if ((tool2 == null ? void 0 : tool2.execute) == null) {
        return void 0;
      }
      const result = await recordSpan({
        name: "ai.toolCall",
        attributes: selectTelemetryAttributes({
          telemetry,
          attributes: {
            ...assembleOperationName({
              operationId: "ai.toolCall",
              telemetry
            }),
            "ai.toolCall.name": toolCall.toolName,
            "ai.toolCall.id": toolCall.toolCallId,
            "ai.toolCall.args": {
              output: () => JSON.stringify(toolCall.args)
            }
          }
        }),
        tracer,
        fn: async (span) => {
          const result2 = await tool2.execute(toolCall.args, { abortSignal });
          try {
            span.setAttributes(
              selectTelemetryAttributes({
                telemetry,
                attributes: {
                  "ai.toolCall.result": {
                    output: () => JSON.stringify(result2)
                  }
                }
              })
            );
          } catch (ignored) {
          }
          return result2;
        }
      });
      return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: toolCall.args,
        result
      };
    })
  );
  return toolResults.filter(
    (result) => result != null
  );
}
var DefaultGenerateTextResult = class {
  constructor(options) {
    this.text = options.text;
    this.toolCalls = options.toolCalls;
    this.toolResults = options.toolResults;
    this.finishReason = options.finishReason;
    this.usage = options.usage;
    this.warnings = options.warnings;
    this.request = options.request;
    this.response = options.response;
    this.steps = options.steps;
    this.experimental_providerMetadata = options.providerMetadata;
    this.logprobs = options.logprobs;
  }
};
function mergeStreams(stream1, stream2) {
  const reader1 = stream1.getReader();
  const reader2 = stream2.getReader();
  let lastRead1 = void 0;
  let lastRead2 = void 0;
  let stream1Done = false;
  let stream2Done = false;
  async function readStream1(controller) {
    try {
      if (lastRead1 == null) {
        lastRead1 = reader1.read();
      }
      const result = await lastRead1;
      lastRead1 = void 0;
      if (!result.done) {
        controller.enqueue(result.value);
      } else {
        controller.close();
      }
    } catch (error) {
      controller.error(error);
    }
  }
  async function readStream2(controller) {
    try {
      if (lastRead2 == null) {
        lastRead2 = reader2.read();
      }
      const result = await lastRead2;
      lastRead2 = void 0;
      if (!result.done) {
        controller.enqueue(result.value);
      } else {
        controller.close();
      }
    } catch (error) {
      controller.error(error);
    }
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        if (stream1Done) {
          await readStream2(controller);
          return;
        }
        if (stream2Done) {
          await readStream1(controller);
          return;
        }
        if (lastRead1 == null) {
          lastRead1 = reader1.read();
        }
        if (lastRead2 == null) {
          lastRead2 = reader2.read();
        }
        const { result, reader } = await Promise.race([
          lastRead1.then((result2) => ({ result: result2, reader: reader1 })),
          lastRead2.then((result2) => ({ result: result2, reader: reader2 }))
        ]);
        if (!result.done) {
          controller.enqueue(result.value);
        }
        if (reader === reader1) {
          lastRead1 = void 0;
          if (result.done) {
            await readStream2(controller);
            stream1Done = true;
          }
        } else {
          lastRead2 = void 0;
          if (result.done) {
            stream2Done = true;
            await readStream1(controller);
          }
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      reader1.cancel();
      reader2.cancel();
    }
  });
}
function runToolsTransformation({
  tools,
  generatorStream,
  toolCallStreaming,
  tracer,
  telemetry,
  abortSignal
}) {
  let toolResultsStreamController = null;
  const toolResultsStream = new ReadableStream({
    start(controller) {
      toolResultsStreamController = controller;
    }
  });
  const activeToolCalls = {};
  const outstandingToolResults = /* @__PURE__ */ new Set();
  let canClose = false;
  let finishChunk = void 0;
  function attemptClose() {
    if (canClose && outstandingToolResults.size === 0) {
      if (finishChunk != null) {
        toolResultsStreamController.enqueue(finishChunk);
      }
      toolResultsStreamController.close();
    }
  }
  const forwardStream = new TransformStream({
    transform(chunk, controller) {
      const chunkType = chunk.type;
      switch (chunkType) {
        case "text-delta":
        case "response-metadata":
        case "error": {
          controller.enqueue(chunk);
          break;
        }
        case "tool-call-delta": {
          if (toolCallStreaming) {
            if (!activeToolCalls[chunk.toolCallId]) {
              controller.enqueue({
                type: "tool-call-streaming-start",
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName
              });
              activeToolCalls[chunk.toolCallId] = true;
            }
            controller.enqueue({
              type: "tool-call-delta",
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              argsTextDelta: chunk.argsTextDelta
            });
          }
          break;
        }
        case "tool-call": {
          const toolName = chunk.toolName;
          if (tools == null) {
            toolResultsStreamController.enqueue({
              type: "error",
              error: new NoSuchToolError({ toolName: chunk.toolName })
            });
            break;
          }
          const tool2 = tools[toolName];
          if (tool2 == null) {
            toolResultsStreamController.enqueue({
              type: "error",
              error: new NoSuchToolError({
                toolName: chunk.toolName,
                availableTools: Object.keys(tools)
              })
            });
            break;
          }
          try {
            const toolCall = parseToolCall({
              toolCall: chunk,
              tools
            });
            controller.enqueue(toolCall);
            if (tool2.execute != null) {
              const toolExecutionId = generateId();
              outstandingToolResults.add(toolExecutionId);
              recordSpan({
                name: "ai.toolCall",
                attributes: selectTelemetryAttributes({
                  telemetry,
                  attributes: {
                    ...assembleOperationName({
                      operationId: "ai.toolCall",
                      telemetry
                    }),
                    "ai.toolCall.name": toolCall.toolName,
                    "ai.toolCall.id": toolCall.toolCallId,
                    "ai.toolCall.args": {
                      output: () => JSON.stringify(toolCall.args)
                    }
                  }
                }),
                tracer,
                fn: async (span) => tool2.execute(toolCall.args, { abortSignal }).then(
                  (result) => {
                    toolResultsStreamController.enqueue({
                      ...toolCall,
                      type: "tool-result",
                      result
                    });
                    outstandingToolResults.delete(toolExecutionId);
                    attemptClose();
                    try {
                      span.setAttributes(
                        selectTelemetryAttributes({
                          telemetry,
                          attributes: {
                            "ai.toolCall.result": {
                              output: () => JSON.stringify(result)
                            }
                          }
                        })
                      );
                    } catch (ignored) {
                    }
                  },
                  (error) => {
                    toolResultsStreamController.enqueue({
                      type: "error",
                      error
                    });
                    outstandingToolResults.delete(toolExecutionId);
                    attemptClose();
                  }
                )
              });
            }
          } catch (error) {
            toolResultsStreamController.enqueue({
              type: "error",
              error
            });
          }
          break;
        }
        case "finish": {
          finishChunk = {
            type: "finish",
            finishReason: chunk.finishReason,
            logprobs: chunk.logprobs,
            usage: calculateLanguageModelUsage(chunk.usage),
            experimental_providerMetadata: chunk.providerMetadata
          };
          break;
        }
        default: {
          const _exhaustiveCheck = chunkType;
          throw new Error(`Unhandled chunk type: ${_exhaustiveCheck}`);
        }
      }
    },
    flush() {
      canClose = true;
      attemptClose();
    }
  });
  return new ReadableStream({
    async start(controller) {
      return Promise.all([
        generatorStream.pipeThrough(forwardStream).pipeTo(
          new WritableStream({
            write(chunk) {
              controller.enqueue(chunk);
            },
            close() {
            }
          })
        ),
        toolResultsStream.pipeTo(
          new WritableStream({
            write(chunk) {
              controller.enqueue(chunk);
            },
            close() {
              controller.close();
            }
          })
        )
      ]);
    }
  });
}
var originalGenerateId4 = createIdGenerator({ prefix: "aitxt", size: 24 });
function streamText({
  model,
  tools,
  toolChoice,
  system,
  prompt,
  messages,
  maxRetries,
  abortSignal,
  headers,
  maxSteps = 1,
  experimental_continueSteps: continueSteps = false,
  experimental_telemetry: telemetry,
  experimental_providerMetadata: providerMetadata,
  experimental_toolCallStreaming: toolCallStreaming = false,
  experimental_activeTools: activeTools,
  onChunk,
  onFinish,
  onStepFinish,
  _internal: {
    now: now22 = now2,
    generateId: generateId3 = originalGenerateId4,
    currentDate = () => /* @__PURE__ */ new Date()
  } = {},
  ...settings
}) {
  return new DefaultStreamTextResult({
    model,
    telemetry,
    headers,
    settings,
    maxRetries,
    abortSignal,
    system,
    prompt,
    messages,
    tools,
    toolChoice,
    toolCallStreaming,
    activeTools,
    maxSteps,
    continueSteps,
    providerMetadata,
    onChunk,
    onFinish,
    onStepFinish,
    now: now22,
    currentDate,
    generateId: generateId3
  });
}
var DefaultStreamTextResult = class {
  constructor({
    model,
    telemetry,
    headers,
    settings,
    maxRetries,
    abortSignal,
    system,
    prompt,
    messages,
    tools,
    toolChoice,
    toolCallStreaming,
    activeTools,
    maxSteps,
    continueSteps,
    providerMetadata,
    onChunk,
    onFinish,
    onStepFinish,
    now: now22,
    currentDate,
    generateId: generateId3
  }) {
    this.warningsPromise = new DelayedPromise();
    this.usagePromise = new DelayedPromise();
    this.finishReasonPromise = new DelayedPromise();
    this.providerMetadataPromise = new DelayedPromise();
    this.textPromise = new DelayedPromise();
    this.toolCallsPromise = new DelayedPromise();
    this.toolResultsPromise = new DelayedPromise();
    this.requestPromise = new DelayedPromise();
    this.responsePromise = new DelayedPromise();
    this.stepsPromise = new DelayedPromise();
    this.stitchableStream = createStitchableStream();
    if (maxSteps < 1) {
      throw new InvalidArgumentError2({
        parameter: "maxSteps",
        value: maxSteps,
        message: "maxSteps must be at least 1"
      });
    }
    const tracer = getTracer(telemetry);
    const baseTelemetryAttributes = getBaseTelemetryAttributes({
      model,
      telemetry,
      headers,
      settings: { ...settings, maxRetries }
    });
    const initialPrompt = standardizePrompt({
      prompt: { system, prompt, messages },
      tools
    });
    const self = this;
    recordSpan({
      name: "ai.streamText",
      attributes: selectTelemetryAttributes({
        telemetry,
        attributes: {
          ...assembleOperationName({ operationId: "ai.streamText", telemetry }),
          ...baseTelemetryAttributes,
          // specific settings that only make sense on the outer level:
          "ai.prompt": {
            input: () => JSON.stringify({ system, prompt, messages })
          },
          "ai.settings.maxSteps": maxSteps
        }
      }),
      tracer,
      endWhenDone: false,
      fn: async (rootSpan) => {
        const retry = retryWithExponentialBackoff({ maxRetries });
        const stepResults = [];
        async function streamStep({
          currentStep,
          responseMessages,
          usage,
          stepType,
          previousStepText,
          hasLeadingWhitespace
        }) {
          const promptFormat = responseMessages.length === 0 ? initialPrompt.type : "messages";
          const promptMessages = await convertToLanguageModelPrompt({
            prompt: {
              type: promptFormat,
              system: initialPrompt.system,
              messages: [...initialPrompt.messages, ...responseMessages]
            },
            modelSupportsImageUrls: model.supportsImageUrls,
            modelSupportsUrl: model.supportsUrl
          });
          const mode = {
            type: "regular",
            ...prepareToolsAndToolChoice({ tools, toolChoice, activeTools })
          };
          const {
            result: { stream, warnings, rawResponse, request },
            doStreamSpan,
            startTimestampMs
          } = await retry(
            () => recordSpan({
              name: "ai.streamText.doStream",
              attributes: selectTelemetryAttributes({
                telemetry,
                attributes: {
                  ...assembleOperationName({
                    operationId: "ai.streamText.doStream",
                    telemetry
                  }),
                  ...baseTelemetryAttributes,
                  "ai.prompt.format": {
                    input: () => promptFormat
                  },
                  "ai.prompt.messages": {
                    input: () => JSON.stringify(promptMessages)
                  },
                  "ai.prompt.tools": {
                    // convert the language model level tools:
                    input: () => {
                      var _a112;
                      return (_a112 = mode.tools) == null ? void 0 : _a112.map((tool2) => JSON.stringify(tool2));
                    }
                  },
                  "ai.prompt.toolChoice": {
                    input: () => mode.toolChoice != null ? JSON.stringify(mode.toolChoice) : void 0
                  },
                  // standardized gen-ai llm span attributes:
                  "gen_ai.system": model.provider,
                  "gen_ai.request.model": model.modelId,
                  "gen_ai.request.frequency_penalty": settings.frequencyPenalty,
                  "gen_ai.request.max_tokens": settings.maxTokens,
                  "gen_ai.request.presence_penalty": settings.presencePenalty,
                  "gen_ai.request.stop_sequences": settings.stopSequences,
                  "gen_ai.request.temperature": settings.temperature,
                  "gen_ai.request.top_k": settings.topK,
                  "gen_ai.request.top_p": settings.topP
                }
              }),
              tracer,
              endWhenDone: false,
              fn: async (doStreamSpan2) => ({
                startTimestampMs: now22(),
                // get before the call
                doStreamSpan: doStreamSpan2,
                result: await model.doStream({
                  mode,
                  ...prepareCallSettings(settings),
                  inputFormat: promptFormat,
                  prompt: promptMessages,
                  providerMetadata,
                  abortSignal,
                  headers
                })
              })
            })
          );
          const transformedStream = runToolsTransformation({
            tools,
            generatorStream: stream,
            toolCallStreaming,
            tracer,
            telemetry,
            abortSignal
          });
          const stepRequest = request != null ? request : {};
          const stepToolCalls = [];
          const stepToolResults = [];
          let stepFinishReason = "unknown";
          let stepUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0
          };
          let stepProviderMetadata;
          let stepFirstChunk = true;
          let stepText = "";
          let fullStepText = stepType === "continue" ? previousStepText : "";
          let stepLogProbs;
          let stepResponse = {
            id: generateId3(),
            timestamp: currentDate(),
            modelId: model.modelId
          };
          let chunkBuffer = "";
          let chunkTextPublished = false;
          let inWhitespacePrefix = true;
          let hasWhitespaceSuffix = false;
          async function publishTextChunk({
            controller,
            chunk
          }) {
            controller.enqueue(chunk);
            stepText += chunk.textDelta;
            fullStepText += chunk.textDelta;
            chunkTextPublished = true;
            hasWhitespaceSuffix = chunk.textDelta.trimEnd() !== chunk.textDelta;
            await (onChunk == null ? void 0 : onChunk({ chunk }));
          }
          self.stitchableStream.addStream(
            transformedStream.pipeThrough(
              new TransformStream({
                async transform(chunk, controller) {
                  var _a112, _b, _c;
                  if (stepFirstChunk) {
                    const msToFirstChunk = now22() - startTimestampMs;
                    stepFirstChunk = false;
                    doStreamSpan.addEvent("ai.stream.firstChunk", {
                      "ai.response.msToFirstChunk": msToFirstChunk
                    });
                    doStreamSpan.setAttributes({
                      "ai.response.msToFirstChunk": msToFirstChunk
                    });
                  }
                  if (chunk.type === "text-delta" && chunk.textDelta.length === 0) {
                    return;
                  }
                  const chunkType = chunk.type;
                  switch (chunkType) {
                    case "text-delta": {
                      if (continueSteps) {
                        const trimmedChunkText = inWhitespacePrefix && hasLeadingWhitespace ? chunk.textDelta.trimStart() : chunk.textDelta;
                        if (trimmedChunkText.length === 0) {
                          break;
                        }
                        inWhitespacePrefix = false;
                        chunkBuffer += trimmedChunkText;
                        const split = splitOnLastWhitespace(chunkBuffer);
                        if (split != null) {
                          chunkBuffer = split.suffix;
                          await publishTextChunk({
                            controller,
                            chunk: {
                              type: "text-delta",
                              textDelta: split.prefix + split.whitespace
                            }
                          });
                        }
                      } else {
                        await publishTextChunk({ controller, chunk });
                      }
                      break;
                    }
                    case "tool-call": {
                      controller.enqueue(chunk);
                      stepToolCalls.push(chunk);
                      await (onChunk == null ? void 0 : onChunk({ chunk }));
                      break;
                    }
                    case "tool-result": {
                      controller.enqueue(chunk);
                      stepToolResults.push(chunk);
                      await (onChunk == null ? void 0 : onChunk({ chunk }));
                      break;
                    }
                    case "response-metadata": {
                      stepResponse = {
                        id: (_a112 = chunk.id) != null ? _a112 : stepResponse.id,
                        timestamp: (_b = chunk.timestamp) != null ? _b : stepResponse.timestamp,
                        modelId: (_c = chunk.modelId) != null ? _c : stepResponse.modelId
                      };
                      break;
                    }
                    case "finish": {
                      stepUsage = chunk.usage;
                      stepFinishReason = chunk.finishReason;
                      stepProviderMetadata = chunk.experimental_providerMetadata;
                      stepLogProbs = chunk.logprobs;
                      const msToFinish = now22() - startTimestampMs;
                      doStreamSpan.addEvent("ai.stream.finish");
                      doStreamSpan.setAttributes({
                        "ai.response.msToFinish": msToFinish,
                        "ai.response.avgCompletionTokensPerSecond": 1e3 * stepUsage.completionTokens / msToFinish
                      });
                      break;
                    }
                    case "tool-call-streaming-start":
                    case "tool-call-delta": {
                      controller.enqueue(chunk);
                      await (onChunk == null ? void 0 : onChunk({ chunk }));
                      break;
                    }
                    case "error": {
                      controller.enqueue(chunk);
                      stepFinishReason = "error";
                      break;
                    }
                    default: {
                      const exhaustiveCheck = chunkType;
                      throw new Error(`Unknown chunk type: ${exhaustiveCheck}`);
                    }
                  }
                },
                // invoke onFinish callback and resolve toolResults promise when the stream is about to close:
                async flush(controller) {
                  const stepToolCallsJson = stepToolCalls.length > 0 ? JSON.stringify(stepToolCalls) : void 0;
                  let nextStepType = "done";
                  if (currentStep + 1 < maxSteps) {
                    if (continueSteps && stepFinishReason === "length" && // only use continue when there are no tool calls:
                    stepToolCalls.length === 0) {
                      nextStepType = "continue";
                    } else if (
                      // there are tool calls:
                      stepToolCalls.length > 0 && // all current tool calls have results:
                      stepToolResults.length === stepToolCalls.length
                    ) {
                      nextStepType = "tool-result";
                    }
                  }
                  if (continueSteps && chunkBuffer.length > 0 && (nextStepType !== "continue" || // when the next step is a regular step, publish the buffer
                  stepType === "continue" && !chunkTextPublished)) {
                    await publishTextChunk({
                      controller,
                      chunk: {
                        type: "text-delta",
                        textDelta: chunkBuffer
                      }
                    });
                    chunkBuffer = "";
                  }
                  try {
                    doStreamSpan.setAttributes(
                      selectTelemetryAttributes({
                        telemetry,
                        attributes: {
                          "ai.response.finishReason": stepFinishReason,
                          "ai.response.text": { output: () => stepText },
                          "ai.response.toolCalls": {
                            output: () => stepToolCallsJson
                          },
                          "ai.response.id": stepResponse.id,
                          "ai.response.model": stepResponse.modelId,
                          "ai.response.timestamp": stepResponse.timestamp.toISOString(),
                          "ai.usage.promptTokens": stepUsage.promptTokens,
                          "ai.usage.completionTokens": stepUsage.completionTokens,
                          // standardized gen-ai llm span attributes:
                          "gen_ai.response.finish_reasons": [stepFinishReason],
                          "gen_ai.response.id": stepResponse.id,
                          "gen_ai.response.model": stepResponse.modelId,
                          "gen_ai.usage.input_tokens": stepUsage.promptTokens,
                          "gen_ai.usage.output_tokens": stepUsage.completionTokens
                        }
                      })
                    );
                  } catch (error) {
                  } finally {
                    doStreamSpan.end();
                  }
                  controller.enqueue({
                    type: "step-finish",
                    finishReason: stepFinishReason,
                    usage: stepUsage,
                    experimental_providerMetadata: stepProviderMetadata,
                    logprobs: stepLogProbs,
                    response: {
                      ...stepResponse
                    },
                    isContinued: nextStepType === "continue"
                  });
                  if (stepType === "continue") {
                    const lastMessage = responseMessages[responseMessages.length - 1];
                    if (typeof lastMessage.content === "string") {
                      lastMessage.content += stepText;
                    } else {
                      lastMessage.content.push({
                        text: stepText,
                        type: "text"
                      });
                    }
                  } else {
                    responseMessages.push(
                      ...toResponseMessages({
                        text: stepText,
                        tools: tools != null ? tools : {},
                        toolCalls: stepToolCalls,
                        toolResults: stepToolResults
                      })
                    );
                  }
                  const currentStepResult = {
                    stepType,
                    text: stepText,
                    toolCalls: stepToolCalls,
                    toolResults: stepToolResults,
                    finishReason: stepFinishReason,
                    usage: stepUsage,
                    warnings,
                    logprobs: stepLogProbs,
                    request: stepRequest,
                    response: {
                      ...stepResponse,
                      headers: rawResponse == null ? void 0 : rawResponse.headers,
                      // deep clone msgs to avoid mutating past messages in multi-step:
                      messages: JSON.parse(JSON.stringify(responseMessages))
                    },
                    experimental_providerMetadata: stepProviderMetadata,
                    isContinued: nextStepType === "continue"
                  };
                  stepResults.push(currentStepResult);
                  await (onStepFinish == null ? void 0 : onStepFinish(currentStepResult));
                  const combinedUsage = {
                    promptTokens: usage.promptTokens + stepUsage.promptTokens,
                    completionTokens: usage.completionTokens + stepUsage.completionTokens,
                    totalTokens: usage.totalTokens + stepUsage.totalTokens
                  };
                  if (nextStepType !== "done") {
                    await streamStep({
                      currentStep: currentStep + 1,
                      responseMessages,
                      usage: combinedUsage,
                      stepType: nextStepType,
                      previousStepText: fullStepText,
                      hasLeadingWhitespace: hasWhitespaceSuffix
                    });
                    return;
                  }
                  try {
                    controller.enqueue({
                      type: "finish",
                      finishReason: stepFinishReason,
                      usage: combinedUsage,
                      experimental_providerMetadata: stepProviderMetadata,
                      logprobs: stepLogProbs,
                      response: {
                        ...stepResponse
                      }
                    });
                    self.stitchableStream.close();
                    rootSpan.setAttributes(
                      selectTelemetryAttributes({
                        telemetry,
                        attributes: {
                          "ai.response.finishReason": stepFinishReason,
                          "ai.response.text": { output: () => fullStepText },
                          "ai.response.toolCalls": {
                            output: () => stepToolCallsJson
                          },
                          "ai.usage.promptTokens": combinedUsage.promptTokens,
                          "ai.usage.completionTokens": combinedUsage.completionTokens
                        }
                      })
                    );
                    self.usagePromise.resolve(combinedUsage);
                    self.finishReasonPromise.resolve(stepFinishReason);
                    self.textPromise.resolve(fullStepText);
                    self.toolCallsPromise.resolve(stepToolCalls);
                    self.providerMetadataPromise.resolve(stepProviderMetadata);
                    self.toolResultsPromise.resolve(stepToolResults);
                    self.requestPromise.resolve(stepRequest);
                    self.responsePromise.resolve({
                      ...stepResponse,
                      headers: rawResponse == null ? void 0 : rawResponse.headers,
                      messages: responseMessages
                    });
                    self.stepsPromise.resolve(stepResults);
                    self.warningsPromise.resolve(warnings != null ? warnings : []);
                    await (onFinish == null ? void 0 : onFinish({
                      finishReason: stepFinishReason,
                      logprobs: stepLogProbs,
                      usage: combinedUsage,
                      text: fullStepText,
                      toolCalls: stepToolCalls,
                      // The tool results are inferred as a never[] type, because they are
                      // optional and the execute method with an inferred result type is
                      // optional as well. Therefore we need to cast the toolResults to any.
                      // The type exposed to the users will be correctly inferred.
                      toolResults: stepToolResults,
                      request: stepRequest,
                      response: {
                        ...stepResponse,
                        headers: rawResponse == null ? void 0 : rawResponse.headers,
                        messages: responseMessages
                      },
                      warnings,
                      experimental_providerMetadata: stepProviderMetadata,
                      steps: stepResults
                    }));
                  } catch (error) {
                    controller.error(error);
                  } finally {
                    rootSpan.end();
                  }
                }
              })
            )
          );
        }
        await streamStep({
          currentStep: 0,
          responseMessages: [],
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0
          },
          previousStepText: "",
          stepType: "initial",
          hasLeadingWhitespace: false
        });
      }
    }).catch((error) => {
      self.stitchableStream.addStream(
        new ReadableStream({
          start(controller) {
            controller.error(error);
          }
        })
      );
      self.stitchableStream.close();
    });
  }
  get warnings() {
    return this.warningsPromise.value;
  }
  get usage() {
    return this.usagePromise.value;
  }
  get finishReason() {
    return this.finishReasonPromise.value;
  }
  get experimental_providerMetadata() {
    return this.providerMetadataPromise.value;
  }
  get text() {
    return this.textPromise.value;
  }
  get toolCalls() {
    return this.toolCallsPromise.value;
  }
  get toolResults() {
    return this.toolResultsPromise.value;
  }
  get request() {
    return this.requestPromise.value;
  }
  get response() {
    return this.responsePromise.value;
  }
  get steps() {
    return this.stepsPromise.value;
  }
  /**
  Split out a new stream from the original stream.
  The original stream is replaced to allow for further splitting,
  since we do not know how many times the stream will be split.
  
  Note: this leads to buffering the stream content on the server.
  However, the LLM results are expected to be small enough to not cause issues.
     */
  teeStream() {
    const [stream1, stream2] = this.stitchableStream.stream.tee();
    this.stitchableStream.stream = stream2;
    return stream1;
  }
  get textStream() {
    return createAsyncIterableStream(this.teeStream(), {
      transform(chunk, controller) {
        if (chunk.type === "text-delta") {
          controller.enqueue(chunk.textDelta);
        } else if (chunk.type === "error") {
          controller.error(chunk.error);
        }
      }
    });
  }
  get fullStream() {
    return createAsyncIterableStream(this.teeStream(), {
      transform(chunk, controller) {
        controller.enqueue(chunk);
      }
    });
  }
  toDataStreamInternal({
    getErrorMessage: getErrorMessage3 = () => "",
    // mask error messages for safety by default
    sendUsage = true
  } = {}) {
    let aggregatedResponse = "";
    const callbackTransformer = new TransformStream({
      async transform(chunk, controller) {
        controller.enqueue(chunk);
        if (chunk.type === "text-delta") {
          aggregatedResponse += chunk.textDelta;
        }
      }
    });
    const streamPartsTransformer = new TransformStream({
      transform: async (chunk, controller) => {
        const chunkType = chunk.type;
        switch (chunkType) {
          case "text-delta": {
            controller.enqueue(formatDataStreamPart("text", chunk.textDelta));
            break;
          }
          case "tool-call-streaming-start": {
            controller.enqueue(
              formatDataStreamPart("tool_call_streaming_start", {
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName
              })
            );
            break;
          }
          case "tool-call-delta": {
            controller.enqueue(
              formatDataStreamPart("tool_call_delta", {
                toolCallId: chunk.toolCallId,
                argsTextDelta: chunk.argsTextDelta
              })
            );
            break;
          }
          case "tool-call": {
            controller.enqueue(
              formatDataStreamPart("tool_call", {
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                args: chunk.args
              })
            );
            break;
          }
          case "tool-result": {
            controller.enqueue(
              formatDataStreamPart("tool_result", {
                toolCallId: chunk.toolCallId,
                result: chunk.result
              })
            );
            break;
          }
          case "error": {
            controller.enqueue(
              formatDataStreamPart("error", getErrorMessage3(chunk.error))
            );
            break;
          }
          case "step-finish": {
            controller.enqueue(
              formatDataStreamPart("finish_step", {
                finishReason: chunk.finishReason,
                usage: sendUsage ? {
                  promptTokens: chunk.usage.promptTokens,
                  completionTokens: chunk.usage.completionTokens
                } : void 0,
                isContinued: chunk.isContinued
              })
            );
            break;
          }
          case "finish": {
            controller.enqueue(
              formatDataStreamPart("finish_message", {
                finishReason: chunk.finishReason,
                usage: sendUsage ? {
                  promptTokens: chunk.usage.promptTokens,
                  completionTokens: chunk.usage.completionTokens
                } : void 0
              })
            );
            break;
          }
          default: {
            const exhaustiveCheck = chunkType;
            throw new Error(`Unknown chunk type: ${exhaustiveCheck}`);
          }
        }
      }
    });
    return this.fullStream.pipeThrough(callbackTransformer).pipeThrough(streamPartsTransformer).pipeThrough(new TextEncoderStream());
  }
  pipeDataStreamToResponse(response, {
    status,
    statusText,
    headers,
    data,
    getErrorMessage: getErrorMessage3,
    sendUsage
  } = {}) {
    writeToServerResponse({
      response,
      status,
      statusText,
      headers: prepareOutgoingHttpHeaders(headers, {
        contentType: "text/plain; charset=utf-8",
        dataStreamVersion: "v1"
      }),
      stream: this.toDataStream({ data, getErrorMessage: getErrorMessage3, sendUsage })
    });
  }
  pipeTextStreamToResponse(response, init) {
    writeToServerResponse({
      response,
      status: init == null ? void 0 : init.status,
      statusText: init == null ? void 0 : init.statusText,
      headers: prepareOutgoingHttpHeaders(init == null ? void 0 : init.headers, {
        contentType: "text/plain; charset=utf-8"
      }),
      stream: this.textStream.pipeThrough(new TextEncoderStream())
    });
  }
  toDataStream(options) {
    const stream = this.toDataStreamInternal({
      getErrorMessage: options == null ? void 0 : options.getErrorMessage,
      sendUsage: options == null ? void 0 : options.sendUsage
    });
    return (options == null ? void 0 : options.data) ? mergeStreams(options == null ? void 0 : options.data.stream, stream) : stream;
  }
  toDataStreamResponse({
    headers,
    status,
    statusText,
    data,
    getErrorMessage: getErrorMessage3,
    sendUsage
  } = {}) {
    return new Response(
      this.toDataStream({ data, getErrorMessage: getErrorMessage3, sendUsage }),
      {
        status,
        statusText,
        headers: prepareResponseHeaders(headers, {
          contentType: "text/plain; charset=utf-8",
          dataStreamVersion: "v1"
        })
      }
    );
  }
  toTextStreamResponse(init) {
    var _a112;
    return new Response(this.textStream.pipeThrough(new TextEncoderStream()), {
      status: (_a112 = init == null ? void 0 : init.status) != null ? _a112 : 200,
      headers: prepareResponseHeaders(init == null ? void 0 : init.headers, {
        contentType: "text/plain; charset=utf-8"
      })
    });
  }
};
var name102 = "AI_NoSuchProviderError";
var marker102 = `vercel.ai.error.${name102}`;
var symbol102 = Symbol.for(marker102);
var _a102;
_a102 = symbol102;
var langchain_adapter_exports = {};
__export2(langchain_adapter_exports, {
  toDataStream: () => toDataStream,
  toDataStreamResponse: () => toDataStreamResponse
});
function createCallbacksTransformer(callbacks = {}) {
  const textEncoder = new TextEncoder();
  let aggregatedResponse = "";
  return new TransformStream({
    async start() {
      if (callbacks.onStart)
        await callbacks.onStart();
    },
    async transform(message, controller) {
      controller.enqueue(textEncoder.encode(message));
      aggregatedResponse += message;
      if (callbacks.onToken)
        await callbacks.onToken(message);
      if (callbacks.onText && typeof message === "string") {
        await callbacks.onText(message);
      }
    },
    async flush() {
      if (callbacks.onCompletion) {
        await callbacks.onCompletion(aggregatedResponse);
      }
    }
  });
}
var HANGING_STREAM_WARNING_TIME_MS = 15 * 1e3;
function createStreamDataTransformer() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return new TransformStream({
    transform: async (chunk, controller) => {
      const message = decoder.decode(chunk);
      controller.enqueue(encoder.encode(formatDataStreamPart("text", message)));
    }
  });
}
function toDataStream(stream, callbacks) {
  return stream.pipeThrough(
    new TransformStream({
      transform: async (value, controller) => {
        var _a112;
        if (typeof value === "string") {
          controller.enqueue(value);
          return;
        }
        if ("event" in value) {
          if (value.event === "on_chat_model_stream") {
            forwardAIMessageChunk(
              (_a112 = value.data) == null ? void 0 : _a112.chunk,
              controller
            );
          }
          return;
        }
        forwardAIMessageChunk(value, controller);
      }
    })
  ).pipeThrough(createCallbacksTransformer(callbacks)).pipeThrough(createStreamDataTransformer());
}
function toDataStreamResponse(stream, options) {
  var _a112;
  const dataStream = toDataStream(stream, options == null ? void 0 : options.callbacks);
  const data = options == null ? void 0 : options.data;
  const init = options == null ? void 0 : options.init;
  const responseStream = data ? mergeStreams(data.stream, dataStream) : dataStream;
  return new Response(responseStream, {
    status: (_a112 = init == null ? void 0 : init.status) != null ? _a112 : 200,
    statusText: init == null ? void 0 : init.statusText,
    headers: prepareResponseHeaders(init == null ? void 0 : init.headers, {
      contentType: "text/plain; charset=utf-8",
      dataStreamVersion: "v1"
    })
  });
}
function forwardAIMessageChunk(chunk, controller) {
  if (typeof chunk.content === "string") {
    controller.enqueue(chunk.content);
  } else {
    const content = chunk.content;
    for (const item of content) {
      if (item.type === "text") {
        controller.enqueue(item.text);
      }
    }
  }
}
var llamaindex_adapter_exports = {};
__export2(llamaindex_adapter_exports, {
  toDataStream: () => toDataStream2,
  toDataStreamResponse: () => toDataStreamResponse2
});
function toDataStream2(stream, callbacks) {
  const trimStart = trimStartOfStream();
  return convertAsyncIteratorToReadableStream(stream[Symbol.asyncIterator]()).pipeThrough(
    new TransformStream({
      async transform(message, controller) {
        controller.enqueue(trimStart(message.delta));
      }
    })
  ).pipeThrough(createCallbacksTransformer(callbacks)).pipeThrough(createStreamDataTransformer());
}
function toDataStreamResponse2(stream, options = {}) {
  var _a112;
  const { init, data, callbacks } = options;
  const dataStream = toDataStream2(stream, callbacks);
  const responseStream = data ? mergeStreams(data.stream, dataStream) : dataStream;
  return new Response(responseStream, {
    status: (_a112 = init == null ? void 0 : init.status) != null ? _a112 : 200,
    statusText: init == null ? void 0 : init.statusText,
    headers: prepareResponseHeaders(init == null ? void 0 : init.headers, {
      contentType: "text/plain; charset=utf-8",
      dataStreamVersion: "v1"
    })
  });
}
function trimStartOfStream() {
  let isStreamStart = true;
  return (text) => {
    if (isStreamStart) {
      text = text.trimStart();
      if (text)
        isStreamStart = false;
    }
    return text;
  };
}

// ../../node_modules/.pnpm/@ai-sdk+anthropic@1.0.0_zod@3.23.0/node_modules/@ai-sdk/anthropic/dist/index.mjs
var anthropicErrorDataSchema = z.object({
  type: z.literal("error"),
  error: z.object({
    type: z.string(),
    message: z.string()
  })
});
var anthropicFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: anthropicErrorDataSchema,
  errorToMessage: (data) => data.error.message
});
function convertToAnthropicMessagesPrompt({
  prompt,
  cacheControl: isCacheControlEnabled
}) {
  var _a16, _b, _c, _d;
  const betas = /* @__PURE__ */ new Set();
  const blocks = groupIntoBlocks(prompt);
  let system = void 0;
  const messages = [];
  function getCacheControl(providerMetadata) {
    var _a23;
    if (isCacheControlEnabled === false) {
      return void 0;
    }
    const anthropic2 = providerMetadata == null ? void 0 : providerMetadata.anthropic;
    const cacheControlValue = (_a23 = anthropic2 == null ? void 0 : anthropic2.cacheControl) != null ? _a23 : anthropic2 == null ? void 0 : anthropic2.cache_control;
    return cacheControlValue;
  }
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const isLastBlock = i === blocks.length - 1;
    const type = block.type;
    switch (type) {
      case "system": {
        if (system != null) {
          throw new UnsupportedFunctionalityError({
            functionality: "Multiple system messages that are separated by user/assistant messages"
          });
        }
        system = block.messages.map(({ content, providerMetadata }) => ({
          type: "text",
          text: content,
          cache_control: getCacheControl(providerMetadata)
        }));
        break;
      }
      case "user": {
        const anthropicContent = [];
        for (const message of block.messages) {
          const { role, content } = message;
          switch (role) {
            case "user": {
              for (let j = 0; j < content.length; j++) {
                const part = content[j];
                const isLastPart = j === content.length - 1;
                const cacheControl = (_a16 = getCacheControl(part.providerMetadata)) != null ? _a16 : isLastPart ? getCacheControl(message.providerMetadata) : void 0;
                switch (part.type) {
                  case "text": {
                    anthropicContent.push({
                      type: "text",
                      text: part.text,
                      cache_control: cacheControl
                    });
                    break;
                  }
                  case "image": {
                    if (part.image instanceof URL) {
                      throw new UnsupportedFunctionalityError({
                        functionality: "Image URLs in user messages"
                      });
                    }
                    anthropicContent.push({
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: (_b = part.mimeType) != null ? _b : "image/jpeg",
                        data: convertUint8ArrayToBase64(part.image)
                      },
                      cache_control: cacheControl
                    });
                    break;
                  }
                  case "file": {
                    if (part.data instanceof URL) {
                      throw new UnsupportedFunctionalityError({
                        functionality: "Image URLs in user messages"
                      });
                    }
                    if (part.mimeType !== "application/pdf") {
                      throw new UnsupportedFunctionalityError({
                        functionality: "Non-PDF files in user messages"
                      });
                    }
                    betas.add("pdfs-2024-09-25");
                    anthropicContent.push({
                      type: "document",
                      source: {
                        type: "base64",
                        media_type: "application/pdf",
                        data: part.data
                      },
                      cache_control: cacheControl
                    });
                    break;
                  }
                }
              }
              break;
            }
            case "tool": {
              for (let i2 = 0; i2 < content.length; i2++) {
                const part = content[i2];
                const isLastPart = i2 === content.length - 1;
                const cacheControl = (_c = getCacheControl(part.providerMetadata)) != null ? _c : isLastPart ? getCacheControl(message.providerMetadata) : void 0;
                const toolResultContent = part.content != null ? part.content.map((part2) => {
                  var _a23;
                  switch (part2.type) {
                    case "text":
                      return {
                        type: "text",
                        text: part2.text,
                        cache_control: void 0
                      };
                    case "image":
                      return {
                        type: "image",
                        source: {
                          type: "base64",
                          media_type: (_a23 = part2.mimeType) != null ? _a23 : "image/jpeg",
                          data: part2.data
                        },
                        cache_control: void 0
                      };
                  }
                }) : JSON.stringify(part.result);
                anthropicContent.push({
                  type: "tool_result",
                  tool_use_id: part.toolCallId,
                  content: toolResultContent,
                  is_error: part.isError,
                  cache_control: cacheControl
                });
              }
              break;
            }
            default: {
              const _exhaustiveCheck = role;
              throw new Error(`Unsupported role: ${_exhaustiveCheck}`);
            }
          }
        }
        messages.push({ role: "user", content: anthropicContent });
        break;
      }
      case "assistant": {
        const anthropicContent = [];
        for (let j = 0; j < block.messages.length; j++) {
          const message = block.messages[j];
          const isLastMessage = j === block.messages.length - 1;
          const { content } = message;
          for (let k = 0; k < content.length; k++) {
            const part = content[k];
            const isLastContentPart = k === content.length - 1;
            const cacheControl = (_d = getCacheControl(part.providerMetadata)) != null ? _d : isLastContentPart ? getCacheControl(message.providerMetadata) : void 0;
            switch (part.type) {
              case "text": {
                anthropicContent.push({
                  type: "text",
                  text: (
                    // trim the last text part if it's the last message in the block
                    // because Anthropic does not allow trailing whitespace
                    // in pre-filled assistant responses
                    isLastBlock && isLastMessage && isLastContentPart ? part.text.trim() : part.text
                  ),
                  cache_control: cacheControl
                });
                break;
              }
              case "tool-call": {
                anthropicContent.push({
                  type: "tool_use",
                  id: part.toolCallId,
                  name: part.toolName,
                  input: part.args,
                  cache_control: cacheControl
                });
                break;
              }
            }
          }
        }
        messages.push({ role: "assistant", content: anthropicContent });
        break;
      }
      default: {
        const _exhaustiveCheck = type;
        throw new Error(`Unsupported type: ${_exhaustiveCheck}`);
      }
    }
  }
  return {
    prompt: { system, messages },
    betas
  };
}
function groupIntoBlocks(prompt) {
  const blocks = [];
  let currentBlock = void 0;
  for (const message of prompt) {
    const { role } = message;
    switch (role) {
      case "system": {
        if ((currentBlock == null ? void 0 : currentBlock.type) !== "system") {
          currentBlock = { type: "system", messages: [] };
          blocks.push(currentBlock);
        }
        currentBlock.messages.push(message);
        break;
      }
      case "assistant": {
        if ((currentBlock == null ? void 0 : currentBlock.type) !== "assistant") {
          currentBlock = { type: "assistant", messages: [] };
          blocks.push(currentBlock);
        }
        currentBlock.messages.push(message);
        break;
      }
      case "user": {
        if ((currentBlock == null ? void 0 : currentBlock.type) !== "user") {
          currentBlock = { type: "user", messages: [] };
          blocks.push(currentBlock);
        }
        currentBlock.messages.push(message);
        break;
      }
      case "tool": {
        if ((currentBlock == null ? void 0 : currentBlock.type) !== "user") {
          currentBlock = { type: "user", messages: [] };
          blocks.push(currentBlock);
        }
        currentBlock.messages.push(message);
        break;
      }
      default: {
        const _exhaustiveCheck = role;
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`);
      }
    }
  }
  return blocks;
}
function mapAnthropicStopReason(finishReason) {
  switch (finishReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool-calls";
    case "max_tokens":
      return "length";
    default:
      return "unknown";
  }
}
function prepareTools(mode) {
  var _a16;
  const tools = ((_a16 = mode.tools) == null ? void 0 : _a16.length) ? mode.tools : void 0;
  const toolWarnings = [];
  const betas = /* @__PURE__ */ new Set();
  if (tools == null) {
    return { tools: void 0, tool_choice: void 0, toolWarnings, betas };
  }
  const anthropicTools2 = [];
  for (const tool of tools) {
    switch (tool.type) {
      case "function":
        anthropicTools2.push({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters
        });
        break;
      case "provider-defined":
        betas.add("computer-use-2024-10-22");
        switch (tool.id) {
          case "anthropic.computer_20241022":
            anthropicTools2.push({
              name: tool.name,
              type: "computer_20241022",
              display_width_px: tool.args.displayWidthPx,
              display_height_px: tool.args.displayHeightPx,
              display_number: tool.args.displayNumber
            });
            break;
          case "anthropic.text_editor_20241022":
            anthropicTools2.push({
              name: tool.name,
              type: "text_editor_20241022"
            });
            break;
          case "anthropic.bash_20241022":
            anthropicTools2.push({
              name: tool.name,
              type: "bash_20241022"
            });
            break;
          default:
            toolWarnings.push({ type: "unsupported-tool", tool });
            break;
        }
        break;
      default:
        toolWarnings.push({ type: "unsupported-tool", tool });
        break;
    }
  }
  const toolChoice = mode.toolChoice;
  if (toolChoice == null) {
    return {
      tools: anthropicTools2,
      tool_choice: void 0,
      toolWarnings,
      betas
    };
  }
  const type = toolChoice.type;
  switch (type) {
    case "auto":
      return {
        tools: anthropicTools2,
        tool_choice: { type: "auto" },
        toolWarnings,
        betas
      };
    case "required":
      return {
        tools: anthropicTools2,
        tool_choice: { type: "any" },
        toolWarnings,
        betas
      };
    case "none":
      return { tools: void 0, tool_choice: void 0, toolWarnings, betas };
    case "tool":
      return {
        tools: anthropicTools2,
        tool_choice: { type: "tool", name: toolChoice.toolName },
        toolWarnings,
        betas
      };
    default: {
      const _exhaustiveCheck = type;
      throw new UnsupportedFunctionalityError({
        functionality: `Unsupported tool choice type: ${_exhaustiveCheck}`
      });
    }
  }
}
var AnthropicMessagesLanguageModel = class {
  constructor(modelId, settings, config) {
    this.specificationVersion = "v1";
    this.defaultObjectGenerationMode = "tool";
    this.supportsImageUrls = false;
    this.modelId = modelId;
    this.settings = settings;
    this.config = config;
  }
  get provider() {
    return this.config.provider;
  }
  async getArgs({
    mode,
    prompt,
    maxTokens,
    temperature,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    stopSequences,
    responseFormat,
    seed
  }) {
    var _a16;
    const type = mode.type;
    const warnings = [];
    if (frequencyPenalty != null) {
      warnings.push({
        type: "unsupported-setting",
        setting: "frequencyPenalty"
      });
    }
    if (presencePenalty != null) {
      warnings.push({
        type: "unsupported-setting",
        setting: "presencePenalty"
      });
    }
    if (seed != null) {
      warnings.push({
        type: "unsupported-setting",
        setting: "seed"
      });
    }
    if (responseFormat != null && responseFormat.type !== "text") {
      warnings.push({
        type: "unsupported-setting",
        setting: "responseFormat",
        details: "JSON response format is not supported."
      });
    }
    const { prompt: messagesPrompt, betas: messagesBetas } = convertToAnthropicMessagesPrompt({
      prompt,
      cacheControl: (_a16 = this.settings.cacheControl) != null ? _a16 : false
    });
    const baseArgs = {
      // model id:
      model: this.modelId,
      // standardized settings:
      max_tokens: maxTokens != null ? maxTokens : 4096,
      // 4096: max model output tokens TODO remove
      temperature,
      top_k: topK,
      top_p: topP,
      stop_sequences: stopSequences,
      // prompt:
      system: messagesPrompt.system,
      messages: messagesPrompt.messages
    };
    switch (type) {
      case "regular": {
        const {
          tools,
          tool_choice,
          toolWarnings,
          betas: toolsBetas
        } = prepareTools(mode);
        return {
          args: { ...baseArgs, tools, tool_choice },
          warnings: [...warnings, ...toolWarnings],
          betas: /* @__PURE__ */ new Set([...messagesBetas, ...toolsBetas])
        };
      }
      case "object-json": {
        throw new UnsupportedFunctionalityError({
          functionality: "json-mode object generation"
        });
      }
      case "object-tool": {
        const { name: name15, description, parameters } = mode.tool;
        return {
          args: {
            ...baseArgs,
            tools: [{ name: name15, description, input_schema: parameters }],
            tool_choice: { type: "tool", name: name15 }
          },
          warnings,
          betas: messagesBetas
        };
      }
      default: {
        const _exhaustiveCheck = type;
        throw new Error(`Unsupported type: ${_exhaustiveCheck}`);
      }
    }
  }
  getHeaders({
    betas,
    headers
  }) {
    if (this.settings.cacheControl) {
      betas.add("prompt-caching-2024-07-31");
    }
    return combineHeaders(
      this.config.headers(),
      betas.size > 0 ? { "anthropic-beta": Array.from(betas).join(",") } : {},
      headers
    );
  }
  async doGenerate(options) {
    var _a16, _b, _c, _d;
    const { args, warnings, betas } = await this.getArgs(options);
    const { responseHeaders, value: response } = await postJsonToApi({
      url: `${this.config.baseURL}/messages`,
      headers: this.getHeaders({ betas, headers: options.headers }),
      body: args,
      failedResponseHandler: anthropicFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(
        anthropicMessagesResponseSchema
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    const { messages: rawPrompt, ...rawSettings } = args;
    let text = "";
    for (const content of response.content) {
      if (content.type === "text") {
        text += content.text;
      }
    }
    let toolCalls = void 0;
    if (response.content.some((content) => content.type === "tool_use")) {
      toolCalls = [];
      for (const content of response.content) {
        if (content.type === "tool_use") {
          toolCalls.push({
            toolCallType: "function",
            toolCallId: content.id,
            toolName: content.name,
            args: JSON.stringify(content.input)
          });
        }
      }
    }
    return {
      text,
      toolCalls,
      finishReason: mapAnthropicStopReason(response.stop_reason),
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens
      },
      rawCall: { rawPrompt, rawSettings },
      rawResponse: { headers: responseHeaders },
      response: {
        id: (_a16 = response.id) != null ? _a16 : void 0,
        modelId: (_b = response.model) != null ? _b : void 0
      },
      warnings,
      providerMetadata: this.settings.cacheControl === true ? {
        anthropic: {
          cacheCreationInputTokens: (_c = response.usage.cache_creation_input_tokens) != null ? _c : null,
          cacheReadInputTokens: (_d = response.usage.cache_read_input_tokens) != null ? _d : null
        }
      } : void 0,
      request: { body: JSON.stringify(args) }
    };
  }
  async doStream(options) {
    const { args, warnings, betas } = await this.getArgs(options);
    const body = { ...args, stream: true };
    const { responseHeaders, value: response } = await postJsonToApi({
      url: `${this.config.baseURL}/messages`,
      headers: this.getHeaders({ betas, headers: options.headers }),
      body,
      failedResponseHandler: anthropicFailedResponseHandler,
      successfulResponseHandler: createEventSourceResponseHandler(
        anthropicMessagesChunkSchema
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    const { messages: rawPrompt, ...rawSettings } = args;
    let finishReason = "unknown";
    const usage = {
      promptTokens: Number.NaN,
      completionTokens: Number.NaN
    };
    const toolCallContentBlocks = {};
    let providerMetadata = void 0;
    const self = this;
    return {
      stream: response.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            var _a16, _b, _c, _d;
            if (!chunk.success) {
              controller.enqueue({ type: "error", error: chunk.error });
              return;
            }
            const value = chunk.value;
            switch (value.type) {
              case "ping": {
                return;
              }
              case "content_block_start": {
                const contentBlockType = value.content_block.type;
                switch (contentBlockType) {
                  case "text": {
                    return;
                  }
                  case "tool_use": {
                    toolCallContentBlocks[value.index] = {
                      toolCallId: value.content_block.id,
                      toolName: value.content_block.name,
                      jsonText: ""
                    };
                    return;
                  }
                  default: {
                    const _exhaustiveCheck = contentBlockType;
                    throw new Error(
                      `Unsupported content block type: ${_exhaustiveCheck}`
                    );
                  }
                }
              }
              case "content_block_stop": {
                if (toolCallContentBlocks[value.index] != null) {
                  const contentBlock = toolCallContentBlocks[value.index];
                  controller.enqueue({
                    type: "tool-call",
                    toolCallType: "function",
                    toolCallId: contentBlock.toolCallId,
                    toolName: contentBlock.toolName,
                    args: contentBlock.jsonText
                  });
                  delete toolCallContentBlocks[value.index];
                }
                return;
              }
              case "content_block_delta": {
                const deltaType = value.delta.type;
                switch (deltaType) {
                  case "text_delta": {
                    controller.enqueue({
                      type: "text-delta",
                      textDelta: value.delta.text
                    });
                    return;
                  }
                  case "input_json_delta": {
                    const contentBlock = toolCallContentBlocks[value.index];
                    controller.enqueue({
                      type: "tool-call-delta",
                      toolCallType: "function",
                      toolCallId: contentBlock.toolCallId,
                      toolName: contentBlock.toolName,
                      argsTextDelta: value.delta.partial_json
                    });
                    contentBlock.jsonText += value.delta.partial_json;
                    return;
                  }
                  default: {
                    const _exhaustiveCheck = deltaType;
                    throw new Error(
                      `Unsupported delta type: ${_exhaustiveCheck}`
                    );
                  }
                }
              }
              case "message_start": {
                usage.promptTokens = value.message.usage.input_tokens;
                usage.completionTokens = value.message.usage.output_tokens;
                if (self.settings.cacheControl === true) {
                  providerMetadata = {
                    anthropic: {
                      cacheCreationInputTokens: (_a16 = value.message.usage.cache_creation_input_tokens) != null ? _a16 : null,
                      cacheReadInputTokens: (_b = value.message.usage.cache_read_input_tokens) != null ? _b : null
                    }
                  };
                }
                controller.enqueue({
                  type: "response-metadata",
                  id: (_c = value.message.id) != null ? _c : void 0,
                  modelId: (_d = value.message.model) != null ? _d : void 0
                });
                return;
              }
              case "message_delta": {
                usage.completionTokens = value.usage.output_tokens;
                finishReason = mapAnthropicStopReason(value.delta.stop_reason);
                return;
              }
              case "message_stop": {
                controller.enqueue({
                  type: "finish",
                  finishReason,
                  usage,
                  providerMetadata
                });
                return;
              }
              case "error": {
                controller.enqueue({ type: "error", error: value.error });
                return;
              }
              default: {
                const _exhaustiveCheck = value;
                throw new Error(`Unsupported chunk type: ${_exhaustiveCheck}`);
              }
            }
          }
        })
      ),
      rawCall: { rawPrompt, rawSettings },
      rawResponse: { headers: responseHeaders },
      warnings,
      request: { body: JSON.stringify(body) }
    };
  }
};
var anthropicMessagesResponseSchema = z.object({
  type: z.literal("message"),
  id: z.string().nullish(),
  model: z.string().nullish(),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("text"),
        text: z.string()
      }),
      z.object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.unknown()
      })
    ])
  ),
  stop_reason: z.string().nullish(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().nullish(),
    cache_read_input_tokens: z.number().nullish()
  })
});
var anthropicMessagesChunkSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_start"),
    message: z.object({
      id: z.string().nullish(),
      model: z.string().nullish(),
      usage: z.object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        cache_creation_input_tokens: z.number().nullish(),
        cache_read_input_tokens: z.number().nullish()
      })
    })
  }),
  z.object({
    type: z.literal("content_block_start"),
    index: z.number(),
    content_block: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("text"),
        text: z.string()
      }),
      z.object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string()
      })
    ])
  }),
  z.object({
    type: z.literal("content_block_delta"),
    index: z.number(),
    delta: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("input_json_delta"),
        partial_json: z.string()
      }),
      z.object({
        type: z.literal("text_delta"),
        text: z.string()
      })
    ])
  }),
  z.object({
    type: z.literal("content_block_stop"),
    index: z.number()
  }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      type: z.string(),
      message: z.string()
    })
  }),
  z.object({
    type: z.literal("message_delta"),
    delta: z.object({ stop_reason: z.string().nullish() }),
    usage: z.object({ output_tokens: z.number() })
  }),
  z.object({
    type: z.literal("message_stop")
  }),
  z.object({
    type: z.literal("ping")
  })
]);
var Bash20241022Parameters = z.object({
  command: z.string(),
  restart: z.boolean().optional()
});
function bashTool_20241022(options = {}) {
  return {
    type: "provider-defined",
    id: "anthropic.bash_20241022",
    args: {},
    parameters: Bash20241022Parameters,
    execute: options.execute,
    experimental_toToolResultContent: options.experimental_toToolResultContent
  };
}
var TextEditor20241022Parameters = z.object({
  command: z.enum(["view", "create", "str_replace", "insert", "undo_edit"]),
  path: z.string(),
  file_text: z.string().optional(),
  insert_line: z.number().int().optional(),
  new_str: z.string().optional(),
  old_str: z.string().optional(),
  view_range: z.array(z.number().int()).optional()
});
function textEditorTool_20241022(options = {}) {
  return {
    type: "provider-defined",
    id: "anthropic.text_editor_20241022",
    args: {},
    parameters: TextEditor20241022Parameters,
    execute: options.execute,
    experimental_toToolResultContent: options.experimental_toToolResultContent
  };
}
var Computer20241022Parameters = z.object({
  action: z.enum([
    "key",
    "type",
    "mouse_move",
    "left_click",
    "left_click_drag",
    "right_click",
    "middle_click",
    "double_click",
    "screenshot",
    "cursor_position"
  ]),
  coordinate: z.array(z.number().int()).optional(),
  text: z.string().optional()
});
function computerTool_20241022(options) {
  return {
    type: "provider-defined",
    id: "anthropic.computer_20241022",
    args: {
      displayWidthPx: options.displayWidthPx,
      displayHeightPx: options.displayHeightPx,
      displayNumber: options.displayNumber
    },
    parameters: Computer20241022Parameters,
    execute: options.execute,
    experimental_toToolResultContent: options.experimental_toToolResultContent
  };
}
var anthropicTools = {
  bash_20241022: bashTool_20241022,
  textEditor_20241022: textEditorTool_20241022,
  computer_20241022: computerTool_20241022
};
function createAnthropic(options = {}) {
  var _a16;
  const baseURL = (_a16 = withoutTrailingSlash(options.baseURL)) != null ? _a16 : "https://api.anthropic.com/v1";
  const getHeaders = () => ({
    "anthropic-version": "2023-06-01",
    "x-api-key": loadApiKey({
      apiKey: options.apiKey,
      environmentVariableName: "ANTHROPIC_API_KEY",
      description: "Anthropic"
    }),
    ...options.headers
  });
  const createChatModel = (modelId, settings = {}) => new AnthropicMessagesLanguageModel(modelId, settings, {
    provider: "anthropic.messages",
    baseURL,
    headers: getHeaders,
    fetch: options.fetch
  });
  const provider = function(modelId, settings) {
    if (new.target) {
      throw new Error(
        "The Anthropic model function cannot be called with the new keyword."
      );
    }
    return createChatModel(modelId, settings);
  };
  provider.languageModel = createChatModel;
  provider.chat = createChatModel;
  provider.messages = createChatModel;
  provider.textEmbeddingModel = (modelId) => {
    throw new NoSuchModelError({ modelId, modelType: "textEmbeddingModel" });
  };
  provider.tools = anthropicTools;
  return provider;
}
var anthropic = createAnthropic();

// ../../node_modules/.pnpm/@ai-sdk+openai@1.0.0_zod@3.23.0/node_modules/@ai-sdk/openai/dist/index.mjs
function convertToOpenAIChatMessages({
  prompt,
  useLegacyFunctionCalling = false
}) {
  const messages = [];
  for (const { role, content } of prompt) {
    switch (role) {
      case "system": {
        messages.push({ role: "system", content });
        break;
      }
      case "user": {
        if (content.length === 1 && content[0].type === "text") {
          messages.push({ role: "user", content: content[0].text });
          break;
        }
        messages.push({
          role: "user",
          content: content.map((part) => {
            var _a16, _b, _c;
            switch (part.type) {
              case "text": {
                return { type: "text", text: part.text };
              }
              case "image": {
                return {
                  type: "image_url",
                  image_url: {
                    url: part.image instanceof URL ? part.image.toString() : `data:${(_a16 = part.mimeType) != null ? _a16 : "image/jpeg"};base64,${convertUint8ArrayToBase64(part.image)}`,
                    // OpenAI specific extension: image detail
                    detail: (_c = (_b = part.providerMetadata) == null ? void 0 : _b.openai) == null ? void 0 : _c.imageDetail
                  }
                };
              }
              case "file": {
                if (part.data instanceof URL) {
                  throw new UnsupportedFunctionalityError({
                    functionality: "'File content parts with URL data' functionality not supported."
                  });
                }
                switch (part.mimeType) {
                  case "audio/wav": {
                    return {
                      type: "input_audio",
                      input_audio: { data: part.data, format: "wav" }
                    };
                  }
                  case "audio/mp3":
                  case "audio/mpeg": {
                    return {
                      type: "input_audio",
                      input_audio: { data: part.data, format: "mp3" }
                    };
                  }
                  default: {
                    throw new UnsupportedFunctionalityError({
                      functionality: `File content part type ${part.mimeType} in user messages`
                    });
                  }
                }
              }
            }
          })
        });
        break;
      }
      case "assistant": {
        let text = "";
        const toolCalls = [];
        for (const part of content) {
          switch (part.type) {
            case "text": {
              text += part.text;
              break;
            }
            case "tool-call": {
              toolCalls.push({
                id: part.toolCallId,
                type: "function",
                function: {
                  name: part.toolName,
                  arguments: JSON.stringify(part.args)
                }
              });
              break;
            }
            default: {
              const _exhaustiveCheck = part;
              throw new Error(`Unsupported part: ${_exhaustiveCheck}`);
            }
          }
        }
        if (useLegacyFunctionCalling) {
          if (toolCalls.length > 1) {
            throw new UnsupportedFunctionalityError({
              functionality: "useLegacyFunctionCalling with multiple tool calls in one message"
            });
          }
          messages.push({
            role: "assistant",
            content: text,
            function_call: toolCalls.length > 0 ? toolCalls[0].function : void 0
          });
        } else {
          messages.push({
            role: "assistant",
            content: text,
            tool_calls: toolCalls.length > 0 ? toolCalls : void 0
          });
        }
        break;
      }
      case "tool": {
        for (const toolResponse of content) {
          if (useLegacyFunctionCalling) {
            messages.push({
              role: "function",
              name: toolResponse.toolName,
              content: JSON.stringify(toolResponse.result)
            });
          } else {
            messages.push({
              role: "tool",
              tool_call_id: toolResponse.toolCallId,
              content: JSON.stringify(toolResponse.result)
            });
          }
        }
        break;
      }
      default: {
        const _exhaustiveCheck = role;
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`);
      }
    }
  }
  return messages;
}
function mapOpenAIChatLogProbsOutput(logprobs) {
  var _a16, _b;
  return (_b = (_a16 = logprobs == null ? void 0 : logprobs.content) == null ? void 0 : _a16.map(({ token, logprob, top_logprobs }) => ({
    token,
    logprob,
    topLogprobs: top_logprobs ? top_logprobs.map(({ token: token2, logprob: logprob2 }) => ({
      token: token2,
      logprob: logprob2
    })) : []
  }))) != null ? _b : void 0;
}
function mapOpenAIFinishReason(finishReason) {
  switch (finishReason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content-filter";
    case "function_call":
    case "tool_calls":
      return "tool-calls";
    default:
      return "unknown";
  }
}
var openAIErrorDataSchema = z.object({
  error: z.object({
    message: z.string(),
    // The additional information below is handled loosely to support
    // OpenAI-compatible providers that have slightly different error
    // responses:
    type: z.string().nullish(),
    param: z.any().nullish(),
    code: z.union([z.string(), z.number()]).nullish()
  })
});
var openaiFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: openAIErrorDataSchema,
  errorToMessage: (data) => data.error.message
});
function getResponseMetadata({
  id,
  model,
  created
}) {
  return {
    id: id != null ? id : void 0,
    modelId: model != null ? model : void 0,
    timestamp: created != null ? new Date(created * 1e3) : void 0
  };
}
function prepareTools2({
  mode,
  useLegacyFunctionCalling = false,
  structuredOutputs = false
}) {
  var _a16;
  const tools = ((_a16 = mode.tools) == null ? void 0 : _a16.length) ? mode.tools : void 0;
  const toolWarnings = [];
  if (tools == null) {
    return { tools: void 0, tool_choice: void 0, toolWarnings };
  }
  const toolChoice = mode.toolChoice;
  if (useLegacyFunctionCalling) {
    const openaiFunctions = [];
    for (const tool of tools) {
      if (tool.type === "provider-defined") {
        toolWarnings.push({ type: "unsupported-tool", tool });
      } else {
        openaiFunctions.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        });
      }
    }
    if (toolChoice == null) {
      return {
        functions: openaiFunctions,
        function_call: void 0,
        toolWarnings
      };
    }
    const type2 = toolChoice.type;
    switch (type2) {
      case "auto":
      case "none":
      case void 0:
        return {
          functions: openaiFunctions,
          function_call: void 0,
          toolWarnings
        };
      case "required":
        throw new UnsupportedFunctionalityError({
          functionality: "useLegacyFunctionCalling and toolChoice: required"
        });
      default:
        return {
          functions: openaiFunctions,
          function_call: { name: toolChoice.toolName },
          toolWarnings
        };
    }
  }
  const openaiTools = [];
  for (const tool of tools) {
    if (tool.type === "provider-defined") {
      toolWarnings.push({ type: "unsupported-tool", tool });
    } else {
      openaiTools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: structuredOutputs === true ? true : void 0
        }
      });
    }
  }
  if (toolChoice == null) {
    return { tools: openaiTools, tool_choice: void 0, toolWarnings };
  }
  const type = toolChoice.type;
  switch (type) {
    case "auto":
    case "none":
    case "required":
      return { tools: openaiTools, tool_choice: type, toolWarnings };
    case "tool":
      return {
        tools: openaiTools,
        tool_choice: {
          type: "function",
          function: {
            name: toolChoice.toolName
          }
        },
        toolWarnings
      };
    default: {
      const _exhaustiveCheck = type;
      throw new UnsupportedFunctionalityError({
        functionality: `Unsupported tool choice type: ${_exhaustiveCheck}`
      });
    }
  }
}
var OpenAIChatLanguageModel = class {
  constructor(modelId, settings, config) {
    this.specificationVersion = "v1";
    this.modelId = modelId;
    this.settings = settings;
    this.config = config;
  }
  get supportsStructuredOutputs() {
    return this.settings.structuredOutputs === true;
  }
  get defaultObjectGenerationMode() {
    if (isAudioModel(this.modelId)) {
      return "tool";
    }
    return this.supportsStructuredOutputs ? "json" : "tool";
  }
  get provider() {
    return this.config.provider;
  }
  get supportsImageUrls() {
    return !this.settings.downloadImages;
  }
  getArgs({
    mode,
    prompt,
    maxTokens,
    temperature,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    stopSequences,
    responseFormat,
    seed,
    providerMetadata
  }) {
    var _a16, _b, _c, _d, _e, _f, _g, _h, _i;
    const type = mode.type;
    const warnings = [];
    if (topK != null) {
      warnings.push({
        type: "unsupported-setting",
        setting: "topK"
      });
    }
    if (responseFormat != null && responseFormat.type === "json" && responseFormat.schema != null) {
      warnings.push({
        type: "unsupported-setting",
        setting: "responseFormat",
        details: "JSON response format schema is not supported"
      });
    }
    const useLegacyFunctionCalling = this.settings.useLegacyFunctionCalling;
    if (useLegacyFunctionCalling && this.settings.parallelToolCalls === true) {
      throw new UnsupportedFunctionalityError({
        functionality: "useLegacyFunctionCalling with parallelToolCalls"
      });
    }
    if (useLegacyFunctionCalling && this.settings.structuredOutputs === true) {
      throw new UnsupportedFunctionalityError({
        functionality: "structuredOutputs with useLegacyFunctionCalling"
      });
    }
    const baseArgs = {
      // model id:
      model: this.modelId,
      // model specific settings:
      logit_bias: this.settings.logitBias,
      logprobs: this.settings.logprobs === true || typeof this.settings.logprobs === "number" ? true : void 0,
      top_logprobs: typeof this.settings.logprobs === "number" ? this.settings.logprobs : typeof this.settings.logprobs === "boolean" ? this.settings.logprobs ? 0 : void 0 : void 0,
      user: this.settings.user,
      parallel_tool_calls: this.settings.parallelToolCalls,
      // standardized settings:
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      frequency_penalty: frequencyPenalty,
      presence_penalty: presencePenalty,
      stop: stopSequences,
      seed,
      // openai specific settings:
      max_completion_tokens: (_b = (_a16 = providerMetadata == null ? void 0 : providerMetadata.openai) == null ? void 0 : _a16.maxCompletionTokens) != null ? _b : void 0,
      store: (_d = (_c = providerMetadata == null ? void 0 : providerMetadata.openai) == null ? void 0 : _c.store) != null ? _d : void 0,
      metadata: (_f = (_e = providerMetadata == null ? void 0 : providerMetadata.openai) == null ? void 0 : _e.metadata) != null ? _f : void 0,
      prediction: (_h = (_g = providerMetadata == null ? void 0 : providerMetadata.openai) == null ? void 0 : _g.prediction) != null ? _h : void 0,
      // response format:
      response_format: (responseFormat == null ? void 0 : responseFormat.type) === "json" ? { type: "json_object" } : void 0,
      // messages:
      messages: convertToOpenAIChatMessages({
        prompt,
        useLegacyFunctionCalling
      })
    };
    if (isReasoningModel(this.modelId)) {
      baseArgs.temperature = void 0;
      baseArgs.top_p = void 0;
      baseArgs.frequency_penalty = void 0;
      baseArgs.presence_penalty = void 0;
    }
    switch (type) {
      case "regular": {
        const { tools, tool_choice, functions, function_call, toolWarnings } = prepareTools2({
          mode,
          useLegacyFunctionCalling,
          structuredOutputs: this.settings.structuredOutputs
        });
        return {
          args: {
            ...baseArgs,
            tools,
            tool_choice,
            functions,
            function_call
          },
          warnings: [...warnings, ...toolWarnings]
        };
      }
      case "object-json": {
        return {
          args: {
            ...baseArgs,
            response_format: this.settings.structuredOutputs === true && mode.schema != null ? {
              type: "json_schema",
              json_schema: {
                schema: mode.schema,
                strict: true,
                name: (_i = mode.name) != null ? _i : "response",
                description: mode.description
              }
            } : { type: "json_object" }
          },
          warnings
        };
      }
      case "object-tool": {
        return {
          args: useLegacyFunctionCalling ? {
            ...baseArgs,
            function_call: {
              name: mode.tool.name
            },
            functions: [
              {
                name: mode.tool.name,
                description: mode.tool.description,
                parameters: mode.tool.parameters
              }
            ]
          } : {
            ...baseArgs,
            tool_choice: {
              type: "function",
              function: { name: mode.tool.name }
            },
            tools: [
              {
                type: "function",
                function: {
                  name: mode.tool.name,
                  description: mode.tool.description,
                  parameters: mode.tool.parameters,
                  strict: this.settings.structuredOutputs === true ? true : void 0
                }
              }
            ]
          },
          warnings
        };
      }
      default: {
        const _exhaustiveCheck = type;
        throw new Error(`Unsupported type: ${_exhaustiveCheck}`);
      }
    }
  }
  async doGenerate(options) {
    var _a16, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r;
    const { args: body, warnings } = this.getArgs(options);
    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({
        path: "/chat/completions",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body,
      failedResponseHandler: openaiFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(
        openAIChatResponseSchema
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    const { messages: rawPrompt, ...rawSettings } = body;
    const choice = response.choices[0];
    let providerMetadata;
    if (((_b = (_a16 = response.usage) == null ? void 0 : _a16.completion_tokens_details) == null ? void 0 : _b.reasoning_tokens) != null || ((_d = (_c = response.usage) == null ? void 0 : _c.prompt_tokens_details) == null ? void 0 : _d.cached_tokens) != null) {
      providerMetadata = { openai: {} };
      if (((_f = (_e = response.usage) == null ? void 0 : _e.completion_tokens_details) == null ? void 0 : _f.reasoning_tokens) != null) {
        providerMetadata.openai.reasoningTokens = (_h = (_g = response.usage) == null ? void 0 : _g.completion_tokens_details) == null ? void 0 : _h.reasoning_tokens;
      }
      if (((_j = (_i = response.usage) == null ? void 0 : _i.prompt_tokens_details) == null ? void 0 : _j.cached_tokens) != null) {
        providerMetadata.openai.cachedPromptTokens = (_l = (_k = response.usage) == null ? void 0 : _k.prompt_tokens_details) == null ? void 0 : _l.cached_tokens;
      }
    }
    return {
      text: (_m = choice.message.content) != null ? _m : void 0,
      toolCalls: this.settings.useLegacyFunctionCalling && choice.message.function_call ? [
        {
          toolCallType: "function",
          toolCallId: generateId(),
          toolName: choice.message.function_call.name,
          args: choice.message.function_call.arguments
        }
      ] : (_n = choice.message.tool_calls) == null ? void 0 : _n.map((toolCall) => {
        var _a23;
        return {
          toolCallType: "function",
          toolCallId: (_a23 = toolCall.id) != null ? _a23 : generateId(),
          toolName: toolCall.function.name,
          args: toolCall.function.arguments
        };
      }),
      finishReason: mapOpenAIFinishReason(choice.finish_reason),
      usage: {
        promptTokens: (_p = (_o = response.usage) == null ? void 0 : _o.prompt_tokens) != null ? _p : NaN,
        completionTokens: (_r = (_q = response.usage) == null ? void 0 : _q.completion_tokens) != null ? _r : NaN
      },
      rawCall: { rawPrompt, rawSettings },
      rawResponse: { headers: responseHeaders },
      request: { body: JSON.stringify(body) },
      response: getResponseMetadata(response),
      warnings,
      logprobs: mapOpenAIChatLogProbsOutput(choice.logprobs),
      providerMetadata
    };
  }
  async doStream(options) {
    if (isReasoningModel(this.modelId)) {
      const result = await this.doGenerate(options);
      const simulatedStream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "response-metadata", ...result.response });
          if (result.text) {
            controller.enqueue({
              type: "text-delta",
              textDelta: result.text
            });
          }
          if (result.toolCalls) {
            for (const toolCall of result.toolCalls) {
              controller.enqueue({
                type: "tool-call",
                ...toolCall
              });
            }
          }
          controller.enqueue({
            type: "finish",
            finishReason: result.finishReason,
            usage: result.usage,
            logprobs: result.logprobs,
            providerMetadata: result.providerMetadata
          });
          controller.close();
        }
      });
      return {
        stream: simulatedStream,
        rawCall: result.rawCall,
        rawResponse: result.rawResponse,
        warnings: result.warnings
      };
    }
    const { args, warnings } = this.getArgs(options);
    const body = {
      ...args,
      stream: true,
      // only include stream_options when in strict compatibility mode:
      stream_options: this.config.compatibility === "strict" ? { include_usage: true } : void 0
    };
    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({
        path: "/chat/completions",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body,
      failedResponseHandler: openaiFailedResponseHandler,
      successfulResponseHandler: createEventSourceResponseHandler(
        openaiChatChunkSchema
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    const { messages: rawPrompt, ...rawSettings } = args;
    const toolCalls = [];
    let finishReason = "unknown";
    let usage = {
      promptTokens: void 0,
      completionTokens: void 0
    };
    let logprobs;
    let isFirstChunk = true;
    const { useLegacyFunctionCalling } = this.settings;
    let providerMetadata;
    return {
      stream: response.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            var _a16, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p;
            if (!chunk.success) {
              finishReason = "error";
              controller.enqueue({ type: "error", error: chunk.error });
              return;
            }
            const value = chunk.value;
            if ("error" in value) {
              finishReason = "error";
              controller.enqueue({ type: "error", error: value.error });
              return;
            }
            if (isFirstChunk) {
              isFirstChunk = false;
              controller.enqueue({
                type: "response-metadata",
                ...getResponseMetadata(value)
              });
            }
            if (value.usage != null) {
              usage = {
                promptTokens: (_a16 = value.usage.prompt_tokens) != null ? _a16 : void 0,
                completionTokens: (_b = value.usage.completion_tokens) != null ? _b : void 0
              };
              if (((_c = value.usage.prompt_tokens_details) == null ? void 0 : _c.cached_tokens) != null) {
                providerMetadata = {
                  openai: {
                    cachedPromptTokens: (_d = value.usage.prompt_tokens_details) == null ? void 0 : _d.cached_tokens
                  }
                };
              }
            }
            const choice = value.choices[0];
            if ((choice == null ? void 0 : choice.finish_reason) != null) {
              finishReason = mapOpenAIFinishReason(choice.finish_reason);
            }
            if ((choice == null ? void 0 : choice.delta) == null) {
              return;
            }
            const delta = choice.delta;
            if (delta.content != null) {
              controller.enqueue({
                type: "text-delta",
                textDelta: delta.content
              });
            }
            const mappedLogprobs = mapOpenAIChatLogProbsOutput(
              choice == null ? void 0 : choice.logprobs
            );
            if (mappedLogprobs == null ? void 0 : mappedLogprobs.length) {
              if (logprobs === void 0) logprobs = [];
              logprobs.push(...mappedLogprobs);
            }
            const mappedToolCalls = useLegacyFunctionCalling && delta.function_call != null ? [
              {
                type: "function",
                id: generateId(),
                function: delta.function_call,
                index: 0
              }
            ] : delta.tool_calls;
            if (mappedToolCalls != null) {
              for (const toolCallDelta of mappedToolCalls) {
                const index = toolCallDelta.index;
                if (toolCalls[index] == null) {
                  if (toolCallDelta.type !== "function") {
                    throw new InvalidResponseDataError({
                      data: toolCallDelta,
                      message: `Expected 'function' type.`
                    });
                  }
                  if (toolCallDelta.id == null) {
                    throw new InvalidResponseDataError({
                      data: toolCallDelta,
                      message: `Expected 'id' to be a string.`
                    });
                  }
                  if (((_e = toolCallDelta.function) == null ? void 0 : _e.name) == null) {
                    throw new InvalidResponseDataError({
                      data: toolCallDelta,
                      message: `Expected 'function.name' to be a string.`
                    });
                  }
                  toolCalls[index] = {
                    id: toolCallDelta.id,
                    type: "function",
                    function: {
                      name: toolCallDelta.function.name,
                      arguments: (_f = toolCallDelta.function.arguments) != null ? _f : ""
                    }
                  };
                  const toolCall2 = toolCalls[index];
                  if (((_g = toolCall2.function) == null ? void 0 : _g.name) != null && ((_h = toolCall2.function) == null ? void 0 : _h.arguments) != null) {
                    if (toolCall2.function.arguments.length > 0) {
                      controller.enqueue({
                        type: "tool-call-delta",
                        toolCallType: "function",
                        toolCallId: toolCall2.id,
                        toolName: toolCall2.function.name,
                        argsTextDelta: toolCall2.function.arguments
                      });
                    }
                    if (isParsableJson(toolCall2.function.arguments)) {
                      controller.enqueue({
                        type: "tool-call",
                        toolCallType: "function",
                        toolCallId: (_i = toolCall2.id) != null ? _i : generateId(),
                        toolName: toolCall2.function.name,
                        args: toolCall2.function.arguments
                      });
                    }
                  }
                  continue;
                }
                const toolCall = toolCalls[index];
                if (((_j = toolCallDelta.function) == null ? void 0 : _j.arguments) != null) {
                  toolCall.function.arguments += (_l = (_k = toolCallDelta.function) == null ? void 0 : _k.arguments) != null ? _l : "";
                }
                controller.enqueue({
                  type: "tool-call-delta",
                  toolCallType: "function",
                  toolCallId: toolCall.id,
                  toolName: toolCall.function.name,
                  argsTextDelta: (_m = toolCallDelta.function.arguments) != null ? _m : ""
                });
                if (((_n = toolCall.function) == null ? void 0 : _n.name) != null && ((_o = toolCall.function) == null ? void 0 : _o.arguments) != null && isParsableJson(toolCall.function.arguments)) {
                  controller.enqueue({
                    type: "tool-call",
                    toolCallType: "function",
                    toolCallId: (_p = toolCall.id) != null ? _p : generateId(),
                    toolName: toolCall.function.name,
                    args: toolCall.function.arguments
                  });
                }
              }
            }
          },
          flush(controller) {
            var _a16, _b;
            controller.enqueue({
              type: "finish",
              finishReason,
              logprobs,
              usage: {
                promptTokens: (_a16 = usage.promptTokens) != null ? _a16 : NaN,
                completionTokens: (_b = usage.completionTokens) != null ? _b : NaN
              },
              ...providerMetadata != null ? { providerMetadata } : {}
            });
          }
        })
      ),
      rawCall: { rawPrompt, rawSettings },
      rawResponse: { headers: responseHeaders },
      request: { body: JSON.stringify(body) },
      warnings
    };
  }
};
var openAITokenUsageSchema = z.object({
  prompt_tokens: z.number().nullish(),
  completion_tokens: z.number().nullish(),
  prompt_tokens_details: z.object({
    cached_tokens: z.number().nullish()
  }).nullish(),
  completion_tokens_details: z.object({
    reasoning_tokens: z.number().nullish()
  }).nullish()
}).nullish();
var openAIChatResponseSchema = z.object({
  id: z.string().nullish(),
  created: z.number().nullish(),
  model: z.string().nullish(),
  choices: z.array(
    z.object({
      message: z.object({
        role: z.literal("assistant").nullish(),
        content: z.string().nullish(),
        function_call: z.object({
          arguments: z.string(),
          name: z.string()
        }).nullish(),
        tool_calls: z.array(
          z.object({
            id: z.string().nullish(),
            type: z.literal("function"),
            function: z.object({
              name: z.string(),
              arguments: z.string()
            })
          })
        ).nullish()
      }),
      index: z.number(),
      logprobs: z.object({
        content: z.array(
          z.object({
            token: z.string(),
            logprob: z.number(),
            top_logprobs: z.array(
              z.object({
                token: z.string(),
                logprob: z.number()
              })
            )
          })
        ).nullable()
      }).nullish(),
      finish_reason: z.string().nullish()
    })
  ),
  usage: openAITokenUsageSchema
});
var openaiChatChunkSchema = z.union([
  z.object({
    id: z.string().nullish(),
    created: z.number().nullish(),
    model: z.string().nullish(),
    choices: z.array(
      z.object({
        delta: z.object({
          role: z.enum(["assistant"]).nullish(),
          content: z.string().nullish(),
          function_call: z.object({
            name: z.string().optional(),
            arguments: z.string().optional()
          }).nullish(),
          tool_calls: z.array(
            z.object({
              index: z.number(),
              id: z.string().nullish(),
              type: z.literal("function").optional(),
              function: z.object({
                name: z.string().nullish(),
                arguments: z.string().nullish()
              })
            })
          ).nullish()
        }).nullish(),
        logprobs: z.object({
          content: z.array(
            z.object({
              token: z.string(),
              logprob: z.number(),
              top_logprobs: z.array(
                z.object({
                  token: z.string(),
                  logprob: z.number()
                })
              )
            })
          ).nullable()
        }).nullish(),
        finish_reason: z.string().nullable().optional(),
        index: z.number()
      })
    ),
    usage: openAITokenUsageSchema
  }),
  openAIErrorDataSchema
]);
function isReasoningModel(modelId) {
  return modelId.startsWith("o1-");
}
function isAudioModel(modelId) {
  return modelId.startsWith("gpt-4o-audio-preview");
}
function convertToOpenAICompletionPrompt({
  prompt,
  inputFormat,
  user = "user",
  assistant = "assistant"
}) {
  if (inputFormat === "prompt" && prompt.length === 1 && prompt[0].role === "user" && prompt[0].content.length === 1 && prompt[0].content[0].type === "text") {
    return { prompt: prompt[0].content[0].text };
  }
  let text = "";
  if (prompt[0].role === "system") {
    text += `${prompt[0].content}

`;
    prompt = prompt.slice(1);
  }
  for (const { role, content } of prompt) {
    switch (role) {
      case "system": {
        throw new InvalidPromptError({
          message: "Unexpected system message in prompt: ${content}",
          prompt
        });
      }
      case "user": {
        const userMessage = content.map((part) => {
          switch (part.type) {
            case "text": {
              return part.text;
            }
            case "image": {
              throw new UnsupportedFunctionalityError({
                functionality: "images"
              });
            }
          }
        }).join("");
        text += `${user}:
${userMessage}

`;
        break;
      }
      case "assistant": {
        const assistantMessage = content.map((part) => {
          switch (part.type) {
            case "text": {
              return part.text;
            }
            case "tool-call": {
              throw new UnsupportedFunctionalityError({
                functionality: "tool-call messages"
              });
            }
          }
        }).join("");
        text += `${assistant}:
${assistantMessage}

`;
        break;
      }
      case "tool": {
        throw new UnsupportedFunctionalityError({
          functionality: "tool messages"
        });
      }
      default: {
        const _exhaustiveCheck = role;
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`);
      }
    }
  }
  text += `${assistant}:
`;
  return {
    prompt: text,
    stopSequences: [`
${user}:`]
  };
}
function mapOpenAICompletionLogProbs(logprobs) {
  return logprobs == null ? void 0 : logprobs.tokens.map((token, index) => ({
    token,
    logprob: logprobs.token_logprobs[index],
    topLogprobs: logprobs.top_logprobs ? Object.entries(logprobs.top_logprobs[index]).map(
      ([token2, logprob]) => ({
        token: token2,
        logprob
      })
    ) : []
  }));
}
var OpenAICompletionLanguageModel = class {
  constructor(modelId, settings, config) {
    this.specificationVersion = "v1";
    this.defaultObjectGenerationMode = void 0;
    this.modelId = modelId;
    this.settings = settings;
    this.config = config;
  }
  get provider() {
    return this.config.provider;
  }
  getArgs({
    mode,
    inputFormat,
    prompt,
    maxTokens,
    temperature,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    stopSequences: userStopSequences,
    responseFormat,
    seed
  }) {
    var _a16;
    const type = mode.type;
    const warnings = [];
    if (topK != null) {
      warnings.push({
        type: "unsupported-setting",
        setting: "topK"
      });
    }
    if (responseFormat != null && responseFormat.type !== "text") {
      warnings.push({
        type: "unsupported-setting",
        setting: "responseFormat",
        details: "JSON response format is not supported."
      });
    }
    const { prompt: completionPrompt, stopSequences } = convertToOpenAICompletionPrompt({ prompt, inputFormat });
    const stop = [...stopSequences != null ? stopSequences : [], ...userStopSequences != null ? userStopSequences : []];
    const baseArgs = {
      // model id:
      model: this.modelId,
      // model specific settings:
      echo: this.settings.echo,
      logit_bias: this.settings.logitBias,
      logprobs: typeof this.settings.logprobs === "number" ? this.settings.logprobs : typeof this.settings.logprobs === "boolean" ? this.settings.logprobs ? 0 : void 0 : void 0,
      suffix: this.settings.suffix,
      user: this.settings.user,
      // standardized settings:
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      frequency_penalty: frequencyPenalty,
      presence_penalty: presencePenalty,
      seed,
      // prompt:
      prompt: completionPrompt,
      // stop sequences:
      stop: stop.length > 0 ? stop : void 0
    };
    switch (type) {
      case "regular": {
        if ((_a16 = mode.tools) == null ? void 0 : _a16.length) {
          throw new UnsupportedFunctionalityError({
            functionality: "tools"
          });
        }
        if (mode.toolChoice) {
          throw new UnsupportedFunctionalityError({
            functionality: "toolChoice"
          });
        }
        return { args: baseArgs, warnings };
      }
      case "object-json": {
        throw new UnsupportedFunctionalityError({
          functionality: "object-json mode"
        });
      }
      case "object-tool": {
        throw new UnsupportedFunctionalityError({
          functionality: "object-tool mode"
        });
      }
      default: {
        const _exhaustiveCheck = type;
        throw new Error(`Unsupported type: ${_exhaustiveCheck}`);
      }
    }
  }
  async doGenerate(options) {
    const { args, warnings } = this.getArgs(options);
    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({
        path: "/completions",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body: args,
      failedResponseHandler: openaiFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(
        openAICompletionResponseSchema
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    const { prompt: rawPrompt, ...rawSettings } = args;
    const choice = response.choices[0];
    return {
      text: choice.text,
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens
      },
      finishReason: mapOpenAIFinishReason(choice.finish_reason),
      logprobs: mapOpenAICompletionLogProbs(choice.logprobs),
      rawCall: { rawPrompt, rawSettings },
      rawResponse: { headers: responseHeaders },
      response: getResponseMetadata(response),
      warnings,
      request: { body: JSON.stringify(args) }
    };
  }
  async doStream(options) {
    const { args, warnings } = this.getArgs(options);
    const body = {
      ...args,
      stream: true,
      // only include stream_options when in strict compatibility mode:
      stream_options: this.config.compatibility === "strict" ? { include_usage: true } : void 0
    };
    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({
        path: "/completions",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), options.headers),
      body,
      failedResponseHandler: openaiFailedResponseHandler,
      successfulResponseHandler: createEventSourceResponseHandler(
        openaiCompletionChunkSchema
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch
    });
    const { prompt: rawPrompt, ...rawSettings } = args;
    let finishReason = "unknown";
    let usage = {
      promptTokens: Number.NaN,
      completionTokens: Number.NaN
    };
    let logprobs;
    let isFirstChunk = true;
    return {
      stream: response.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (!chunk.success) {
              finishReason = "error";
              controller.enqueue({ type: "error", error: chunk.error });
              return;
            }
            const value = chunk.value;
            if ("error" in value) {
              finishReason = "error";
              controller.enqueue({ type: "error", error: value.error });
              return;
            }
            if (isFirstChunk) {
              isFirstChunk = false;
              controller.enqueue({
                type: "response-metadata",
                ...getResponseMetadata(value)
              });
            }
            if (value.usage != null) {
              usage = {
                promptTokens: value.usage.prompt_tokens,
                completionTokens: value.usage.completion_tokens
              };
            }
            const choice = value.choices[0];
            if ((choice == null ? void 0 : choice.finish_reason) != null) {
              finishReason = mapOpenAIFinishReason(choice.finish_reason);
            }
            if ((choice == null ? void 0 : choice.text) != null) {
              controller.enqueue({
                type: "text-delta",
                textDelta: choice.text
              });
            }
            const mappedLogprobs = mapOpenAICompletionLogProbs(
              choice == null ? void 0 : choice.logprobs
            );
            if (mappedLogprobs == null ? void 0 : mappedLogprobs.length) {
              if (logprobs === void 0) logprobs = [];
              logprobs.push(...mappedLogprobs);
            }
          },
          flush(controller) {
            controller.enqueue({
              type: "finish",
              finishReason,
              logprobs,
              usage
            });
          }
        })
      ),
      rawCall: { rawPrompt, rawSettings },
      rawResponse: { headers: responseHeaders },
      warnings,
      request: { body: JSON.stringify(body) }
    };
  }
};
var openAICompletionResponseSchema = z.object({
  id: z.string().nullish(),
  created: z.number().nullish(),
  model: z.string().nullish(),
  choices: z.array(
    z.object({
      text: z.string(),
      finish_reason: z.string(),
      logprobs: z.object({
        tokens: z.array(z.string()),
        token_logprobs: z.array(z.number()),
        top_logprobs: z.array(z.record(z.string(), z.number())).nullable()
      }).nullish()
    })
  ),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number()
  })
});
var openaiCompletionChunkSchema = z.union([
  z.object({
    id: z.string().nullish(),
    created: z.number().nullish(),
    model: z.string().nullish(),
    choices: z.array(
      z.object({
        text: z.string(),
        finish_reason: z.string().nullish(),
        index: z.number(),
        logprobs: z.object({
          tokens: z.array(z.string()),
          token_logprobs: z.array(z.number()),
          top_logprobs: z.array(z.record(z.string(), z.number())).nullable()
        }).nullish()
      })
    ),
    usage: z.object({
      prompt_tokens: z.number(),
      completion_tokens: z.number()
    }).nullish()
  }),
  openAIErrorDataSchema
]);
var OpenAIEmbeddingModel = class {
  constructor(modelId, settings, config) {
    this.specificationVersion = "v1";
    this.modelId = modelId;
    this.settings = settings;
    this.config = config;
  }
  get provider() {
    return this.config.provider;
  }
  get maxEmbeddingsPerCall() {
    var _a16;
    return (_a16 = this.settings.maxEmbeddingsPerCall) != null ? _a16 : 2048;
  }
  get supportsParallelCalls() {
    var _a16;
    return (_a16 = this.settings.supportsParallelCalls) != null ? _a16 : true;
  }
  async doEmbed({
    values,
    headers,
    abortSignal
  }) {
    if (values.length > this.maxEmbeddingsPerCall) {
      throw new TooManyEmbeddingValuesForCallError({
        provider: this.provider,
        modelId: this.modelId,
        maxEmbeddingsPerCall: this.maxEmbeddingsPerCall,
        values
      });
    }
    const { responseHeaders, value: response } = await postJsonToApi({
      url: this.config.url({
        path: "/embeddings",
        modelId: this.modelId
      }),
      headers: combineHeaders(this.config.headers(), headers),
      body: {
        model: this.modelId,
        input: values,
        encoding_format: "float",
        dimensions: this.settings.dimensions,
        user: this.settings.user
      },
      failedResponseHandler: openaiFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(
        openaiTextEmbeddingResponseSchema
      ),
      abortSignal,
      fetch: this.config.fetch
    });
    return {
      embeddings: response.data.map((item) => item.embedding),
      usage: response.usage ? { tokens: response.usage.prompt_tokens } : void 0,
      rawResponse: { headers: responseHeaders }
    };
  }
};
var openaiTextEmbeddingResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })),
  usage: z.object({ prompt_tokens: z.number() }).nullish()
});
function createOpenAI(options = {}) {
  var _a16, _b, _c;
  const baseURL = (_a16 = withoutTrailingSlash(options.baseURL)) != null ? _a16 : "https://api.openai.com/v1";
  const compatibility = (_b = options.compatibility) != null ? _b : "compatible";
  const providerName = (_c = options.name) != null ? _c : "openai";
  const getHeaders = () => ({
    Authorization: `Bearer ${loadApiKey({
      apiKey: options.apiKey,
      environmentVariableName: "OPENAI_API_KEY",
      description: "OpenAI"
    })}`,
    "OpenAI-Organization": options.organization,
    "OpenAI-Project": options.project,
    ...options.headers
  });
  const createChatModel = (modelId, settings = {}) => new OpenAIChatLanguageModel(modelId, settings, {
    provider: `${providerName}.chat`,
    url: ({ path }) => `${baseURL}${path}`,
    headers: getHeaders,
    compatibility,
    fetch: options.fetch
  });
  const createCompletionModel = (modelId, settings = {}) => new OpenAICompletionLanguageModel(modelId, settings, {
    provider: `${providerName}.completion`,
    url: ({ path }) => `${baseURL}${path}`,
    headers: getHeaders,
    compatibility,
    fetch: options.fetch
  });
  const createEmbeddingModel = (modelId, settings = {}) => new OpenAIEmbeddingModel(modelId, settings, {
    provider: `${providerName}.embedding`,
    url: ({ path }) => `${baseURL}${path}`,
    headers: getHeaders,
    fetch: options.fetch
  });
  const createLanguageModel = (modelId, settings) => {
    if (new.target) {
      throw new Error(
        "The OpenAI model function cannot be called with the new keyword."
      );
    }
    if (modelId === "gpt-3.5-turbo-instruct") {
      return createCompletionModel(
        modelId,
        settings
      );
    }
    return createChatModel(modelId, settings);
  };
  const provider = function(modelId, settings) {
    return createLanguageModel(modelId, settings);
  };
  provider.languageModel = createLanguageModel;
  provider.chat = createChatModel;
  provider.completion = createCompletionModel;
  provider.embedding = createEmbeddingModel;
  provider.textEmbedding = createEmbeddingModel;
  provider.textEmbeddingModel = createEmbeddingModel;
  return provider;
}
var openai = createOpenAI({
  compatibility: "strict"
  // strict for OpenAI API
});

// electron/ai.ts
var CHAT_SYSTEM_TASK = `\u4F60\u662F ai-devflow \u7684\u9700\u6C42\u534F\u4F5C\u52A9\u624B\uFF0C\u5E2E\u52A9\u7528\u6237\u628A\u6A21\u7CCA\u7684\u4EA7\u54C1\u60F3\u6CD5\u7EC6\u5316\u4E3A\u53EF\u6267\u884C\u7684\u5F00\u53D1\u4EFB\u52A1\u3002
- \u7528\u4E2D\u6587\u6C9F\u901A\uFF0C\u7B80\u6D01\u3001\u805A\u7126\u3002
- \u4E3B\u52A8\u6F84\u6E05\u8FB9\u754C\u3001\u9A8C\u6536\u6807\u51C6\u4E0E\u62C6\u5206\u7C92\u5EA6\u3002
- \u5F53\u9700\u6C42\u8DB3\u591F\u6E05\u6670\u65F6\uFF0C\u63D0\u793A\u7528\u6237\u70B9\u51FB"\u751F\u6210\u4EFB\u52A1\u8349\u7A3F"\u4EE5\u81EA\u52A8\u521B\u5EFA\u4EFB\u52A1\u3002`;
var CHAT_SYSTEM_REQ = `\u4F60\u662F ai-devflow \u7684\u9700\u6C42\u5206\u6790\u52A9\u624B\uFF0C\u5E2E\u52A9\u7528\u6237\u628A\u6A21\u7CCA\u7684\u4EA7\u54C1\u60F3\u6CD5\u5B8C\u5584\u4E3A\u51C6\u786E\u3001\u6E05\u6670\u3001\u53EF\u9A8C\u6536\u7684\u9700\u6C42\u3002
- \u7528\u4E2D\u6587\u6C9F\u901A\uFF0C\u7B80\u6D01\u3001\u805A\u7126\uFF0C\u591A\u95EE\u6F84\u6E05\u6027\u95EE\u9898\uFF08\u8FB9\u754C\u3001\u7528\u6237\u3001\u5F02\u5E38\u8DEF\u5F84\u3001\u5B8C\u6210\u5B9A\u4E49\uFF09\u3002
- \u91CD\u70B9\u5E2E\u52A9\u7528\u6237\u660E\u786E"\u5B8C\u6210\u5B9A\u4E49"\u4E0E\u53EF\u68C0\u9A8C\u7684\u9A8C\u6536\u6807\u51C6\uFF08\u95E8\u7981\u6761\u4EF6\uFF09\uFF1A\u600E\u6837\u624D\u7B97\u505A\u5B8C\u4E86\uFF1F
- \u5F53\u9700\u6C42\u8DB3\u591F\u6E05\u6670\u65F6\uFF0C\u63D0\u793A\u7528\u6237\u70B9\u51FB"\u751F\u6210\u9700\u6C42\u8349\u7A3F"\u4EE5\u586B\u5145\u8868\u5355\u3002`;
var PROPOSE_TASK_SYSTEM = `\u6839\u636E\u5BF9\u8BDD\u5185\u5BB9\uFF0C\u63D0\u70BC\u51FA 1 \u5230 N \u4E2A\u53EF\u6267\u884C\u7684\u5F00\u53D1\u4EFB\u52A1\u3002
- \u6BCF\u4E2A\u4EFB\u52A1\u5305\u542B\uFF1A\u6807\u9898\uFF08\u52A8\u5BBE\u7ED3\u6784\uFF0C\u7B80\u6D01\uFF09\u3001\u63CF\u8FF0\uFF08\u5B9E\u73B0\u8981\u70B9\u4E0E\u8FB9\u754C\uFF09\u3001\u89D2\u8272\u3002
- \u89D2\u8272 role \u4EC5\u9650\uFF1Aplanner\uFF08\u89C4\u5212\uFF09\u3001coder\uFF08\u5F00\u53D1\uFF09\u3001reviewer\uFF08\u5BA1\u67E5\uFF09\u3001tester\uFF08\u6D4B\u8BD5\uFF09\u3002
- \u4E0D\u8981\u7F16\u9020\u672A\u63D0\u53CA\u7684\u529F\u80FD\uFF1B\u4E0D\u786E\u5B9A\u65F6\u7ED9\u51FA\u6700\u4FDD\u5B88\u7684\u62C6\u5206\u3002
- \u8F93\u51FA\u683C\u5F0F\uFF1A\u4EC5\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u5F62\u5982 {"tasks":[{"title":"","description":"","role":"coder"}]}\uFF0C\u4E0D\u8981\u5305\u542B markdown \u4EE3\u7801\u5757\u6216\u4EFB\u4F55\u989D\u5916\u8BF4\u660E\u3002`;
var PROPOSE_REQ_SYSTEM = `\u6839\u636E\u5BF9\u8BDD\u5185\u5BB9\uFF0C\u63D0\u70BC\u4E3A\u4E00\u4E2A\u7ED3\u6784\u5316\u7684\u9700\u6C42\u3002
- title\uFF1A\u7B80\u6D01\u7684\u9700\u6C42\u6807\u9898\uFF08\u540D\u8BCD\u77ED\u8BED\uFF09\u3002
- description\uFF1A\u9700\u6C42\u63CF\u8FF0\uFF08\u80CC\u666F\u3001\u76EE\u6807\u3001\u8303\u56F4\uFF09\u3002
- acceptance\uFF1A\u9A8C\u6536\u6807\u51C6 / \u95E8\u7981\u6761\u4EF6\uFF08\u53EF\u68C0\u9A8C\u7684\u5B8C\u6210\u5B9A\u4E49\uFF0C\u591A\u6761\u7528\u5206\u53F7\u6216\u6362\u884C\u5206\u9694\uFF09\u3002
- priority\uFF1Alow / medium / high\u3002
- \u4E0D\u8981\u7F16\u9020\u672A\u63D0\u53CA\u7684\u529F\u80FD\uFF1B\u4E0D\u786E\u5B9A\u65F6\u7ED9\u51FA\u6700\u4FDD\u5B88\u7684\u63CF\u8FF0\u3002
- \u8F93\u51FA\u683C\u5F0F\uFF1A\u4EC5\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u5F62\u5982 {"title":"","description":"","acceptance":"","priority":"medium"}\uFF0C\u4E0D\u8981\u5305\u542B markdown \u4EE3\u7801\u5757\u6216\u4EFB\u4F55\u989D\u5916\u8BF4\u660E\u3002`;
function getModel(cfg) {
  if (!cfg.apiKey?.trim()) {
    throw new Error("\u672A\u914D\u7F6E AI \u670D\u52A1\u5546 API Key\uFF0C\u8BF7\u5728\u201C\u8BBE\u7F6E -> AI \u670D\u52A1\u5546\u201D\u4E2D\u586B\u5199\u3002");
  }
  if (cfg.provider === "anthropic") {
    const anthropic2 = createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || void 0 });
    return anthropic2(cfg.model || "claude-sonnet-5");
  }
  const openai2 = createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || void 0 });
  return openai2(cfg.model || "gpt-4o");
}
function buildSystem(base, context) {
  return context ? `${base}

\u3010\u4E0A\u4E0B\u6587\u3011
${context}` : base;
}
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("\u672A\u627E\u5230 JSON \u5BF9\u8C61");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
async function generateStructured(cfg, system, messages, schema, label) {
  const model = getModel(cfg);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const sys = attempt === 0 ? system : `${system}

\u4F60\u4E0A\u4E00\u6B21\u7684\u8F93\u51FA\u65E0\u6CD5\u89E3\u6790\uFF08${lastError}\uFF09\u3002\u8BF7\u4E25\u683C\u4EC5\u8F93\u51FA\u7B26\u5408\u4E0A\u8FF0\u683C\u5F0F\u7684\u7EAF JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981\u5305\u542B\u4EFB\u4F55\u989D\u5916\u6587\u5B57\u6216\u4EE3\u7801\u5757\u3002`;
    const { text } = await generateText({ model, system: sys, messages });
    let parsed;
    try {
      parsed = extractJson(text);
    } catch (e) {
      lastError = `JSON \u89E3\u6790\u5931\u8D25\uFF1A${e.message}`;
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    lastError = result.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  throw new Error(`AI \u8F93\u51FA\u65E0\u6CD5\u89E3\u6790\u4E3A${label}\uFF1A${lastError}`);
}
var taskSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string().min(1),
      description: z.string(),
      role: z.enum(["planner", "coder", "reviewer", "tester"])
    })
  )
});
var requirementSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  acceptance: z.string(),
  priority: z.enum(["low", "medium", "high"])
});
async function chatStream(cfg, sessionId, messages, send, opts) {
  const base = opts?.mode === "requirement" ? CHAT_SYSTEM_REQ : CHAT_SYSTEM_TASK;
  const system = buildSystem(base, opts?.context);
  let model;
  try {
    model = getModel(cfg);
  } catch (e) {
    send({ type: "error", sessionId, error: e.message });
    return;
  }
  try {
    const result = streamText({ model, system, messages });
    let full = "";
    for await (const delta of result.textStream) {
      full += delta;
      send({ type: "delta", sessionId, text: delta });
    }
    send({ type: "done", sessionId, fullText: full });
  } catch (e) {
    const msg = e.message || String(e);
    send({
      type: "error",
      sessionId,
      error: msg.includes("API key") ? `AI \u8C03\u7528\u5931\u8D25\uFF1AAPI Key \u65E0\u6548\u6216\u672A\u6388\u6743\u3002${msg}` : `AI \u8C03\u7528\u5931\u8D25\uFF08\u8BF7\u68C0\u67E5\u7F51\u7EDC\u4E0E\u914D\u7F6E\uFF09\uFF1A${msg}`
    });
  }
}
async function proposeTasks(cfg, messages, context) {
  const system = buildSystem(PROPOSE_TASK_SYSTEM, context);
  const data = await generateStructured(cfg, system, messages, taskSchema, "\u4EFB\u52A1\u5217\u8868");
  return data.tasks;
}
async function proposeRequirement(cfg, messages) {
  return generateStructured(cfg, PROPOSE_REQ_SYSTEM, messages, requirementSchema, "\u9700\u6C42");
}

// electron/ipc.ts
var channel = (ns, method) => `ai-devflow:${ns}:${method}`;
function deriveProjectName(input) {
  const s = input.trim().replace(/[\\/]+$/, "");
  const last = (s.split(/[\\/]/).pop() ?? s).replace(/\.git$/i, "");
  const parts = last.split(/[-_.]+/).filter(Boolean);
  if (parts.length === 0) return last;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
function registerIpc(services2, send, sendAi) {
  const { repos, orchestrator, timeoutEngine, webhooks, registry, encryptSecret: encryptSecret2, decryptSecret: decryptSecret2 } = services2;
  orchestrator.on("task-event", (e) => send({ kind: "task-event", taskId: e.taskId, data: e.event }));
  orchestrator.on("log", (entry) => send({ kind: "log", taskId: entry.taskId, data: entry }));
  orchestrator.on("task-status", (e) => send({ kind: "task-status", taskId: e.taskId, data: e.status }));
  orchestrator.on("task-canceled", (e) => send({ kind: "task-canceled", taskId: e.taskId, data: null }));
  orchestrator.on("task-failed", (e) => send({ kind: "task-failed", taskId: e.taskId, data: e.error }));
  orchestrator.on("task-error", (e) => send({ kind: "task-failed", taskId: e.taskId, data: e.error }));
  orchestrator.on("task-retry", (e) => send({ kind: "task-status", taskId: e.taskId, data: `retry:${e.reason}` }));
  orchestrator.on("task-recovered-failed", (e) => send({ kind: "task-status", taskId: e.taskId, data: "recovered-failed" }));
  orchestrator.on("task-awaiting", (e) => send({ kind: "task-awaiting", taskId: e.taskId, data: null }));
  import_electron3.ipcMain.handle(channel("projects", "list"), () => repos.projects.list());
  import_electron3.ipcMain.handle(channel("projects", "create"), (_e, input) => {
    const nv = validateProjectName(input.name);
    if (!nv.ok) throw new Error(nv.errors.join("; "));
    const pv = validateLocalPath(input.path);
    if (!pv.ok) throw new Error(pv.errors.join("; "));
    const project = {
      id: randomId(),
      name: input.name.trim(),
      path: input.path,
      defaultBranch: input.defaultBranch || "main",
      createdAt: now(),
      updatedAt: now(),
      settings: {}
    };
    repos.projects.insert(project);
    return project;
  });
  import_electron3.ipcMain.handle(channel("projects", "pickFolder"), (e) => {
    const win = import_electron3.BrowserWindow.fromWebContents(e.sender) ?? void 0;
    return import_electron3.dialog.showOpenDialog(win, { properties: ["openDirectory", "treatPackageAsDirectory"] }).then((res) => {
      if (res.canceled || res.filePaths.length === 0) return null;
      const path = res.filePaths[0];
      return { path, name: deriveProjectName(path) };
    });
  });
  import_electron3.ipcMain.handle(channel("projects", "createAtPath"), (_e, input) => {
    const nv = validateProjectName(input.name);
    if (!nv.ok) throw new Error(nv.errors.join("; "));
    const pv = validateLocalPath(input.parentDir);
    if (!pv.ok) throw new Error(pv.errors.join("; "));
    const defaultBranch = input.defaultBranch || "main";
    const projectDir = (0, import_node_path3.join)(input.parentDir, input.name.trim());
    try {
      (0, import_node_fs.mkdirSync)(projectDir, { recursive: false });
    } catch (err) {
      throw new Error(`\u521B\u5EFA\u9879\u76EE\u76EE\u5F55\u5931\u8D25\uFF1A${err.message}\uFF08\u76EE\u5F55\u53EF\u80FD\u5DF2\u5B58\u5728\uFF09`);
    }
    if (input.gitInit) {
      try {
        (0, import_node_child_process4.execFileSync)("git", ["init"], { cwd: projectDir, stdio: "pipe" });
        (0, import_node_child_process4.execFileSync)("git", ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], { cwd: projectDir, stdio: "pipe" });
        (0, import_node_fs.writeFileSync)((0, import_node_path3.join)(projectDir, "README.md"), `# ${input.name.trim()}
`);
        (0, import_node_child_process4.execFileSync)("git", ["add", "."], { cwd: projectDir, stdio: "pipe" });
        (0, import_node_child_process4.execFileSync)("git", ["commit", "-q", "-m", "init"], { cwd: projectDir, stdio: "pipe" });
      } catch (err) {
        console.warn("[git init] failed:", err.message);
        throw new Error(`git init \u5931\u8D25\uFF1A${err.message}\uFF08\u8BF7\u786E\u8BA4\u5DF2\u5B89\u88C5 git\uFF09`);
      }
    }
    const project = {
      id: randomId(),
      name: input.name.trim(),
      path: projectDir,
      defaultBranch,
      createdAt: now(),
      updatedAt: now(),
      settings: {}
    };
    repos.projects.insert(project);
    return project;
  });
  import_electron3.ipcMain.handle(channel("projects", "update"), (_e, p) => repos.projects.update(p));
  import_electron3.ipcMain.handle(channel("projects", "delete"), (_e, id) => repos.projects.delete(id));
  import_electron3.ipcMain.handle(channel("iterations", "list"), (_e, projectId) => repos.iterations.listByProject(projectId));
  import_electron3.ipcMain.handle(channel("iterations", "create"), (_e, projectId, name15, version) => {
    const it = { id: randomId(), projectId, name: name15, version, status: "active", createdAt: now() };
    repos.iterations.insert(it);
    return it;
  });
  import_electron3.ipcMain.handle(channel("iterations", "archive"), (_e, id) => repos.iterations.archive(id));
  import_electron3.ipcMain.handle(channel("requirements", "list"), (_e, iterationId) => repos.requirements.listByIteration(iterationId));
  import_electron3.ipcMain.handle(channel("requirements", "get"), (_e, id) => repos.requirements.get(id));
  import_electron3.ipcMain.handle(channel("requirements", "create"), (_e, iterationId, title, description, priority, acceptance) => {
    const r = {
      id: randomId(),
      iterationId,
      title,
      description,
      priority,
      acceptance,
      createdAt: now(),
      archived: false
    };
    repos.requirements.insert(r);
    return r;
  });
  import_electron3.ipcMain.handle(channel("requirements", "update"), (_e, r) => repos.requirements.update(r));
  import_electron3.ipcMain.handle(channel("requirements", "archive"), (_e, id) => {
    const req = repos.requirements.get(id);
    if (!req) throw new Error("\u9700\u6C42\u4E0D\u5B58\u5728");
    const tasks = repos.tasks.listByRequirement(id);
    const gate = canArchiveRequirement(tasks);
    if (!gate.ok) throw new Error(gate.reasons.join("; "));
    repos.requirements.archive(id, now());
  });
  import_electron3.ipcMain.handle(channel("tasks", "listByIteration"), (_e, iterationId) => repos.tasks.listByIteration(iterationId));
  import_electron3.ipcMain.handle(channel("tasks", "listByProject"), (_e, projectId) => repos.tasks.listByProject(projectId));
  import_electron3.ipcMain.handle(channel("tasks", "listAll"), () => repos.tasks.list());
  import_electron3.ipcMain.handle(channel("tasks", "listByRequirement"), (_e, requirementId) => repos.tasks.listByRequirement(requirementId));
  import_electron3.ipcMain.handle(channel("tasks", "get"), (_e, id) => repos.tasks.get(id));
  import_electron3.ipcMain.handle(channel("tasks", "create"), (_e, input) => {
    const req = repos.requirements.get(input.requirementId);
    if (!req) throw new Error("\u9700\u6C42\u4E0D\u5B58\u5728");
    const iteration = repos.iterations.get(req.iterationId);
    if (!iteration) throw new Error("\u8FED\u4EE3\u4E0D\u5B58\u5728");
    const t = {
      id: randomId(),
      requirementId: input.requirementId,
      iterationId: req.iterationId,
      projectId: iteration.projectId,
      title: input.title,
      description: input.description,
      status: "backlog",
      agentType: input.agentType,
      role: input.role,
      stages: [{ id: "impl", name: "\u5B9E\u73B0", role: input.role }],
      currentStage: 0,
      statusChangedAt: now(),
      createdAt: now(),
      updatedAt: now(),
      retryCount: 0,
      dependsOn: input.dependsOn
    };
    repos.tasks.insert(t);
    return t;
  });
  import_electron3.ipcMain.handle(channel("tasks", "update"), (_e, input) => {
    const t = repos.tasks.get(input.id);
    if (!t) throw new Error("\u4EFB\u52A1\u4E0D\u5B58\u5728");
    if (t.status !== "backlog" && t.status !== "ready") {
      throw new Error("\u4EC5\u9700\u6C42\u6C60/\u5F85\u5F00\u53D1\u72B6\u6001\u7684\u4EFB\u52A1\u53EF\u7F16\u8F91");
    }
    if (input.title !== void 0) t.title = input.title;
    if (input.description !== void 0) t.description = input.description;
    if (input.role !== void 0) t.role = input.role;
    if (input.agentType !== void 0) t.agentType = input.agentType || void 0;
    if (input.dependsOn !== void 0) t.dependsOn = input.dependsOn === null ? [] : input.dependsOn;
    t.updatedAt = now();
    repos.tasks.update(t);
    return t;
  });
  import_electron3.ipcMain.handle(channel("tasks", "updateStatus"), (_e, id, target) => {
    const t = repos.tasks.get(id);
    if (!t) throw new Error("\u4EFB\u52A1\u4E0D\u5B58\u5728");
    const req = repos.requirements.get(t.requirementId);
    const hasExec = repos.executions.listByTask(id).length > 0;
    const hasCp = !!repos.checkpoints.getLatest(id);
    const gate = canTransition(t, target, {
      hasAcceptance: !!req?.acceptance,
      hasAgentAssigned: !!t.agentType,
      hasArtifacts: hasExec || hasCp,
      testPassed: target === "archived" ? hasExec : void 0,
      auditOk: target === "archived" ? true : void 0,
      hasUserAnswer: !!repos.pendingQuestions.get(id)?.answer
    });
    if (!gate.ok) throw new Error(`\u72B6\u6001\u8FC1\u79FB\u88AB\u95E8\u7981\u62D2\u7EDD\uFF1A${gate.reasons.join("; ")}`);
    repos.tasks.updateStatus(id, target, now());
  });
  import_electron3.ipcMain.handle(channel("tasks", "pause"), (_e, id) => {
    const t = repos.tasks.get(id);
    if (!t) throw new Error("\u4EFB\u52A1\u4E0D\u5B58\u5728");
    if (t.status !== "in_progress" && t.status !== "in_review") {
      throw new Error("\u4EC5\u5F00\u53D1\u4E2D/\u6D4B\u8BD5\u4E2D\u4EFB\u52A1\u53EF\u6807\u8BB0\u5F85\u6C9F\u901A");
    }
    const gate = canTransition(t, "awaiting_input", { hasAcceptance: true, hasAgentAssigned: true, hasArtifacts: true });
    if (!gate.ok) throw new Error(`\u65E0\u6CD5\u6682\u505C\uFF1A${gate.reasons.join("; ")}`);
    repos.tasks.updateStatus(id, "awaiting_input", now());
  });
  import_electron3.ipcMain.handle(channel("tasks", "start"), (_e, id) => orchestrator.start(id));
  import_electron3.ipcMain.handle(channel("tasks", "resume"), (_e, id, answer) => orchestrator.resume(id, answer));
  import_electron3.ipcMain.handle(channel("tasks", "cancel"), (_e, id) => orchestrator.cancel(id));
  import_electron3.ipcMain.handle(channel("tasks", "retry"), (_e, id) => orchestrator.retry(id));
  import_electron3.ipcMain.handle(channel("tasks", "logs"), (_e, id) => repos.logs.listByTask(id));
  import_electron3.ipcMain.handle(channel("tasks", "executions"), (_e, id) => repos.executions.listByTask(id));
  import_electron3.ipcMain.handle(channel("tasks", "pendingQuestion"), (_e, id) => repos.pendingQuestions.get(id));
  import_electron3.ipcMain.handle(channel("agents", "detectAll"), async () => {
    const types = ["claude_code", "codex", "pi"];
    return Promise.all(types.map((t) => registry.require(t).detect()));
  });
  import_electron3.ipcMain.handle(channel("agents", "detect"), (_e, type) => registry.require(type).detect());
  import_electron3.ipcMain.handle(channel("notificationRules", "list"), () => repos.notificationRules.list());
  import_electron3.ipcMain.handle(channel("notificationRules", "create"), (_e, rule) => {
    const r = { ...rule, id: rule.id || randomId() };
    repos.notificationRules.insert(r);
    return r;
  });
  import_electron3.ipcMain.handle(channel("notificationRules", "update"), (_e, r) => repos.notificationRules.update(r));
  import_electron3.ipcMain.handle(channel("notificationRules", "delete"), (_e, id) => repos.notificationRules.delete(id));
  const mask = (w) => ({ ...w, secret: "" });
  import_electron3.ipcMain.handle(channel("webhooks", "list"), () => repos.webhookConfigs.list().map(mask));
  import_electron3.ipcMain.handle(channel("webhooks", "create"), (_e, input) => {
    const w = {
      id: randomId(),
      name: input.name,
      url: input.url,
      secret: encryptSecret2(input.secret || ""),
      events: input.events,
      enabled: true,
      createdAt: now()
    };
    repos.webhookConfigs.insert(w);
    return mask(w);
  });
  import_electron3.ipcMain.handle(channel("webhooks", "update"), (_e, w) => {
    const existing = repos.webhookConfigs.get(w.id);
    if (!existing) throw new Error("webhook \u4E0D\u5B58\u5728");
    const updated = {
      ...w,
      secret: w.secret ? encryptSecret2(w.secret) : existing.secret,
      createdAt: existing.createdAt
    };
    repos.webhookConfigs.update(updated);
    return mask(updated);
  });
  import_electron3.ipcMain.handle(channel("webhooks", "delete"), (_e, id) => repos.webhookConfigs.delete(id));
  import_electron3.ipcMain.handle(channel("webhooks", "test"), async (_e, id) => {
    const w = repos.webhookConfigs.get(id);
    if (!w) throw new Error("webhook \u4E0D\u5B58\u5728");
    const plain = { ...w, secret: decryptSecret2(w.secret) };
    const res = await webhooks.test(plain);
    return { ok: res.ok, status: res.status, attempts: res.attempts };
  });
  import_electron3.ipcMain.handle(channel("webhooks", "deliveries"), (_e, id) => repos.webhookDeliveries.listByWebhook(id));
  import_electron3.ipcMain.handle(channel("settings", "getLocale"), () => {
    const raw = repos.credentials.get("locale");
    return raw === "en" ? "en" : "zh";
  });
  import_electron3.ipcMain.handle(channel("settings", "setLocale"), (_e, locale) => {
    repos.credentials.upsert("locale", locale);
  });
  import_electron3.ipcMain.handle(channel("settings", "getAiProvider"), () => {
    const raw = repos.credentials.get("ai_provider");
    if (!raw) return void 0;
    try {
      const cfg = JSON.parse(decryptSecret2(raw));
      return { provider: cfg.provider, apiKey: "", baseURL: cfg.baseURL, model: cfg.model };
    } catch {
      return void 0;
    }
  });
  import_electron3.ipcMain.handle(channel("settings", "setAiProvider"), (_e, cfg) => {
    if (!cfg) {
      repos.credentials.delete("ai_provider");
      return;
    }
    let apiKey = cfg.apiKey;
    if (!apiKey) {
      const raw = repos.credentials.get("ai_provider");
      if (raw) {
        try {
          apiKey = JSON.parse(decryptSecret2(raw)).apiKey ?? "";
        } catch {
        }
      }
    }
    repos.credentials.upsert("ai_provider", encryptSecret2(JSON.stringify({ ...cfg, apiKey })));
  });
  import_electron3.ipcMain.handle(channel("settings", "getProjectSettings"), (_e, projectId) => repos.projects.get(projectId)?.settings ?? {});
  import_electron3.ipcMain.handle(channel("settings", "updateProjectSettings"), (_e, projectId, settings) => repos.projects.updateSettings(projectId, settings));
  import_electron3.ipcMain.on("ai-devflow:ai:chat", async (_e, payload) => {
    const raw = repos.credentials.get("ai_provider");
    if (!raw) {
      sendAi({ type: "error", sessionId: payload.sessionId, error: "\u5C1A\u672A\u914D\u7F6E AI \u670D\u52A1\u5546\uFF0C\u8BF7\u5728\u201C\u8BBE\u7F6E -> AI \u670D\u52A1\u5546\u201D\u4E2D\u586B\u5199\u3002" });
      return;
    }
    let cfg;
    try {
      cfg = JSON.parse(decryptSecret2(raw));
    } catch {
      sendAi({ type: "error", sessionId: payload.sessionId, error: "AI \u670D\u52A1\u5546\u914D\u7F6E\u635F\u574F\uFF0C\u8BF7\u91CD\u65B0\u586B\u5199\u3002" });
      return;
    }
    await chatStream(cfg, payload.sessionId, payload.messages, sendAi, { mode: payload.mode, context: payload.context });
  });
  import_electron3.ipcMain.handle(channel("ai", "propose"), async (_e, messages, context) => {
    const raw = repos.credentials.get("ai_provider");
    if (!raw) throw new Error("\u5C1A\u672A\u914D\u7F6E AI \u670D\u52A1\u5546\uFF0C\u8BF7\u5728\u201C\u8BBE\u7F6E -> AI \u670D\u52A1\u5546\u201D\u4E2D\u586B\u5199\u3002");
    const cfg = JSON.parse(decryptSecret2(raw));
    return proposeTasks(cfg, messages, context);
  });
  import_electron3.ipcMain.handle(channel("ai", "proposeRequirement"), async (_e, messages) => {
    const raw = repos.credentials.get("ai_provider");
    if (!raw) throw new Error("\u5C1A\u672A\u914D\u7F6E AI \u670D\u52A1\u5546\uFF0C\u8BF7\u5728\u201C\u8BBE\u7F6E -> AI \u670D\u52A1\u5546\u201D\u4E2D\u586B\u5199\u3002");
    const cfg = JSON.parse(decryptSecret2(raw));
    return proposeRequirement(cfg, messages);
  });
  timeoutEngine.start();
}

// electron/notifier.ts
var import_electron4 = require("electron");
var ElectronNotifier = class {
  constructor(getWindow, onDeepLink) {
    this.getWindow = getWindow;
    this.onDeepLink = onDeepLink;
  }
  async notify(n) {
    const note = new import_electron4.Notification({
      title: n.title,
      body: n.body
    });
    note.on("click", () => {
      const win = this.getWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      if (n.taskId) this.onDeepLink(n.taskId);
    });
    note.show();
  }
};
function parseDeepLink(url) {
  const m = /^ai-devflow:\/\/task\/(.+)$/.exec(url);
  if (m) return { taskId: decodeURIComponent(m[1]) };
  return void 0;
}

// electron/main.ts
var isDev = !import_electron5.app.isPackaged && process.env.AI_DEVFLOW_DEV === "1";
var mainWindow;
var services;
var pendingDeepLinkTaskId;
function createWindow() {
  const win = new import_electron5.BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: (0, import_node_path4.join)(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  win.once("ready-to-show", () => win.show());
  if (isDev) {
    win.loadURL("http://127.0.0.1:5174");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile((0, import_node_path4.join)(__dirname, "../dist/index.html"));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      import_electron5.shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  return win;
}
function installCsp() {
  const csp = isDev ? "default-src 'self' 'unsafe-inline' http://127.0.0.1:5174 ws://127.0.0.1:5174; img-src 'self' data: blob:;" : "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';";
  import_electron5.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp]
      }
    });
  });
}
function registerDeepLinkProtocol() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      import_electron5.app.setAsDefaultProtocolClient("ai-devflow", process.execPath, [(0, import_node_fs2.existsSync)(process.argv[1]) ? process.argv[1] : ""]);
    }
  } else {
    import_electron5.app.setAsDefaultProtocolClient("ai-devflow");
  }
  import_electron5.protocol.handle("ai-devflow", (request) => {
    const parsed = parseDeepLink(request.url);
    if (parsed?.taskId) {
      handleDeepLink(parsed.taskId);
    }
    return new Response("", { status: 200 });
  });
}
function handleDeepLink(taskId) {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send("ai-devflow:deep-link", { taskId });
  } else {
    pendingDeepLinkTaskId = taskId;
  }
}
import_electron5.app.whenReady().then(async () => {
  if (process.env.AI_DEVFLOW_USER_DATA) {
    import_electron5.app.setPath("userData", process.env.AI_DEVFLOW_USER_DATA);
  }
  installCsp();
  registerDeepLinkProtocol();
  mainWindow = createWindow();
  const notifier = new ElectronNotifier(() => mainWindow, (taskId) => handleDeepLink(taskId));
  services = createServices(notifier);
  const send = (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ai-devflow:stream", e);
    }
  };
  const sendAi = (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ai-devflow:ai-stream", e);
    }
  };
  registerIpc(services, send, sendAi);
  try {
    await services.orchestrator.recover();
  } catch (err) {
    console.error("[recover] error:", err.message);
  }
  if (pendingDeepLinkTaskId) {
    handleDeepLink(pendingDeepLinkTaskId);
    pendingDeepLinkTaskId = void 0;
  }
  import_electron5.app.on("activate", () => {
    if (import_electron5.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
import_electron5.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") import_electron5.app.quit();
});
import_electron5.app.on("open-url", (event, url) => {
  event.preventDefault();
  const parsed = parseDeepLink(url);
  if (parsed?.taskId) handleDeepLink(parsed.taskId);
});
//# sourceMappingURL=main.cjs.map
