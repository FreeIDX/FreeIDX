/**
 * T1-1 DoD：权限矩阵单测全覆盖（组 × 版块 × 版主），后续所有接口的正确性基线。
 * 断言全部对照权限引擎 forumAccessUser/forumAccessMod/各过滤器的实现行为。
 */
import { describe, it, expect } from 'vitest';
import {
  forumAccessUser,
  forumAccessMod,
  canUpdatePost,
  canDeletePost,
  forumListAccessFilter,
  threadListAccessFilter,
  postListAccessFilter,
  resolveGroupUpgrade,
  type AccessCtx,
  type ForumForAccess,
  type GroupForAccess,
} from '../src/core/access';

const group = (
  gid: number,
  bits: Partial<Record<string, number>> = {},
): GroupForAccess => ({
  gid,
  allowread: 1,
  allowthread: 1,
  allowpost: 1,
  allowattach: 1,
  allowdown: 1,
  allowupdate: 0,
  allowdelete: 0,
  allowtop: 0,
  allowmove: 0,
  creditsfrom: 0,
  creditsto: 0,
  ...bits,
});

// fid=1 开放版块；fid=2 开启 accesson（仅 gid=101 可读可发）；fid=3 accesson 但矩阵拒绝
const forumlist: Record<number, ForumForAccess> = {
  1: { fid: 1, accesson: 0, moduids: '10,11' },
  2: {
    fid: 2,
    accesson: 1,
    moduids: '11',
    accesslist: {
      101: { allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1 },
      0: { allowread: 0, allowthread: 0, allowpost: 0, allowattach: 0, allowdown: 0 },
    },
  },
  3: {
    fid: 3,
    accesson: 1,
    moduids: '',
    accesslist: {
      101: { allowread: 0, allowthread: 0, allowpost: 0, allowattach: 0, allowdown: 0 },
    },
  },
};

const grouplist: Record<number, GroupForAccess> = {
  0: group(0, { allowthread: 0, allowattach: 0 }),
  1: group(1, { allowupdate: 1, allowdelete: 1, allowtop: 1, allowmove: 1 }),
  2: group(2, { allowupdate: 1, allowdelete: 1, allowtop: 1, allowmove: 1 }),
  4: group(4, { allowupdate: 1, allowdelete: 1, allowtop: 1, allowmove: 1 }),
  5: group(5, { allowupdate: 1, allowtop: 1 }),
  7: group(7, { allowread: 0, allowthread: 0, allowpost: 0, allowattach: 0, allowdown: 0 }),
  101: group(101, { creditsfrom: 0, creditsto: 50 }),
  102: group(102, { creditsfrom: 50, creditsto: 200 }),
  103: group(103, { creditsfrom: 200, creditsto: 1000 }),
};

const ctx = (uid: number, gid: number): AccessCtx => ({
  uid,
  gid,
  forumlist,
  grouplist,
});

describe('forumAccessUser（accesson 双与判定）', () => {
  it('fid 不存在恒拒绝', () => {
    expect(forumAccessUser(ctx(1, 1), 999, 'allowread')).toBe(false);
  });

  it('accesson=0：只看组位（游客可读不可发帖）', () => {
    expect(forumAccessUser(ctx(0, 0), 1, 'allowread')).toBe(true);
    expect(forumAccessUser(ctx(0, 0), 1, 'allowthread')).toBe(false);
    expect(forumAccessUser(ctx(5, 7), 1, 'allowread')).toBe(false);
  });

  it('accesson=1：组位 && 矩阵位 双与', () => {
    expect(forumAccessUser(ctx(20, 101), 2, 'allowthread')).toBe(true); // 101×2 允许
    expect(forumAccessUser(ctx(20, 0), 2, 'allowread')).toBe(false); // 0×2 矩阵拒绝
    expect(forumAccessUser(ctx(20, 101), 3, 'allowread')).toBe(false); // 矩阵行 allowread=0
  });

  it('accesson=1 时组位也参与（组拒绝则矩阵允许也无效）', () => {
    // gid=0 对 fid=2 矩阵全 0；构造组允许+矩阵允许才通过 → 用 101 验证组位来源
    const f: Record<number, ForumForAccess> = {
      9: {
        fid: 9,
        accesson: 1,
        moduids: '',
        accesslist: { 0: { allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1 } },
      },
    };
    const c: AccessCtx = { uid: 0, gid: 0, forumlist: f, grouplist };
    expect(forumAccessUser(c, 9, 'allowthread')).toBe(false); // 游客组 allowthread=0，矩阵 1 也无效
    expect(forumAccessUser(c, 9, 'allowread')).toBe(true); // 组 1 且矩阵 1
  });
});

describe('forumAccessMod（仅 gid 1/2 直通，3/4 查 moduids）', () => {
  it('gid=1/2 恒通过', () => {
    expect(forumAccessMod(ctx(999, 1), 2, 'allowtop')).toBe(true);
    expect(forumAccessMod(ctx(999, 2), 3, 'allowdelete')).toBe(true);
  });

  it('gid=4 且在 moduids → 组位有效', () => {
    expect(forumAccessMod(ctx(10, 4), 1, 'allowtop')).toBe(true);
    expect(forumAccessMod(ctx(10, 4), 2, 'allowmove')).toBe(false); // 10 不在 fid=2 名册
  });

  it('gid=4 名册内但组位为 0 → 拒绝（close/digest 复用 allowtop 由调用方传位）', () => {
    const g: Record<number, GroupForAccess> = { ...grouplist, 4: group(4, { allowtop: 0 }) };
    const c: AccessCtx = { uid: 10, gid: 4, forumlist, grouplist: g };
    expect(forumAccessMod(c, 1, 'allowtop')).toBe(false);
  });

  it('口径校准（§D.5）：实习版主 gid=5 无版务权——不照 §6.3 笔误放开', () => {
    expect(forumAccessMod(ctx(10, 5), 1, 'allowtop')).toBe(false);
  });

  it('普通用户组一律拒绝', () => {
    expect(forumAccessMod(ctx(10, 101), 1, 'allowdelete')).toBe(false);
  });
});

