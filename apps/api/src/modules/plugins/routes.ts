/**
 * 遗留功能扩展 + 运行时插件的公开端点：
 *  GET  /api/quick-reply-message ← 快速回复限制扩展前台下拉数据：
 *                                  { enabled, options: [默认回复语, ...备选回复语(# 分隔)] }
 *  GET  /api/insert-codes        ← 插入代码扩展八个注入位原始 HTML：
 *                                  键名为存储键（勿改名），空串照返，前端据此决定是否渲染。
 *  GET  /api/checkin             ← 每日签到插件状态：{ enabled, rewards?, checked?, days?, todayCount?, todayUsers? }
 *  POST /api/checkin             ← 每日签到执行（需登录；按天幂等，重复签到报 checkin.already）
 *  GET  /api/related-threads     ← 相关帖子插件列表：{ enabled, list: [{ tid, fid, subject, username, avatar, posts, views, createDate, lastDate, reasons }] }
 * 均免登录（POST 签到除外）；插件停用时按「关闭态」返回（enabled:false / 全空串 / 404），前台零残留。
 */
import { Hono } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { loadExtConfig } from '../../core/ext-store';
import { isEnabled, loadExtensionsState } from '../../core/extensions/registry';
import { loadForumlist, loadGrouplist, loadViewer, makeAccessCtx } from '../../core/loaders';
import { forumAccessUser } from '../../core/access';
import { hasSeeCheck } from '../../core/check';
import { checkinPlugin, checkinStatus, checkinToday, doCheckin, emptyWeek, loadCheckinRewards } from '../../extensions/checkin';
import { loadRelatedConfig, queryRelatedThreads, relatedPlugin } from '../../extensions/related';
import { INSERT_CODE_EXT_ID, INSERT_CODE_KEYS, QUICK_REPLY_EXT_ID, idxQuickReplyModule, idxInsertCodeModule } from '../../extensions/legacy-extensions';
import { core, intParam, type ReadEnv } from '../shared';

export function pluginsRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  /** 快速回复下拉数据：插件启用且开关开启时返回 [默认语, ...# 分隔备选语]（去空白、去空项） */
  app.get('/api/quick-reply-message', async (c) => {
    const { db, cache } = core(c);
    const state = await loadExtensionsState(cache, db);
    if (!isEnabled(idxQuickReplyModule.manifest, state)) {
      return ok(c, 'ok', { data: { enabled: false, options: [] } });
    }
    const cfg = await loadExtConfig(cache, db, QUICK_REPLY_EXT_ID);
    const enabled = Number(cfg.is_quick_reply_message) === 1;
    const options = enabled
      ? [String(cfg.quick_reply_message_default ?? ''), ...String(cfg.quick_reply_message ?? '').split('#')]
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    return ok(c, 'ok', { data: { enabled, options } });
  });

  /** 八个注入位原始 HTML：键名为存储键（勿改名），未配置/停用一律空串 */
  app.get('/api/insert-codes', async (c) => {
    const { db, cache } = core(c);
    const state = await loadExtensionsState(cache, db);
    const blank = Object.fromEntries(INSERT_CODE_KEYS.map((k) => [k, '']));
    if (!isEnabled(idxInsertCodeModule.manifest, state)) {
      return ok(c, 'ok', { data: blank });
    }
    const cfg = await loadExtConfig(cache, db, INSERT_CODE_EXT_ID);
    const codes = Object.fromEntries(INSERT_CODE_KEYS.map((k) => [k, typeof cfg[k] === 'string' ? (cfg[k] as string) : '']));
    return ok(c, 'ok', { data: codes });
  });

  /** 每日签到状态：奖励配置 + 当前用户今日已签/累计天数/本周七天标记 + 今日签到聚合（人数与签到者列表） */
  app.get('/api/checkin', async (c) => {
    const { db, cache } = core(c);
    const state = await loadExtensionsState(cache, db);
    if (!isEnabled(checkinPlugin.manifest, state)) {
      return ok(c, 'ok', { data: { enabled: false } });
    }
    const rewards = await loadCheckinRewards(cache, db);
    const v = await loadViewer(cache, db, c);
    const [status, today] = await Promise.all([
      v.uid > 0 ? checkinStatus(db, v.uid) : Promise.resolve({ checked: false, days: 0, ...emptyWeek() }),
      checkinToday(db),
    ]);
    return ok(c, 'ok', { data: { enabled: true, rewards, ...status, ...today } });
  });

  /**
   * 相关帖子（related 插件）：帖子详情页「主贴下方、评论区上方」的列表数据。
   * 权限与审核口径与列表接口一致（可读版块 + ok 可见性下推到 SQL）；
   * 插件停用返回 enabled:false（前端据此不渲染、不再请求）。
   */
  app.get('/api/related-threads', async (c) => {
    const { db, cache } = core(c);
    const state = await loadExtensionsState(cache, db);
    if (!isEnabled(relatedPlugin.manifest, state)) return ok(c, 'ok', { data: { enabled: false, list: [] } });
    const tid = intParam(c.req.query('tid'));
    const empty = { enabled: true, list: [] };
    if (tid <= 0) return ok(c, 'ok', { data: empty });
    const cfg = await loadRelatedConfig(cache, db);
    const [forumlist, grouplist, viewer] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const thread = await db
      .prepare<{ tid: number; fid: number; uid: number; tags: string }>('SELECT tid,fid,uid,tags FROM bbs_thread WHERE tid = ?')
      .bind(tid)
      .first<{ tid: number; fid: number; uid: number; tags: string }>();
    // 主题不存在或当前访问者无权阅读其版块：与详情页同一口径，直接空列表（不泄露其它版块内容）
    if (!thread || !forumAccessUser(ctx, Number(thread.fid), 'allowread')) return ok(c, 'ok', { data: empty });
    const readableFids = Object.keys(forumlist)
      .map(Number)
      .filter((fid) => forumAccessUser(ctx, fid, 'allowread'));
    const tags = String(thread.tags ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4);
    const list = await queryRelatedThreads(db, {
      tid,
      fid: Number(thread.fid),
      uid: Number(thread.uid),
      tags,
      readableFids,
      viewerUid: viewer.uid,
      seeCheck: hasSeeCheck(grouplist[viewer.gid]),
      cfg,
    });
    return ok(c, 'ok', { data: { enabled: true, list } });
  });

  /** 每日签到执行（需登录）：按天幂等，重复签到返回 checkin.already；成功回奖励明细供前台提示 */
  app.post('/api/checkin', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const state = await loadExtensionsState(cache, db);
    if (!isEnabled(checkinPlugin.manifest, state)) throw new AppError(Code.NOT_FOUND, t('common.routeNotFound'));
    const v = await loadViewer(cache, db, c);
    if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
    const r = await doCheckin({ db, cache }, v.uid);
    if (r === 'already') throw new AppError(Code.VALIDATION_ERROR, t('checkin.already'));
    const g = r.granted;
    const parts: string[] = [];
    if (g.exp > 0) parts.push(`${t('credit.exp')}+${g.exp}`);
    if (g.gold > 0) parts.push(`${t('credit.gold')}+${g.gold}`);
    if (g.rmb > 0) parts.push(`${t('credit.rmb')}+${g.rmb}`);
    if (g.vipDays > 0) parts.push(`${t('checkin.vip')}${g.vipDays}${t('checkin.day_unit')}`);
    const status = await checkinStatus(db, v.uid);
    return ok(c, 'ok', { data: { rewards: g, summary: parts.join(' '), ...status } });
  });

  return app;
}
