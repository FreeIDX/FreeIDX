/**
 * 主题只读接口（T1-4）：
 *  GET /api/threads?fid&page&digest&orderby&before_{col}   首页聚合（fid=0）
 *  GET /api/forums/:fid/threads?page&orderby&digest&before_{col}
 *  GET /api/search?q&page   站内标题搜索（LIKE 简版）
 *  GET /api/threads/:tid?page&keyword
 * DoD：列表页零 user 二次查询（thread 反规范化列）、单请求 ≤50 查询、
 *      置顶合并/权限过滤在列表侧统一完成；浏览量 waitUntil 攒批 +1。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { Code, PageSize, normalizeContentLang, type AttachItem, type FavoriterItem, type PostItem, type PostReplyItem, type SearchUserHit, type ThreadListItem, type ThreadDetail } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import type { Cache } from '../../core/cache';
import { lightPlugin } from '../../extensions/light';
import {
  THREAD_LIST_COLS,
  THREAD_LIST_COLS_T,
  THREAD_DETAIL_COLS,
  POST_PAGE_COLS,
  T,
  P,
} from '../../core/db/columns';
import { cursorCond, shallowOffset } from '../../core/db/paginate';
import {
  canDeletePost,
  canUpdatePost,
  forumAccessMod,
  forumAccessUser,
  threadListAccessFilter,
} from '../../core/access';
import type { AccessCtx } from '../../core/access';
import { loadForumlist, loadGrouplist, loadSetting, loadViewer, makeAccessCtx } from '../../core/loaders';
import { canSeeUnapproved, hasSeeCheck } from '../../core/check';
import { loadExtConfig } from '../../core/ext-store';
import { isEnabled, loadExtensionsState } from '../../core/extensions/registry';
import { IDX_EXT_ID, IDX_MANIFEST } from '../../extensions/legacy-extensions';
import { core, highlight, intParam, orderCol, totalPageOf, avatarAutoOf, redactPaidBlocks, type ReadEnv } from '../shared';

interface ThreadRow {
  tid: number;
  fid: number;
  top: number;
  digest: number;
  closed: number;
  uid: number;
  username: string;
  avatar: number;
  subject: string;
  posts: number;
  views: number;
  images: number;
  files: number;
  lastpid: number;
  lastuid: number;
  lastusername: string;
  create_date: number;
  last_date: number;
  /** 审核位（tt_check）：非 1 仅作者与 see_check 组可见 */
  ok: number;
  /** 付费位（tt_credits）：content_buy>0 即收费帖（type 1经验 2金币 3人民币[单位分]） */
  content_buy: number;
  content_buy_type: number;
  /** 标签（简蓝主题，逗号分隔的标签名，可空串） */
  tags?: string;
  /** 列表图片组（thread_summary_pic，首帖图片地址 ≤9 张逗号分隔，可空串） */
  image_urls?: string;
  /** 列表摘要（thread_summary_word，首帖纯文本 ≤300 字，可空串） */
  summary?: string;
  /** 内容语言（zh/en/ja/ko/ru/th/de/fr/es/other；空串 = 未指定，不参与语言过滤） */
  lang?: string;
}

interface ThreadDetailRow extends ThreadRow {
  firstpid: number;
  mods: number;
  userip: number;
}

interface PostRow {
  pid: number;
  tid: number;
  uid: number;
  isfirst: number;
  create_date: number;
  userip: number;
  images: number;
  files: number;
  doctype: number;
  quotepid: number;
  message: string;
  message_fmt: string;
  /** 审核位（tt_check）：非 1 仅作者与 see_check 组可见 */
  ok: number;
}

