/**
 * 版块列表（树形内联编辑）：一级版块 → 其子版块（二级）缩进展示，一级版块可收缩/展开。
 * 列 = 名称(树列，含收缩箭头) / 版块ID / 父版块(行内下拉，可即时挂到一级版块下) / 内容语言(只读摘要，改在编辑页) /
 *      图标缩略图 / 上传图标 / 排序 / 编辑 / 删除；
 * `<table class="adm-table" style="min-width:960px">`，页面无二级 Tab（版块菜单的 tab 是空表）。
 * 实现差异（§7 记账）：
 *  - **图标两列**：缩略图 48px + 行内 file input（选图立即上传
 *    PUT /api/admin/forums/:fid/icon，存 R2 forum/{fid}.{ext}，见 admin/forums.ts）；
 *    未上传回退内置默认图标（内置 folder 图形）；
 *    未保存的新行（不在服务端返回集合内）不能上传，需先「确定」保存；
 *  - 文本列提交时**只发变化的行**（逐行 PUT /api/admin/forums/:fid），新行走 POST；未变化行不发请求，省 D1 写；
 *  - 提交体不含 `access` 键 → 服务端不动权限矩阵（矩阵只在编辑页整体替换，见 ForumEditPage）；
 *  - 删除是级联删（主题/回帖/附件/计数回退 + SEO 静态产物失效），故在提示之外补一层 ConfirmModal 明细文案，
 *    fid=1 的「系统保留」提示、含子版块的「请先删除子版块」提示均在点击删除时就地给出。
 * 计数校准（scan/found）已并入每日 cron（cronDaily），本页不再提供手动入口。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { CONTENT_LANG_NATIVE_NAMES, FORUM_LANG_UNRESTRICTED, type ContentLang } from '@freeidx/shared';
import { deleteForum, getForums, updateForum, createForum, uploadForumIcon } from '../api';
import type { AdminForumRow, ForumInput } from '../types';
import { useAdminT } from '../t';
import { useBatchAction } from '../use-action';
import { useAuth } from '../../store/auth';
import { Alert, Button, Card, ConfirmModal, ErrorState, Input, PageTitle, Select, cx } from '../ui';
import { Icon } from '../../components/icons';

/** 提交口径 = 服务端 PUT 的标量字段集（不带 access） */
function scalarInput(r: AdminForumRow): ForumInput {
  return {
    name: r.name,
    rank: r.rank,
    brief: r.brief,
    announcement: r.announcement,
    accesson: r.accesson,
    orderby: r.orderby,
    icon: r.icon,
    moduids: r.moduids,
    seo_title: r.seo_title,
    seo_keywords: r.seo_keywords,
    parent_fid: r.parent_fid,
    lang: r.lang,
  };
}

const DIFF_KEYS: (keyof ForumInput)[] = [
  'name', 'rank', 'brief', 'announcement', 'accesson', 'orderby', 'icon', 'moduids', 'seo_title', 'seo_keywords', 'parent_fid', 'lang',
];

function changed(a: AdminForumRow, b: AdminForumRow): boolean {
  const x = scalarInput(a);
  const y = scalarInput(b);
  return DIFF_KEYS.some((k) => x[k] !== y[k]);
}

/** 二级版块：按「一级版块 → 其子版块」重排，便于后台树形对照（父不可见的孤儿追加到末尾） */
function orderForums(list: AdminForumRow[]): AdminForumRow[] {
  const out: AdminForumRow[] = [];
  for (const t of list.filter((f) => !f.parent_fid)) out.push(t, ...list.filter((f) => f.parent_fid === t.fid));
  for (const f of list) if (!out.includes(f)) out.push(f);
  return out;
}

function BLANK_FORUM(): AdminForumRow {
  return {
    fid: 0,
    name: '',
    rank: 0,
    threads: 0,
    todayposts: 0,
    todaythreads: 0,
    brief: '',
    announcement: '',
    accesson: 0,
    orderby: 0,
    icon: 0,
    icon_file: '',
    icon_time: 0,
    icon_url: '',
    moduids: '',
    seo_title: '',
    seo_keywords: '',
    parent_fid: 0,
    lang: '',
    accesslist: {},
  };
}

