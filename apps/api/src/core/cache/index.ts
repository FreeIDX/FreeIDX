/**
 * 三层数据缓存（T1-3，§7）——可插拔分层：
 *  L0 Isolate 内存 Map+TTL（10~60s，零额度）
 *  L1 KV（TTL 1h）——仅 setting/forumlist/grouplist（KV 免费写 1k/天，高变更键严禁入内）
 *  L2 D1 cache 表（带 expiry）——高变更/共享缓存（user:{uid}）
 * 失效：主动 delete（写路径调用），L0 逐 isolate（每实例独立，短 TTL 兜底）。
 * 响应级缓存（L-1 Cache API，游客只读接口 + 爬虫 HTML）在 ./edge.ts，不在本类内。
 */
import type { Env } from '../../types/env';
import type { D1b } from '../db';

type CacheLayer = 'L0' | 'L1' | 'L2';

interface KeyPolicy {
  ttl: number;
  layers: CacheLayer[];
}

/**
 * L0 内存层过期上限（秒）。
 * 只读配置键的 TTL 是 1h（L1 KV 口径），但 L0 是逐 isolate 副本，`del()` 只能清掉当前 isolate；
 * 若 L0 也按 1h 过期，后台改设置/版块/用户组后其它 isolate 最长 1 小时不生效 → 属功能变更。
 * 因此 L0 一律钳制到 30s：跨 isolate 陈旧窗口有上界，同时吃掉同请求与热点请求的重复读。
 */
const L0_MAX_TTL = 30;

/**
 * §7 键表：TTL 与存放层一一对应（防 KV 写额度耗尽的断言依据）。
 *
 * L1(KV) 只放「后台低频改」的键：免费层 KV 写/删各 1,000 次/天，且**同一个 key 每秒只能写 1 次**。
 * forumlist 会随每次发主题/回帖失效（modules/write/routes.ts 的 thread_create / post_create 路径），
 * 放 KV 时「1,000 帖/天」即打满额度，此后 CACHE.delete 报错会被 await 抛出 → 发帖直接 500。
 * 故 forumlist 移到 L0+L2（D1 bbs_cache 表：免费层写 10 万行/天，余量 100 倍，且强一致，
 * 比 KV 的最终一致更新鲜）；L2 TTL 300s 仅作「失效被漏调」时的兜底陈旧上界。
 */
const KEY_POLICIES: Record<string, KeyPolicy> = {
  /* 只读配置键：L0 短存 + L1 KV 持久（写只发生在后台改设置/版块/用户组，个位数/天）。
     L0 让「同请求内重复装载」与「30s 内热点请求」零 KV 读（此前只有 L1，L0 分支从不生效，
     每次 loadSetting() 都真打一次 KV；单请求内 setting 会被中间件与 handler 装载 2~3 次） */
  forumlist: { ttl: 300, layers: ['L0', 'L2'] },
  grouplist: { ttl: 3600, layers: ['L0', 'L1'] },
  setting: { ttl: 3600, layers: ['L0', 'L1'] },
  // 积分交易规则（tt_credits）：后台低频改，读多写少 → 与 setting 同层
  tt_credits: { ttl: 3600, layers: ['L0', 'L1'] },

  runtime: { ttl: 10, layers: ['L0', 'L2'] },
};
/** 前缀策略：user:{uid} = L0+L2/30s（禁 KV） */
export function policyFor(key: string): KeyPolicy {
  if (key.startsWith('user:')) return { ttl: 30, layers: ['L0', 'L2'] };
  return KEY_POLICIES[key] ?? { ttl: 60, layers: ['L0', 'L2'] };
}

/** L0 进程内缓存（isolate 级） */
const l0 = new Map<string, { v: string; exp: number }>();
export function l0Clear(): void {
  l0.clear();
}

export class Cache {
  /** KV 写调用计数（测试断言高变更键 0 次 KV 写） */
  kvWrites = 0;
  /** D1 cache 表写计数（预算观测） */
  l2Writes = 0;
  /**
   * 请求级装载去重表。Cache 实例由 index.ts 每个请求 new 一次，故该表天然只作用于单个请求，
   * 不构成跨请求共享（跨请求共享只发生在模块级 L0 上）。
   * 用途：同一请求内 setting 会被 i18n 中间件、runlevel 闸门与业务 handler 各装载一次，
   * 命中即复用首次结果，省掉重复的 KV/D1 读与重复 JSON.parse。
   * 契约：装载结果在请求内视为只读；调用方不得就地修改（如 loadForumlist 的 accesslist 已在装载期构建完毕）。
   */
  private readonly loaded = new Map<string, unknown>();

