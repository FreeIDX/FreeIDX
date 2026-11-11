/**
 * 权限引擎（§6.3 单一事实源，T1-1）：
 *  - forumAccessUser：accesson 双与；fid 不存在恒 FALSE
 *  - forumAccessMod：gid 1/2 恒 TRUE；gid 3/4 走组位 && moduids
 *    （设计文档 §6.3 写 3/4/5，按功能等价核对收敛：实习版主 gid=5 无版务权，MOD_GIDS 注明）
 *  - forumListAccessFilter：gid=1 直通；过滤后剥离 accesslist
 *  - threadListAccessFilter：accesson 版块才过滤；top>0 不过滤
 *  - postListAccessFilter：同 thread，需带 thread 上下文
 *
 * 校准（§D.8）：close/digest 复用 allowtop；不实现 ban/allowbanuser 死代码。
 * 纯函数设计：forumlist/grouplist 由缓存层（T1-3）注入，判定零 D1 查询（§7 CPU 归零原则）。
 */
import type { GroupPerm, ModPerm, UserPerm } from '@freeidx/shared';
import { GroupId } from '@freeidx/shared';

export interface AccessRow {
  allowread: number;
  allowthread: number;
  allowpost: number;
  allowattach: number;
  allowdown: number;
  /** forum_access 表仅 5 列；版务位恒缺失（undefined→falsy），保留索引签名供 GroupPerm 泛化查询 */
  [perm: string]: number | undefined;
}

export interface ForumForAccess {
  fid: number;
  accesson: number;
  moduids: string; // 逗号分隔
  accesslist?: Record<number, Partial<AccessRow>>; // gid -> 行（accesson=1 时必需）
  /** 审核位（thread_check/post_check/edit_check，tt_check 的 forum 矩阵）；索引签名供 checkOrNot 泛化查询 */
  [perm: string]: number | string | Record<number, Partial<AccessRow>> | undefined;
}

export interface GroupForAccess {
  gid: number;
  [perm: string]: number | string;
}

export interface AccessCtx {
  uid: number;
  gid: number;
  forumlist: Record<number, ForumForAccess>;
  grouplist: Record<number, GroupForAccess>;
}

/** 版务判定组：gid 1/2 恒通过，3/4 需版主名册（gid=5 实习版主无版务权） */
const MOD_GIDS = [3, 4];

function inString(uid: number, moduids: string): boolean {
  // in_string：',a,b,c,' 包含 ',uid,'
  if (!moduids) return false;
  return (',' + moduids + ',').includes(',' + uid + ',');
}

/** 普通操作：allowread/allowthread/allowpost/allowattach/allowdown */
export function forumAccessUser(
  ctx: AccessCtx,
  fid: number,
  perm: UserPerm,
): boolean {
  const forum = ctx.forumlist[fid];
  if (!forum) return false; // fid 不在 forumlist → FALSE
  const group = ctx.grouplist[ctx.gid];
  if (forum.accesson) {
    return !!(group?.[perm] && forum.accesslist?.[ctx.gid]?.[perm]);
  }
  return !!group?.[perm];
}

/** 版务操作：allowtop/allowmove/allowupdate/allowdelete（close/digest 复用 allowtop，§D.8#1） */
export function forumAccessMod(ctx: AccessCtx, fid: number, perm: ModPerm): boolean {
  if (ctx.gid === GroupId.ADMIN || ctx.gid === GroupId.SUPER_MOD) return true;
  if (MOD_GIDS.includes(ctx.gid)) {
    const group = ctx.grouplist[ctx.gid];
    const forum = ctx.forumlist[fid];
    return !!(group?.[perm] && forum && inString(ctx.uid, forum.moduids));
  }
  return false;
}

/** 编辑/删除作者叠加：本人恒可（无需组开关），或具备版务权限 */
export function canUpdatePost(ctx: AccessCtx, fid: number, postUid: number): boolean {
  if (ctx.uid > 0 && ctx.uid === postUid) return true;
  return forumAccessMod(ctx, fid, 'allowupdate');
}

export function canDeletePost(ctx: AccessCtx, fid: number, postUid: number): boolean {
  if (ctx.uid > 0 && ctx.uid === postUid) return true;
  return forumAccessMod(ctx, fid, 'allowdelete');
}

