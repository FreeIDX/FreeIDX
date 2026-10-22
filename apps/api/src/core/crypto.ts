/**
 * 扩展私密密钥命名空间 AES-GCM 加解密（§17.1 `ext:{id}:secret`，T5-4 支付通道复用同一封装）。
 * master key 走 wrangler Secret（SECRETS_MASTER_KEY，base64 编码的 32 字节 AES-256 密钥），
 * 密文格式 `v1.<iv_b64>.<ct_b64>`；密钥缺失或解密失败一律返回 null（调用侧按未配置处理，绝不回退明文）。
 */
import { t0 } from './i18n';

const te = new TextEncoder();
const td = new TextDecoder();

function toB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

async function aesKey(masterB64: string): Promise<CryptoKey> {
  const raw = fromB64(masterB64);
  if (raw.length !== 32) throw new Error(t0('sec.masterKeyInvalid'));
  return crypto.subtle.importKey('raw', raw as unknown as ArrayBuffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** 加密明文 → `v1.iv.ciphertext`；master key 缺失即抛（调用侧须先校验配置存在） */
export async function encryptSecret(plaintext: string, masterB64: string): Promise<string> {
  const key = await aesKey(masterB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as ArrayBuffer }, key, te.encode(plaintext));
  return `v1.${toB64(iv.buffer as ArrayBuffer)}.${toB64(ct)}`;
}

/** 解密密文 → 明文；任何异常/格式不符返回 null（安全失败，不外泄、不崩站） */
export async function decryptSecret(token: string, masterB64: string): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const key = await aesKey(masterB64);
    const iv = fromB64(parts[1]!);
    const ct = fromB64(parts[2]!);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as ArrayBuffer }, key, ct as unknown as ArrayBuffer);
    return td.decode(pt);
  } catch {
    return null;
  }
}
