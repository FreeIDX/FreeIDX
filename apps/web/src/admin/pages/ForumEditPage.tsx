/**
 * 版块编辑 / 新增（模式 C + D1）：
 *  - 字段顺序：名称 / 排序(窄栏) / 简介 / 公告 / 版主 / 用户权限(accesson + 矩阵)
 *    （brief、announcement 都是 100%×80px textarea）；
 *  - 卡体第一行是卡内小标题「编辑 - 名称」，标题词取 i18n `forum_edit`（即「编辑」）；
 *  - 本版排序/绑定内容语言/SEO 是本项目扩展键，统一放到权限矩阵之后、提交按钮之前（§7 记账）；
 *    图标为**上传图片**（选图即传 PUT /:fid/icon 存 R2；未上传回退内置默认图），
 *    早期版本的「图标编号」输入已废弃，bbs_forum.icon 编号列仅作兼容保留；
 *  - 版主口径差异：接口直接收 UID（服务端负责与用户名的互转），故这里就按 UID 说明；
 *  - accesson 关闭时矩阵整块不渲染（开关切换语义，见 PermissionMatrix.enabled）；
 *  - 矩阵每次提交都**整体替换**（编辑表单总是提交当前矩阵），故必须带 access 键；
 *  - 游客（gid=0）不进矩阵：服务端 normAccess 丢弃 gid<=0，游客权限由用户组自身的 allowread 决定。
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CONTENT_LANGS, CONTENT_LANG_NATIVE_NAMES, FORUM_LANG_UNRESTRICTED, type ContentLang } from '@freeidx/shared';
import { createForum, getForums, updateForum, uploadForumIcon, deleteForumIcon } from '../api';
import type { AccessInput, ForumInput, GroupFullRow } from '../types';
import { useAdminT } from '../t';
import { useGroupName } from '../../lib/i18n';
import { useAdminAction } from '../use-action';
import { Icon } from '../../components/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ErrorState,
  Field,
  Input,
  LinkButton,
  PageTitle,
  PermissionMatrix,
  Select,
  SubmitRow,
  Textarea,
} from '../ui';

/** 矩阵五个权限档：标签键与矩阵 thead 一致 */
const PERM_KEYS = [
  { key: 'allowread', labelKey: 'allow_view' },
  { key: 'allowthread', labelKey: 'allow_thread' },
  { key: 'allowpost', labelKey: 'allow_post' },
  { key: 'allowattach', labelKey: 'allow_upload' },
  { key: 'allowdown', labelKey: 'allow_download' },
] as const;

const EMPTY: ForumInput = {
  name: '',
  rank: 0,
  brief: '',
  announcement: '',
  accesson: 0,
  orderby: 0,
  icon: 0,
  moduids: '',
  seo_title: '',
  seo_keywords: '',
  parent_fid: 0,
  lang: '',
};

type Matrix = Record<number, Record<string, number>>;

