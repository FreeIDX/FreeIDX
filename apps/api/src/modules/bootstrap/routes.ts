/**
 * GET /api/bootstrap（T1-4）：一次下发版头所需全量——setting + 可见版块树 + 用户组 + 当前用户。
 * 合并版头渲染依赖的 forumlist/grouplist/当前用户为单请求（§7 首屏 RTT 收敛）。
 */
import { Hono } from 'hono';
import { effectiveBanScope, normForumNameI18n, normNameI18n } from '@freeidx/shared';
import { USER_PUBLIC_COLS } from '../../core/db/columns';
import { forumListAccessFilter } from '../../core/access';
import { hasSeeCheck } from '../../core/check';
import { forumLangOf, forumRankCompare, loadForumlist, loadGrouplist, loadSetting, loadViewer } from '../../core/loaders';
import { remember } from '../../core/cache';
import { unescapeHtmlEntities } from '../../core/fmt';
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
      // 邮件通道实际可用性：后台「注册邮箱验证」只是开关，能否发信取决于邮件账号池是否存在（§11.3 无池即降级）。
      // 前台必须按「实际生效」口径渲染验证码框，否则会给出必填验证码、发码却永远失败的死路。
      // 60s 读穿缓存：本接口是热点，不能每次 bootstrap 都去解密一次 secret。
      remember(cache, 'email:on', async () => (await getEmailProvider(c.env, db, cache)) !== null),
    ]);
    const visible = forumListAccessFilter(forumlist, viewer.gid, grouplist);
    const nodes = Object.values(visible)
      .sort(forumRankCompare)
      .map((f) => ({
        fid: f.fid,
        name: f.name,
        /* 版块名多语言（0027）：整份 map 下发，前端按当前界面语言取词 → 切语言即时同步 */
        nameI18n: normForumNameI18n(f.name_i18n),
        rank: f.rank,
        brief: f.brief,
        /* 简介多语言（0028）：整份 map 下发，前端按当前界面语言取词。
           保留它的唯一理由是发现页「全部版块」网格从本接口取简介（DiscoveryPage）。 */
        briefI18n: normNameI18n(f.brief_i18n),
        threads: f.threads,
        todayposts: f.todayposts,
        todaythreads: f.todaythreads,
        icon: f.icon,
        iconUrl: f.icon_url,
        /* 图标显示开关（0029）：0 = 前台版块栏只显示版块名，不渲染图标 */
        iconShow: f.icon_show,
        announcement: f.announcement,
        /* 公告多语言（0028）**不下发**：只有版块页用它，而版块页自己的
           GET /api/forums/:fid/threads 已随 forum 对象带上 announcementI18n
           （见 modules/thread/routes.ts）。让全站每次 bootstrap 都背 15KB 没有意义。 */
        /* SEO 标题/关键词只下发**单值**，不下发 10 语言映射（0028）：
           - 前端全站零引用（页面标题由 Layout 用站点标题统一设置，版块页不覆盖）；
           - SEO 产物由 prerender 直接查库生成，且固定按站点语言取词
             （modules/seo/core.ts），10 个语言里只有 1 个会进 HTML。
           单值保留是因为量极小（合计 ~1KB），给主题留一个「页面标题」的取词入口。 */
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

    /**
     * 首页公告条与在线人数：原本各是一个独立请求（GET /api/announcements、GET /api/online?summary=1）。
     * 并入 bootstrap 后：少 2 次 Worker 调用，且冷启动少 2 条 D1 查询。
     * 公告走 60s 读穿缓存（登录用户每个 bootstrap 都真打一次 D1，公告变更低频）；
     * 在线数刻意保持实时（COUNT 便宜且语义就是"当前在线"）。
     * fail-soft：一条公告和一个数字不值得让整份首屏数据失败（配额耗尽/表缺失时按空处理）。
     */
    const [announcements, online] = await Promise.all([
      remember(cache, 'announcements', async () =>
        db
          .prepare<{ aid: number; message: string; create_date: number }>(
            'SELECT aid, message, create_date FROM bbs_announcement WHERE isshow = 1 ORDER BY aid DESC LIMIT 10',
          )
          .all()
          .then((r) =>
            r.results.map((x) => ({
              aid: Number(x.aid),
              message: unescapeHtmlEntities(String(x.message ?? '')),
              createDate: Number(x.create_date ?? 0),
            })),
          )
          .catch(() => []),
      ),
      db
        .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_session')
        .first<{ c: number }>()
        .then((r) => Number(r?.c ?? 0))
        .catch(() => 0),
    ]);

    return ok(c, 'ok', {
      // mailOn 现算后覆盖：setting 本身是缓存对象，不得就地改写（L0/L1 共享）
      data: {
        version: '0.1.0',
        setting: { ...setting, mailOn },
        forumlist: nodes,
        grouplist: groups,
        me,
        runtime,
        ext,
        theme,
        announcements,
        online,
      },
    });
  });

  return app;
}
