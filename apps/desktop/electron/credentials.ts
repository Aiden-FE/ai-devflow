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

/**
 * 安全存储后端是否真正加密：不可用或 Linux 选用 'basic_text'（明文落盘）均视为不安全。
 * getSelectedStorageBackend 在部分 Electron/平台可能不存在，做可选调用。
 */
function secureBackendAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  if (backend === 'basic_text') return false;
  return true;
}

/**
 * 严格加密 Provider API Key：安全存储不可用（或 Linux basic_text 明文后端）时抛错，绝不写明文。
 * 与 encryptSecret 不同——后者会退回 base64 占位；Provider 密钥不允许任何明文落盘。
 */
export function encryptProviderSecret(plain: string): string {
  if (!secureBackendAvailable()) throw new Error('安全存储不可用');
  return 'enc:' + safeStorage.encryptString(plain).toString('base64');
}

/** 严格解密 Provider API Key：只接受 enc: 密文；其它形态一律拒绝。 */
export function decryptProviderSecret(stored: string): string {
  if (!stored.startsWith('enc:')) throw new Error('非法的密钥密文');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('安全存储不可用');
  return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
}
