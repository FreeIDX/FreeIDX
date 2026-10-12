/**
 * 导航栏设置（本项目新增）：配置前台顶部导航栏（首页右侧的自定义导航项）。
 * 数据存 kv setting 的 nav 键（PUT /api/admin/setting 白名单内，提交 NavItem[] 的 JSON 字符串），
 * 前台 bootstrap → useAuth().setting.nav 读取；清空保存 = 恢复默认导航（首页 + 版块列表）。
 * 每项可链接：版块（/forum/{fid}，下拉选）/ 文章（/thread/{tid}，填主题 ID）/ 自定义地址（站内路径或完整 URL）。
 * 未配置时预填前台顶栏当前实际显示的默认版块项（与 Layout.tsx 版块回落同口径），
 * 使「首页顶栏里看到的项目」在后台直接可见可改，无需先空白新建。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NavItem } from '@freeidx/shared';
import { getSetting, putSetting } from '../api';
import type { AdminSettingMap } from '../types';
import { useAdminT } from '../t';
import { useAdminAction } from '../use-action';
import { useAuth } from '../../store/auth';
import { Alert, Button, Card, ErrorState, Input, PageTitle, Select, SubmitRow, Switch, cx } from '../ui';

/** 行编辑态：type 只为录入辅助，保存时折算成 url */
interface NavRow {
  label: string;
  type: 'forum' | 'thread' | 'custom';
  fid: string;
  tid: string;
  url: string;
  on: boolean;
}

/** url → 行编辑态（回显时按前缀识别录入类型） */
function toRow(it: NavItem): NavRow {
  const url = String(it.url ?? '');
  const fm = /^\/forum\/(\d+)/.exec(url);
  const tm = /^\/thread\/(\d+)/.exec(url);
  return {
    label: String(it.label ?? ''),
    type: fm ? 'forum' : tm ? 'thread' : 'custom',
    fid: fm ? fm[1]! : '',
    tid: tm ? tm[1]! : '',
    url,
    on: it.on === 0 ? false : true,
  };
}

/** 行编辑态 → 存储项（sort 用行序，启用项才保留） */
function toItem(r: NavRow, i: number): NavItem {
  const url = r.type === 'forum' && r.fid ? `/forum/${r.fid}` : r.type === 'thread' && r.tid ? `/thread/${r.tid}` : r.url.trim();
  return { label: r.label.trim(), url, sort: i, on: r.on ? 1 : 0 };
}