interface AttachRow {
  aid: number;
  pid: number;
  orgfilename: string;
  filesize: number;
  isimage: number;
  width: number;
  height: number;
  downloads: number;
  create_date: number;
  credits: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** 作者 V 头衔 + 预设头像：
 *  列表按页批量一次 IN 查询随行下发；预设经语义解析（avatar=0 且非 '0' 才生效） */
interface AuthorExtras {
  uv: string;
  avatarAuto: string;
}

async function fetchUserExtrasMap(db: D1b, uids: number[]): Promise<Map<number, AuthorExtras>> {
  const uniq = [...new Set(uids.map(Number).filter((u) => u > 0))];
  if (!uniq.length) return new Map();
  const r = await db
    .prepare<{ uid: number; v: string; avatar: number; avatar_auto: string }>(
      `SELECT uid,v,avatar,avatar_auto FROM bbs_user WHERE uid IN (${uniq.map(() => '?').join(',')})`,
    )
    .bind(...uniq)
    .all();
  return new Map(
    r.results.map((u) => [
      Number(u.uid),
      { uv: String(u.v ?? '0'), avatarAuto: avatarAutoOf(Number(u.avatar), u.avatar_auto) },
    ]),
  );
}

/** 仅激活者随行下发字段（uv 认证头衔 / avatar_auto 预设头像），未激活不占带宽 */
function attachAuthorExtras<T extends ThreadListItem>(item: T, extra?: AuthorExtras): T {
  if (!extra) return item;
  return {
    ...item,
    ...(extra.uv !== '0' ? { uv: extra.uv } : {}),
    ...(extra.avatarAuto ? { avatar_auto: extra.avatarAuto } : {}),
  };
}

function toThreadItem(r: ThreadRow): ThreadListItem {
  return {
    tid: r.tid,
    fid: r.fid,
    top: r.top as ThreadListItem['top'],
    digest: r.digest as ThreadListItem['digest'],
    closed: r.closed as ThreadListItem['closed'],
    uid: r.uid,
    username: r.username,
    avatar: r.avatar,
    subject: r.subject,
    posts: r.posts,
    views: r.views,
    images: r.images,
    files: r.files,
    lastpid: r.lastpid,
    lastuid: r.lastuid,
    lastusername: r.lastusername,
    createDate: r.create_date,
    lastDate: r.last_date,
    ok: Number(r.ok),
    /** tt_credits：列表标题后购物车图标（>0 金色）；详情页图标按 purchased 上色 */
    contentBuy: Number(r.content_buy),
    contentBuyType: Number(r.content_buy_type),
    /** 简蓝主题标签（逗号分隔；空串不下发，前端据此零残留） */
    ...(r.tags ? { tags: String(r.tags) } : {}),
    /** 列表图片组（逗号分隔；空串不下发） */
    ...(r.image_urls ? { imageUrls: String(r.image_urls) } : {}),
    /** 列表摘要（首帖纯文本；空串不下发） */
    ...(r.summary ? { summary: String(r.summary) } : {}),
    /** 内容语言（空串不下发，前端据此零残留） */
    ...(r.lang ? { lang: String(r.lang) } : {}),
  };
}

/** 可读版块 fid 集合（首页聚合用；accesson 双与由 forumAccessUser 完成） */
function readableFids(ctx: AccessCtx, forumlist: Record<number, { fid: number }>): number[] {
  return Object.keys(forumlist)
    .map(Number)
    .filter((fid) => forumAccessUser(ctx, fid, 'allowread'));
}

async function queryThreadPage(
  db: D1b,
  opts: { fids: number[]; col: 'tid' | 'lastpid'; digest: boolean; before?: number; size: number; page?: number; tag?: string; lang?: string },
): Promise<ThreadRow[]> {
  if (!opts.fids.length) return [];
  const ph = opts.fids.map(() => '?').join(',');
  /* 标签筛选：反规范化列精确匹配，',tag,' 子串命中（tags 为空串时天然不命中） */
  const tagCond = opts.tag ? ` AND instr(','||tags||',', ?) > 0` : '';
  const tagParams = opts.tag ? [`,${opts.tag},`] : [];
  /* 内容语言筛选：等值命中（lang 为空串的存量帖不参与任何语言过滤，需先回填） */
  const langCond = opts.lang ? ' AND lang = ?' : '';
  const langParams = opts.lang ? [opts.lang] : [];
  // 编号分页器（?page=N）走浅层 OFFSET，与主题详情同一语义；游标 before_ 优先（无限滚动）。
  if (opts.before == null && (opts.page ?? 1) > 1) {
    const off = shallowOffset(opts.page!, opts.size);
    const sql =
      `SELECT ${THREAD_LIST_COLS} FROM ${T} WHERE fid IN (${ph}) ` +
      (opts.digest ? 'AND digest > 0 ' : '') +
      tagCond +
      langCond +
      ` ORDER BY ${opts.col} DESC ${off.sql}`;
    const r = await db.prepare<ThreadRow>(sql).bind(...opts.fids, ...tagParams, ...langParams, ...off.params).all();
    return r.results;
  }
  const cur = cursorCond({ column: opts.col, size: opts.size, before: opts.before, desc: true });
  const sql =
    `SELECT ${THREAD_LIST_COLS} FROM ${T} WHERE fid IN (${ph}) ${cur.where}` +
    (opts.digest ? ' AND digest > 0' : '') +
    tagCond +
    langCond +
    ` ${cur.order} LIMIT ?`;
  const r = await db
    .prepare<ThreadRow>(sql)
    .bind(...opts.fids, ...cur.params, ...tagParams, ...langParams, opts.size)
    .all();
  return r.results;
}

/** 置顶合并（§D.2）：首页并全局置顶 top=3；版块页并版块置顶 top∈1..2；语言筛选时置顶帖同样受语言约束 */
async function queryTopThreads(db: D1b, fid: number, readable: Set<number>, lang?: string): Promise<ThreadRow[]> {
  const cond = fid === 0 ? 'tt.top = 3' : 'tt.fid = ? AND tt.top BETWEEN 1 AND 2';
  const params: Array<number | string> = fid === 0 ? [] : [fid];
  const langCond = lang ? ' AND t.lang = ?' : '';
  if (lang) params.push(lang);
  const r = await db
    .prepare<ThreadRow>(
      `SELECT ${THREAD_LIST_COLS_T} FROM bbs_thread_top tt JOIN ${T} t ON t.tid = tt.tid
       WHERE ${cond}${langCond} ORDER BY tt.top DESC, t.tid DESC LIMIT 30`,
    )
    .bind(...params)
    .all();
  return r.results.filter((t) => fid === 0 || readable.has(t.fid));
}

/** 首页/版块页共用：置顶合并 + 游标翻页 + 权限过滤（同一条列表查询路径） */
async function threadListHandler(c: Context<ReadEnv>, fid: number) {
    const t = c.get('t');
    const { db, cache } = core(c);
    const digest = c.req.query('digest') === '1';
    const page = Math.max(1, intParam(c.req.query('page'), 1));

    const [forumlist, grouplist, viewer, setting] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
      loadSetting(cache, db),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const col =
      fid > 0
        ? orderCol(c.req.query('orderby'), forumlist[fid]?.orderby ?? 0)
        : orderCol(c.req.query('orderby'), Number(setting.forumOrderby) || 0);
    const before = intParam(c.req.query('before_' + col)) || undefined;
    const size = PageSize.THREAD_LIST;
    const readable = readableFids(ctx, forumlist);
    /* 标签筛选：?tag=标签名 —— 仅按名精确匹配，长度与字符做基础归一 */
    const tag = (c.req.query('tag') ?? '').trim().slice(0, 12) || undefined;
    /* 内容语言筛选：站点开关未开启时忽略参数（存量行为零变化）；?lang=all / 非法值 = 不过滤 */
    const lang = Number(setting.contentLang) > 0 ? normalizeContentLang(c.req.query('lang')) || undefined : undefined;

    const tasks: Promise<ThreadRow[]>[] = [];
    if (fid > 0) {
      if (!forumlist[fid]) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
      if (!readable.includes(fid)) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
      tasks.push(queryThreadPage(db, { fids: [fid], col, digest, before, size, page, tag, lang }));
    } else {
      tasks.push(queryThreadPage(db, { fids: readable, col, digest, before, size, page, tag, lang }));
    }
    if (page === 1 && !digest) tasks.push(queryTopThreads(db, fid, new Set(readable), lang));
    const results = await Promise.all(tasks);
    const normal = results[0] ?? [];
    const tops = results[1] ?? [];

    const merged = [...tops, ...normal.filter((t) => !tops.some((x) => x.tid === t.tid))];
    // 作者 V 头衔 + 预设头像按页批量一次补查（随行下发，仅激活者带字段）
    const extras = await fetchUserExtrasMap(db, merged.map((t) => Number(t.uid)));
    // 审核过滤（ok!=1 且非 see_check 组且非作者 → 剔除）
    const seeCheck = hasSeeCheck(grouplist[viewer.gid]);
    const list = threadListAccessFilter(ctx, merged)
      .filter((t) => canSeeUnapproved(Number(t.ok), { seeCheck, isAuthor: Number(t.uid) === viewer.uid }))
      .map((t) => attachAuthorExtras(toThreadItem(t), extras.get(Number(t.uid))));
    const total =
      fid > 0 ? forumlist[fid]?.threads ?? 0 : readable.reduce((s, f) => s + (forumlist[f]?.threads ?? 0), 0);
    return ok(c, 'ok', {
      data: {
        list,
        page,
        size,
        totalPage: totalPageOf(total, size),
        nextCursor: normal.at(-1)?.[col],
        // 游标列名（tid | lastpid，随 orderby/setting 变）：前端须据此拼 before_<cursorCol>，否则深翻失效
        cursorCol: col,
        ...(fid > 0 && forumlist[fid]
          ? {
              forum: {
                fid: forumlist[fid].fid,
                name: forumlist[fid].name,
                brief: forumlist[fid].brief,
                moduids: forumlist[fid].moduids,
                icon: forumlist[fid].icon,
                iconUrl: forumlist[fid].icon_url,
                announcement: forumlist[fid].announcement,
                threads: forumlist[fid].threads,
                todayposts: forumlist[fid].todayposts,
                todaythreads: forumlist[fid].todaythreads,
              },
            }
          : {}),
      },
    });
}

/** LIKE 通配转义（%/_/\ 前置反斜杠），配合查询端 ESCAPE '\' 使用 */
const likeOf = (s: string): string => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** light 主题扩展启用判定：热门回复端点随主题插件启停（停用即前后端一致零残留） */
async function lightOn(cache: Cache, db: D1b): Promise<boolean> {
  const st = await loadExtensionsState(cache, db);
  return isEnabled(lightPlugin.manifest, st);
}

/** 搜索正文摘要：去标签 + 压缩空白 + 120 字截断（前端再按关键词高亮） */
function searchSnippet(raw: string | null | undefined): string | undefined {
  const text = String(raw ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  const chars = [...text];
  return chars.length > 120 ? `${chars.slice(0, 120).join('')}…` : text;
}

export function threadRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/threads', (c) => threadListHandler(c, intParam(c.req.query('fid'), 0)));

  app.get('/api/forums/:fid/threads', (c) => threadListHandler(c, intParam(c.req.param('fid'))));

  /**
   * 站内搜索（页头搜索框落点，idx_search）：range=thread（默认，仅标题）| all（标题+正文）| user（用户名）。
   * 限当前用户组可读版块、浅分页；关键词高亮由前台按 keyword 包裹（后端不注入 HTML）。
   */
  app.get('/api/search', async (c) => {
    const { db, cache } = core(c);
    const q = (c.req.query('q') ?? '').trim().slice(0, 64);
    const rangeRaw = c.req.query('range');
    const range = rangeRaw === 'all' || rangeRaw === 'user' ? rangeRaw : 'thread';
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = PageSize.USER_THREAD_LIST;

    const [forumlist, grouplist, viewer, setting] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
      loadSetting(cache, db),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const readable = readableFids(ctx, forumlist);
    /* 内容语言筛选：与列表同一口径（站点未开启时忽略参数；all/非法值 = 不过滤） */
    const lang = Number(setting.contentLang) > 0 ? normalizeContentLang(c.req.query('lang')) || undefined : undefined;
    const empty = { keyword: q, range, list: [] as ThreadListItem[], users: [] as SearchUserHit[], page, size, total: 0, totalPage: 1 };
    if (!q) return ok(c, 'ok', { data: empty });
    const like = likeOf(q);
    // 多关键词（空白分隔，≤4 个）AND 匹配；标题/正文范围共用
    const termLikes = q.split(/\s+/).filter(Boolean).slice(0, 4).map(likeOf);

    // range=user：按用户名模糊匹配（idx_search 的「用户」范围；公开字段零敏感）
    if (range === 'user') {
      const off = shallowOffset(page, size);
      const [cnt, r] = await Promise.all([
        db
          .prepare<{ c: number }>("SELECT COUNT(*) AS c FROM bbs_user WHERE username LIKE ? ESCAPE '\\'")
          .bind(like)
          .first<{ c: number }>(),
        db
          .prepare<{ uid: number; username: string; avatar: number; avatar_auto: string | null }>(
            "SELECT uid,username,avatar,avatar_auto FROM bbs_user WHERE username LIKE ? ESCAPE '\\' ORDER BY uid DESC " + off.sql,
          )
          .bind(like, ...off.params)
          .all(),
      ]);
      const total = Number(cnt?.c ?? 0);
      const users: SearchUserHit[] = r.results.map((u) => {
        const auto = avatarAutoOf(Number(u.avatar), u.avatar_auto);
        return {
          uid: Number(u.uid),
          username: String(u.username),
          avatar: Number(u.avatar),
          ...(auto ? { avatar_auto: auto } : {}),
        };
      });
      return ok(c, 'ok', { data: { ...empty, users, total, totalPage: totalPageOf(total, size) } });
    }

    if (!readable.length) return ok(c, 'ok', { data: empty });
    const seeCheck = hasSeeCheck(grouplist[viewer.gid]);
    // 多关键词 AND：range=all 每词可命中标题或任意楼层正文；range=thread 仅标题
    const conds: string[] = [];
    const matchParams: string[] = [];
    for (const lk of termLikes) {
      if (range === 'all') {
        // 楼层正文匹配须过审（p.ok=1）：待审/回收楼层正文不得被搜索命中（审核可见性口径与主题级 canSeeUnapproved 对齐）
        conds.push(
          `(subject LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM ${P} p WHERE p.tid = ${T}.tid AND p.ok = 1 AND p.message LIKE ? ESCAPE '\\'))`,
        );
        matchParams.push(lk, lk);
      } else {
        conds.push(`subject LIKE ? ESCAPE '\\'`);
        matchParams.push(lk);
      }
    }
    const match = conds.length ? `(${conds.join(' AND ')})` : '1=0';
    const langCond = lang ? ' AND lang = ?' : '';
    const langParams = lang ? [lang] : [];
    const where = `WHERE ${match} AND fid IN (${readable.map(() => '?').join(',')})${langCond}`;
    const cnt = await db
      .prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM ${T} ${where}`)
      .bind(...matchParams, ...readable, ...langParams)
      .first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const off = shallowOffset(page, size);
    // range=all 追加命中正文摘要（相关子查询取首个命中楼层的 message_fmt，随行下发，前端高亮；仅取已过审楼层）
    const snippetSql =
      range === 'all' && termLikes.length
        ? `, (SELECT p.message_fmt FROM ${P} p WHERE p.tid = ${T}.tid AND p.ok = 1 AND p.message LIKE ? ESCAPE '\\' ORDER BY p.pid ASC LIMIT 1) AS snippet_raw`
        : '';
    const r = await db
      .prepare<ThreadRow & { snippet_raw?: string | null }>(
        `SELECT ${THREAD_LIST_COLS}${snippetSql} FROM ${T} ${where} ORDER BY tid DESC ${off.sql}`,
      )
      .bind(...(snippetSql ? [termLikes[0]] : []), ...matchParams, ...readable, ...langParams, ...off.params)
      .all();

    // 作者 V 头衔 + 预设头像按页批量一次补查（随行下发，仅激活者带字段）
    const extras = await fetchUserExtrasMap(db, r.results.map((t) => Number(t.uid)));
    return ok(c, 'ok', {
      data: {
        keyword: q,
        range,
        list: threadListAccessFilter(ctx, r.results)
          .filter((t) => canSeeUnapproved(Number(t.ok), { seeCheck, isAuthor: Number(t.uid) === viewer.uid }))
          .map((t) => {
            const item = attachAuthorExtras(toThreadItem(t), extras.get(Number(t.uid)));
            // 摘要可能命中付费段：搜索场景一律剥离段内正文（爬虫/游客均可读）
            const snippet = searchSnippet(redactPaidBlocks((t as ThreadRow & { snippet_raw?: string | null }).snippet_raw ?? ''));
            return snippet ? { ...item, snippet } : item;
          }),
        users: [] as SearchUserHit[],
        page,
        size,
        total,
        totalPage: totalPageOf(total, size),
      },
    });
  });

  app.get('/api/threads/:tid', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const tid = intParam(c.req.param('tid'));
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const keyword = c.req.query('keyword') ?? '';
    const size = PageSize.POST_PAGE;

    const [forumlist, grouplist, viewer, setting] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
      loadSetting(cache, db),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);

    const thread = await db
      .prepare<ThreadDetailRow>(`SELECT ${THREAD_DETAIL_COLS} FROM ${T} WHERE tid = ?`)
      .bind(tid)
      .first<ThreadDetailRow>();
    if (!thread) throw new AppError(Code.NOT_FOUND, t('common.threadNotFoundOrDeleted'));
    const forum = forumlist[thread.fid];
    if (!forum || !forumAccessUser(ctx, thread.fid, 'allowread'))
      throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
    // 审核可见性（ok!=1 且非 see_check 组且非作者 → 拒绝访问）
    const seeCheck = hasSeeCheck(grouplist[viewer.gid]);
    if (!canSeeUnapproved(Number(thread.ok), { seeCheck, isAuthor: Number(thread.uid) === viewer.uid })) {
      throw new AppError(
        Code.NO_PERMISSION,
        Number(thread.ok) === -2
          ? t('thread.recycleDenied')
          : Number(thread.ok) === -1
            ? t('thread.rejectedDenied')
            : t('thread.pendingDenied'),
      );
    }

    // 点赞/收藏计数 + 当前访问者态（A4/A5，bbs_like/bbs_favorite 实时 COUNT）
    const [likeCnt, favCnt, likedRow, favRow] = await Promise.all([
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_like WHERE tid = ?').bind(tid).first<{ c: number }>(),
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_favorite WHERE tid = ?').bind(tid).first<{ c: number }>(),
      viewer.uid > 0
        ? db.prepare<{ x: number }>('SELECT 1 AS x FROM bbs_like WHERE uid = ? AND tid = ?').bind(viewer.uid, tid).first<{ x: number }>()
        : Promise.resolve(null),
      viewer.uid > 0
        ? db.prepare<{ x: number }>('SELECT 1 AS x FROM bbs_favorite WHERE uid = ? AND tid = ?').bind(viewer.uid, tid).first<{ x: number }>()
        : Promise.resolve(null),
    ]);

    const off = shallowOffset(page, size);
    const postsR = await db
      .prepare<PostRow>(`SELECT ${POST_PAGE_COLS} FROM ${P} WHERE tid = ? ORDER BY pid ASC ${off.sql}`)
      .bind(tid, ...off.params)
      .all();
    // 回帖审核过滤（ok!=1 且非 see_check 组且非作者 → 剔除）
    const posts = postsR.results.filter((p) =>
      canSeeUnapproved(Number(p.ok), { seeCheck, isAuthor: Number(p.uid) === viewer.uid }),
    );
    const pids = posts.map((p) => p.pid);

    // 楼层点赞：一次 IN 批量取「各 pid 计数」+「当前访问者已赞集合」（§7 禁 N+1）
    const postLikeCount = new Map<number, number>();
    const postLikedSet = new Set<number>();
    if (pids.length) {
      const inList = pids.map(() => '?').join(',');
      const [cntR, mineR] = await Promise.all([
        db
          .prepare<{ pid: number; c: number }>(`SELECT pid, COUNT(*) AS c FROM bbs_post_like WHERE pid IN (${inList}) GROUP BY pid`)
          .bind(...pids)
          .all(),
        viewer.uid > 0
          ? db
              .prepare<{ pid: number }>(`SELECT pid FROM bbs_post_like WHERE uid = ? AND pid IN (${inList})`)
              .bind(viewer.uid, ...pids)
              .all()
          : Promise.resolve(null),
      ]);
      for (const r of cntR.results) postLikeCount.set(Number(r.pid), Number(r.c));
      for (const r of mineR?.results ?? []) postLikedSet.add(Number(r.pid));
    }

    // 付费主题可见性：
    // purchased 默认 '1'（content_buy=0 或首帖无 [ttPay] 付费段时视为无需购买）；
    // content_buy>0 且存在付费段时，仅作者本人 / paylist type=1 已购者可见。
    // 未购时服务端清空段内正文（仅保留空标记供前台渲染价格/购买按钮），防止直连 API 绕过付费墙。
    const firstFmt = posts.find((p) => p.isfirst === 1)?.message_fmt ?? '';
    const hasPayBlocks = /\[ttPay\][\s\S]*?\[\/ttPay\]/i.test(firstFmt);
    let purchased = true;
    if (Number(thread.content_buy) > 0 && hasPayBlocks) {
      const paid =
        viewer.uid > 0
          ? await db
              .prepare<{ x: number }>('SELECT 1 AS x FROM bbs_paylist WHERE tid = ? AND uid = ? AND type = 1')
              .bind(tid, viewer.uid)
              .first<{ x: number }>()
          : null;
      purchased = Boolean(paid) || (viewer.uid > 0 && Number(thread.uid) === viewer.uid);
    }

    // 附件一次 IN；回帖作者 + 引用作者一次 IN（§7 禁 N+1）
    const attachR = pids.length
      ? await db
          .prepare<AttachRow>(
            // 刻意不取 filename（R2 key）：详情不下发对象 key，防 `/files/attach/*` 匿名直取绕过付费/权限校验
            `SELECT aid,pid,orgfilename,filesize,isimage,width,height,downloads,create_date,credits FROM bbs_attach WHERE pid IN (${pids.map(() => '?').join(',')}) ORDER BY aid ASC`,
          )
          .bind(...pids)
          .all()
      : null;
    const attachesByPid = new Map<number, AttachItem[]>();
    for (const a of attachR?.results ?? []) {
      const item: AttachItem = {
        aid: a.aid,
        tid: thread.tid,
        pid: a.pid,
        orgfilename: a.orgfilename,
        filesize: a.filesize,
        isimage: a.isimage,
        width: a.width,
        height: a.height,
        downloads: a.downloads,
        createDate: a.create_date,
        credits: a.credits,
      };
      const list = attachesByPid.get(a.pid) ?? [];
      list.push(item);
      attachesByPid.set(a.pid, list);
    }

    const quotePids = [...new Set(posts.map((p) => p.quotepid).filter((q) => q > 0))];
    const quotedR = quotePids.length
      ? await db
          .prepare<{ pid: number; uid: number; message_fmt: string }>(
            `SELECT pid,uid,message_fmt FROM ${P} WHERE pid IN (${quotePids.map(() => '?').join(',')})`,
          )
          .bind(...quotePids)
          .all()
      : null;

    // 回帖作者 + 引用作者 + 主题作者（th 头部头像用）一次 IN（§7 禁 N+1）；同查询带出 V 头衔与预设头像
    const uids = [...new Set([Number(thread.uid), ...posts.map((p) => p.uid), ...(quotedR?.results ?? []).map((q) => q.uid)])];
    const usersMap = new Map<number, { username: string; avatar: number; uv: string; avatarAuto: string }>();
    if (uids.length) {
      const users = await db
        .prepare<{ uid: number; username: string; avatar: number; v: string; avatar_auto: string }>(
          `SELECT uid,username,avatar,v,avatar_auto FROM bbs_user WHERE uid IN (${uids.map(() => '?').join(',')})`,
        )
        .bind(...uids)
        .all();
      for (const u of users.results) {
        usersMap.set(u.uid, {
          username: u.username,
          avatar: u.avatar,
          uv: String(u.v ?? '0'),
          avatarAuto: avatarAutoOf(Number(u.avatar), u.avatar_auto),
        });
      }
    }

    const allowViewIp = !!grouplist[viewer.gid]?.allowviewip;
    const postsOut = posts.map((p) => {
      const author = usersMap.get(p.uid);
      const quote = quotedR?.results.find((q) => q.pid === p.quotepid);
      const canUpd = canUpdatePost(ctx, thread.fid, p.uid);
      return {
        pid: p.pid,
        tid: p.tid,
        uid: p.uid,
        username: p.isfirst ? thread.username : (author?.username ?? ''),
        avatar: p.isfirst ? thread.avatar : (author?.avatar ?? 0),
        /** 作者 V 头衔（'0'=未认证；仅认证作者下发） */
        ...((author?.uv ?? '0') !== '0' ? { v: author!.uv } : {}),
        /** 作者预设头像路径（仅生效者下发） */
        ...(author?.avatarAuto ? { avatar_auto: author.avatarAuto } : {}),
        isfirst: p.isfirst,
        doctype: p.doctype,
        quotepid: p.quotepid,
        // 原文仅对有编辑权的人下发（对读者剥离 message，只给 message_fmt）
        ...(canUpd ? { message: p.message } : {}),
        messageFmt: highlight(
          p.isfirst === 1 && !purchased ? redactPaidBlocks(p.message_fmt ?? '', true) : (p.message_fmt ?? ''),
          keyword,
        ),
        images: p.images,
        files: p.files,
        ...(allowViewIp ? { userip: p.userip } : {}),
        createDate: p.create_date,
        ok: Number(p.ok),
        allowupdate: canUpd,
        allowdelete: canDeletePost(ctx, thread.fid, p.uid),
        likes: postLikeCount.get(p.pid) ?? 0,
        liked: postLikedSet.has(p.pid),
        attaches: attachesByPid.get(p.pid) ?? [],
        ...(quote
          ? {
              quoted: {
                pid: quote.pid,
                username: usersMap.get(quote.uid)?.username ?? '',
                messageSnippet: quote.message_fmt.replace(/<[^>]*>/g, '').slice(0, 80),
              },
            }
          : {}),
      };
    });

