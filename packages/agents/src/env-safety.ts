// 子进程环境安全（设计 §14）：受控 PATH 白名单构造。
//
// PATH 只保留角色工具执行所需的系统标准目录，不直接透传 process.env.PATH，不含任何
// $HOME 相对（用户级）目录，也不参与 Pi 入口解析（入口用绝对路径，见 §6.3）。Pi 的 bash
// 工具沿此 PATH 解析 git 等系统工具；项目自有的 Node/编译器等工具链由角色 bash 显式调用
// 或经项目本地工具（node_modules/.bin）使用，不从应用启动环境透传。

/** macOS 受信系统目录白名单（含 Apple Silicon / Intel Homebrew 与 Xcode CLT）。 */
const TRUSTED_PATH_DIRS_DARWIN = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/Library/Developer/CommandLineTools/usr/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

/** Linux 受信系统目录白名单（FHS + snap）。 */
const TRUSTED_PATH_DIRS_LINUX = [
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/snap/bin',
];

/**
 * 构造受控 PATH（设计 §14）：从平台受信系统目录白名单构造，绝不透传 process.env.PATH，
 * 不含任何 $HOME 相对（用户级）目录。Windows 走 SystemRoot\System32 系统目录。
 *
 * 这是「白名单」而非「黑名单过滤」：只产出受信系统目录，即使应用启动环境注入了
 * `/tmp/evil/bin` 等非用户级但不受信的目录也不会进入 Pi 子进程。
 */
export function buildControlledPath(
  platform: NodeJS.Platform = process.platform,
  systemRoot: string = process.env.SystemRoot ?? 'C:\\Windows',
): string {
  if (platform === 'win32') {
    return [`${systemRoot}\\System32`, `${systemRoot}\\System32\\Wbem`, systemRoot].join(';');
  }
  const trusted = platform === 'darwin' ? TRUSTED_PATH_DIRS_DARWIN : TRUSTED_PATH_DIRS_LINUX;
  return trusted.join(':');
}