describe('作者叠加 canUpdate/canDelete', () => {
  it('本人 + 组允许 → 可编辑（post.allowupdate 标记）', () => {
    const g: Record<number, GroupForAccess> = { ...grouplist, 101: group(101, { allowupdate: 1, allowdelete: 1 }) };
    const c: AccessCtx = { uid: 20, gid: 101, forumlist, grouplist: g };
    expect(canUpdatePost(c, 1, 20)).toBe(true);
    expect(canDeletePost(c, 1, 20)).toBe(true);
    expect(canUpdatePost(c, 1, 21)).toBe(false);
  });

  it('101 组默认禁编辑，版主可编辑他人帖', () => {
    expect(canUpdatePost(ctx(20, 101), 1, 21)).toBe(false);
    expect(canUpdatePost(ctx(10, 4), 1, 21)).toBe(true);
  });

  it('作者本人恒可编辑/删除自己的帖子（组 allowupdate/allowdelete=0 亦然，作者叠加口径）', () => {
    // gid=101 默认 allowupdate=0 / allowdelete=0，但作者叠加纯看作者身份，不看组开关
    expect(canUpdatePost(ctx(20, 101), 1, 20)).toBe(true);
    expect(canDeletePost(ctx(20, 101), 1, 20)).toBe(true);
    // 游客（uid=0）不得借 uid=0 匿名帖放行
    expect(canUpdatePost(ctx(0, 0), 1, 0)).toBe(false);
  });

  it('作者叠加不越版块名册：版主对非名册版块他人帖无编辑权', () => {
    expect(canDeletePost(ctx(10, 4), 2, 21)).toBe(false);
  });
});

describe('三级过滤器', () => {
  it('forumListAccessFilter：gid=1 直通；其余按 accesson 分支过滤并剥离 accesslist', () => {
    const admin = forumListAccessFilter(forumlist, 1, grouplist);
    expect(Object.keys(admin)).toEqual(['1', '2', '3']);
    expect(admin[2]?.accesslist).toBeUndefined();
    const guest = forumListAccessFilter(forumlist, 0, grouplist);
    expect(Object.keys(guest)).toEqual(['1']); // fid2 矩阵 0 行拒绝；fid3 拒绝
    const member = forumListAccessFilter(forumlist, 101, grouplist);
    expect(Object.keys(member)).toEqual(['1', '2']);
    const banned = forumListAccessFilter(forumlist, 7, grouplist);
    expect(Object.keys(banned)).toEqual([]);
  });

  it('forumListAccessFilter：accesson 版块须「组位 && 矩阵」双与（组全局拒绝时不因矩阵行放行而露出）', () => {
    // 组 102 全局拒绝读，但版块矩阵为它开了 1：双与口径下该版块必须被过滤（否则列表可见、点进去 403）
    const g: Record<number, GroupForAccess> = { ...grouplist, 102: group(102, { allowread: 0 }) };
    const strict: Record<number, ForumForAccess> = {
      ...forumlist,
      2: {
        fid: 2,
        accesson: 1,
        moduids: '11',
        accesslist: { 102: { allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1 } },
      },
    };
    // 单点判定（forumAccessUser）为 false → 过滤器必须一致（fid2 不得出现）
    expect(forumAccessUser({ uid: 20, gid: 102, forumlist: strict, grouplist: g }, 2, 'allowread')).toBe(false);
    expect(forumListAccessFilter(strict, 102, g)[2]).toBeUndefined();
  });

  it('threadListAccessFilter：非 accesson 版块直通；置顶帖不过滤', () => {
    const rows = [
      { fid: 1, top: 0 },
      { fid: 2, top: 0 },
      { fid: 2, top: 1 }, // 版块内置顶 → 保留
      { fid: 3, top: 3 }, // 全局置顶 → 保留
    ];
    const out = threadListAccessFilter(ctx(20, 0), rows);
    expect(out).toEqual([
      { fid: 1, top: 0 },
      { fid: 2, top: 1 },
      { fid: 3, top: 3 },
    ]);
  });

  it('postListAccessFilter：按 thread 上下文过滤，缺上下文不误删', () => {
    const threadCtx = new Map([
      [11, { fid: 2, top: 0 }],
      [12, { fid: 2, top: 1 }],
      [13, { fid: 1, top: 0 }],
    ]);
    const rows = [{ tid: 11 }, { tid: 12 }, { tid: 13 }, { tid: 99 }];
    expect(postListAccessFilter(ctx(20, 0), rows, threadCtx)).toEqual([
      { tid: 12 },
      { tid: 13 },
      { tid: 99 },
    ]);
  });
});

describe('resolveGroupUpgrade（user_update_group：posts+threads 落区间换组）', () => {
  it('gid<100 保护管理组', () => {
    expect(resolveGroupUpgrade(ctx(1, 1), 99999, 99999)).toBeNull();
  });

  it('101→102：总数 60 落入 (50,200)', () => {
    expect(resolveGroupUpgrade(ctx(20, 101), 55, 5)).toBe(102);
  });

  it('已在目标组返回 null（不触发无谓写入）', () => {
    expect(resolveGroupUpgrade(ctx(20, 102), 55, 5)).toBeNull();
  });

  it('边界值不落入任何开区间 → 不换组（creditsfrom<n<creditsto）', () => {
    expect(resolveGroupUpgrade(ctx(20, 101), 50, 0)).toBeNull(); // n=50 恰为边界
  });
});
