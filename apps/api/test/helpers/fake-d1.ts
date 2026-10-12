/** 测试替身：满足 D1b 包装所需的最小 D1Database 面 */
export function fakeD1(opts: { rows?: number; failAt?: number; firstRow?: unknown } = {}) {
  let executed = 0;
  const results = Array.from({ length: opts.rows ?? 0 }, (_, i) => ({ i }));
  function stmt(): D1PreparedStatement {
    const self: D1PreparedStatement = {
      bind: () => self,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      first: async () => (opts.firstRow !== undefined ? opts.firstRow : { v: 1 }) as any,
      all: async () => ({ success: true, meta: {}, results }) as never,
      raw: async () => results as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async () => ({ success: true, meta: {} }) as any,
    };
    return self;
  }
  const db: D1Database = {
    prepare: () => {
      executed++;
      if (opts.failAt != null && executed > opts.failAt) throw new Error('fake D1 statement cap');
      return stmt();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    batch: async (stmts: any[]) => {
      executed += stmts.length;
      return stmts.map(() => ({ success: true, meta: {}, results }));
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, get executed() { return executed; } };
}

export interface SqlRule {
  test: RegExp;
  rows?: unknown[] | ((params: readonly unknown[]) => unknown[]);
  first?: unknown | null | ((params: readonly unknown[]) => unknown | null);
  /** 模拟 D1 batch 语句的 meta.changes（扣减入账守卫用） */
  changes?: number;
  /** 模拟该语句执行时抛错（如唯一约束冲突） */
  throws?: string;
}

/** 按 SQL 模式分发的测试替身（路由集成测试用；未匹配的 SQL 直接抛错防漂移） */
export function fakeD1Sql(rules: SqlRule[]) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  function resolve(sql: string, params: readonly unknown[]): SqlRule {
    calls.push({ sql, params });
    const rule = rules.find((r) => r.test.test(sql));
    if (!rule) throw new Error('fakeD1Sql unmatched SQL: ' + sql.replace(/\s+/g, ' '));
    return rule;
  }
  function stmtFor(sql: string): D1PreparedStatement {
    let params: readonly unknown[] = [];
    const maybeThrow = (rule: SqlRule) => {
      if (rule.throws) throw new Error(rule.throws);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self: any = {
      bind: (...p: unknown[]) => {
        params = p;
        return self;
      },
      first: async () => {
        const f = resolve(sql, params).first;
        return (typeof f === 'function' ? f(params) : (f ?? null)) ?? null;
      },
      all: async () => {
        const rl = resolve(sql, params);
        maybeThrow(rl);
        const r = rl.rows;
        return {
          success: true,
          meta: rl.changes !== undefined ? { changes: rl.changes } : {},
          results: (typeof r === 'function' ? r(params) : (r ?? [])) as never,
        };
      },
      raw: async () => {
        const r = resolve(sql, params).rows;
        return (typeof r === 'function' ? r(params) : (r ?? [])) as never;
      },
      run: async () => {
        const rl = resolve(sql, params);
        maybeThrow(rl);
        return { success: true, meta: rl.changes !== undefined ? { changes: rl.changes } : {} };
      },
    };
    return self as D1PreparedStatement;
  }
  const db: D1Database = {
    prepare: (sql: string) => stmtFor(sql),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    batch: async (stmts: any[]) => Promise.all(stmts.map((s) => s.all())),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, calls };
}

/** 最小 KV 替身 */
export function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
}

/** 最小 R2 替身：存字节 + contentType，get 返回 body/httpMetadata（与 R2Object 读取面兼容） */
export function fakeR2() {
  const store = new Map<string, { data: Uint8Array; contentType?: string }>();
  const toBytes = (v: unknown): Uint8Array => {
    if (v instanceof Uint8Array) return v;
    if (typeof v === 'string') return new TextEncoder().encode(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return new TextEncoder().encode(String(v));
  };
  return {
    store,
    put: async (key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) => {
      store.set(key, { data: toBytes(value), contentType: options?.httpMetadata?.contentType });
    },
    get: async (key: string) => {
      const hit = store.get(key);
      if (!hit) return null;
      return {
        body: hit.data,
        arrayBuffer: async () => hit.data.buffer.slice(hit.data.byteOffset, hit.data.byteOffset + hit.data.byteLength),
        httpMetadata: { contentType: hit.contentType },
      };
    },
    delete: async (key: string) => void store.delete(key),
    head: async (key: string) => {
      const hit = store.get(key);
      return hit ? { httpMetadata: { contentType: hit.contentType } } : null;
    },
  };
}

/**
 * 合并部署 [assets] 绑定（env.ASSETS）替身：命中 files 则按真实静态资源应答，
 * 否则复现 not_found_handling="single-page-application" —— 一律回 SPA 壳 HTML。
 */
export function fakeAssets(files: Record<string, string> = {}) {
  const typeOf = (p: string) =>
    p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.html') ? 'text/html' : 'text/plain';
  return {
    fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      const hit = files[path];
      if (hit === undefined) {
        return new Response('<!doctype html><html><head><title>FreeIDX</title></head><body><div id="root"></div></body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(hit, { headers: { 'content-type': `${typeOf(path)}; charset=utf-8` } });
    },
  };
}

/**
 * 最小 Cache API（caches.default）替身：Node 测试环境没有 Cloudflare 边缘缓存。
 * put 存快照（状态/头/字节），match 每次返回新 Response —— 与真实缓存"体只可读一次"一致。
 * entries 供断言：写入条数、键 URL（含 fi-ua 分键）、缓存副本的 cache-control。
 */
export function fakeCaches() {
  const entries = new Map<string, { status: number; headers: [string, string][]; body: ArrayBuffer }>();
  const keyOf = (req: RequestInfo | URL): string =>
    typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url;
  const bucket = {
    match: async (req: RequestInfo | URL) => {
      const hit = entries.get(keyOf(req));
      return hit ? new Response(hit.body.slice(0), { status: hit.status, headers: hit.headers }) : undefined;
    },
    put: async (req: RequestInfo | URL, res: Response) => {
      entries.set(keyOf(req), {
        status: res.status,
        headers: Array.from(res.headers.entries()),
        body: await res.clone().arrayBuffer(),
      });
    },
    delete: async (req: RequestInfo | URL) => entries.delete(keyOf(req)),
  };
  const stub = { default: bucket, open: async () => bucket };
  return { caches: stub, entries, install: () => void Object.assign(globalThis, { caches: stub }) };
}
