/**
 * 扩展配置/私密命名空间存取（§17.1 `ext:{id}:config` 明文 + `ext:{id}:secret` AES-GCM）。
 * 落 bbs_kv（与 'setting'/'extensions' 同库，启停/配置零部署）；config 走三层缓存，secret 绝不缓存明文。
 * ads 插件与后台扩展管理页共用本模块，核心不硬编码任何广告参数。
 *
 * 主密钥解析顺序（零配置优先，见 keyCandidates）：
 *   ① `SECRETS_MASTER_KEY`（base64 的 32 字节，或 64 位 hex）
 *   ② 由必填项 `JWT_SECRET` 派生的 32 字节（SHA-256）
 * 于是「只部署、不配任何额外 Secret」的站点也能保存邮件 API Key / 插件私钥；
 * 显式配置仍优先，供希望把邮件凭据与登录密钥分开管理的部署使用。
 */
import { decryptSecret, deriveMasterKey, encryptSecret, masterKeyShape, normalizeMasterKey } from './crypto';
import { remember } from './cache';
import type { Cache } from './cache';
import type { D1b } from './db';

const extConfigKey = (id: string): string => `ext:${id}:config`;
export const extSecretKey = (id: string): string => `ext:${id}:secret`;

/** 主密钥来源（结构上等价于 Env 的相关字段，core 不依赖具体 Env 类型） */
export interface SecretsEnv {
  SECRETS_MASTER_KEY?: string;
  JWT_SECRET?: string;
}

/** 显式密钥填错只提示一次（每个 isolate），避免读路径每次请求都刷日志 */
let warnedInvalid = false;

/**
 * 候选主密钥：解密按序尝试（换过密钥的站点仍能读旧密文），加密取第一把。
 * 顺序 = 显式 `SECRETS_MASTER_KEY` → `JWT_SECRET` 派生。
 */
async function keyCandidates(env?: SecretsEnv): Promise<string[]> {
  const out: string[] = [];
  const explicit = normalizeMasterKey(env?.SECRETS_MASTER_KEY);
  if (explicit) out.push(explicit);
  else if (env?.SECRETS_MASTER_KEY && !warnedInvalid) {
    warnedInvalid = true;
    console.warn(
      `[secrets] SECRETS_MASTER_KEY malformed (${masterKeyShape(env.SECRETS_MASTER_KEY)}); falling back to JWT_SECRET-derived key`,
    );
  }
  const seed = env?.JWT_SECRET?.trim();
  if (seed) {
    const derived = await deriveMasterKey(seed);
    if (!out.includes(derived)) out.push(derived);
  }
  return out;
}

/** 是否具备可用的加密密钥（连 JWT_SECRET 都没有才为 false；后台写入前据此拦一次） */
export async function hasSecretsKey(env?: SecretsEnv): Promise<boolean> {
  return (await keyCandidates(env)).length > 0;
}

async function readKv(db: D1b, key: string): Promise<string | null> {
  const row = await db.prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?').bind(key).first<{ v: string }>();
  return row?.v ?? null;
}

function parseObj(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 非敏感配置：经三层缓存读穿（键名唯一，写侧 cache.del 即时失效） */
export function loadExtConfig(cache: Cache, db: D1b, id: string): Promise<Record<string, unknown>> {
  const key = extConfigKey(id);
  return remember(cache, key, async () => parseObj(await readKv(db, key)));
}

/** 私密配置：无可用密钥或解密失败 → {}（安全失败，绝不回退明文、不缓存） */
export async function loadExtSecret(db: D1b, id: string, env?: SecretsEnv): Promise<Record<string, unknown>> {
  const keys = await keyCandidates(env);
  if (!keys.length) return {};
  const token = await readKv(db, extSecretKey(id));
  if (!token) return {};
  for (const key of keys) {
    const plain = await decryptSecret(token, key);
    if (plain) return parseObj(plain);
  }
  return {};
}

/** 写入非敏感配置（整量覆盖），并失效缓存 */
export async function saveExtConfig(db: D1b, cache: Cache, id: string, config: Record<string, unknown>): Promise<void> {
  const key = extConfigKey(id);
  await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind(key, JSON.stringify(config)).run();
  await cache.del(key);
}

/** 加密写入私密配置（调用侧先 hasSecretsKey 校验，缺密钥时转 400） */
export async function saveExtSecret(db: D1b, id: string, secret: Record<string, unknown>, env: SecretsEnv): Promise<void> {
  const [key] = await keyCandidates(env);
  if (!key) throw new Error('no secrets master key available (SECRETS_MASTER_KEY / JWT_SECRET both missing)');
  const token = await encryptSecret(JSON.stringify(secret), key);
  await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind(extSecretKey(id), token).run();
}

/**
 * 原子写「明文配置 + 私密配置」（D1 batch = 单事务，任一失败整批回滚）。
 * 邮箱池的密码数组与 pool 行是**按下标对齐**的两份数据：两次独立 REPLACE 之间失败会留下
 * 「新池 + 旧密码」的错配（保存看似成功、之后发信全部 535 且难以定位），故必须同批提交。
 */
export async function saveExtConfigAndSecret(
  db: D1b,
  cache: Cache,
  id: string,
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
  env: SecretsEnv,
): Promise<void> {
  const [key] = await keyCandidates(env);
  if (!key) throw new Error('no secrets master key available (SECRETS_MASTER_KEY / JWT_SECRET both missing)');
  const token = await encryptSecret(JSON.stringify(secret), key);
  await db.batch([
    db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind(extSecretKey(id), token),
    db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind(extConfigKey(id), JSON.stringify(config)),
  ]);
  await cache.del(extConfigKey(id));
}