export function ForumEditPage() {
  const t = useAdminT();
  const gn = useGroupName();
  const navigate = useNavigate();
  const routeFid = Number(useParams().fid ?? 0);
  const isNew = !routeFid;
  const q = useQuery({ queryKey: ['admin', 'forums'], queryFn: getForums });

  const [form, setForm] = useState<ForumInput | null>(null);
  const [matrix, setMatrix] = useState<Matrix>({});
  /** 版块图标直链（选图即传，不随表单提交；''=内置默认图） */
  const [iconUrl, setIconUrl] = useState('');
  const [iconNotice, setIconNotice] = useState('');

  useEffect(() => {
    if (!q.data || form) return;
    if (isNew) {
      setForm({ ...EMPTY });
      // 新版块默认给所有真实用户组全开（默认建表口径），管理员可再收紧
      const seed: Matrix = {};
      for (const g of q.data.groups.filter(usableGroup)) seed[g.gid] = Object.fromEntries(PERM_KEYS.map((p) => [p.key, 1]));
      setMatrix(seed);
      return;
    }
    const row = q.data.forums.find((f) => f.fid === routeFid);
    if (!row) return;
    setForm({
      name: row.name,
      rank: row.rank,
      brief: row.brief,
      announcement: row.announcement,
      accesson: row.accesson,
      orderby: row.orderby,
      icon: row.icon,
      moduids: row.moduids,
      seo_title: row.seo_title,
      seo_keywords: row.seo_keywords,
      parent_fid: row.parent_fid,
      lang: row.lang ?? '',
    });
    setIconUrl(row.icon_url);
    const seed: Matrix = {};
    for (const g of q.data.groups.filter(usableGroup)) {
      const a = row.accesslist[String(g.gid)];
      seed[g.gid] = Object.fromEntries(PERM_KEYS.map((p) => [p.key, Number(a?.[p.key as keyof AccessInput] ?? 0)]));
    }
    setMatrix(seed);
  }, [q.data, form, isNew, routeFid]);

  /** 图标选图即传（与列表页同一上传语义，编辑页提供同等入口）；isNew 无 fid 先保存再传 */
  const onIconFile = async (file: File | undefined) => {
    if (!file) return;
    if (isNew) {
      setIconNotice(t('forum_icon_new_hint', '新板块请先「确定」创建后再上传图标。'));
      return;
    }
    if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type)) {
      setIconNotice(t('forum_icon_format_err', '图标仅支持 png / jpg / gif / webp / bmp 格式。'));
      return;
    }
    if (file.size > 1024 * 1024) {
      setIconNotice(t('forum_icon_size_err', '图标不能超过 1M。'));
      return;
    }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error(t('forum_icon_read_err', '图片读取失败')));
        fr.readAsDataURL(file);
      });
      const d = await uploadForumIcon(routeFid, data);
      setIconUrl(d.icon_url);
      setIconNotice('');
    } catch (e) {
      setIconNotice(e instanceof Error ? e.message : t('forum_icon_upload_err', '图标上传失败'));
    }
  };

  const resetIcon = async () => {
    if (isNew) return;
    try {
      await deleteForumIcon(routeFid);
      setIconUrl('');
      setIconNotice('');
    } catch (e) {
      setIconNotice(e instanceof Error ? e.message : t('forum_icon_reset_err', '恢复默认失败'));
    }
  };

  const set = <K extends keyof ForumInput>(k: K, v: ForumInput[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const groups = (q.data?.groups ?? []).filter(usableGroup);
  /** 二级版块：本版块已有子版块 → 锁定父选择（保持一级，避免三级）；父候选 = 一级版块（排除自身） */
  const hasChildren = routeFid > 0 && (q.data?.forums ?? []).some((f) => f.parent_fid === routeFid);
  const parentOptions = (q.data?.forums ?? []).filter((f) => f.parent_fid === 0 && f.fid !== routeFid);
  /** 父版块（仅两级）：子版块留空 = 继承父版块语言，故空选项文案随父版块是否已绑定而变化 */
  const parentForum = (q.data?.forums ?? []).find((f) => f.fid === (form?.parent_fid ?? 0));
  const parentLangName = parentForum?.lang ? CONTENT_LANG_NATIVE_NAMES[parentForum.lang as ContentLang] : '';

  const submit = useAdminAction(
    async () => {
      const access = toAccess(matrix);
      const body: ForumInput = { ...(form ?? EMPTY), access };
      if (isNew) {
        const d = await createForum(body);
        navigate(`/admin/forums/${d.fid}/edit`, { replace: true });
        return d;
      }
      return updateForum(routeFid, body);
    },
    { ok: isNew ? t('forum_create_success', '创建成功') : t('forum_save_success', '保存成功'), invalidate: [['admin', 'forums'], ['admin', 'runtime']] },
  );

  if (q.isError) return <ErrorState error={q.error} />;
  if (!form && !q.isPending) return <Card>{t('forum_not_found_id', '版块 {fid} 不存在。', { fid: routeFid })}</Card>;
  if (!form) return <Card>{t('loading', '加载中…')}</Card>;

  return (
    <div className="space-y-3">
      <PageTitle>{isNew ? t('admin_forum_add', '新增版块') : `${t('forum_edit', '编辑版块')} - ${form.name || routeFid}`}</PageTitle>
      {submit.flash && <Alert tone={submit.flash.tone}>{submit.flash.text}</Alert>}

      <Card>
        {/* 卡体第一行是卡内小标题「编辑 - 名称」，`margin:0` 去掉 h4 默认的 .5rem 下边距，故标题与首个字段之间无额外空隙 */}
        <h4 className="mb-0 text-[1.1rem] font-normal leading-[1.2]">
          {isNew ? t('admin_forum_add', '新增版块') : `${t('forum_edit', '编辑')} - ${form.name}`}
        </h4>
        <Field label={t('forum_name', '名称')} htmlFor="f-name">
          <Input id="f-name" value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field
          label={t('forum_parent', '父版块')}
          htmlFor="f-parent"
          controlClass="sm:w-4/12"
          hint={hasChildren ? t('forum_parent_locked', '该版块已有子版块，不能改为子版块') : t('forum_parent_hint', '仅支持两级：选一个一级版块即为二级版块')}
        >
          <Select
            id="f-parent"
            value={String(form.parent_fid ?? 0)}
            disabled={hasChildren}
            onChange={(e) => {
              const next = Number(e.target.value || 0);
              set('parent_fid', next);
              /* 顶级版块的「显式不限制」与空串等价：切回顶级时清掉哨兵，否则下拉会出现无对应选项的空值 */
              if (next === 0 && form.lang === FORUM_LANG_UNRESTRICTED) set('lang', '');
            }}
          >
            <option value="0">{t('forum_parent_top', '顶级版块')}</option>
            {parentOptions.map((f) => (
              <option key={f.fid} value={f.fid}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('rank', '排序')} htmlFor="f-rank" controlClass="sm:w-3/12" hint={t('forum_rank_hint', '数字越小越靠前')}>
          <Input id="f-rank" type="number" value={String(form.rank ?? 0)} onChange={(e) => set('rank', Number(e.target.value || 0))} />
        </Field>
        <Field label={t('forum_brief', '简介')} hint={t('forum_brief_hint', '前台版块页标题下方一行')}>
          <Textarea className="h-[80px] min-h-0" value={form.brief ?? ''} onChange={(e) => set('brief', e.target.value)} />
        </Field>
        <Field label={t('forum_anouncement', '版块公告')} hint={t('forum_announcement_hint', '进入本版块的置顶公告条')}>
          <Textarea className="h-[80px] min-h-0" value={form.announcement ?? ''} onChange={(e) => set('announcement', e.target.value)} />
        </Field>
        <Field label={t('moderator', '版主')} hint={t('forum_moderator_hint', '逗号分隔的用户 ID，如 3,17；版主可在前台管理本版块')}>
          <Input value={form.moduids ?? ''} onChange={(e) => set('moduids', e.target.value)} placeholder="3,17" />
        </Field>

        <Field label={t('user_privilege', '用户权限')}>
          <p className="mb-[1rem]">
            <Checkbox checked={form.accesson === 1} onChange={(v) => set('accesson', v ? 1 : 0)} label={t('enable', '启用')} />
          </p>
          <PermissionMatrix
            groups={groups.map((g) => ({ gid: g.gid, name: gn(g.gid, g.name) }))}
            perms={PERM_KEYS.map((p) => ({ key: p.key, label: t(p.labelKey) }))}
            value={matrix}
            enabled={form.accesson === 1}
            onChange={(gid, key, checked) =>
              setMatrix((m) => ({ ...m, [gid]: { ...(m[gid] ?? {}), [key]: checked ? 1 : 0 } }))
            }
          />
          {form.accesson === 1 && (
            <p className="mt-2 text-xs text-muted-2">{t('forum_perm_matrix_note', '注：勾选「全选」会同步整行；保存时矩阵整体替换本版块的权限记录，游客组不在此表内。')}</p>
          )}
        </Field>

        {/* 以下三项是本项目在本版块上额外的可配键（§7） */}
        <Field label={t('forum_orderby_label', '本版排序')} hint={t('forum_orderby_hint', '填 0 表示跟随全站「主题排序」设置')}>
          <Select value={String(form.orderby ?? 0)} onChange={(e) => set('orderby', e.target.value === '1' ? 1 : 0)}>
            <option value="0">{t('forum_orderby_top', '按顶贴时间')}</option>
            <option value="1">{t('forum_orderby_create', '按发帖时间')}</option>
          </Select>
        </Field>
        {/* 内容语言绑定（0024）：留空 = 顶级版块不限制 / 子版块继承父版块；
            「全部语言」= 显式不限制（仅子版块出现，用于解除继承）；具体语言 = 本版块新主题强制该语言 */}
        <Field label={t('content_lang_label')} hint={t('forum_content_lang_hint')}>
          <Select value={form.lang ?? ''} onChange={(e) => set('lang', e.target.value)}>
            <option value="">
              {form.parent_fid
                ? `${t('forum_content_lang_inherit')}${parentLangName ? ` · ${parentLangName}` : ''}`
                : t('content_lang_auto')}
            </option>
            {form.parent_fid ? <option value={FORUM_LANG_UNRESTRICTED}>{t('content_lang_all')}</option> : null}
            {CONTENT_LANGS.map((l) => (
              <option key={l} value={l}>
                {CONTENT_LANG_NATIVE_NAMES[l]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('forum_icon', '图标')}
          hint={t('forum_icon_hint', '上传图片作为版块图标（png/jpg/gif/webp/bmp，≤1M）；未上传时前台使用内置默认图')}
        >
          <div className="flex flex-wrap items-center gap-3">
            {iconUrl ? (
              <img src={iconUrl} alt={t('forum_icon_alt', '版块图标')} className="size-12 rounded object-contain" />
            ) : (
              <span className="grid size-12 place-items-center rounded bg-muted text-muted-2" title={t('forum_icon_default', '内置默认图')}>
                <Icon name="folder" className="size-6" />
              </span>
            )}
            {/* 自定义「选择文件」钮 + 隐藏原生控件：原生 file 控件文案随浏览器语言，不走站点 i18n */}
            <label
              className="inline-flex cursor-pointer items-center rounded bg-muted px-2 py-1 text-xs text-ink transition-colors hover:bg-line"
              aria-label={t('forum_icon_upload_label', '上传版块图标')}
            >
              {t('choose_file')}
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.gif,.webp,.bmp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  void onIconFile(f);
                }}
              />
            </label>
            {iconUrl && !isNew && (
              <Button variant="secondary" onClick={() => void resetIcon()}>
                {t('forum_icon_reset', '恢复默认')}
              </Button>
            )}
          </div>
          {iconNotice && <p className="mt-2 text-xs text-destructive">{iconNotice}</p>}
        </Field>
        <Field label={t('forum_seo_title', 'SEO 标题')} hint={t('forum_seo_title_hint', '留空则用「版块名 - 站点名」')}>
          <Input value={form.seo_title ?? ''} onChange={(e) => set('seo_title', e.target.value)} />
        </Field>
        <Field label={t('forum_seo_keywords', 'SEO 关键词')}>
          <Input value={form.seo_keywords ?? ''} onChange={(e) => set('seo_keywords', e.target.value)} />
        </Field>

        <SubmitRow>
          <Button block loading={submit.pending} onClick={() => submit.mutate()}>
            {t('confirm', '确定')}
          </Button>
          <LinkButton to="/admin/forums" variant="secondary" className="mt-[1rem] w-full">
            {t('back', '返回')}
          </LinkButton>
        </SubmitRow>
      </Card>
    </div>
  );
}

/** 游客(gid=0) 不进矩阵：服务端 normAccess 丢弃 gid<=0，游客读权限由用户组自身的 allowread 决定 */
function usableGroup(g: GroupFullRow): boolean {
  return g.gid > 0;
}

function toAccess(matrix: Matrix): AccessInput[] {
  return Object.entries(matrix).map(([gid, v]) => ({
    gid: Number(gid),
    allowread: Number(v.allowread ?? 0),
    allowthread: Number(v.allowthread ?? 0),
    allowpost: Number(v.allowpost ?? 0),
    allowattach: Number(v.allowattach ?? 0),
    allowdown: Number(v.allowdown ?? 0),
  }));
}
