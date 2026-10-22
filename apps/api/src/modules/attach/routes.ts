/**
 * R2 附件全流程（T2-8，§9）：
 *  POST   /api/attachments                  上传（base64 `data` 或 multipart `file`，≤20M、白名单、名单外改名 `_ext`）→ R2 tmp/ + attach(status=0)，返回 aid 数组
 *  DELETE /api/attachments/:aid             临时件按 uid+status=0 校验；正式件本人或版主 allowdelete
 *  GET    /api/attachments/:aid/preview     内联预览（pending 仅本人；入库附件免扣但付费附件/付费主题附件需购买）
 *  GET    /api/attachments/:aid/download    allowdown 校验 + downloads+1 + 原名 disposition
 *  GET    /files/*                          Worker 流式代理 R2（仅 avatar/、forum/、site/，tmp/、attach/ 与穿越拒绝），强缓存
 *                                           —— attach/ 刻意不放行：正式附件 R2 key 匿名直取会绕过付费/权限校验（走 /api 端点）
 * 关联 associateAttachments()：发帖/回帖/编辑带 attachAids[] → tmp→attach/YYYYmm/ 移动 + status=1 + images/files 计数（§9.3 无 message 串替换，预览链接按 aid 恒定）。
 * 待关联态用真状态列 attach.status（§9.3），GC 归 T3-8。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import type { Cache } from '../../core/cache';
import { loadForumlist, loadGrouplist, loadViewer, makeAccessCtx, loadSetting } from '../../core/loaders';
import { forumAccessMod, forumAccessUser } from '../../core/access';
import { chargePoints, creditDeltaStmts, loadCreditsRules, upgradeGroupByCredits } from '../../core/points';
import { getExtensions } from '../../core/extensions';
import { decodeBase64, intParam, type ReadEnv } from '../shared';
import type { ApiT } from '../../core/i18n';
import {
  ATTACH_MAX_BYTES,
  attachKey,
  fileExt,
  filesBucket,
  mimeFor,
  storageExt,
  tmpKey,
  ymDir,
  attachType,
} from './core';

type Ctx = Context<ReadEnv>;
const now = () => Math.floor(Date.now() / 1000);

/** RFC 5987 双栈文件名（ASCII 回退 + UTF-8 精确） */
function disposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 上传闸门：登录 + allowattach（gid=1 恒允许） */
async function requireUpload(core: { db: D1b; cache: Cache }, c: Ctx) {
  const t = c.get('t');
  const v = await loadViewer(core.cache, core.db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const grouplist = await loadGrouplist(core.cache, core.db);
  const group = grouplist[v.gid];
  if (!group?.allowattach && v.gid !== 1) throw new AppError(Code.NO_PERMISSION, t('attach.uploadDenied'));
  return v;
}

interface ReadAttach {
  aid: number;
  uid: number;
  tid: number;
  filename: string;
  orgfilename: string;
  filesize: number;
  isimage: number;
  status: number;
  credits: number;
}

async function readAttach(db: D1b, aid: number, t: ApiT): Promise<ReadAttach> {
  const a = await db
    .prepare<ReadAttach>(
      'SELECT aid,uid,tid,filename,orgfilename,filesize,isimage,status,credits FROM bbs_attach WHERE aid = ?',
    )
    .bind(aid)
    .first<ReadAttach>();
  if (!a) throw new AppError(Code.NOT_FOUND, t('common.attachNotFound'));
  return a;
}

/** POST /api/attachments */
async function createAttachment(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core = { db: c.get('db'), cache: c.get('cache') };
  const v = await requireUpload(core, c);

  let name = '';
  let bytes: Uint8Array | null = null;
  let isimage = 0;
  let width = 0;
  let height = 0;
  let creditsPrice = 0;

  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('multipart/form-data')) {
    const fd = await c.req.formData();
    const file = fd.get('file') as (Blob & { name?: string }) | null;
    if (file && typeof file.arrayBuffer === 'function') {
      name = String(fd.get('name') ?? file.name ?? '');
      bytes = new Uint8Array(await file.arrayBuffer());
    }
    isimage = Number(fd.get('is_image') ?? 0);
    width = Number(fd.get('width') ?? 0);
    height = Number(fd.get('height') ?? 0);
    creditsPrice = Math.max(0, Math.floor(Number(fd.get('credits') ?? 0)) || 0);
  } else {
    let b: Record<string, unknown>;
    try {
      b = await c.req.json<Record<string, unknown>>();
    } catch {
      throw new AppError(Code.VALIDATION_ERROR, t('common.bodyJsonOrMultipart'));
    }
    name = String(b.name ?? '');
    const data = String(b.data ?? '');
    bytes = data ? decodeBase64(data, t) : null;
    isimage = Number(b.is_image ?? 0);
    width = Number(b.width ?? 0);
    height = Number(b.height ?? 0);
    creditsPrice = Math.max(0, Math.floor(Number(b.credits ?? 0)) || 0);
  }

  if (!name) throw new AppError(Code.VALIDATION_ERROR, t('attach.nameRequired'));
  if (!bytes || bytes.length === 0) throw new AppError(Code.VALIDATION_ERROR, t('common.fileContentEmpty'));
  if (bytes.length > ATTACH_MAX_BYTES) {
    throw new AppError(Code.FORM_FILE_TOO_LARGE, t('attach.tooLarge'), { size: bytes.length });
  }

  const ext = fileExt(name, 7);
  const filetype = attachType(ext);
  const stored = storageExt(ext); // 名单外前缀 `_` 防执行
  const key = tmpKey(v.uid, stored);
  // 暂存桶内容统一按二进制写（预览/下载侧决定呈现），避免 tmp 对象被内容嗅探执行
  await filesBucket(c.env).put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });

  const created = now();
  // 付费附件价格（T5-2，§15.1）：credits 已在上方归一为非负整数（0=免费）
  const row = await core.db
    .prepare<{ aid: number }>(
      `INSERT INTO bbs_attach (tid,pid,uid,filesize,width,height,filename,orgfilename,filetype,create_date,downloads,isimage,status,credits)
       VALUES (0,0,?,?,?,?,?,?,?,?,0,?,0,?) RETURNING aid`,
    )
    .bind(v.uid, bytes.length, width, height, key, name, filetype, created, isimage, creditsPrice)
    .first<{ aid: number }>();
  const aid = Number(row?.aid ?? 0);
  if (!aid) throw new AppError(Code.SYSTEM_ERROR, t('attach.writeFailed'));

  return ok(c, t('attach.uploadDone'), {
    data: {
      aid,
      url: `/api/attachments/${aid}/preview`,
      orgfilename: name,
      filetype,
      filesize: bytes.length,
      width,
      height,
      isimage,
      downloads: 0,
      status: 0,
      credits: creditsPrice,
    },
  });
}