    // 「上一篇/下一篇」（thread_postlist_before 位）：同版块按 tid 邻接各取一条
    // （UNION ALL 单语句取两条，省一次 D1 往返；
    //   是否渲染由前台按 light.preNextThread 开关决定）
    const neighborsR = await db
      .prepare<{ tid: number; subject: string }>(
        `SELECT tid,subject FROM (SELECT tid,subject FROM ${T} WHERE fid = ? AND tid < ? ORDER BY tid DESC LIMIT 1)
         UNION ALL
         SELECT tid,subject FROM (SELECT tid,subject FROM ${T} WHERE fid = ? AND tid > ? ORDER BY tid ASC LIMIT 1)`,
      )
      .bind(thread.fid, tid, thread.fid, tid)
      .all();
    const prevRow = neighborsR.results.find((r) => r.tid < tid) ?? null;
    const nextRow = neighborsR.results.find((r) => r.tid > tid) ?? null;

    // 浏览量异步自增（waitUntil 不占响应路径；受 update_views_on 开关控制）
    if (page === 1 && setting.updateViewsOn) {
      // 虚拟点击：插件启用时增量 = ceil(倍数)；未启用/未配置/倍数 ≤0 按 1
      let step = 1;
      const extState = await loadExtensionsState(cache, db);
      if (isEnabled(IDX_MANIFEST, extState)) {
        const cfg = await loadExtConfig(cache, db, IDX_EXT_ID);
        const beishu = Number(cfg.beishu);
        if (Number.isFinite(beishu) && beishu > 0) step = Math.max(1, Math.ceil(beishu));
      }
      const p = db
        .prepare(`UPDATE ${T} SET views = views + ? WHERE tid = ?`)
        .bind(step, tid)
        .run()
        .catch(() => undefined); // 浏览量统计失败不影响读路径（best-effort）
      let deferred = false;
      try {
        const ex = (c as unknown as { executionCtx: { waitUntil?: (pr: Promise<unknown>) => void } }).executionCtx;
        if (ex.waitUntil) {
          ex.waitUntil(p);
          deferred = true;
        }
      } catch {
        // 非 Workers 运行环境（本地 node 测试）无 ExecutionContext，直接旁路丢弃
      }
      if (!deferred) void p;
    }

