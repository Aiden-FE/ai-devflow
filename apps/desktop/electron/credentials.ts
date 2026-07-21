// 凭证安全存储：用 Electron safeStorage 加密 Webhook 密钥等敏感值，落盘为密文。
// safeStorage 在 macOS 用 Keychain，在 Windows 用 DPAPI，在 Linux 用 libsecret。
import { safeStorage } from 'electron';

export function encryptSecret(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // 不可用时退回 base64（仅作占位，并标记），生产环境应提示用户。
    return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
  }
  return 'enc:' + safeStorage.encryptString(plain).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (stored.startsWith('enc:')) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('密钥已加密但当前环境无法解密（safeStorage 不可用）');
    }
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  }
  if (stored.startsWith('b64:')) {
    return Buffer.from(stored.slice(4), 'base64').toString('utf8');
  }
  return stored;
}