  constructor(
    private readonly env: Env,
    private readonly db: D1b,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const policy = policyFor(key);
    const now = this.now();

    if (policy.layers.includes('L0')) {
      const hit = l0.get(key);
      if (hit && hit.exp > now) return JSON.parse(hit.v) as T;
      if (hit) l0.delete(key);
    }
    if (policy.layers.includes('L1')) {
      const v = await this.kvGet(`fi:${key}`);
      if (v != null) {
        l0.set(key, { v, exp: now + L0_MAX_TTL }); // L1 命中也回填 L0 短存（上限 30s）
        return JSON.parse(v) as T;
      }
    }
    if (policy.layers.includes('L2')) {
      const row = await this.db
        .prepare<{ v: string }>('SELECT v FROM bbs_cache WHERE k = ? AND (expiry = 0 OR expiry > ?)')
        .bind(key, now)
        .first<{ v: string }>();
      if (row) {
        l0.set(key, { v: row.v, exp: now + Math.min(policy.ttl, L0_MAX_TTL) });
        return JSON.parse(row.v) as T;
      }
    }
    return null;
  }

  async set<T>(key: string, value: T, ttlOverride?: number): Promise<void> {
    const policy = policyFor(key);
    const ttl = ttlOverride ?? policy.ttl;
    const now = this.now();
    const v = JSON.stringify(value);

    // L0 过期一律钳到 L0_MAX_TTL：避免逐 isolate 副本按 1h 的 KV 口径长期陈旧
    if (policy.layers.includes('L0')) l0.set(key, { v, exp: now + Math.min(ttl, L0_MAX_TTL) });
    this.loaded.delete(key); // 值已更新 → 请求级去重表失效，后续 remember 以新值为准
    if (policy.layers.includes('L1')) await this.kvPut(`fi:${key}`, v, ttl);
    if (policy.layers.includes('L2')) {
      this.l2Writes++;
      try {
        await this.db
          .prepare('REPLACE INTO bbs_cache (k, v, expiry) VALUES (?, ?, ?)')
          .bind(key, v, ttl > 0 ? now + ttl : 0)
          .run();
      } catch (e) {
        // L2 同 L1 一样 fail-soft（§7 契约「缓存操作失败不得升级为业务失败」）：
        // D1 写故障/行预算耗尽时只告警，读路径回落 loader，陈旧窗口由 L0(≤30s)/TTL 兜底。
        console.warn('[cache] L2 set failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  /** 主动失效（写路径调用；论坛语义 = 版块/用户组/设置变更即失效） */
  async del(key: string): Promise<void> {
    const policy = policyFor(key);
    l0.delete(key);
    this.loaded.delete(key);
    if (policy.layers.includes('L1')) await this.kvDel(`fi:${key}`);
    if (policy.layers.includes('L2')) {
      try {
        await this.db.prepare('DELETE FROM bbs_cache WHERE k = ?').bind(key).run();
      } catch (e) {
        // fail-soft 同上：业务写已提交时 del 失败绝不能把整个请求打成 500（否则用户重试 = 重复发帖）。
        console.warn('[cache] L2 del failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  /**
   * L1(KV) 读写包装（fail-soft）。
   * 免费层 KV 有「读 10 万/天、写/删各 1,000/天、同一 key 每秒 1 次写」硬限，超限后该类操作直接报错；
   * KV 只是缓存层，绝不能把「缓存操作失败」升级成「业务请求失败」（否则额度耗尽 = 发帖全站 500）：
   * 读失败按 miss 继续走 L2/loader；写/删失败只告警，陈旧窗口由 L0(≤30s) 与 L2 TTL 兜底。
   */
  private async kvGet(k: string): Promise<string | null> {
    try {
      return await this.env.CACHE.get(k);
    } catch (e) {
      console.warn('[cache] KV get failed:', e instanceof Error ? e.message : e);
      return null;
    }
  }

  private async kvPut(k: string, v: string, ttl: number): Promise<void> {
    this.kvWrites++;
    try {
      await this.env.CACHE.put(k, v, { expirationTtl: Math.max(60, ttl) });
    } catch (e) {
      console.warn('[cache] KV put failed:', e instanceof Error ? e.message : e);
    }
  }

  private async kvDel(k: string): Promise<void> {
    this.kvWrites++;
    try {
      await this.env.CACHE.delete(k);
    } catch (e) {
      console.warn('[cache] KV delete failed:', e instanceof Error ? e.message : e);
    }
  }

  /** @internal 请求级去重：该键在本请求内是否已装载过 */
  hasLoaded(key: string): boolean {
    return this.loaded.has(key);
  }

  /** @internal 请求级去重：取本请求内已装载的值（调用前须先 hasLoaded） */
  getLoaded<T>(key: string): T {
    return this.loaded.get(key) as T;
  }

  /** @internal 请求级去重：记录本请求内已装载的值 */
  putLoaded(key: string, value: unknown): void {
    this.loaded.set(key, value);
  }
}

/** 读穿包装：miss 时执行 loader 并回填 */
export async function remember<T>(
  cache: Cache,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  // 请求级去重优先：同请求内重复装载直接复用首次结果（零 KV/D1 读、零重复 JSON.parse）
  if (cache.hasLoaded(key)) return cache.getLoaded<T>(key);
  const hit = await cache.get<T>(key);
  if (hit !== null) {
    cache.putLoaded(key, hit);
    return hit;
  }
  const v = await loader();
  await cache.set(key, v); // set 会失效去重表，故须在 putLoaded 之前
  cache.putLoaded(key, v);
  return v;
}