    const detail: ThreadDetail = {
      // 主题作者 V 头衔 + 预设头像随行下发（同 usersMap 一次 IN 查询的结果）
      thread: attachAuthorExtras(toThreadItem(thread), usersMap.get(Number(thread.uid))),
      forum: { fid: forum.fid, name: forum.name, moduids: forum.moduids },
      posts: { list: postsOut as ThreadDetail['posts']['list'], page, totalPage: totalPageOf(thread.posts + 1, size) },
      perms: {
        // closed 帖仅版务可回（叠加版务权限）；close/digest 复用 allowtop（§D.8#1）
        allowpost: forumAccessUser(ctx, thread.fid, 'allowpost') && (!thread.closed || forumAccessMod(ctx, thread.fid, 'allowtop')),
        allowupdate: canUpdatePost(ctx, thread.fid, thread.uid),
        allowdelete: canDeletePost(ctx, thread.fid, thread.uid),
        allowmod: forumAccessMod(ctx, thread.fid, 'allowtop'),
        // tt_check see_check：可见他人未过审内容并在帖内现场审核（前端据此渲染审核按钮）
        seeCheck,
      },
      likes: Number(likeCnt?.c ?? 0),
      liked: Boolean(likedRow),
      favorites: Number(favCnt?.c ?? 0),
      favorited: Boolean(favRow),
      /** tt_credits：付费内容可见（作者/已购/无付费段；前台据此渲染绿块/标题购物车图标） */
      purchased,
      /** 上一篇/下一篇（同版块 tid 邻接；无则 null） */
      prev: prevRow ? { tid: prevRow.tid, subject: prevRow.subject } : null,
      next: nextRow ? { tid: nextRow.tid, subject: nextRow.subject } : null,
    };
    return ok(c, 'ok', { data: detail });
  });

  /**
   * GET /api/posts/:pid/replies：某楼层（pid）的全部直接回复（quotepid=pid，按时间升序、每页 20）。
   *  head 为该楼层本身。限可读版块；审核位过滤同帖内口径。
   */
  app.get('/api/posts/:pid/replies', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const pid = intParam(c.req.param('pid'));
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = PageSize.POST_PAGE;
    const [forumlist, grouplist, viewer] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const head = await db
      .prepare<{ pid: number; uid: number; create_date: number; message_fmt: string; fid: number; pok: number; tok: number; tuid: number }>(
        `SELECT p.pid,p.uid,p.create_date,p.message_fmt,p.ok AS pok,t.fid AS fid,t.ok AS tok,t.uid AS tuid FROM ${P} p INNER JOIN ${T} t ON t.tid = p.tid WHERE p.pid = ?`,
      )
      .bind(pid)
      .first<{ pid: number; uid: number; create_date: number; message_fmt: string; fid: number; pok: number; tok: number; tuid: number }>();
    if (!head) throw new AppError(Code.NOT_FOUND, t('common.postNotFound'));
    if (!forumAccessUser(ctx, Number(head.fid), 'allowread')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
    const seeCheck = hasSeeCheck(grouplist[viewer.gid]);
    // head 楼层与所属主题均须过审（或访问者为版务/作者）：否则待审/回收站内容可借本端点 head 字段泄露
    // （口径与帖内楼层列表的 canSeeUnapproved 一致；主题不可见时整端点 404）。
    const threadVisible = canSeeUnapproved(Number(head.tok), { seeCheck, isAuthor: Number(head.tuid) === viewer.uid });
    if (!threadVisible || !canSeeUnapproved(Number(head.pok), { seeCheck, isAuthor: Number(head.uid) === viewer.uid })) {
      throw new AppError(Code.NOT_FOUND, t('common.postNotFound'));
    }
    const off = shallowOffset(page, size);
    const [cnt, r] = await Promise.all([
      db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM ${P} WHERE quotepid = ?`).bind(pid).first<{ c: number }>(),
      db
        .prepare<{ pid: number; uid: number; create_date: number; message_fmt: string; ok: number }>(
          `SELECT pid,uid,create_date,message_fmt,ok FROM ${P} WHERE quotepid = ? ORDER BY create_date ASC ${off.sql}`,
        )
        .bind(pid, ...off.params)
        .all(),
    ]);
    const total = Number(cnt?.c ?? 0);
    const rows = r.results.filter(
      (x) => canSeeUnapproved(Number(x.ok), { seeCheck, isAuthor: Number(x.uid) === viewer.uid }) && threadVisible,
    );
    const uids = [...new Set([Number(head.uid), ...rows.map((x) => Number(x.uid))])];
    const usersMap = new Map<number, { username: string; avatar: number; avatarAuto: string }>();
    if (uids.length) {
      const users = await db
        .prepare<{ uid: number; username: string; avatar: number; avatar_auto: string }>(
          `SELECT uid,username,avatar,avatar_auto FROM bbs_user WHERE uid IN (${uids.map(() => '?').join(',')})`,
        )
        .bind(...uids)
        .all();
      for (const u of users.results) {
        usersMap.set(Number(u.uid), {
          username: u.username,
          avatar: Number(u.avatar),
          avatarAuto: avatarAutoOf(Number(u.avatar), u.avatar_auto),
        });
      }
    }
    const toItem = (pidV: number, uid: number, createDate: number, messageFmt: string): PostReplyItem => {
      const u = usersMap.get(uid);
      return {
        pid: pidV,
        uid,
        username: u?.username ?? '',
        avatar: u?.avatar ?? 0,
        ...(u?.avatarAuto ? { avatar_auto: u.avatarAuto } : {}),
        createDate,
        messageFmt,
      };
    };
    return ok(c, 'ok', {
      data: {
        head: toItem(Number(head.pid), Number(head.uid), Number(head.create_date), String(head.message_fmt ?? '')),
        list: rows.map((x) => toItem(Number(x.pid), Number(x.uid), Number(x.create_date), String(x.message_fmt ?? ''))),
        page,
        size,
        total,
        totalPage: totalPageOf(total, size),
      },
    });
  });

  /** GET /api/threads/:tid/favoriters：收藏者列表（按收藏时间倒序，≤50 人） */
  app.get('/api/threads/:tid/favoriters', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const tid = intParam(c.req.param('tid'));
    // 可见性口径与收藏 toggle / 其它读路径一致：无权版块与未过审/回收站主题的收藏者不可查，
    // 否则可借本端点探测不可见主题存在性、并泄露私密版块主题的收藏者社交关系。
    const [forumlist, grouplist, viewer] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const th = await db
      .prepare<{ fid: number; ok: number; uid: number }>(`SELECT fid,ok,uid FROM ${T} WHERE tid = ?`)
      .bind(tid)
      .first<{ fid: number; ok: number; uid: number }>();
    if (!th) throw new AppError(Code.NOT_FOUND, t('common.threadNotFoundOrDeleted'));
    if (!forumAccessUser(ctx, Number(th.fid), 'allowread')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
    const seeCheck = hasSeeCheck(grouplist[viewer.gid]);
    if (!canSeeUnapproved(Number(th.ok), { seeCheck, isAuthor: Number(th.uid) === viewer.uid })) {
      throw new AppError(Code.NOT_FOUND, t('common.threadNotFoundOrDeleted'));
    }
    const [r, cnt] = await Promise.all([
      db
        .prepare<{ uid: number; username: string; avatar: number }>(
          'SELECT u.uid,u.username,u.avatar FROM bbs_favorite f JOIN bbs_user u ON u.uid = f.uid WHERE f.tid = ? ORDER BY f.create_date DESC LIMIT 50',
        )
        .bind(tid)
        .all(),
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_favorite WHERE tid = ?').bind(tid).first<{ c: number }>(),
    ]);
    const list: FavoriterItem[] = r.results.map((u) => ({ uid: u.uid, username: u.username, avatar: u.avatar }));
    return ok(c, 'ok', { data: { list, total: Number(cnt?.c ?? 0) } });
  });

  /** POST /api/threads/:tid/like：点赞/取消赞 toggle（登录态，bbs_like 唯一键防重） */
  app.post('/api/threads/:tid/like', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const viewer = await loadViewer(cache, db, c);
    if (viewer.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
    const tid = intParam(c.req.param('tid'));
    // 可见性口径与收藏 toggle 一致（防借点赞成功与否反查探测不可见主题）
    const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const th = await db
      .prepare<{ fid: number; ok: number; uid: number }>(`SELECT fid,ok,uid FROM ${T} WHERE tid = ?`)
      .bind(tid)
      .first<{ fid: number; ok: number; uid: number }>();
    if (!th) throw new AppError(Code.NOT_FOUND, t('common.threadNotFoundOrDeleted'));
    if (!forumAccessUser(ctx, Number(th.fid), 'allowread')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
    const seeCheck = hasSeeCheck(grouplist[viewer.gid]);
    if (!canSeeUnapproved(Number(th.ok), { seeCheck, isAuthor: Number(th.uid) === viewer.uid })) {
      throw new AppError(Code.NOT_FOUND, t('common.threadNotFoundOrDeleted'));
    }
    let existing = await db
      .prepare<{ uid: number }>('SELECT uid FROM bbs_like WHERE uid = ? AND tid = ?')
      .bind(viewer.uid, tid)
      .first<{ uid: number }>();
    if (existing) {
      await db.batch([db.prepare('DELETE FROM bbs_like WHERE uid = ? AND tid = ?').bind(viewer.uid, tid) as unknown as Stmt]);
    } else {
      try {
        await db.prepare('INSERT INTO bbs_like (uid, tid, create_date) VALUES (?, ?, ?)').bind(viewer.uid, tid, now()).run();
      } catch (e) {
        // 并发双击：两请求都查到「未赞」，第二个撞唯一约束 → 按已点赞幂等成功（不 500、不误取消）
        const msg = e instanceof Error ? e.message : String(e);
        if (!/UNIQUE constraint failed/i.test(msg)) throw e;
        existing = { uid: viewer.uid };
      }
    }
    const cnt = await db
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_like WHERE tid = ?')
      .bind(tid)
      .first<{ c: number }>();
    return ok(c, existing ? t('thread.likeCancelled') : t('thread.liked'), { data: { likes: Number(cnt?.c ?? 0), liked: !existing } });
  });

  /**
   * POST /api/posts/:pid/like：楼层点赞/取消赞 toggle（bbs_post_like 唯一键防重）。
   *  和主题点赞（bbs_like）独立；返回该楼层最新点赞数与当前访问者态。
   *  可见性口径同帖内楼层列表：版块 allowread + 主题/楼层审核位（版务与作者可见待审）。
   */
  app.post('/api/posts/:pid/like', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const viewer = await loadViewer(cache, db, c);
    if (viewer.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
    if (!(await lightOn(cache, db))) throw new AppError(Code.NOT_FOUND, t('light.featureDisabled'));
    const pid = intParam(c.req.param('pid'));
    const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const post = await db
      .prepare<{ pid: number; tid: number; pok: number; puid: number; fid: number; tok: number; tuid: number }>(
        `SELECT p.pid,p.tid,p.ok AS pok,p.uid,t.fid,t.ok AS tok,t.uid AS tuid FROM ${P} p INNER JOIN ${T} t ON t.tid = p.tid WHERE p.pid = ?`,
      )
      .bind(pid)
      .first<{ pid: number; tid: number; pok: number; puid: number; fid: number; tok: number; tuid: number }>();
    if (!post) throw new AppError(Code.NOT_FOUND, t('common.postNotFound'));
    if (!forumAccessUser(ctx, Number(post.fid), 'allowread')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
    const seeCheck = hasSeeCheck(grouplist[viewer.gid]);
    const threadVisible = canSeeUnapproved(Number(post.tok), { seeCheck, isAuthor: Number(post.tuid) === viewer.uid });
    const postVisible = canSeeUnapproved(Number(post.pok), { seeCheck, isAuthor: Number(post.puid) === viewer.uid });
    if (!threadVisible || !postVisible) throw new AppError(Code.NOT_FOUND, t('common.postNotFound'));
    let existing = await db
      .prepare<{ uid: number }>('SELECT uid FROM bbs_post_like WHERE uid = ? AND pid = ?')
      .bind(viewer.uid, pid)
      .first<{ uid: number }>();
    if (existing) {
      await db.batch([db.prepare('DELETE FROM bbs_post_like WHERE uid = ? AND pid = ?').bind(viewer.uid, pid) as unknown as Stmt]);
    } else {
      try {
        await db
          .prepare('INSERT INTO bbs_post_like (uid,pid,tid,create_date) VALUES (?,?,?,?)')
          .bind(viewer.uid, pid, Number(post.tid), now())
          .run();
      } catch (e) {
        // 并发双击撞唯一约束 → 按已点赞幂等成功（同主题点赞口径）
        const msg = e instanceof Error ? e.message : String(e);
        if (!/UNIQUE constraint failed/i.test(msg)) throw e;
        existing = { uid: viewer.uid };
      }
    }
    const cnt = await db
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_post_like WHERE pid = ?')
      .bind(pid)
      .first<{ c: number }>();
    return ok(c, existing ? t('thread.likeCancelled') : t('thread.liked'), { data: { likes: Number(cnt?.c ?? 0), liked: !existing } });
  });


  /**
   * GET /api/threads/:tid/hot-posts?limit=&threshold=&includeFirst=
   *  帖子内「热门回复」卡：同帖点赞数 ≥ 阈值的回复，按点赞数倒序取 N 条；
   *  默认剔除主贴（hot_like_isfirst=0），第 1 页展示；版块可读性与审核位过滤同帖内口径。
   */
  app.get('/api/threads/:tid/hot-posts', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    if (!(await lightOn(cache, db))) throw new AppError(Code.NOT_FOUND, t('light.featureDisabled'));
    const tid = intParam(c.req.param('tid'));
    const limit = Math.min(50, Math.max(1, intParam(c.req.query('limit'), 5)));
    const threshold = Math.min(999, Math.max(1, intParam(c.req.query('threshold'), 10)));
    const includeFirst = c.req.query('includeFirst') === '1';
    const [forumlist, grouplist, viewer] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const th = await db
      .prepare<{ fid: number }>('SELECT fid FROM bbs_thread WHERE tid = ?')
      .bind(tid)
      .first<{ fid: number }>();
    if (!th) throw new AppError(Code.NOT_FOUND, t('common.threadNotFoundOrDeleted'));
    if (!forumAccessUser(ctx, Number(th.fid), 'allowread')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
    const seeCheck = hasSeeCheck(grouplist[viewer.gid]);
    const r = await db
      .prepare<{
        pid: number;
        uid: number;
        isfirst: number;
        doctype: number;
        quotepid: number;
        images: number;
        files: number;
        message_fmt: string | null;
        create_date: number;
        ok: number;
        likes: number;
      }>(
        `SELECT p.pid,p.uid,p.isfirst,p.doctype,p.quotepid,p.images,p.files,p.message_fmt,p.create_date,p.ok,COUNT(pl.uid) AS likes
         FROM ${P} p JOIN bbs_post_like pl ON pl.pid = p.pid
         WHERE p.tid = ?${includeFirst ? '' : ' AND p.isfirst = 0'}
         GROUP BY p.pid HAVING likes >= ?
         ORDER BY likes DESC, p.create_date DESC LIMIT ?`,
      )
      .bind(tid, threshold, limit)
      .all();
    const rows = r.results.filter((x) =>
      canSeeUnapproved(Number(x.ok), { seeCheck, isAuthor: Number(x.uid) === viewer.uid }),
    );
    const uids = [...new Set(rows.map((x) => Number(x.uid)))];
    // 当前访问者已赞集合（登录态；一次 IN 批量）
    const likedPids = new Set<number>();
    if (viewer.uid > 0 && rows.length) {
      const pids = rows.map((x) => Number(x.pid));
      const mine = await db
        .prepare<{ pid: number }>(`SELECT pid FROM bbs_post_like WHERE uid = ? AND pid IN (${pids.map(() => '?').join(',')})`)
        .bind(viewer.uid, ...pids)
        .all();
      for (const m of mine.results) likedPids.add(Number(m.pid));
    }
    const uMap = new Map<number, { username: string; avatar: number; uv: string; avatarAuto: string }>();
    if (uids.length) {
      const us = await db
        .prepare<{ uid: number; username: string; avatar: number; v: string; avatar_auto: string }>(
          `SELECT uid,username,avatar,v,avatar_auto FROM bbs_user WHERE uid IN (${uids.map(() => '?').join(',')})`,
        )
        .bind(...uids)
        .all();
      for (const u of us.results) {
        uMap.set(Number(u.uid), {
          username: String(u.username),
          avatar: Number(u.avatar),
          uv: String(u.v ?? '0'),
          avatarAuto: avatarAutoOf(Number(u.avatar), u.avatar_auto),
        });
      }
    }
    const list: PostItem[] = rows.map((x) => {
      const u = uMap.get(Number(x.uid));
      return {
        pid: Number(x.pid),
        tid,
        uid: Number(x.uid),
        username: u?.username ?? '',
        avatar: u?.avatar ?? 0,
        ...((u?.uv ?? '0') !== '0' ? { v: u!.uv } : {}),
        ...(u?.avatarAuto ? { avatar_auto: u.avatarAuto } : {}),
        isfirst: Number(x.isfirst) as PostItem['isfirst'],
        doctype: Number(x.doctype) as PostItem['doctype'],
        quotepid: Number(x.quotepid),
        messageFmt: String(x.message_fmt ?? ''),
        images: Number(x.images),
        files: Number(x.files),
        createDate: Number(x.create_date),
        ok: Number(x.ok),
        allowupdate: false,
        allowdelete: false,
        likes: Number(x.likes),
        liked: likedPids.has(Number(x.pid)),
      };
    });
    return ok(c, 'ok', { data: { list, threshold, limit } });
  });

  /**
   * GET /api/threads/hot-favorites?days=&limit=：热门收藏（窗口内收藏数倒序）
   * 统计窗口内（默认 30 天）按收藏数倒序；仅已过审主题；版块可读性按统一口径过滤。
   */
  app.get('/api/threads/hot-favorites', async (c) => {
    const { db, cache } = core(c);
    const [forumlist, grouplist, viewer] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const days = Math.min(365, Math.max(1, intParam(c.req.query('days'), 30)));
    const limit = Math.min(50, Math.max(1, intParam(c.req.query('limit'), 10)));
    const since = now() - days * 86400;
    const r = await db
      .prepare<{ tid: number; subject: string; fid: number; top: number; favorites: number }>(
        `SELECT t.tid, t.subject, t.fid, t.top, COUNT(*) AS favorites
         FROM bbs_favorite f INNER JOIN ${T} t ON t.tid = f.tid
         WHERE t.ok = 1 AND f.create_date >= ?
         GROUP BY t.tid ORDER BY favorites DESC, t.tid DESC LIMIT ?`,
      )
      .bind(since, limit * 2)
      .all();
    const list = threadListAccessFilter(ctx, r.results)
      .slice(0, limit)
      .map((x) => ({ tid: Number(x.tid), subject: String(x.subject ?? ''), favorites: Number(x.favorites ?? 0) }));
    return ok(c, 'ok', { data: { list, days, limit } });
  });

  /**
   * GET /api/posts/latest：最新评论（发现页「互动评论」列：
   * post_find(isfirst=0, quotepid=0, create_date desc, 10) —— 最新 10 条顶层回帖，
   * 下发作者头像/昵称 + 去标签正文摘要（25 字）+ 时间；版块可读性与审核位按统一口径过滤。
   */
  app.get('/api/posts/latest', async (c) => {
    const { db, cache } = core(c);
    const [forumlist, grouplist, viewer] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const r = await db
      .prepare<{ pid: number; tid: number; uid: number; message_fmt: string; create_date: number; fid: number; top: number }>(
        `SELECT p.pid,p.tid,p.uid,p.message_fmt,p.create_date,t.fid,t.top
         FROM ${P} p INNER JOIN ${T} t ON t.tid = p.tid
         WHERE p.isfirst = 0 AND p.quotepid = 0 AND p.ok = 1 AND t.ok = 1
         ORDER BY p.pid DESC LIMIT 20`,
      )
      .all();
    const rows = threadListAccessFilter(ctx, r.results).slice(0, 10);
    const uids = [...new Set(rows.map((x) => Number(x.uid)))];
    const users = new Map<number, { username: string; avatar: number }>();
    if (uids.length) {
      const us = await db
        .prepare<{ uid: number; username: string; avatar: number }>(
          `SELECT uid,username,avatar FROM bbs_user WHERE uid IN (${uids.map(() => '?').join(',')})`,
        )
        .bind(...uids)
        .all();
      for (const u of us.results) users.set(Number(u.uid), { username: u.username, avatar: Number(u.avatar) });
    }
    const list = rows.map((x) => {
      // 去标签 + 压缩空白 + 25 字截断
      const text = String(x.message_fmt ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const chars = [...text];
      return {
        pid: Number(x.pid),
        tid: Number(x.tid),
        uid: Number(x.uid),
        username: users.get(Number(x.uid))?.username ?? '',
        avatar: users.get(Number(x.uid))?.avatar ?? 0,
        text: chars.length > 25 ? `${chars.slice(0, 25).join('')}…` : text,
        createDate: Number(x.create_date),
      };
    });
    return ok(c, 'ok', { data: { list, size: list.length } });
  });

  return app;
}
