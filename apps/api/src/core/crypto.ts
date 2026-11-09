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

/**
 * 主密钥形态校验：base64 必须解码出正好 32 字节。
 * 后台保存私密项前应先调这里转成可读的 400 —— 否则 encryptSecret 抛的是裸 Error，
 * 会被 envelope 归类成 500「服务器错误」，管理员无从知道是密钥格式（hex/短串/带引号）错了。
 */
export function isMasterKeyValid(masterB64?: string): boolean {
  if (!masterB64) return false;
  try {
    return fromB64(masterB64).length === 32;
  } catch {
    return false;
  }
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * 把运维实际填进来的值归一化成「base64 的 32 字节」，不认识则返回 null。
 *
 * 为什么要宽容 hex：README 里 JWT_SECRET 的生成命令是 `randomBytes(32).toString('hex')`，
 * 紧挨着的 master key 命令才是 base64 —— 管理员照着第一条做（脚本/习惯）时贴进来的就是 64 位 hex。
 * 同一份随机熵，两种写法都代表 32 字节密钥，这里统一接受，避免"配了却说格式不对"的反复；
 * 其余形态（命令原文、带引号、短串）仍然拒绝，由调用侧报可读的 400。
 */
export function normalizeMasterKey(value?: string): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (HEX64.test(v)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(v.slice(i * 2, i * 2 + 2), 16);
    return toB64(bytes.buffer as ArrayBuffer);
  }
  return isMasterKeyValid(v) ? v : null;
}

/**
 * 值的形态摘要（**不含任何密钥内容**）：长度 / base64 解码字节数 / 是否含非 ASCII。
 * 形参非法时把它附在 400 文案后，管理员一眼能分辨：
 *   len=71 → 把命令原文贴进去了；len=64 但未通过 → 含非 hex 字符；
 *   len=44,bytes=33 → 多了个字符；len=45,nonAscii=1 → 混进了全角/零宽字符。
 */
export function masterKeyShape(value?: string): string {
  const v = (value ?? '').trim();
  if (!v) return 'len=0';
  let bytes = -1;
  try {
    bytes = fromB64(v).length;
  } catch {
    bytes = -1;
  }
  const nonAscii = /[^\x20-\x7E]/.test(v) ? 1 : 0;
  return `len=${v.length},base64Bytes=${bytes},nonAscii=${nonAscii}`;
}

/**
 * 由 `JWT_SECRET` 派生主密钥（SHA-256 → 32 字节 → base64）。
 * 零配置兜底：JWT_SECRET 是每个部署的必填项，于是「只填必填项」也能保存 SMTP 密码。
 * 代价是轮换 JWT_SECRET 会让已存密文解不开（需重填密码）——文档已注明；
 * 希望隔离的部署仍显式配置 SECRETS_MASTER_KEY（优先级更高）。
 */
export async function deriveMasterKey(seed: string): Promise<string> {
  return toB64(await crypto.subtle.digest('SHA-256', te.encode(seed)));
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
