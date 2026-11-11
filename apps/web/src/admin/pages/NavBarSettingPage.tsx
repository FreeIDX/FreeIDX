/**
 * 导航栏设置（本项目新增）：配置前台顶部导航栏（首页右侧的自定义导航项）。
 * 数据存 kv setting 的 nav 键（PUT /api/admin/setting 白名单内，提交 NavItem[] 的 JSON 字符串），
 * 前台 bootstrap → useAuth().setting.nav 读取；清空保存 = 恢复默认导航（首页 + 版块列表）。
 * 每项可链接：版块（/forum/{fid}，下拉选）/ 文章（/thread/{tid}，填主题 ID）/ 自定义地址（站内路径或完整 URL）。
 * 每项可上传一张图标图片（非链接输入：选图即传 R2 site/nav/ 拿直链，随「确定」写进 nav 项的 iconUrl），
 * 前台顶栏优先渲染这张图；不传图标则只显示名称。
 * 每项有「显示」开关（on=1/0）：停用只是前台不显示，配置保留；一条都不保留（清空保存）才回落默认导航。
 * 未配置时预填前台顶栏当前实际显示的默认版块项（与 Layout.tsx 版块回落同口径），
 * 使「首页顶栏里看到的项目」在后台直接可见可改，无需先空白新建。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NavItem } from '@freeidx/shared';
import { getSetting, putSetting, uploadNavIcon } from '../api';
import type { AdminSettingMap } from '../types';
import { useAdminT } from '../t';
import { useAdminAction } from '../use-action';
import { useAuth } from '../../store/auth';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  Input,
  PageTitle,
  Select,
  SubmitRow,
  Switch,
  cx,
} from '../ui';
import { NameI18nModal } from '../NameI18nModal';
import { Icon, isIconName } from '../../components/icons';

/** 行编辑态：type 只为录入辅助，保存时折算成 url */
interface NavRow {
  label: string;
  /** 名称多语言：locale → 名称；空 = 未配置，前台回退 label */
  labels: Record<string, string>;
  /** 内置图标名（历史配置遗留：现在只作回显，新配置走 iconUrl 上传；空 = 无内置图标） */
  icon: string;
  /** 上传的自定义图标直链（/files/site/nav/…；空 = 未上传，前台不显示图标） */
  iconUrl: string;
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
    labels: it.labels ?? {},
    icon: String(it.icon ?? ''),
    iconUrl: String(it.iconUrl ?? ''),
    type: fm ? 'forum' : tm ? 'thread' : 'custom',
    fid: fm ? fm[1]! : '',
    tid: tm ? tm[1]! : '',
    url,
    on: it.on === 0 ? false : true,
  };
}

/** 行编辑态 → 存储项（sort 用行序，启用项才保留） */
function toItem(r: NavRow, i: number): NavItem {
  const url =
    r.type === 'forum' && r.fid
      ? `/forum/${r.fid}`
      : r.type === 'thread' && r.tid
        ? `/thread/${r.tid}`
        : r.url.trim();
  /* labels 为空时不落字段（与「未配置」同义，避免把空对象写进 kv）；图标同理：未选不落字段 */
  return {
    label: r.label.trim(),
    ...(Object.keys(r.labels).length ? { labels: r.labels } : {}),
    ...(r.icon ? { icon: r.icon } : {}),
    ...(r.iconUrl ? { iconUrl: r.iconUrl } : {}),
    url,
    sort: i,
    on: r.on ? 1 : 0,
  };
}

