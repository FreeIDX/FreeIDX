/**
 * T1-8 扩展点契约运行时单测：启停、事件订阅、错误隔离、registerRoute 分发。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { Cache, l0Clear } from '../src/core/cache';
import { D1b } from '../src/core/db';
import { buildRuntime, loadExtensionsState, type ExtensionModule } from '../src/core/extensions/registry';
import { EXTENSION_MODULES } from '../src/core/extensions';
import { fakeAssets, fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

afterEach(() => {
  l0Clear();
});

describe('extensions runtime (T1-8)', () => {
  it('全部停用：不接线、不贡献、核心零影响（seo/geo/light 出厂启用，须显式停用）', async () => {
    const rt = buildRuntime(EXTENSION_MODULES, {
      seo: { installed: 1, enable: 0 },
      geo: { installed: 1, enable: 0 },
      light: { installed: 1, enable: 0 },
    });
    expect(rt.enabledIds).toEqual([]);
    const ext: Record<string, unknown> = {};
    await rt.bus.emit('bootstrap:contribute', { payload: ext });
    expect(Object.keys(ext)).toEqual([]);
    expect(rt.bus.listenerCount('post:created')).toBe(0);
  });

  it('kv 启用后：bootstrap:contribute 注入插件字段，事件订阅可达', async () => {
    const probe: ExtensionModule = {
      manifest: { id: 'demo-empty', name: {}, version: '1.0.0', installed: 1, enable: 1 },
      setup(api) {
        api.contributeBootstrap((ext) => {
          ext['demo-empty'] = { ok: 1 };
        });
        api.bus.on('post:created', () => {});
      },
    };
    const rt = buildRuntime([...EXTENSION_MODULES, probe], { 'demo-empty': { installed: 1, enable: 1 } });
    expect(rt.enabledIds).toEqual(['seo', 'geo', 'light', 'demo-empty']);
    const ext: Record<string, unknown> = {};
    await rt.bus.emit('bootstrap:contribute', { payload: ext });
    expect(ext['demo-empty']).toEqual({ ok: 1 });
    expect(rt.bus.listenerCount('post:created')).toBe(1);
  });

  it('installed=0 视同停用', () => {
    const rt = buildRuntime(EXTENSION_MODULES, {
      seo: { installed: 0, enable: 1 },
      geo: { installed: 0, enable: 1 },
      light: { installed: 0, enable: 1 },
    });
    expect(rt.enabledIds).toEqual([]);
  });

  it('错误隔离：处理器抛错不影响其他处理器与核心', async () => {
    const seen: number[] = [];
    const bad: ExtensionModule = {
      manifest: { id: 'bad', name: {}, version: '1.0.0', installed: 1, enable: 1 },
      setup(api) {
        api.bus.on('post:created', () => {
          throw new Error('boom');
        });
      },
    };
    const good: ExtensionModule = {
      manifest: { id: 'good', name: {}, version: '1.0.0', installed: 1, enable: 1 },
      setup(api) {
        api.bus.on('post:created', (p) => {
          seen.push(p.pid);
        });
      },
    };
    const rt = buildRuntime([bad, good], {});
    await expect(rt.bus.emit('post:created', { pid: 7, tid: 1, uid: 1, isfirst: 0 })).resolves.toBeUndefined();
    expect(seen).toEqual([7]);
  });

  it('契约登记：registerRoute / registerCron / robots 贡献收集', () => {
    const m: ExtensionModule = {
      manifest: { id: 'reg', name: {}, version: '1.0.0', installed: 1, enable: 1 },
      setup(api) {
        api.registerRoute('GET', '/sitemap.xml', () => new Response('x'));
        api.registerCron({ pattern: '0 3 * * *', name: 'ping', run: async () => {} });
        api.contributeRobots(10, ['Disallow: /api/']);
      },
    };
    const rt = buildRuntime([m], {});
    expect(rt.routes.map((r) => r.path)).toEqual(['/sitemap.xml']);
    expect(rt.crons.map((c) => c.name)).toEqual(['ping']);
    expect(rt.robots).toEqual([{ order: 10, lines: ['Disallow: /api/'] }]);
  });

  it('loadExtensionsState：bbs_kv extensions 键读穿三层缓存', async () => {
    const { db } = fakeD1Sql([
      {
        test: /FROM bbs_kv/,
        first: (params: readonly unknown[]) =>
          params[0] === 'extensions' ? { v: '{"demo-empty":{"installed":1,"enable":1}}' } : null,
      },
      { test: /FROM bbs_cache WHERE/, first: null },
      { test: /REPLACE INTO bbs_cache/, rows: [] },
    ]);
    const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: '' } as never, new D1b(db as never));
    const state = await loadExtensionsState(cache, new D1b(db as never));
    expect(state['demo-empty']?.enable).toBe(1);
    // 第二次命中 L0，不再查库
    const state2 = await loadExtensionsState(cache, new D1b(db as never));
    expect(state2['demo-empty']?.installed).toBe(1);
  });

  it('registerRoute 经 Worker 入口分发（启停只改 kv，零部署）', async () => {
    const probe: ExtensionModule = {
      manifest: { id: 'route-probe', name: {}, version: '1.0.0', installed: 1, enable: 0 },
      setup(api) {
        api.registerRoute('GET', '/probe.txt', () => new Response('probe-ok'));
      },
    };
    EXTENSION_MODULES.push(probe);
    const kvBlob = JSON.stringify({ 'route-probe': { installed: 1, enable: 1 } });
    const settingRow = { v: JSON.stringify({ sitename: 'S', runlevel: 5 }) };
    const rules: SqlRule[] = [
      {
        test: /FROM bbs_kv/,
        first: (params: readonly unknown[]) => (params[0] === 'extensions' ? { v: kvBlob } : settingRow),
      },
      { test: /FROM bbs_cache WHERE/, first: null },
      { test: /REPLACE INTO bbs_cache/, rows: [] },
    ];
    try {
      const fake = fakeD1Sql(rules);
      const env = { DB: fake.db, CACHE: fakeKv(), ASSETS: fakeAssets(), SITE_URL: 'http://local' };
      const res = await app.request('/probe.txt', {}, env as never);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('probe-ok');
      // 未注册路径仍走核心 404 信封
      const miss = await app.request('/no-such.txt', {}, env as never);
      expect(((await miss.json()) as { code: number }).code).toBe(-4);
    } finally {
      EXTENSION_MODULES.pop();
      l0Clear();
    }
  });
});
