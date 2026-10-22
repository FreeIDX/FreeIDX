/**
 * T5-2 付费附件（attach.credits 付费墙）：扣减入账幂等/透支守卫、免扣豁免、已购放行、
 * 付费墙与下载计数严格一致（被拦截的下载不计数）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, fakeR2, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';

const now = () => Math.floor(Date.now() / 1000);

const GROUP_ADMIN = {
  gid: 1, name: '管理员', creditsfrom: 0, creditsto: 0,
  allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1,
  allowtop: 1, allowupdate: 1, allowdelete: 1, allowmove: 1, allowbanuser: 1, allowdeleteuser: 1, allowviewip: 1,
};
const GROUP_LEVEL1 = { ...GROUP_ADMIN, gid: 101, name: '初级会员', allowupdate: 0, allowdelete: 0, allowmove: 0, allowtop: 0, creditsfrom: 0, creditsto: 200 };
const FORUM1 = { fid: 1, name: '默认版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0, brief: '', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };

interface Opts {
  credits?: number; // 附件价格
  buyerUid?: number;
  buyerGid?: number;
  uploaderUid?: number;
  chargeChanges?: number; // 扣减 UPDATE meta.changes：1=扣成功，0=余额不足
  chargeThrows?: string; // point_log 唯一冲突
  /** 主题付费位（tt_credits content_buy 未购拦截）：默认免费且作者非下载者 */
  thread?: { content_buy: number; uid: number };
  /** 已购 paylist 命中（type=1） */
  purchased?: boolean;
  /** tt_credits 规则（kv；缺省全 0=关闭） */
  creditsRules?: Record<string, number>;
  /** 下载者三币余额（down_* 规则读取） */
  balance?: { credits: number; golds: number; rmbs: number };
}

function rules(o: Opts): SqlRule[] {
  const buyerUid = o.buyerUid ?? 2;
  const buyerGid = o.buyerGid ?? 101;
  const th = o.thread ?? { content_buy: 0, uid: 99 };
  const bal = o.balance ?? { credits: 100, golds: 100, rmbs: 100 };
  return [
    {
      test: /SELECT v FROM bbs_kv WHERE k = \?/,
      first: (p: readonly unknown[]) =>
        p[0] === 'tt_credits'
          ? { v: JSON.stringify(o.creditsRules ?? {}) }
          : p[0] === 'setting'
            ? { v: JSON.stringify({ runlevel: 5, lang: 'zh-cn' }) }
            : { v: '{}' },
    },
    { test: /FROM bbs_session WHERE sid/, first: () => ({ uid: buyerUid, last_date: now() }) },
    { test: /token_version FROM bbs_user WHERE uid = \?/, first: () => ({ uid: buyerUid, gid: buyerGid, username: `u${buyerUid}`, token_version: 0 }) },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM1] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_group/, rows: [GROUP_ADMIN, GROUP_LEVEL1] },
    {
      test: /SELECT aid,uid,tid,filename,orgfilename,filesize,isimage,status,credits FROM bbs_attach WHERE aid/,
      first: () => ({ aid: 42, uid: o.uploaderUid ?? 1, tid: 9, filename: 'attach/202410/p.bin', orgfilename: 'p.bin', filesize: 5, isimage: 0, status: 1, credits: o.credits ?? 0 }),
    },
    { test: /SELECT fid,content_buy,uid,ok FROM bbs_thread WHERE tid/, first: { fid: 1, ok: 1, ...th } },
    { test: /SELECT plid FROM bbs_paylist WHERE tid = \? AND uid = \? AND type = 1/, first: o.purchased ? { plid: 1 } : null },
    { test: /SELECT vip_expire_at FROM bbs_user WHERE uid = \?/, first: { vip_expire_at: 0 } },
    // 预览侧的「已付费下载过」判定（与扣费幂等键同源）
    { test: /SELECT 1 AS x FROM bbs_point_log/, first: null },
    // 下载扣分（down_*）：三币余额读取 + 扣减 + 扣后组重算读取
    { test: /SELECT credits,golds,rmbs FROM bbs_user WHERE uid = \?/, first: () => ({ ...bal }) },
    { test: /SELECT gid,credits FROM bbs_user WHERE uid = \?/, first: () => ({ gid: buyerGid, credits: bal.credits }) },
    { test: /UPDATE bbs_user SET gid = \?/, rows: [] },
    { test: /INSERT INTO bbs_point_log/, rows: [], throws: o.chargeThrows },
    { test: /UPDATE bbs_user SET credits = credits - \?/, changes: o.chargeChanges ?? 1, rows: [] },
    { test: /UPDATE bbs_user SET credits = credits \+ \?/, rows: [] },
    { test: /UPDATE bbs_user SET golds = golds \+ \?/, rows: [] },
    { test: /UPDATE bbs_user SET rmbs = rmbs \+ \?/, rows: [] },
    { test: /UPDATE bbs_attach SET downloads/, rows: [] },
  ];
}

