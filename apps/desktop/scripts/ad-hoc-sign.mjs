// electron-builder afterSign 钩子：macOS 产物以 Ad hoc（无证书）方式封装整个 .app。
//
// 为什么需要它：electron-builder 在 CSC_IDENTITY_AUTO_DISCOVERY=false 时不会对顶层 bundle
// 做任何签名（仅 Electron 自带二进制是 linker-signed adhoc）。未封装的 bundle 资源未密封，
// 在部分 macOS（尤其 Apple Silicon）上首次运行更易出现「已损坏」提示。这里用 Ad hoc 身份
// （`-`）整体封装 bundle，使产物成为结构完整的 Ad hoc 签名应用：仍未经公证，Gatekeeper 仍会
// 隔离，用户首次运行执行 `xattr -d com.apple.quarantine` 放行即可（详见 README 安装说明）。
//
// 为什么是 Ad hoc 而非开发者证书：本项目为开源、无 Apple 付费开发者证书的发版流程；
// Ad hoc 签名不需要任何证书，且足以让应用在移除隔离属性后正常启动。
//
// 与自动更新的关系：Ad hoc 签名的应用无法被 Squirrel.Mac 自动安装更新（需要相同的开发者
// 身份/DR）。updater.ts 的签名检测会识别 Ad hoc（无 Authority）并改为引导用户到 GitHub Releases
// 手动下载，因此这里无需为自动更新做额外处理。
//
// 仅在 macOS 打包时执行；其它平台直接返回。失败即抛错（让构建失败，绝不静默放过未签名产物）。
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 在 electron-builder 的 appOutDir 中定位唯一的 .app bundle。 */
function findAppBundle(appOutDir) {
  if (!appOutDir) return undefined;
  for (const name of readdirSync(appOutDir)) {
    if (name.endsWith('.app')) return join(appOutDir, name);
  }
  return undefined;
}

/** 以回调形式调用 codesign，返回 { code, stderr }（stderr 含诊断信息）。 */
function runCodesign(args) {
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', args, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
export default async function afterSign(context) {
  // 仅 macOS 需要封装签名。
  if (process.platform !== 'darwin') return;
  // 若显式提供开发者证书（本地正式签名场景），交由 electron-builder 自行签名，这里不覆盖。
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('[ad-hoc-sign] 检测到 CSC_LINK/CSC_NAME，跳过 Ad hoc 封装（由 electron-builder 用开发者证书签名）。');
    return;
  }

  const appPath = findAppBundle(context.appOutDir);
  if (!appPath) {
    throw new Error(`[ad-hoc-sign] 未在 appOutDir=${context.appOutDir} 中找到 .app，无法 Ad hoc 封装。`);
  }

  console.log(`[ad-hoc-sign] 以 Ad hoc 身份封装 ${appPath}`);
  // --force：覆盖既有签名；--deep：递归封装嵌套的 Helper/Framework（Ad hoc 无 hardened runtime，--deep 适用）。
  const sign = await runCodesign(['--force', '--deep', '--sign', '-', appPath]);
  if (sign.code !== 0) {
    throw new Error(`[ad-hoc-sign] codesign 封装失败（exit ${sign.code}）：\n${sign.stderr}`);
  }

  // 校验：结构必须合法（--strict）。Ad hoc 签名可通过 --verify，但无 Authority，故 updater 会走手动下载。
  const verify = await runCodesign(['--verify', '--strict', '--verbose=2', appPath]);
  if (verify.code !== 0) {
    throw new Error(`[ad-hoc-sign] 封装后校验失败（exit ${verify.code}）：\n${verify.stderr}`);
  }

  // 确认确为 Ad hoc（无 Authority / TeamIdentifier not set），避免误用真实身份后被当作可自动更新。
  const info = await runCodesign(['-dv', '--verbose=4', appPath]);
  const dump = `${info.stdout}\n${info.stderr}`;
  const isAdhoc = /Signature\s*=\s*adhoc/i.test(dump) || /flags=[^\n]*adhoc/i.test(dump);
  if (!isAdhoc) {
    throw new Error(`[ad-hoc-sign] 封装后未检测到 Ad hoc 签名，产物签名身份异常：\n${dump}`);
  }
  console.log('[ad-hoc-sign] Ad hoc 封装完成并校验通过。');
}
