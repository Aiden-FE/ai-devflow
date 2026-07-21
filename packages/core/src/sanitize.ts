// 输入校验与敏感字段脱敏。

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateProjectName(name: string): ValidationResult {
  const errors: string[] = [];
  const trimmed = name.trim();
  if (trimmed.length === 0) errors.push('项目名不能为空');
  if (trimmed.length > 120) errors.push('项目名过长（>120）');
  if (/[<>]/.test(trimmed)) errors.push('项目名含非法字符 < 或 >');
  return { ok: errors.length === 0, errors };
}

export function validateLocalPath(path: string): ValidationResult {
  const errors: string[] = [];
  if (path.trim().length === 0) errors.push('路径不能为空');
  if (!path.startsWith('/')) errors.push('必须是绝对路径');
  if (path.includes('\n')) errors.push('路径含换行');
  return { ok: errors.length === 0, errors };
}

export function validateWebhookUrl(url: string): ValidationResult {
  const errors: string[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, errors: ['URL 格式非法'] };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    errors.push('仅支持 http/https');
  }
  return { ok: errors.length === 0, errors };
}

export function validateMinutes(minutes: number): ValidationResult {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, errors: ['分钟数必须为正数'] };
  }
  if (minutes > 60 * 24 * 30) {
    return { ok: false, errors: ['分钟数过大'] };
  }
  return { ok: true, errors: [] };
}

export function validatePrompt(prompt: string): ValidationResult {
  if (prompt.trim().length === 0) return { ok: false, errors: ['提示词不能为空'] };
  if (prompt.length > 50_000) return { ok: false, errors: ['提示词过长'] };
  return { ok: true, errors: [] };
}

/** 已知的敏感字段名（小写匹配）。 */
export const SENSITIVE_FIELDS = new Set([
  'secret',
  'token',
  'apikey',
  'api_key',
  'password',
  'passwd',
  'authorization',
  'auth',
  'webhooksecret',
  'privatekey',
  'credential',
]);

/** 已知的敏感模式：长 token、Bearer、AWS key 等。 */
const SENSITIVE_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /sk-[A-Za-z0-9_\-]{16,}/g, replacement: 'sk-***' },
  { re: /Bearer\s+[A-Za-z0-9._\-]{8,}/gi, replacement: 'Bearer ***' },
  { re: /AKIA[0-9A-Z]{12,}/g, replacement: 'AKIA***' },
  { re: /[A-Za-z0-9_\-]{32,}/g, replacement: '***' }, // 长 hex/base64 串
];

/** 脱敏文本中的敏感串。 */
export function redactText(input: string): string {
  let out = input;
  for (const { re, replacement } of SENSITIVE_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** 脱敏对象：对键名敏感的字段整体掩码，对字符串值做 redactText。 */
export function redactObject<T>(obj: T): T {
  return redactDeep(obj) as T;
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELDS.has(k.toLowerCase())) {
        out[k] = typeof v === 'string' && v.length > 0 ? '***' : v;
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out;
  }
  return value;
}

/** 校验项目设置整体。 */
export function validateAll(inputs: {
  name?: string;
  path?: string;
}): ValidationResult {
  const errors: string[] = [];
  if (inputs.name !== undefined) errors.push(...validateProjectName(inputs.name).errors);
  if (inputs.path !== undefined) errors.push(...validateLocalPath(inputs.path).errors);
  return { ok: errors.length === 0, errors };
}