export function NavBarSettingPage() {
  const t = useAdminT();
  const q = useQuery({ queryKey: ['admin', 'setting'], queryFn: getSetting });
  const forumlist = useAuth((s) => s.forumlist);
  const refresh = useAuth((s) => s.refresh);
  const [rows, setRows] = useState<NavRow[] | null>(null);
  /* true = 尚未保存过自定义导航，列表内容为前台顶栏当前实际显示的默认版块项（预填供直接编辑） */
  const [prefilled, setPrefilled] = useState(false);
  /** 名称多语言弹窗：快照该行默认名称与译文，确认后回写行（取消丢弃草稿） */
  const [i18nEdit, setI18nEdit] = useState<{
    index: number;
    name: string;
    value: Record<string, string>;
  } | null>(null);
  /** 正在上传图标的行号（null = 空闲）：上传期间禁用该行选图，避免连点重复上传 */
  const [iconBusy, setIconBusy] = useState<number | null>(null);
  /** 图标上传的失败提示（格式/大小/网络错误；成功即清空） */
  const [iconNotice, setIconNotice] = useState('');

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
      const topForums = forumlist.filter(
        (f) => !f.parentFid || !forumlist.some((p) => p.fid === f.parentFid),
      );
      /* 预填项直接继承版块名的多语言（nameI18n → labels），避免保存后默认导航丢掉译文 */
      items = topForums.slice(0, 8).map((f, i) => ({
        label: f.name,
        ...(f.nameI18n && Object.keys(f.nameI18n).length ? { labels: f.nameI18n } : {}),
        url: `/forum/${f.fid}`,
        sort: i,
        on: 1 as const,
      }));
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

  const set = (i: number, patch: Partial<NavRow>) =>
    setRows((rs) => (rs ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const next = [...(rs ?? [])];
      const j = i + d;
      if (j < 0 || j >= next.length) return next;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const remove = (i: number) => setRows((rs) => (rs ?? []).filter((_, j) => j !== i));
  /* 新增项默认「显示中」（on=true），需要隐藏时再关掉该行开关 */
  const add = () =>
    setRows((rs) => [
      ...(rs ?? []),
      { label: '', labels: {}, icon: '', iconUrl: '', type: 'custom', fid: '', tid: '', url: '', on: true },
    ]);

  /**
   * 图标选图即传（与版块图标同一语义：先落 R2 拿直链，随「确定」写进该行 iconUrl）。
   * 不做「填链接」入口：只接受本地图片文件，格式/大小在客户端先挡一次，服务端再校验一次。
   */
  const onIconFile = async (i: number, file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) {
      setIconNotice(t('forum_icon_format_err', '图标仅支持 png / jpg / gif / webp / bmp 格式。'));
      return;
    }
    if (file.size > 1024 * 1024) {
      setIconNotice(t('forum_icon_size_err', '图标不能超过 1M。'));
      return;
    }
    setIconBusy(i);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error(t('forum_icon_read_err', '图片读取失败')));
        fr.readAsDataURL(file);
      });
      const d = await uploadNavIcon(data);
      /* 换了上传图就清掉遗留的内置图标名：两者只保留一个，前台永远只渲染一张图标 */
      set(i, { iconUrl: d.icon_url, icon: '' });
      setIconNotice('');
    } catch (e) {
      setIconNotice(e instanceof Error ? e.message : t('forum_icon_upload_err', '图标上传失败'));
    } finally {
      setIconBusy(null);
    }
  };
  /* 移除只清配置，不删 R2 对象：该图可能仍被线上已保存的顶栏引用，
     未被引用的文件由「存储维护」按 site/ 前缀判定孤儿后回收 */
  const clearIcon = (i: number) => set(i, { iconUrl: '', icon: '' });

  /* 未预填（= 已保存过自定义导航）且有条目 → 显示已配置计数；预填态提示「未配置」 */
  const configured = rows.length > 0 && !prefilled;

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_menu_nav_setting', '导航栏')}</PageTitle>
      <Card
        title={t('nav_setting_title', '前台顶部导航栏')}
        footer={t(
          'nav_setting_hint',
          '导航项可链接到版块、文章或自定义地址，并可上传一张图标（png/jpg/gif/webp/bmp，≤1M，显示在名称左侧）；每项可随时开关「显示」。一条都不保留（清空保存）时前台恢复默认导航（首页 + 版块列表）。链接类型选「版块」从下拉选择，选「文章」填主题 ID，选「自定义」填站内路径或完整网址。',
        )}
      >
        {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
        {iconNotice && <Alert tone="warn">{iconNotice}</Alert>}
        {configured && (
          <p className="mb-2 text-sm text-muted-2">
            {t('nav_current_count', '已配置 {n} 个导航项（含停用项）', { n: rows.length }).replace(
              '{n}',
              String(rows.length),
            )}
          </p>
        )}
        {!configured && (
          <p className="mb-2 text-sm text-muted-2">
            {t(
              'nav_empty_hint',
              '当前未配置，以下为前台顶栏正在显示的默认版块项，可直接修改后保存；全部删除后保存即恢复默认导航。',
            )}
          </p>
        )}
        <div className="space-y-2">
          {rows.map((r, i) => {
            /** 已配置的界面语言数（仅用于按钮上的提示标记） */
            const i18nCount = Object.keys(r.labels ?? {}).length;
            return (
              <div key={i} className="rounded-[6px] border border-line-soft p-2.5">
                {/* 单行排布：名称 → 图标 → 语言 → 链接类型 → 目标 → 右侧开关/排序/删除。
                    控件基础样式自带 w-full（Tailwind v4 中 .w-full 排在 .w-[..] 之后，覆盖行内定宽），
                    故宽度一律由定宽包裹层锁定，与 CardAdminPage 同口径。 */}
                <div className="flex flex-wrap items-center gap-2">
                  {/* 名称（默认名称） */}
                  <div className="w-40">
                    <Input
                      value={r.label}
                      placeholder={t('nav_item_label', '名称')}
                      aria-label={t('nav_item_label', '名称')}
                      onChange={(e) => set(i, { label: e.target.value })}
                    />
                  </div>
                  {/* 图标：点击缩略图选本地图片上传/更换（选图即传，直链随「确定」写入该行 iconUrl）；
                      未上传时显示占位图，历史配置的内置图标名也在这里回显。 */}
                  <label
                    className={cx(
                      'relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[6px] border border-line-soft bg-muted',
                      iconBusy === i ? 'cursor-progress opacity-60' : 'cursor-pointer',
                    )}
                    aria-label={t('nav_item_icon_title', '导航项图标')}
                    title={
                      r.iconUrl || isIconName(r.icon)
                        ? t('nav_icon_replace', '更换图标')
                        : t('nav_icon_upload', '上传图标')
                    }
                  >
                    {r.iconUrl ? (
                      <img src={r.iconUrl} alt="" className="size-full object-contain" />
                    ) : isIconName(r.icon) ? (
                      <Icon name={r.icon} className="size-4" />
                    ) : (
                      <Icon name="image" className="size-4 opacity-50" />
                    )}
                    <input
                      type="file"
                      accept=".png,.jpg,.jpeg,.gif,.webp,.bmp"
                      className="hidden"
                      disabled={iconBusy === i}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        void onIconFile(i, f);
                      }}
                    />
                  </label>
                  {(r.iconUrl || r.icon) && (
                    <Button
                      size="sm"
                      variant="default"
                      aria-label={t('nav_icon_remove', '移除图标')}
                      onClick={() => clearIcon(i)}
                    >
                      {t('nav_icon_remove', '移除图标')}
                    </Button>
                  )}
                  {/* 名称多语言：前台按站点语言取词，未填写的语言回退默认名称 */}
                  <Button
                    variant="default"
                    title={t('nav_item_name_i18n_title', '导航项名称多语言')}
                    onClick={() => setI18nEdit({ index: i, name: r.label, value: r.labels })}
                  >
                    {t('forum_name_i18n', '语言')}
                    {i18nCount > 0 ? ` (${i18nCount})` : ''}
                  </Button>
                  {/* 链接类型 */}
                  <div className="w-28">
                    <Select
                      value={r.type}
                      aria-label={t('nav_item_type', '链接类型')}
                      onChange={(e) => set(i, { type: e.target.value as NavRow['type'] })}
                    >
                      <option value="forum">{t('nav_type_forum', '版块')}</option>
                      <option value="thread">{t('nav_type_thread', '文章')}</option>
                      <option value="custom">{t('nav_type_custom', '自定义')}</option>
                    </Select>
                  </div>
                  {/* 目标：版块下拉 / 文章 tid / 自定义地址 */}
                  {r.type === 'forum' && (
                    <div className="w-44">
                      <Select
                        value={r.fid}
                        aria-label={t('nav_pick_forum', '选择版块')}
                        onChange={(e) => set(i, { fid: e.target.value })}
                      >
                        <option value="">{t('nav_pick_forum', '选择版块')}</option>
                        {forumlist.map((f) => (
                          <option key={f.fid} value={f.fid}>
                            {f.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                  {r.type === 'thread' && (
                    <div className="w-32">
                      <Input
                        type="number"
                        min={1}
                        value={r.tid}
                        placeholder={t('nav_thread_tid', '主题 ID')}
                        aria-label={t('nav_thread_tid', '主题 ID')}
                        onChange={(e) => set(i, { tid: e.target.value })}
                      />
                    </div>
                  )}
                  {r.type === 'custom' && (
                    <div className="w-56">
                      <Input
                        value={r.url}
                        placeholder={t('nav_custom_url', '链接地址，如 /new 或 https://')}
                        aria-label={t('nav_custom_url', '链接地址')}
                        onChange={(e) => set(i, { url: e.target.value })}
                      />
                    </div>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    {/* 「是否显示」开关：关掉只影响前台显示，配置与图标都保留；带文字标签，避免只剩一个哑开关 */}
                    <Switch
                      checked={r.on}
                      onChange={(v) => set(i, { on: v })}
                      title={t('nav_item_on', '启用')}
                      label={<span className="text-xs text-muted-2">{t('nav_item_on', '启用')}</span>}
                    />
                    <Button
                      size="sm"
                      variant="default"
                      disabled={i === 0}
                      aria-label={t('nav_move_up', '上移')}
                      onClick={() => move(i, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="default"
                      disabled={i === rows.length - 1}
                      aria-label={t('nav_move_down', '下移')}
                      onClick={() => move(i, 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={t('nav_delete', '删除')}
                      onClick={() => remove(i)}
                    >
                      {t('delete', '删除')}
                    </Button>
                  </div>
                </div>
                {/* 生成的链接预览（无效输入提示） */}
                <p
                  className={cx(
                    'mt-1.5 text-xs',
                    toItem(r, i).url ? 'text-muted-2' : 'text-danger',
                  )}
                >
                  {toItem(r, i).url
                    ? t('nav_link_preview', '链接：{url}', { url: toItem(r, i).url }).replace(
                        '{url}',
                        toItem(r, i).url,
                      )
                    : t('nav_link_missing', '请完整填写名称和链接目标')}
                </p>
              </div>
            );
          })}
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

      <NameI18nModal
        open={i18nEdit !== null}
        name={i18nEdit?.name ?? ''}
        value={i18nEdit?.value}
        title={t('nav_item_name_i18n_title', '导航项名称多语言')}
        onSave={(next, defaultName) => {
          if (i18nEdit) set(i18nEdit.index, { labels: next, label: defaultName });
          setI18nEdit(null);
        }}
        onClose={() => setI18nEdit(null)}
      />
    </div>
  );
}
