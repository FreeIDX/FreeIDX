/**
 * core/auth（T2-1，§8.4）：PasswordHasher 接口（算法可换）+ PBKDF2-SHA256 主实现
 * + 存量 `md5(前端md5(明文)+salt)` 兼容校验 + 待升级标记。
 * 铁律：登录请求内不做重算（2× CPU 陷阱）——verify 只判格式并回报 upgradeNeeded，
 * 重哈希发生在改密（低频、本就单次哈希）或迁移任务；接口含 iterations 参数，调参不动业务代码。
 * 入参口令均为前端预哈希串（存量数据迁移期保留）。
 */
import { md5Hex } from '@freeidx/shared';

/** S1 spike 本机标定：2 万次 ≈2.7ms（≤8ms 目标 3 倍余量，抗 workerd 波动）；远端复核后再上调 */
export const PBKDF2_ITERATIONS = 20_000;
const KEY_LEN_BITS = 256;

interface PasswordHasher {
  readonly algorithm: string;
  hash(clientPassword: string): Promise<string>;
  /** 返回是否匹配；stored 为本实现自产的编码串 */
  verify(clientPassword: string, stored: string): Promise<boolean>;
}

interface VerifyResult {
  ok: boolean;
  /** 存量 md5 格式验证通过 → 待升级标记（不在本请求内重算） */
  upgradeNeeded: boolean;
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHexHex(hex: string): Uint8Array {
  // 奇数长度会让 new Uint8Array(len/2) 得到非整数长度 → RangeError: Invalid typed array length；
  // 库中存量哈希被写坏（salt 奇数字节）时不应把登录整体打成 500，故按偶长度截断兜底。
  const even = hex.length % 2 === 0 ? hex : hex.slice(0, -1);
  const out = new Uint8Array(even.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(even.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomSaltHex(bytes = 16): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b.buffer);
}

/** 恒定时间比较（长度已在 hex 层归一） */
function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2Hex(clientPassword: string, saltHex: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(clientPassword), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHexHex(saltHex), iterations, hash: 'SHA-256' },
    key,
    KEY_LEN_BITS,
  );
  return toHex(bits);
}

/** 编码：pbkdf2$sha256$<iterations>$<saltHex>$<hashHex> */
export class Pbkdf2Sha256Hasher implements PasswordHasher {
  readonly algorithm = 'pbkdf2-sha256';
  constructor(readonly iterations: number = PBKDF2_ITERATIONS) {}

  async hash(clientPassword: string): Promise<string> {
    const salt = randomSaltHex();
    const hash = await pbkdf2Hex(clientPassword, salt, this.iterations);
    return `pbkdf2$sha256$${this.iterations}$${salt}$${hash}`;
  }

  async verify(clientPassword: string, stored: string): Promise<boolean> {
    const p = stored.split('$');
    if (p.length !== 5 || p[0] !== 'pbkdf2' || p[1] !== 'sha256') return false;
    const iterations = Number(p[2]);
    const salt = p[3] ?? '';
    const expect = p[4] ?? '';
    // salt 必须是「偶数个」hex（成对字节）：旧写法允许奇数长度，会一路走到 pbkdf2 才抛 RangeError
    if (!Number.isInteger(iterations) || iterations <= 0 || !/^(?:[0-9a-f]{2})*$/i.test(salt) || !/^[0-9a-f]{64}$/.test(expect)) {
      return false;
    }
    return timingSafeHexEqual(await pbkdf2Hex(clientPassword, salt, iterations), expect);
  }
}

const hasher: PasswordHasher = new Pbkdf2Sha256Hasher();

/** 存量格式：32 位小写 hex（md5(前端md5(明文)+salt)） */
export function isLegacyMd5(stored: string): boolean {
  return /^[0-9a-f]{32}$/.test(stored);
}

/** 新口令入库编码（注册/改密唯一入口；iterations 供 S1 复核后调参） */
export async function hashPassword(clientPassword: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  return new Pbkdf2Sha256Hasher(iterations).hash(clientPassword);
}

/**
 * 统一校验：按 stored 自动选链路。
 * md5 旧格式命中 → ok 且 upgradeNeeded=true（本请求内不重算，§8.4 陷阱对策）。
 */
export async function verifyClientPassword(
  clientPassword: string,
  stored: string,
  salt: string,
): Promise<VerifyResult> {
  if (isLegacyMd5(stored)) {
    const ok = timingSafeHexEqual(md5Hex(clientPassword + salt), stored.toLowerCase());
    return { ok, upgradeNeeded: ok };
  }
  const ok = await hasher.verify(clientPassword, stored);
  return { ok, upgradeNeeded: false };
}