/** DELETE /api/attachments/:aid */
async function deleteAttachment(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core = { db: c.get('db'), cache: c.get('cache') };
  const v = await loadViewer(core.cache, core.db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const aid = intParam(c.req.param('aid'));
  const a = await readAttach(core.db, aid, t);

  if (Number(a.status) === 0) {
    // 临时待关联：仅上传者本人
    if (Number(a.uid) !== v.uid) throw new AppError(Code.NO_PERMISSION, t('common.permDenied'));
  } else {
    const th = await core.db
      .prepare<{ fid: number }>('SELECT fid FROM bbs_thread WHERE tid = ?')
      .bind(Number(a.tid))
      .first<{ fid: number }>();
    if (!th) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
    const [forumlist, grouplist] = await Promise.all([loadForumlist(core.cache, core.db), loadGrouplist(core.cache, core.db)]);
    const ctx = makeAccessCtx(v, forumlist, grouplist);
    if (Number(a.uid) !== v.uid && !forumAccessMod(ctx, Number(th.fid), 'allowdelete')) {
      throw new AppError(Code.NO_PERMISSION, t('common.permDenied'));
    }
  }

  await core.db.batch([
    core.db.prepare('DELETE FROM bbs_attach WHERE aid = ?').bind(aid) as unknown as Stmt,
  ]);
  await filesBucket(c.env).delete(a.filename);
  return ok(c, t('common.deleted'), { data: { aid } });
}

/** 桶对象 → Response 字节 */
async function bucketBytes(c: Ctx, key: string): Promise<Uint8Array | null> {
  const obj = await filesBucket(c.env).get(key);
  if (!obj || obj.body == null) return null;
  if (obj.body instanceof Uint8Array) return obj.body;
  return new Uint8Array(await new Response(obj.body as BodyInit).arrayBuffer());
}

/** 附件所属主题的最小上下文（付费主题未购拦截用） */
interface AttachThread {
  fid: number;
  content_buy: number;
  uid: number;
  /** 主题审核状态：非 1（待审/拒绝/回收站）不得被非作者/版主访问 */
  ok: number;
}

/**
 * 附件可见性闸门（预览/下载共用，均不产生扣费）：
 *  allowdown 组位 → 付费主题未购拦截 → 付费附件免扣豁免判定（上传者/管理员/免扣版主/VIP）。
 * 返回 exempt=true 表示付费附件可免扣放行；调用方决定是否实际扣费（预览一律不扣）。
 */
async function attachVisibilityGate(
  core: { db: D1b; cache: Cache },
  c: Ctx,
  a: ReadAttach,
  th: AttachThread,
  t: ApiT,
): Promise<{
  v: Awaited<ReturnType<typeof loadViewer>>;
  ctx: ReturnType<typeof makeAccessCtx>;
  grouplist: Awaited<ReturnType<typeof loadGrouplist>>;
  exempt: boolean;
}> {
  const v = await loadViewer(core.cache, core.db, c);
  const [forumlist, grouplist] = await Promise.all([loadForumlist(core.cache, core.db), loadGrouplist(core.cache, core.db)]);
  const ctx = makeAccessCtx(v, forumlist, grouplist);
  // 版块可见性 + 主题审核态：免费附件同样不能绕过（按 aid 遍历即可读到私密版块/待审主题的附件）
  if (!forumAccessUser(ctx, Number(th.fid), 'allowread') || !forumAccessUser(ctx, Number(th.fid), 'allowdown')) {
    throw new AppError(Code.NO_PERMISSION, t('attach.downloadDenied'));
  }
  if (Number(th.ok) !== 1 && v.uid !== Number(th.uid) && v.gid !== 1 && !forumAccessMod(ctx, Number(th.fid), 'allowdelete')) {
    throw new AppError(Code.NO_PERMISSION, t('attach.downloadDenied'));
  }

  // 付费主题未购拦截：主题 content_buy>0 且访问者非主题作者、未购（paylist type=1）→ 拒绝。
  if (Number(th.content_buy ?? 0) > 0 && v.uid !== Number(th.uid)) {
    const paid =
      v.uid > 0
        ? await core.db
            .prepare<{ plid: number }>('SELECT plid FROM bbs_paylist WHERE tid = ? AND uid = ? AND type = 1')
            .bind(Number(a.tid), v.uid)
            .first<{ plid: number }>()
        : null;
    if (!paid) throw new AppError(Code.NO_PERMISSION, t('attach.buyRequired'));
  }

  // 付费附件（T5-2，§15.1）：上传者/管理员/（可配）版主/VIP 免扣；其余需付积分（下载侧负责扣费，预览侧拒绝）。
  const price = Number(a.credits ?? 0);
  if (price <= 0) return { v, ctx, grouplist, exempt: true };
  const isUploader = v.uid > 0 && v.uid === Number(a.uid);
  if (isUploader || v.gid === 1) return { v, ctx, grouplist, exempt: true };
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('attach.loginForDownload'));
  const setting = await loadSetting(core.cache, core.db);
  const freeForMod = Number(setting.attachFreeForMod ?? 1) > 0 && forumAccessMod(ctx, Number(th.fid), 'allowdelete');
  let freeForVip = false;
  if (Number(setting.attachFreeForVip ?? 1) > 0) {
    const vip = await core.db
      .prepare<{ vip_expire_at: number }>('SELECT vip_expire_at FROM bbs_user WHERE uid = ?')
      .bind(v.uid)
      .first<{ vip_expire_at: number }>();
    freeForVip = Number(vip?.vip_expire_at ?? 0) > now();
  }
  return { v, ctx, grouplist, exempt: freeForMod || freeForVip };
}

