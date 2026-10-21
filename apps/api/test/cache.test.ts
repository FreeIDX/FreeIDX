import { describe, it, expect } from 'vitest';
import { Cache, policyFor, remember, l0Clear } from '../src/core/cache';
import { D1b } from '../src/core/db';
import { fakeD1 } from './helpers/fake-d1';

function makeEnv() {
  const kvStore = new Map<string, string>();
  const env = {
    DB: fakeD1().db,
    CACHE: {
      get: async (k: string) => kvStore.get(k) ?? null,
      put: async (k: string, v: string) => void kvStore.set(k, v),
      delete: async (k: string) => void kvStore.delete(k),
    },
    FILES: {},
    SITE_URL: '',
  };
  return { env, kvStore };
}

describe('三层缓存策略（§7 键表）', () => {
  it('高变更键禁入 KV：user:*/runtime/forumlist 均不含 L1', () => {
    // forumlist 随每次发主题/回帖失效 → 放 KV 时「1,000 帖/天」即打满写额度（且同 key 1 次/秒）
    for (const k of ['user:42', 'runtime', 'forumlist']) {
      expect(policyFor(k).layers).not.toContain('L1');
    }
    // 只有后台低频改的键才允许 L1
    expect(policyFor('grouplist').layers).toContain('L1');
    expect(policyFor('setting').layers).toContain('L1');
    expect(policyFor('tt_credits').layers).toContain('L1');
  });

  it('T1-3 DoD 断言：写高变更键时 KV 写调用 = 0（防 1k/天额度耗尽）', async () => {
    const { env } = makeEnv();
    const cache = new Cache(env as never, new D1b(env.DB as never));
    await cache.set('user:1', { uid: 1 });
    await cache.set('rank:1d', { list: [] });
    await cache.set('runtime', { threads: 10 });
    expect(cache.kvWrites).toBe(0);
  });

  it('低频键走 KV 且 L1 命中免 D1 查询', async () => {
    const { env, kvStore } = makeEnv();
    const db = new D1b(env.DB as never);
    const cache = new Cache(env as never, db);
    await cache.set('setting', { sitename: 'x' });
    expect(kvStore.has('fi:setting')).toBe(true);
    l0Clear(); // 剥离 L0，强制走 L1
    const v = await cache.get('setting');
    expect(v).toEqual({ sitename: 'x' });
    expect(db.stats.d1Queries).toBe(0); // KV 命中零 D1
  });

  it('L2 读穿：D1 cache 表命中回填 L0', async () => {
    const { env } = makeEnv();
    const db2 = fakeD1({ firstRow: { v: JSON.stringify({ uid: 7 }) } }).db;
    const cache = new Cache({ ...env, DB: db2 } as never, new D1b(db2 as never));
    await cache.set('user:7', { uid: 7 });
    expect(cache.l2Writes).toBe(1);
    l0Clear();
    const v = await cache.get('user:7');
    expect(v).toEqual({ uid: 7 });
  });

  it('remember 命中不再执行 loader', async () => {
    const { env } = makeEnv();
    const cache = new Cache(env as never, new D1b(env.DB as never));
    let calls = 0;
    const a = await remember(cache, 'setting', async () => {
      calls++;
      return { sitename: 'x' };
    });
    const b = await remember(cache, 'setting', async () => {
      calls++;
      return { sitename: 'y' };
    });
    expect(calls).toBe(1);
    expect(b).toEqual(a);
  });

  it('del 清全部层（含 KV）', async () => {
    const { env, kvStore } = makeEnv();
    const cache = new Cache(env as never, new D1b(env.DB as never));
    await cache.set('setting', { sitename: 'x' });
    l0Clear();
    await cache.del('setting');
    expect(kvStore.has('fi:setting')).toBe(false);
  });

  it('forumlist 失效走 L2（D1 bbs_cache），不产生任何 KV 写', async () => {
    const { env, kvStore } = makeEnv();
    const cache = new Cache(env as never, new D1b(env.DB as never));
    await cache.del('forumlist');
    expect(cache.kvWrites).toBe(0);
    expect(kvStore.size).toBe(0);
  });

  it('KV 额度耗尽（get/put/delete 抛错）时 fail-soft：读按 miss、写删只告警，绝不抛给业务', async () => {
    const boom = {
      get: async () => {
        throw new Error('KV quota exceeded');
      },
      put: async () => {
        throw new Error('KV quota exceeded');
      },
      delete: async () => {
        throw new Error('KV quota exceeded');
      },
    };
    const db2 = fakeD1({ firstRow: { v: JSON.stringify({ uid: 7 }) } }).db;
    const cache = new Cache({ DB: db2, CACHE: boom, FILES: {}, SITE_URL: '' } as never, new D1b(db2 as never));
    // 写：不抛错（KV put 失败被吞）
    await expect(cache.set('setting', { sitename: 'x' })).resolves.toBeUndefined();
    // 读：剥离 L0 后 KV get 抛错 → 视为 miss（而不是把异常抛给业务），L1 键回落 null
    l0Clear();
    await expect(cache.get('setting')).resolves.toBeNull();
    // 读（L0+L2 键）不受 KV 故障影响：正常回落 L2
    await expect(cache.get('user:7')).resolves.toEqual({ uid: 7 });
    // 删：不抛错
    await expect(cache.del('setting')).resolves.toBeUndefined();
  });
});