export function ForumListPage() {
  const t = useAdminT();
  const navigate = useNavigate();
  const refresh = useAuth((s) => s.refresh);
  const q = useQuery({ queryKey: ['admin', 'forums'], queryFn: getForums });
  const [rows, setRows] = useState<AdminForumRow[]>([]);
  const [confirming, setConfirming] = useState<AdminForumRow | null>(null);
  const [notice, setNotice] = useState('');
  /** 折叠的一级版块 fid（默认全部展开）；驱动子版块显隐 */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggleCollapsed = (fid: number) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(fid)) n.delete(fid);
      else n.add(fid);
      return n;
    });

  /**
   * 未保存草稿保护：任何来源的重取（invalidate，以及全局 refetchOnWindowFocus 若恢复开启）都会拿到新 q.data，
   * 若无条件覆盖就会静默清空正在编辑的版块表单；保存/删除成功后会复位标记，让服务端数据回灌（含新行 fid）。
   */
  const dirtyRef = useRef(false);
  const markDirty = () => {
    dirtyRef.current = true;
  };
  useEffect(() => {
    if (dirtyRef.current) return;
    if (q.data) setRows(orderForums(q.data.forums));
  }, [q.data]);

  const original = useMemo(() => q.data?.forums ?? [], [q.data]);
  const batch = useBatchAction([['admin', 'forums']]);

  const save = async () => {
    const jobs: (() => Promise<unknown>)[] = [];
    for (const r of rows) {
      const src = original.find((o) => o.fid === r.fid);
      if (!src) {
        if (r.name.trim()) jobs.push(() => createForum(scalarInput(r)));
      } else if (changed(src, r)) {
        jobs.push(() => updateForum(r.fid, scalarInput(r)));
      }
    }
    if (await batch.run(jobs, t('save_successfully', '保存成功'))) {
      dirtyRef.current = false; // 已落库：允许服务端数据回灌（新行 fid / 重排）
      await refresh();
    }
  };

  const remove = async (r: AdminForumRow) => {
    if (await batch.run([() => deleteForum(r.fid)], t('admin_forum_deleted', '已删除版块「{name}」', { name: r.name }))) {
      dirtyRef.current = false;
      await refresh();
    }
    setConfirming(null);
  };

  /** 行内图标上传（选图即传；本地回写 icon_url 不整表刷新，避免丢未保存的其他行编辑） */
  const uploadIcon = async (r: AdminForumRow, file: File | undefined) => {
    if (!file) return;
    if (!r.fid) {
      setNotice(t('admin_forum_icon_save_first', '新增行请先「确定」保存后再上传图标。'));
      return;
    }
    if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) {
      setNotice(t('admin_forum_icon_format', '图标仅支持 png / jpg / gif / webp / bmp 格式。'));
      return;
    }
    if (file.size > 1024 * 1024) {
      setNotice(t('admin_forum_icon_too_large', '图标不能超过 1M。'));
      return;
    }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error(t('admin_image_read_failed', '图片读取失败')));
        fr.readAsDataURL(file);
      });
      const d = await uploadForumIcon(r.fid, data);
      setNotice('');
      setRows((prev) => prev.map((x) => (x.fid === r.fid ? { ...x, icon_url: d.icon_url } : x)));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t('admin_icon_upload_failed', '图标上传失败'));
    }
  };

  /** 一级版块（父不可见的孤儿也按一级展示）／某版块的子版块 */
  const isTop = (f: AdminForumRow) => !f.parent_fid || !rows.some((p) => p.fid === f.parent_fid);
  const kidsOf = (fid: number) => rows.filter((f) => f.parent_fid === fid);
  /** 可选父版块 = 一级版块（仅两级），排除自身 */
  const parentOptions = (self: AdminForumRow) => rows.filter((f) => isTop(f) && f.fid !== self.fid);
  /** 绑定语言摘要（只读）：具体语言 / 全部语言（显式不限制）/ 继承父版块(·语言) / 自动识别 */
  const langLabel = (f: AdminForumRow): string => {
    const parent = f.parent_fid ? rows.find((p) => p.fid === f.parent_fid) : undefined;
    /* 顶级版块的「显式不限制」与空串等价（服务端保存时会归一回空串），此处按自动识别展示 */
    if (!parent) {
      return f.lang && f.lang !== FORUM_LANG_UNRESTRICTED ? (CONTENT_LANG_NATIVE_NAMES[f.lang as ContentLang] ?? f.lang) : t('content_lang_auto');
    }
    if (f.lang === FORUM_LANG_UNRESTRICTED) return t('content_lang_all');
    if (f.lang) return CONTENT_LANG_NATIVE_NAMES[f.lang as ContentLang] ?? f.lang;
    const inherited =
      parent.lang && parent.lang !== FORUM_LANG_UNRESTRICTED ? (CONTENT_LANG_NATIVE_NAMES[parent.lang as ContentLang] ?? '') : '';
    return `${t('forum_content_lang_inherit')}${inherited ? ` · ${inherited}` : ''}`;
  };
  /** 新增行 = 不在服务端返回集合内（区分 POST/PUT，且未保存前禁用图标上传） */
  const isNewRow = (r: AdminForumRow) => !original.some((o) => o.fid === r.fid);
  const patch = (fid: number, p: Partial<AdminForumRow>) => {
    markDirty();
    setRows((prev) => prev.map((x) => (x.fid === fid ? { ...x, ...p } : x)));
  };
  const addRow = () => {
    markDirty();
    setRows((prev) => [
      ...prev,
      { ...BLANK_FORUM(), fid: Math.max(0, ...prev.map((r) => r.fid)) + 1, rank: Math.max(0, ...prev.map((r) => r.rank)) + 1 },
    ]);
  };
  /** 树形可见行：一级版块 +（未折叠时）其子版块；折叠的父版块只显示自身 */
  const visible: { row: AdminForumRow; depth: 0 | 1; kids: number }[] = [];
  for (const t0 of rows.filter(isTop)) {
    const kids = kidsOf(t0.fid);
    visible.push({ row: t0, depth: 0, kids: kids.length });
    if (kids.length && !collapsed.has(t0.fid)) for (const k of kids) visible.push({ row: k, depth: 1, kids: 0 });
  }

  if (q.isError) return <ErrorState error={q.error} />;

  /** fid=1 是系统保留版块：点删除弹提示，按钮照常渲染 */
  const askDelete = (r: AdminForumRow) => {
    if (r.fid === 1) {
      setNotice(t('forum_cant_delete_system_reserved', '不能删除系统保留的版块。'));
      return;
    }
    /* 二级版块：仍有子版块时阻止删除（服务端亦会拦截，此处先给出提示） */
    if (rows.some((x) => x.parent_fid === r.fid)) {
      setNotice(t('forum_please_delete_sub_forum'));
      return;
    }
    setNotice('');
    setConfirming(r);
  };

  return (
    <div className="space-y-3">
      <PageTitle>{t('forum_admin', '版块管理')}</PageTitle>
      {(batch.flash) && (
        <Alert tone={batch.flash.tone}>{batch.flash.text}</Alert>
      )}
      {notice && <Alert tone="warn">{notice}</Alert>}
      {!q.isPending && rows.length === 0 && <Card>{t('admin_no_forum_create', '还没有版块，点下方「[+]增加一行」建一个。')}</Card>}

      <Card>
        <div className="overflow-x-auto">
          <table className="adm-table w-full min-w-[960px] text-base">
            <thead>
              <tr>
                <th scope="col" className="whitespace-nowrap text-left font-medium">{t('forum_name', '名称')}</th>
                <th scope="col" className="w-[90px] whitespace-nowrap font-medium">{t('forum_id', '版块 ID')}</th>
                <th scope="col" className="w-[150px] whitespace-nowrap font-medium">{t('forum_parent', '父版块')}</th>
                <th scope="col" className="w-[130px] whitespace-nowrap font-medium">{t('content_lang_label')}</th>
                <th scope="col" className="w-[72px] whitespace-nowrap font-medium">{t('forum_icon', '图标')}</th>
                <th scope="col" className="w-[170px] whitespace-nowrap font-medium">{t('admin_upload_icon', '上传图标')}</th>
                <th scope="col" className="w-[100px] whitespace-nowrap font-medium">{t('forum_rank', '排序')}</th>
                <th scope="col" className="w-[100px] whitespace-nowrap text-center font-medium">{t('forum_edit', '编辑')}</th>
                <th scope="col" className="w-[100px] whitespace-nowrap text-center font-medium">{t('forum_delete', '删除')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ row: r, depth, kids }) => {
                const open = !collapsed.has(r.fid);
                return (
                  <tr key={r.fid} className="text-center">
                    {/* 名称列 = 树列：一级版块带收缩/展开箭头，子版块缩进 */}
                    <td className="text-left">
                      <div className="flex items-center gap-1" style={depth ? { paddingLeft: '1.75rem' } : undefined}>
                        {kids > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleCollapsed(r.fid)}
                            aria-expanded={open}
                            aria-label={open ? t('side_nav_collapse') : t('side_nav_expand')}
                            title={open ? t('side_nav_collapse') : t('side_nav_expand')}
                            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-2 transition-colors hover:text-ink"
                          >
                            <Icon name={open ? 'chevron_down' : 'chevron_right'} className="size-4" />
                          </button>
                        ) : (
                          <span className="size-5 shrink-0" aria-hidden="true" />
                        )}
                        <Input value={r.name} placeholder={t('forum_name', '名称')} onChange={(e) => patch(r.fid, { name: e.target.value })} />
                      </div>
                    </td>
                    <td className="text-muted-2">{r.fid || '—'}</td>
                    <td>
                      {/* 行内选父版块：改完点「确定」即持久化；已有子版块的版块不能再当子版块（服务端亦校验） */}
                      <Select
                        value={String(r.parent_fid)}
                        disabled={kids > 0}
                        title={kids > 0 ? t('forum_parent_locked', '该版块已有子版块，不能作为子版块') : undefined}
                        onChange={(e) => patch(r.fid, { parent_fid: Number(e.target.value) })}
                      >
                        <option value="0">{t('forum_parent_top', '顶级版块')}</option>
                        {parentOptions(r).map((p) => (
                          <option key={p.fid} value={p.fid}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    {/* 内容语言摘要（只读）：绑定值在编辑页修改，此处用于发现「某个版块被锁成日语」这类配置 */}
                    <td className="whitespace-nowrap text-xs text-muted-2">{langLabel(r)}</td>
                    <td>
                      {r.icon_url ? (
                        <img src={r.icon_url} alt={r.name} className="mx-auto size-12 rounded object-contain" />
                      ) : (
                        <Icon name="folder" className="mx-auto size-10 text-muted-2" title={t('admin_default_icon', '默认图标')} />
                      )}
                    </td>
                    <td>
                      {/* 自定义「选择文件」钮 + 隐藏原生控件：原生 file 控件文案随浏览器语言，不走站点 i18n */}
                      <label
                        className={cx(
                          'inline-flex cursor-pointer items-center rounded bg-muted px-2 py-1 text-xs text-ink transition-colors hover:bg-line',
                          isNewRow(r) && 'pointer-events-none opacity-50',
                        )}
                        aria-label={t('admin_upload_forum_icon', '上传版块 {name} 图标', { name: r.name || r.fid })}
                        title={isNewRow(r) ? t('admin_save_forum_before_icon', '先保存版块再上传图标') : t('admin_select_image_to_upload', '选择图片后立即上传（≤1M）')}
                      >
                        {t('choose_file')}
                        <input
                          type="file"
                          multiple={false}
                          accept=".jpg,.jpeg,.png,.gif,.webp,.bmp"
                          className="hidden"
                          disabled={isNewRow(r)}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            void uploadIcon(r, f);
                          }}
                        />
                      </label>
                    </td>
                    <td>
                      <Input type="number" className="w-[80px]" value={String(r.rank)} onChange={(e) => patch(r.fid, { rank: Number(e.target.value || 0) })} />
                    </td>
                    <td>
                      <Button variant="default" onClick={() => navigate(r.fid ? `/admin/forums/${r.fid}/edit` : '/admin/forums/new')}>
                        {t('forum_edit', '编辑')}
                      </Button>
                    </td>
                    <td>
                      <Button variant="default" onClick={() => askDelete(r)}>
                        {t('forum_delete', '删除')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mb-4 mt-3">
          <Button variant="default" onClick={addRow}>
            [+]
            {t('add_new_line', '增加一行')}
          </Button>
        </p>
        <p className="mb-4 text-center">
          <Button type="submit" loading={batch.pending} onClick={() => void save()} className="w-[10rem]">
            {t('confirm', '确定')}
          </Button>
        </p>
        <p className="mb-4 text-[80%] text-muted-2">
          {t('admin_note_tip', '注：{tip}', { tip: t('forum_edit_tip', '请谨慎编辑版块，一旦确定后不要轻易变动，否则可能会导致数据关联错误，一般在正式运营时就不要再变动。') })}
        </p>
      </Card>

      <ConfirmModal
        open={confirming !== null}
        loading={batch.pending}
        text={t('admin_forum_delete_confirm', '删除版块「{name}」会级联删除其全部主题、回帖与附件并回退作者计数，不可恢复。确定删除？', { name: confirming?.name ?? '' })}
        onConfirm={() => void remove(confirming!)}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
