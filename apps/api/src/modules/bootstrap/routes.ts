/**
 * GET /api/bootstrap（T1-4）：一次下发版头所需全量——setting + 可见版块树 + 用户组 + 当前用户。
 * 合并版头渲染依赖的 forumlist/grouplist/当前用户为单请求（§7 首屏 RTT 收敛）。
 */
import { Hono } from 'hono';
import { USER_PUBLIC_COLS } from '../../core/db/columns';
import { forumListAccessFilter } from '../../core/access';
import { hasSeeCheck } from '../../core/check';
import { loadForumlist, loadGrouplist, loadSetting, loadViewer } from '../../core/loaders';
import { remember } from '../../core/cache';
import { getExtensions } from '../../core/extensions';
import { ok } from '../../middleware/envelope';
import { core, avatarAutoOf, type ReadEnv } from '../shared';

export function bootstrapRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/bootstrap', async (c) => {
    const { db, cache } = core(c);
    const [forumlist, grouplist, viewer, setting] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
      loadSetting(cache, db),
    ]);
    const visible = forumListAccessFilter(forumlist, viewer.gid, grouplist);
    const nodes = Object.values(visible)
      .sort((a, b) => b.rank - a.rank || a.fid - b.fid)
      .map((f) => ({
        fid: f.fid,
        name: f.name,
        rank: f.rank,
        brief: f.brief,
        threads: f.threads,
        todayposts: f.todayposts,
        todaythreads: f.todaythreads,
        icon: f.icon,
        iconUrl: f.icon_url,
        announcement: f.announcement,
        seoTitle: f.seo_title,
        seoKeywords: f.seo_keywords,
        /* 二级版块：上级版块 fid，0 = 一级版块（前端据此归并二级导航） */
        parentFid: f.parent_fid,
      }));
    const groups = Object.values(grouplist).map((g) => ({
      gid: g.gid,
      name: g.name,
      creditsfrom: Number(g.creditsfrom),
      creditsto: Number(g.creditsto),
      /** tt_credits：发帖页「支付」设置仅对该位置 1 的用户组渲染 */
      allowsell: Number(g.allowsell ?? 0),
    }));

    let me = null;
    if (viewer.uid > 0) {
      const [u, followers, following, favorites, unread] = await Promise.all([
        db
          .prepare<Record<string, number | string>>(
            `SELECT ${USER_PUBLIC_COLS}, golds, rmbs FROM bbs_user WHERE uid = ?`,
          )
          .bind(viewer.uid)
          .first<Record<string, number | string>>(),
        db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_follow WHERE followee_uid = ?').bind(viewer.uid).first<{ c: number }>(),
        db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_follow WHERE follower_uid = ?').bind(viewer.uid).first<{ c: number }>(),
        db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_favorite WHERE uid = ?').bind(viewer.uid).first<{ c: number }>(),
        /* 消息未读数（huux_notice：实时 COUNT，口径见 0006 迁移） */
        db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_notice WHERE recvuid = ? AND isread = 0').bind(viewer.uid).first<{ c: number }>(),
      ]);
      if (u) {
        const avatarAuto = avatarAutoOf(Number(u.avatar), u.avatar_auto);
        me = {
          uid: Number(u.uid),
          gid: Number(u.gid),
          username: String(u.username),
          avatar: Number(u.avatar),
          /** 预设头像路径（avatar=0 且 avatar_auto 非 '0' 时生效） */
          ...(avatarAuto ? { avatar_auto: avatarAuto } : {}),
          /** 主页背景预设编号（'0'=默认 bg-0.png） */
          bgimg: String(u.bgimg ?? '0'),
          threads: Number(u.threads),
          posts: Number(u.posts),
          credits: Number(u.credits),
          /** 三币种（积分区展示）：金币 / 人民币（分） */
          golds: Number(u.golds ?? 0),
          rmbs: Number(u.rmbs ?? 0),
          createDate: Number(u.create_date),
          followers: Number(followers?.c ?? 0),
          following: Number(following?.c ?? 0),
          favorites: Number(favorites?.c ?? 0),
          unreadNotices: Number(unread?.c ?? 0),
          /** 账号审核状态（tt_check）：非 1 时前台顶部提示且禁发帖回帖 */
          ok: Number(u.ok ?? 1),
          /** see_check 组（tt_check）：列表/帖内显示未过审内容与现场审核按钮 */
          seeCheck: hasSeeCheck(grouplist[Number(u.gid)]),
          /** 认证头衔（'0'=未认证；个人中心头像旁 V 标） */
          v: String(u.v ?? '0'),
        };
      }
    }

    // 站点运行数据：全站贴子总数 + 用户数（bbs_forum 无 posts 反规范化列 → COUNT(bbs_post)），
    // 'runtime_card' 走默认键策略 L0+L2 / 60s 读穿，预算友好
    const runtime = await remember(cache, 'runtime_card', async () => {
      const [posts, users] = await Promise.all([
        db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_post').first<{ c: number }>(),
        db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_user').first<{ c: number }>(),
      ]);
      return { posts: Number(posts?.c ?? 0), users: Number(users?.c ?? 0) };
    });

    // 契约 ⑦ bootstrap:contribute：插件字段随核心一次下发，不产生额外请求
    const ext: Record<string, unknown> = {};
    const rt = await getExtensions(cache, db, c.env);
    await rt.bus.emit('bootstrap:contribute', { payload: ext });

    return ok(c, 'ok', {
      data: { version: '0.1.0', setting, forumlist: nodes, grouplist: groups, me, runtime, ext },
    });
  });

  return app;
}