/** 付费附件「已付费下载过」判定：与扣费幂等键同源（bbs_point_log.biz_key = `attach:{aid}:{uid}`） */
async function hasPaidAttach(core: { db: D1b }, uid: number, aid: number): Promise<boolean> {
  if (uid <= 0) return false;
  const row = await core.db
    .prepare<{ x: number }>('SELECT 1 AS x FROM bbs_point_log WHERE uid = ? AND biz_key = ?')
    .bind(uid, `attach:${aid}:${uid}`)
    .first<{ x: number }>();
  return Boolean(row);
}

/** GET /api/attachments/:aid/preview */
async function previewAttachment(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core = { db: c.get('db'), cache: c.get('cache') };
  const aid = intParam(c.req.param('aid'));
  const a = await readAttach(core.db, aid, t);
  let gated = false;
  if (Number(a.status) === 0) {
    // 临时件（未关联）：仅上传者本人
    const v = await loadViewer(core.cache, core.db, c);
    if (Number(a.uid) !== v.uid) throw new AppError(Code.NO_PERMISSION, t('common.permDenied'));
  } else {
    // 正式件：一律先校验所属主题（版块可见性 + 审核态 + 付费主题），
    // 免费附件也不能按 aid 遍历绕过私密版块/待审主题；预览不扣费，付费件未购一律拒绝。
    const th = await core.db
      .prepare<AttachThread>('SELECT fid,content_buy,uid,ok FROM bbs_thread WHERE tid = ?')
      .bind(Number(a.tid))
      .first<AttachThread>();
    if (!th) throw new AppError(Code.NO_PERMISSION, t('attach.downloadDenied'));
    const price = Number(a.credits ?? 0);
    const { v, exempt } = await attachVisibilityGate(core, c, a, th, t);
    if (price > 0 && !exempt && !(await hasPaidAttach(core, v.uid, aid))) {
      throw new AppError(Code.NO_PERMISSION, t('attach.downloadDenied'));
    }
    gated = price > 0 || Number(th.content_buy ?? 0) > 0;
  }
  const data = await bucketBytes(c, a.filename);
  if (!data) throw new AppError(Code.NOT_FOUND, t('attach.fileNotFound'));
  const ct = Number(a.isimage) > 0 ? mimeFor(fileExt(a.filename)) : 'application/octet-stream';
  return new Response(data, {
    headers: {
      'content-type': ct,
      'content-disposition': disposition('inline', a.orgfilename || `aid-${aid}`),
      // 受限期件的响应不得进公共缓存（否则未购者可经边缘/浏览器缓存取到）
      'cache-control': Number(a.status) === 1 && !gated ? 'public, max-age=86400' : 'private, no-store',
    },
  });
}