function envOf(o: Opts) {
  const { db, calls } = fakeD1Sql(rules(o));
  const r2 = fakeR2();
  r2.store.set('attach/202410/p.bin', { data: new TextEncoder().encode('DATA'), contentType: 'application/octet-stream' });
  return { env: { DB: db, CACHE: fakeKv(), FILES: r2, SITE_URL: 'http://localhost' }, calls };
}

const buyerHeaders = (): HeadersInit => ({ cookie: 'sid=sessA' });

beforeEach(() => l0Clear());

describe('GET /api/attachments/:aid/download（付费墙）', () => {
  it('积分充足：扣减入账 + 上传者入账 + downloads+1', async () => {
    const r = envOf({ credits: 10, buyerUid: 2, uploaderUid: 1, chargeChanges: 1 });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    expect(res.status).toBe(200);
    const sqls = r.calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/INSERT INTO bbs_point_log/);
    expect(sqls).toMatch(/credits = credits - \?/); // 买家扣减
    expect(sqls).toMatch(/credits = credits \+ \?/); // 上传者入账
    expect(sqls).toMatch(/UPDATE bbs_attach SET downloads/);
  });

  it('积分不足（扣减 0 行变更）→ 拒绝且 downloads 不计数（墙与计数一致）', async () => {
    const r = envOf({ credits: 10, buyerUid: 2, uploaderUid: 1, chargeChanges: 0 });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(Code.FORM_INSUFFICIENT_CREDITS);
    expect(r.calls.some((c) => /UPDATE bbs_attach SET downloads/.test(c.sql))).toBe(false);
  });

  it('已购（biz_key 唯一冲突）→ 放行不再扣款', async () => {
    const r = envOf({
      credits: 10,
      buyerUid: 2,
      uploaderUid: 1,
      chargeThrows: 'UNIQUE constraint failed: bbs_point_log.uid, bbs_point_log.biz_key',
    });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    expect(res.status).toBe(200);
    // 唯一冲突整批回滚：入账语句与扣款同批提交（SQL 已登记但整批失败），不会出现单边扣款/入账
    expect(r.calls.some((c) => /credits = credits \+ \?/.test(c.sql))).toBe(true);
    expect(r.calls.some((c) => /UPDATE bbs_attach SET downloads/.test(c.sql))).toBe(true);
  });

  it('上传者本人下载付费附件 → 免扣，无流水', async () => {
    const r = envOf({ credits: 10, buyerUid: 3, uploaderUid: 3 });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    expect(res.status).toBe(200);
    expect(r.calls.some((c) => /bbs_point_log/.test(c.sql))).toBe(false);
    expect(r.calls.some((c) => /UPDATE bbs_attach SET downloads/.test(c.sql))).toBe(true);
  });

  it('管理员（gid=1）→ 免扣放行', async () => {
    const r = envOf({ credits: 10, buyerUid: 1, buyerGid: 1, uploaderUid: 9 });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    expect(res.status).toBe(200);
    expect(r.calls.some((c) => /bbs_point_log/.test(c.sql))).toBe(false);
  });

  it('免费附件（credits=0）→ 直通不查积分', async () => {
    const r = envOf({ credits: 0, buyerUid: 2, uploaderUid: 1 });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    expect(res.status).toBe(200);
    expect(r.calls.some((c) => /bbs_point_log/.test(c.sql))).toBe(false);
    expect(r.calls.some((c) => /vip_expire_at/.test(c.sql))).toBe(false);
  });
});

