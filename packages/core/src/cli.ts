// CLI 输出标准化：把 Agent CLI 的原始终端输出归一化为干净、可展示的日志行。
// 处理 ANSI 控制序列、回车光标重置、CRLF、不可见控制字符、行尾空白。

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OTHER_CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** 移除 ANSI 转义与其它控制字符。 */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '').replace(OTHER_CTRL_RE, '');
}

/** 规范换行为 \n。 */
export function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 处理光标回退（\r 覆盖同一行）后产生的“进度行”：保留每段 \r 分隔的最后一段。 */
export function collapseCarriage(input: string): string {
  return input
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      return parts[parts.length - 1] ?? '';
    })
    .join('\n');
}

export interface StandardLine {
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** 把原始输出标准化为日志行数组：去 ANSI、规范换行、折叠回车、去空行与尾空白。 */
export function standardizeCliOutput(raw: string): StandardLine[] {
  const cleaned = collapseCarriage(normalizeNewlines(stripAnsi(raw)));
  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.map((l) => ({ level: inferLevel(l), text: l }));
}

/** 根据常见前缀/关键词推断日志级别。 */
export function inferLevel(line: string): 'info' | 'warn' | 'error' {
  const lower = line.toLowerCase();
  if (/\b(error|err|failed|failure|fatal|panic)\b/.test(lower)) return 'error';
  if (/\b(warn|warning|deprecat)\b/.test(lower)) return 'warn';
  return 'info';
}

/** 把多行原始输出压缩成单行摘要（用于通知/历史）。 */
export function summarizeOutput(raw: string, maxLen = 200): string {
  const lines = standardizeCliOutput(raw);
  if (lines.length === 0) return '';
  const last = lines[lines.length - 1]!.text;
  if (last.length <= maxLen) return last;
  return last.slice(0, maxLen - 1) + '…';
}