/** GET /api/attachments/:aid/download */
async function downloadAttachment(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core = { db: c.get('db'), cache: c.get('cache') };
  const aid = intParam(c.req.param('aid'));
  const a = await readAttach(core.db, aid, t);
  const th = await core.db
    .prepare<AttachThread>('SELECT fid,content_buy,uid,ok FROM bbs_thread WHERE tid = ?')
    .bind(Number(a.tid))
    .first<AttachThread>();
  if (!th) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
  // 可见性闸门（allowdown + 付费主题未购 + 付费附件免扣豁免）与预览共用，保证两端口径一致。
  const { v, grouplist, exempt } = await attachVisibilityGate(core, c, a, th, t);

  // 先取 R2 对象再扣费：对象缺失/读取失败时不得已经扣了积分（否则重试还会再扣一次）。
  const data = await bucketBytes(c, a.filename);
  if (!data) throw new AppError(Code.NOT_FOUND, t('attach.fileNotFound'));

  // 付费墙（T5-2，§15.1）：attach.credits>0 需先扣积分入账；上传者/管理员/（可配）版主/VIP 免扣，已购用户放行。
  // downloads 计数与放行严格一致：扣减失败（积分不足）→ 拒服、计数不增。
  const price = Number(a.credits ?? 0);
  if (price > 0) {
    // 下载是 GET（CSRF 不覆盖）：拒绝跨站顶层导航，防止外站链接诱导受害者付费下载扣分。
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      throw new AppError(Code.NO_PERMISSION, t('attach.downloadDenied'));
    }
  }
  if (price > 0 && !exempt) {
    const res = await chargePoints(core, {
      uid: v.uid,
      price,
      reason: 'attach_purchase',
      bizKey: `attach:${aid}:${v.uid}`,
      ts: now(),
      incomeTo: Number(a.uid),
    });
    if (res === 'insufficient') {
      throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, t('attach.insufficientForAttach', { price }), { price });
    }
  }

  // 下载扣分：三币种规则全 0 则跳过；
  // 负向规则会把余额扣成负数 → 拒下载（credit_no_enough）；否则同批扣减并重算等级组。
  const rules = await loadCreditsRules(core.cache, core.db);
  const dExp = Number(rules.down_exp ?? 0);
  const dGold = Number(rules.down_gold ?? 0);
  const dRmb = Number(rules.down_rmb ?? 0);
  if (dExp !== 0 || dGold !== 0 || dRmb !== 0) {
    // uid=0（游客）且有非零规则 → 拒绝下载
    if (v.uid <= 0) throw new AppError(Code.NO_PERMISSION, t('attach.groupDownloadDenied'));
    const u = await core.db
      .prepare<{ credits: number; golds: number; rmbs: number }>('SELECT credits,golds,rmbs FROM bbs_user WHERE uid = ?')
      .bind(v.uid)
      .first<{ credits: number; golds: number; rmbs: number }>();
    if (u) {
      if (
        (dExp < 0 && Number(u.credits) + dExp < 0) ||
        (dGold < 0 && Number(u.golds) + dGold < 0) ||
        (dRmb < 0 && Number(u.rmbs) + dRmb < 0)
      ) {
        throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, t('credits.insufficient'));
      }
      const ts = now();
      // 每次下载都扣，流水键加随机尾缀防同秒重复被唯一键吞掉
      const biz = `download:${aid}:${v.uid}:${ts}:${Math.random().toString(36).slice(2, 6)}`;
      const stmts: Stmt[] = [];
      const deltas: [number, number, string][] = [
        [1, dExp, ':exp'],
        [2, dGold, ':gold'],
        [3, dRmb, ':rmb'],
      ];
      for (const [creditType, change, suffix] of deltas) {
        if (change === 0) continue;
        stmts.push(...creditDeltaStmts(core, { uid: v.uid, creditType, change, reason: 'attach_purchase', bizKey: biz + suffix, ts }));
      }
      if (stmts.length) await core.db.batch(stmts);
      const up = await upgradeGroupByCredits(core, v.uid, grouplist);
      if (up) {
        const rt = await getExtensions(core.cache, core.db, undefined, { preloadConfigs: false });
        await rt.bus.emit('user:group-changed', { uid: v.uid, oldGid: up.oldGid, newGid: up.newGid });
      }
    }
  }

  // downloads+1：旁路写，不占响应关键路径
  const p = core.db.prepare('UPDATE bbs_attach SET downloads = downloads + 1 WHERE aid = ?').bind(aid).run();
  let ex: { waitUntil?: (pr: Promise<unknown>) => void } | undefined;
  try {
    ex = (c as unknown as { executionCtx?: { waitUntil?: (pr: Promise<unknown>) => void } }).executionCtx;
  } catch {
    ex = undefined;
  }
  if (ex?.waitUntil) ex.waitUntil(p);
  else await p;

  return new Response(data, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': disposition('attachment', a.orgfilename || `aid-${aid}`),
      'content-length': String(data.length),
      // 每次下载都要扣分/计数，不能允许浏览器或边缘缓存 24h 复用（否则重复下载不扣分）
      'cache-control': 'private, no-store',
    },
  });
}