/** 版块树过滤：gid=1 直通；输出剥离 accesslist 防泄露 */
export function forumListAccessFilter<T extends ForumForAccess>(
  forumlist: Record<number, T>,
  gid: number,
  grouplist: Record<number, GroupForAccess>,
  perm: GroupPerm = 'allowread',
): Record<number, T> {
  const out: Record<number, T> = {};
  if (gid === GroupId.ADMIN) {
    for (const [fid, f] of Object.entries(forumlist))
      out[+fid] = { ...f, accesslist: undefined } as T;
    return out;
  }
  const group = grouplist[gid];
  for (const [fid, forum] of Object.entries(forumlist)) {
    /**
     * accesson=1 时「组位 && 版块矩阵」双与（与 forumAccessUser 同一口径，§6.3）：
     * 只判矩阵会让「组全局拒绝、矩阵行允许」的版块出现在版块列表里，点进去却 403，
     * 口径不一致且泄露私有版块元数据。
     */
    const okRow = forum.accesson
      ? !!(group?.[perm] && forum.accesslist?.[gid]?.[perm])
      : !!group?.[perm];
    if (!okRow) continue;
    const { accesslist: _drop, ...rest } = forum;
    out[+fid] = rest as T;
  }
  return out;
}

/**
 * 主题列表过滤：公开版块放行，私有版块按 allowread 判定。
 * 失败关闭：版块不在 forumlist（数据不一致/已删除）时一律过滤，绝不因元数据缺失而放行；
 * 置顶（top>0）也不再短路——置顶只影响排序，不能突破版块可读性，否则私有版块的置顶帖会出现在
 * 发现页/用户主页/最新评论等未按 fid 预过滤的公共列表里（并被边缘缓存放大）。
 */
export function threadListAccessFilter<T extends { fid: number }>(
  ctx: AccessCtx,
  rows: T[],
): T[] {
  return rows.filter((t) => {
    const forum = ctx.forumlist[t.fid];
    if (!forum) return false;
    if (!forum.accesson) return true;
    return forumAccessUser(ctx, t.fid, 'allowread');
  });
}

/** 回帖列表过滤：tid→fid 上下文由调用方以 Map 提供（反 N+1，免每行一查）；同上失败关闭 */
export function postListAccessFilter<T extends { tid: number }>(
  ctx: AccessCtx,
  rows: T[],
  threadCtx: Map<number, { fid: number }>,
): T[] {
  return rows.filter((p) => {
    const th = threadCtx.get(p.tid);
    if (!th) return false;
    const forum = ctx.forumlist[th.fid];
    if (!forum) return false;
    if (!forum.accesson) return true;
    return forumAccessUser(ctx, th.fid, 'allowread');
  });
}

/**
 * 用户组自动升级（§6.3）：
 * gid<100 直接保护（管理组不动）；n=posts+threads 落入 creditsfrom<n<creditsto 即换组。
 * 纯函数返回目标 gid（null=不换），写库与缓存失效由调用方处理。
 */
export function resolveGroupUpgrade(
  ctx: AccessCtx,
  posts: number,
  threads: number,
): number | null {
  if (ctx.gid < GroupId.LEVEL1) return null;
  const n = posts + threads;
  for (const g of Object.values(ctx.grouplist)) {
    if (g.gid < GroupId.LEVEL1) continue;
    const from = Number(g.creditsfrom ?? 0);
    const to = Number(g.creditsto ?? 0);
    if (from < n && n < to) {
      return g.gid === ctx.gid ? null : g.gid;
    }
  }
  return null;
}

/**
 * 经验值版自动升级（计数来源从 posts+threads 换成用户经验值，边界沿用核心 `from<n<to`）：
 * gid<100 直接保护（管理组不动）；credits 落入 creditsfrom<credits<creditsto 即换组。
 * 纯函数返回目标 gid（null=不换），写库与缓存失效由 core/points.upgradeGroupByCredits 处理。
 */
export function resolveCreditsUpgrade(
  grouplist: Record<number, GroupForAccess>,
  gid: number,
  credits: number,
): number | null {
  if (gid < GroupId.LEVEL1) return null;
  for (const g of Object.values(grouplist)) {
    if (g.gid < GroupId.LEVEL1) continue;
    const from = Number(g.creditsfrom ?? 0);
    const to = Number(g.creditsto ?? 0);
    // 区间口径 (from, to]：种子组为 0–50、50–200…，用开区间会让恰好 50/200/1000 的用户落空不升级
    if (from < credits && credits <= to) {
      return g.gid === gid ? null : g.gid;
    }
  }
  return null;
}