describe('GET /api/attachments/:aid/preview（付费墙同样生效）', () => {
  it('付费附件（credits>0）未购且非上传者/管理员 → 拒绝预览（不再匿名内联直出）', async () => {
    const r = envOf({ credits: 10, buyerUid: 2, buyerGid: 101, uploaderUid: 1 });
    const res = await app.request('/api/attachments/42/preview', { headers: buyerHeaders() }, r.env as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(Code.NO_PERMISSION);
  });

  it('免费附件 → 直接放行预览（图片内联渲染不受影响）', async () => {
    const r = envOf({ credits: 0, buyerUid: 2, uploaderUid: 1 });
    const res = await app.request('/api/attachments/42/preview', { headers: buyerHeaders() }, r.env as never);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/attachments/:aid/download（tt_credits 联动）', () => {
  it('付费主题未购且非作者 → 拒下载（cannot_down），downloads 不计数', async () => {
    const r = envOf({ credits: 0, buyerUid: 2, uploaderUid: 1, thread: { content_buy: 50, uid: 99 } });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    const body = (await res.json()) as { code: number; message: string };
    expect(body.code).toBe(Code.NO_PERMISSION);
    expect(body.message).toContain('您需要先购买该主题才能下载附件');
    expect(r.calls.some((c) => /UPDATE bbs_attach SET downloads/.test(c.sql))).toBe(false);
  });

  it('付费主题已购 → 放行', async () => {
    const r = envOf({ credits: 0, buyerUid: 2, uploaderUid: 1, thread: { content_buy: 50, uid: 99 }, purchased: true });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    expect(res.status).toBe(200);
    expect(r.calls.some((c) => /UPDATE bbs_attach SET downloads/.test(c.sql))).toBe(true);
  });

  it('付费主题作者本人 → 免验放行（不查 paylist）', async () => {
    const r = envOf({ credits: 0, buyerUid: 2, uploaderUid: 1, thread: { content_buy: 50, uid: 2 } });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    expect(res.status).toBe(200);
    expect(r.calls.some((c) => /SELECT plid FROM bbs_paylist/.test(c.sql))).toBe(false);
  });

  it('down_exp=10 → 同批扣减 + 经验流水', async () => {
    const r = envOf({ credits: 0, buyerUid: 2, uploaderUid: 1, creditsRules: { down_exp: 10 }, balance: { credits: 100, golds: 0, rmbs: 0 } });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    expect(res.status).toBe(200);
    const del = r.calls.find((c) => /UPDATE bbs_user SET credits = credits \+ \?/.test(c.sql));
    expect(del?.params).toEqual([10, 2]);
    expect(r.calls.some((c) => /INSERT INTO bbs_point_log/.test(c.sql))).toBe(true);
  });

  it('down_exp=-5 且余额不足以扣成负数 → 积分不足拒下载', async () => {
    const r = envOf({ credits: 0, buyerUid: 2, uploaderUid: 1, creditsRules: { down_exp: -5 }, balance: { credits: 3, golds: 0, rmbs: 0 } });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(Code.FORM_INSUFFICIENT_CREDITS);
    expect(r.calls.some((c) => /UPDATE bbs_attach SET downloads/.test(c.sql))).toBe(false);
  });

  it('down_gold=2 → 金币扣减，不写经验流水', async () => {
    const r = envOf({ credits: 0, buyerUid: 2, uploaderUid: 1, creditsRules: { down_gold: 2 }, balance: { credits: 100, golds: 50, rmbs: 0 } });
    const res = await app.request('/api/attachments/42/download', { headers: buyerHeaders() }, r.env as never);
    expect(res.status).toBe(200);
    const del = r.calls.find((c) => /UPDATE bbs_user SET golds = golds \+ \?/.test(c.sql));
    expect(del?.params).toEqual([2, 2]);
    expect(r.calls.some((c) => /INSERT INTO bbs_point_log/.test(c.sql))).toBe(false);
  });
});