export function NavBarSettingPage() {
  const t = useAdminT();
  const q = useQuery({ queryKey: ['admin', 'setting'], queryFn: getSetting });
  const forumlist = useAuth((s) => s.forumlist);
  const refresh = useAuth((s) => s.refresh);
  const [rows, setRows] = useState<NavRow[] | null>(null);
  /* true = 尚未保存过自定义导航，列表内容为前台顶栏当前实际显示的默认版块项（预填供直接编辑） */
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    if (!q.data || rows) return;
    const raw = q.data as AdminSettingMap;
    /* nav 存 JSON 字符串；解析失败/为空 = 未配置 */
    let items: NavItem[] = [];
    try {
      const parsed = typeof raw.nav === 'string' ? JSON.parse(raw.nav) : [];
      if (Array.isArray(parsed)) items = parsed as NavItem[];
    } catch {
      /* 存储态异常按未配置处理 */
    }
    if (items.length === 0) {
      /* 未配置：预填前台顶栏当前实际显示的默认版块项。
         口径与 Layout.tsx 的版块回落一致（只取一级版块、最多 8 项），顺序沿用 bootstrap forumlist。 */
      const topForums = forumlist.filter((f) => !f.parentFid || !forumlist.some((p) => p.fid === f.parentFid));
      items = topForums.slice(0, 8).map((f, i) => ({ label: f.name, url: `/forum/${f.fid}`, sort: i, on: 1 as const }));
      setPrefilled(true);
    }
    setRows(items.map(toRow));
  }, [q.data, rows, forumlist]);

  const save = useAdminAction(
    async () => {
      const items = (rows ?? []).map(toItem);
      const r = await putSetting({ nav: JSON.stringify(items) });
      setPrefilled(false); // 已保存：此后按「已配置」呈现（清空保存则回落默认导航）
      await refresh(); // 前台顶栏读 bootstrap 里的 setting.nav，同步刷新全局态
      return r;
    },
    { ok: t('nav_save_success', '保存成功，前台顶栏即时生效'), invalidate: [['admin', 'setting']] },
  );

  if (q.isError) return <ErrorState error={q.error} />;
  if (!rows) return <Card>{t('setting_loading', '设置加载中…')}</Card>;

  const set = (i: number, patch: Partial<NavRow>) => setRows((rs) => (rs ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const next = [...(rs ?? [])];
      const j = i + d;
      if (j < 0 || j >= next.length) return next;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const remove = (i: number) => setRows((rs) => (rs ?? []).filter((_, j) => j !== i));
  const add = () =>
    setRows((rs) => [...(rs ?? []), { label: '', type: 'custom', fid: '', tid: '', url: '', on: true }]);

  /* 未预填（= 已保存过自定义导航）且有条目 → 显示已配置计数；预填态提示「未配置」 */
  const configured = rows.length > 0 && !prefilled;

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_menu_nav_setting', '导航栏')}</PageTitle>
      <Card title={t('nav_setting_title', '前台顶部导航栏')} footer={t('nav_setting_hint', '导航项可链接到版块、文章或自定义地址；一条都不保留（清空保存）时前台恢复默认导航（首页 + 版块列表）。链接类型选「版块」从下拉选择，选「文章」填主题 ID，选「自定义」填站内路径或完整网址。')}>
        {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
        {configured && <p className="mb-2 text-sm text-muted-2">{t('nav_current_count', '已配置 {n} 个导航项（含停用项）', { n: rows.length }).replace('{n}', String(rows.length))}</p>}
        {!configured && <p className="mb-2 text-sm text-muted-2">{t('nav_empty_hint', '当前未配置，以下为前台顶栏正在显示的默认版块项，可直接修改后保存；全部删除后保存即恢复默认导航。')}</p>}
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="rounded-[6px] border border-line-soft p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                {/* 名称 */}
                <Input
                  className="w-36"
                  value={r.label}
                  placeholder={t('nav_item_label', '名称')}
                  aria-label={t('nav_item_label', '名称')}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
                {/* 链接类型 */}
                <Select
                  className="w-32"
                  value={r.type}
                  aria-label={t('nav_item_type', '链接类型')}
                  onChange={(e) => set(i, { type: e.target.value as NavRow['type'] })}
                >
                  <option value="forum">{t('nav_type_forum', '版块')}</option>
                  <option value="thread">{t('nav_type_thread', '文章')}</option>
                  <option value="custom">{t('nav_type_custom', '自定义')}</option>
                </Select>
                {/* 目标：版块下拉 / 文章 tid / 自定义地址 */}
                {r.type === 'forum' && (
                  <Select className="w-44" value={r.fid} aria-label={t('nav_pick_forum', '选择版块')} onChange={(e) => set(i, { fid: e.target.value })}>
                    <option value="">{t('nav_pick_forum', '选择版块')}</option>
                    {forumlist.map((f) => (
                      <option key={f.fid} value={f.fid}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                )}
                {r.type === 'thread' && (
                  <Input
                    className="w-32"
                    type="number"
                    min={1}
                    value={r.tid}
                    placeholder={t('nav_thread_tid', '主题 ID')}
                    aria-label={t('nav_thread_tid', '主题 ID')}
                    onChange={(e) => set(i, { tid: e.target.value })}
                  />
                )}
                {r.type === 'custom' && (
                  <Input
                    className="w-56"
                    value={r.url}
                    placeholder={t('nav_custom_url', '链接地址，如 /new 或 https://')}
                    aria-label={t('nav_custom_url', '链接地址')}
                    onChange={(e) => set(i, { url: e.target.value })}
                  />
                )}
                <div className="ml-auto flex items-center gap-1">
                  <Switch checked={r.on} onChange={(v) => set(i, { on: v })} title={t('nav_item_on', '启用')} />
                  <Button size="sm" variant="default" disabled={i === 0} aria-label={t('nav_move_up', '上移')} onClick={() => move(i, -1)}>
                    ↑
                  </Button>
                  <Button size="sm" variant="default" disabled={i === rows.length - 1} aria-label={t('nav_move_down', '下移')} onClick={() => move(i, 1)}>
                    ↓
                  </Button>
                  <Button size="sm" variant="danger" aria-label={t('nav_delete', '删除')} onClick={() => remove(i)}>
                    {t('delete', '删除')}
                  </Button>
                </div>
              </div>
              {/* 生成的链接预览（无效输入提示） */}
              <p className={cx('mt-1.5 text-xs', toItem(r, i).url ? 'text-muted-2' : 'text-danger')}>
                {toItem(r, i).url
                  ? t('nav_link_preview', '链接：{url}', { url: toItem(r, i).url }).replace('{url}', toItem(r, i).url)
                  : t('nav_link_missing', '请完整填写名称和链接目标')}
              </p>
            </div>
          ))}
        </div>
        <Button className="mt-3" variant="default" onClick={add}>
          + {t('nav_add_item', '添加导航项')}
        </Button>
        <SubmitRow>
          <Button block loading={save.pending} onClick={() => save.mutate()}>
            {t('confirm', '确定')}
          </Button>
        </SubmitRow>
      </Card>
    </div>
  );
}
