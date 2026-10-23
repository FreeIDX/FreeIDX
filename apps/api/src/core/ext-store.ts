/**
 * 扩展配置/私密命名空间存取（§17.1 `ext:{id}:config` 明文 + `ext:{id}:secret` AES-GCM）。
 * 落 bbs_kv（与 'setting'/'extensions' 同库，启停/配置零部署）；config 走三层缓存，secret 绝不缓存明文。
 * ads 插件与后台扩展管理页共用本模块，核心不硬编码任何广告参数。
 */
import { decryptSecret, encryptSecret } from './crypto';
import { remember } from './cache';
import type { Cache } from './cache';
import type { D1b } from './db';

const extConfigKey = (id: string): string => `ext:${id}:config`;
export const extSecretKey = (id: string): string => `ext:${id}:secret`;

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

/** 私密配置：master key 缺失或解密失败 → {}（安全失败，绝不回退明文、不缓存） */
export async function loadExtSecret(db: D1b, id: string, masterKey?: string): Promise<Record<string, unknown>> {
  if (!masterKey) return {};
  const token = await readKv(db, extSecretKey(id));
  if (!token) return {};
  const plain = await decryptSecret(token, masterKey);
  return plain ? parseObj(plain) : {};
}

/** 写入非敏感配置（整量覆盖），并失效缓存 */
export async function saveExtConfig(db: D1b, cache: Cache, id: string, config: Record<string, unknown>): Promise<void> {
  const key = extConfigKey(id);
  await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind(key, JSON.stringify(config)).run();
  await cache.del(key);
}

/** 加密写入私密配置（master key 必需，缺失即抛由调用侧转 400） */
export async function saveExtSecret(db: D1b, id: string, secret: Record<string, unknown>, masterKey: string): Promise<void> {
  const token = await encryptSecret(JSON.stringify(secret), masterKey);
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
  masterKey: string,
): Promise<void> {
  const token = await encryptSecret(JSON.stringify(secret), masterKey);
  await db.batch([
    db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind(extSecretKey(id), token),
    db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind(extConfigKey(id), JSON.stringify(config)),
  ]);
  await cache.del(extConfigKey(id));
}