/**
 * GET /files/* — avatar/、forum/、site/ 前缀流式直链；tmp/、attach/ 与路径穿越拒绝。
 * attach/ 属受限资源：正式附件 key 匿名直取会绕过 allowdown/付费主题/付费附件校验，
 * 必须走 /api/attachments/:aid/{preview,download}，故不作为公共前缀放行。
 */
async function filesProxy(c: Ctx): Promise<Response> {
  const rel = c.req.path.replace(/^\/files\//, '');
  if (!rel || rel.includes('..') || !/^(avatar|forum|site)\//.test(rel)) {
    return c.text('Not Found', 404, { 'content-type': 'text/plain; charset=utf-8' });
  }
  const obj = await filesBucket(c.env).get(rel);
  if (!obj || obj.body == null) return c.text('Not Found', 404, { 'content-type': 'text/plain; charset=utf-8' });
  const ct = obj.httpMetadata?.contentType ?? mimeFor(fileExt(rel));
  // 头像长缓存；其余二进制短缓存（同名不可变由 R2 key 随机段保证；
  // forum/ 图标 key 固定会被覆盖重传，immutable 仅对带 ?v= 版本号的 icon_url 安全，直链统一按日失效）
  const immutable = /^avatar\//.test(rel) && (ct.startsWith('image/') || ct === 'application/octet-stream');
  return new Response(obj.body as BodyInit, {
    headers: {
      'content-type': ct,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
    },
  });
}

interface AssocArgs {
  db: D1b;
  env: Ctx['env'];
  uid: number;
  tid: number;
  pid: number;
  isfirst: boolean;
  aids: number[];
}

/**
 * 关联待上传附件到帖子（§9.3 无 message 串替换）：
 * 仅处理【本 uid + status=0 + 命中 aid】的行；tmp→attach/YYYYmm 移动、status=1、images/files 计数回写（首帖并回写 thread）。
 * R2 I/O 不计 CPU；无匹配则整体跳过（零额外查询）。
 */
export async function associateAttachments(a: AssocArgs): Promise<void> {
  const aids = a.aids.filter((x) => Number.isFinite(x) && x > 0);
  if (!aids.length) return;
  const placeholders = aids.map(() => '?').join(',');
  const rows = await a.db
    .prepare<{ aid: number; filename: string; isimage: number }>(
      `SELECT aid,filename,isimage FROM bbs_attach WHERE uid = ? AND status = 0 AND aid IN (${placeholders})`,
    )
    .bind(a.uid, ...aids)
    .all();
  if (!rows.results.length) return;

  const bucket = filesBucket(a.env);
  const ym = ymDir(now());
  const stmts: Stmt[] = [];
  let images = 0;
  let files = 0;
  for (const r of rows.results) {
    const oldKey = String(r.filename);
    const stored = fileExt(oldKey); // 含 `_ext` 名单外形态一并保留
    const newKey = attachKey(ym, stored);
    const obj = await bucket.get(oldKey);
    if (obj && obj.body != null) {
      await bucket.put(newKey, obj.body as ArrayBufferView, { httpMetadata: { contentType: 'application/octet-stream' } });
      await bucket.delete(oldKey);
    }
    if (Number(r.isimage) > 0) images++;
    else files++;
    stmts.push(
      a.db
        .prepare('UPDATE bbs_attach SET tid = ?, pid = ?, filename = ?, status = 1 WHERE aid = ?')
        .bind(a.tid, a.pid, newKey, Number(r.aid)) as unknown as Stmt,
    );
  }
  // 计数用「累加本批」而非「覆盖」：本批仅取 status=0 待关联件，每个 aid 一生只被计一次，
  // 编辑帖时保留历史已关联件计数（不做按 pid 全量重算）。
  stmts.push(a.db.prepare('UPDATE bbs_post SET images = images + ?, files = files + ? WHERE pid = ?').bind(images, files, a.pid) as unknown as Stmt);
  if (a.isfirst) {
    stmts.push(a.db.prepare('UPDATE bbs_thread SET images = images + ?, files = files + ? WHERE tid = ?').bind(images, files, a.tid) as unknown as Stmt);
  }
  await a.db.batch(stmts);
}

export function attachRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();
  app.post('/api/attachments', createAttachment);
  app.delete('/api/attachments/:aid', deleteAttachment);
  app.get('/api/attachments/:aid/preview', previewAttachment);
  app.get('/api/attachments/:aid/download', downloadAttachment);
  app.get('/files/*', filesProxy);
  return app;
}
