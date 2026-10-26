/**
 * GET /api/bootstrap（T1-4）：一次下发版头所需全量——setting + 可见版块树 + 用户组 + 当前用户。
 * 合并版头渲染依赖的 forumlist/grouplist/当前用户为单请求（§7 首屏 RTT 收敛）。
 */
import { Hono } from 'hono';
import { effectiveBanScope } from '@freeidx/shared';
import { USER_PUBLIC_COLS } from '../../core/db/columns';
import { forumListAccessFilter } from '../../core/access';
import { hasSeeCheck } from '../../core/check';
import { forumLangOf, loadForumlist, loadGrouplist, loadSetting, loadViewer } from '../../core/loaders';
import { remember } from '../../core/cache';
import { getEmailProvider } from '../../core/email';
import { getExtensions } from '../../core/extensions';
import { loadThemeId } from '../../core/theme';
import { ok } from '../../middleware/envelope';
import { core, avatarAutoOf, type ReadEnv } from '../shared';

export function bootstrapRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/bootstrap', async (c) => {
    const { db, cache } = core(c);
    const [forumlist, grouplist, viewer, setting, mailOn] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
      loadSetting(cache, db),
      // 邮件通道实际可用性：后台「注册邮箱验证」只是开关，能否发信取决于 SMTP 池是否存在（§11.3 无池即降级）。
      // 前台必须按「实际生效」口径渲染验证码框，否则会给出必填验证码、发码却永远失败的死路。
      // 60s 读穿缓存：本接口是热点，不能每次 bootstrap 都去解密一次 secret。
      remember(cache, 'email:on', async () => (await getEmailProvider(c.env, db, cache)) !== null),
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
        /* 生效内容语言（0024，已含父版块继承）：非空时发帖页锁定语言选择，服务端强制该语言 */
        lang: forumLangOf(forumlist, f.fid),
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
            `SELECT ${USER_PUBLIC_COLS}, golds, rmbs, ban_scope, ban_until, ban_reason FROM bbs_user WHERE uid = ?`,
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
          /**
           * 小黑屋（0025）：生效中的封禁位（0=未封禁/已到期）。
           * 前台据此提示原因与到期时间，并在禁言时置灰发帖/回帖入口；
           * 到期的惰性判定在前端按 banUntil 再算一次（bootstrap 可能命中缓存）。
           */
          banScope: effectiveBanScope(u.ban_scope, u.ban_until, Math.floor(Date.now() / 1000)),
          banUntil: Number(u.ban_until ?? 0),
          banReason: String(u.ban_reason ?? ''),
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

    // 启用主题 id：与 ext.light 分开两个概念——theme 选「用哪套外观」，ext.light 是简蓝的配置面
    const theme = await loadThemeId(cache, db);

    return ok(c, 'ok', {
      // mailOn 现算后覆盖：setting 本身是缓存对象，不得就地改写（L0/L1 共享）
      data: { version: '0.1.0', setting: { ...setting, mailOn }, forumlist: nodes, grouplist: groups, me, runtime, ext, theme },
    });
  });

  return app;
}
