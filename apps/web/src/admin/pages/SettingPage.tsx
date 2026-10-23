/**
 * 站点设置（模式 C 满宽）：写回的是 kv 'setting' 的 **snake_case 原始 JSON**
 * （PUT 走服务端白名单 merge，未提交的键与扩展自建键原样保留），
 * 与前台 useAuth().setting 的 camelCase 规范化视图是两套口径，勿混用。
 * runlevel 闸门中间件每请求直读 kv（不走缓存），保存后全站即时生效。
 *
 * 版式核实：
 *  - 顶部二级 Tab 两档（基本设置 / 邮箱设置）；
 *  - 卡体直接以表单开头，不补标题；
 *  - 字段顺序 = sitename / sitebrief / runlevel / user_create_on / user_create_email_on / user_resetpw_on / lang；
 *  - runlevel 与三个 *_on 都是 **radio 组**（横排单选），不是下拉框，
 *    runlevel 的六档文案取 `runlevel_0..5`（5 档原话是「所有人可读写」）；
 *  - sitebrief 是固定 100px 高的 textarea，下面跟一行 `sitebrief_tips`
 *    （该串存的是 HTML 实体 `&lt;br&gt;`，回显前要解一次实体）。
 * 基础 7 个字段之外，`url/kw/desc`（SEO）、`runlevel_reason`、`forum_orderby`、`update_views_on`、
 * `upload_max_size` 是本项目要在后台可改的键，统一排在基础字段之后、提交按钮之前（§7 记账）。
 */
import { useEffect, useState, type ComponentProps } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AVAILABLE_LOCALES, RunLevel, type AdminKey } from '@freeidx/shared';
import { getSetting, putSetting, uploadSiteLogo, deleteSiteLogo, uploadSiteFavicon, deleteSiteFavicon } from '../api';
import type { AdminSettingInput, AdminSettingMap } from '../types';
import { useAdminT } from '../t';
import { useAdminAction } from '../use-action';
import { useAuth } from '../../store/auth';
import { SETTING_TABS } from '../tabs';
import { Alert, Button, Card, ErrorState, Field as BaseField, Input, PageTitle, RadioGroup, Select, SubmitRow, TabBar, Textarea } from '../ui';

const str = (v: unknown, fb = ''): string => (v === undefined || v === null ? fb : String(v));
const num = (v: unknown, fb = 0): number => (Number.isFinite(Number(v)) ? Number(v) : fb);
const bool01 = (v: unknown): number => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

/** lang 下拉十个 locale → 显示名 */
const LANG_NAMES: Record<string, AdminKey> = {
  'zh-cn': 'lang_zh_cn',
  'zh-tw': 'lang_zh_tw',
  'en-us': 'lang_en_us',
  'ru-ru': 'lang_ru_ru',
  'th-th': 'lang_th_th',
  'de-de': 'lang_de_de',
  'ja-jp': 'lang_ja_jp',
  'ko-kr': 'lang_ko_kr',
  'es-es': 'lang_es_es',
  'fr-fr': 'lang_fr_fr',
};


/**
 * 本页统一字段版式：标签栏定宽 85px；文本类控件（输入框/文本域/下拉）定宽 500px，
 * 说明文字排在控件右侧（hintInline 的单选组行仍走「控件流式 + 说明同行」）。
 */
function SettingField({ hintInline, children, ...rest }: Omit<ComponentProps<typeof BaseField>, 'labelClass' | 'controlClass' | 'hintAfter'>) {
  return (
    <BaseField
      {...rest}
      hintInline={hintInline}
      labelClass="sm:w-[85px]"
      controlClass={hintInline ? 'sm:w-10/12' : 'sm:w-[500px] sm:shrink-0'}
      hintAfter={!hintInline}
    >
      {children}
    </BaseField>
  );
}

export function SettingPage() {
  const t = useAdminT();
  const q = useQuery({ queryKey: ['admin', 'setting'], queryFn: getSetting });
  const [form, setForm] = useState<AdminSettingInput | null>(null);
  /** Logo/Favicon 直链（上传即生效，不走表单 PUT；与 form 分离避免误提交） */
  const [logoUrl, setLogoUrl] = useState('');
  const [faviconUrl, setFaviconUrl] = useState('');
  const [iconMsg, setIconMsg] = useState('');

  useEffect(() => {
    if (!q.data || form) return;
    const raw = q.data as AdminSettingMap;
    setForm({
      sitename: str(raw.sitename),
      brief: str(raw.brief),
      url: str(raw.url),
      kw: str(raw.kw),
      desc: str(raw.desc),
      runlevel: num(raw.runlevel, RunLevel.NORMAL),
      runlevel_reason: str(raw.runlevel_reason),
      user_create_on: bool01(raw.user_create_on ?? 1),
      user_create_email_on: bool01(raw.user_create_email_on),
      user_resetpw_on: bool01(raw.user_resetpw_on ?? 1),
      device_phone_on: bool01(raw.device_phone_on ?? 1),
      device_tablet_on: bool01(raw.device_tablet_on ?? 1),
      device_tv_on: bool01(raw.device_tv_on ?? 1),
      forum_orderby: num(raw.forum_orderby) === 1 ? 1 : 0,
      update_views_on: bool01(raw.update_views_on ?? 1),
      content_lang: num(raw.content_lang),
      upload_max_size: num(raw.upload_max_size, 20 * 1024 * 1024),
      lang: str(raw.lang, 'en-us'),
      admin_lang: str(raw.admin_lang, str(raw.lang, 'en-us')),
    });
    setLogoUrl(str(raw.logo_url));
    setFaviconUrl(str(raw.favicon_url));
  }, [q.data, form]);

  const refresh = useAuth((s) => s.refresh);
  const save = useAdminAction(
    async () => {
      const r = await putSetting(form ?? {});
      await refresh(); // 前台 navbar/标题读的是规范化 setting，同步刷新全局态
      return r;
    },
    { ok: t('setting_save_success', '保存成功，前台下次请求即生效（零部署）'), invalidate: [['admin', 'setting']] },
  );
  const set = <K extends keyof AdminSettingInput>(k: K, v: AdminSettingInput[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  /** 站点 Logo / Favicon 上传（选图即传：data URL → PUT /api/admin/setting/:kind，服务端落 R2 并写 kv setting） */
  const uploadIcon = async (kind: 'logo' | 'favicon', file: File | undefined) => {
    if (!file) return;
    const isIco = file.type === 'image/x-icon' || file.type === 'image/vnd.microsoft.icon' || /\.ico$/i.test(file.name);
    if (!/^image\/(png|jpeg|gif|webp|bmp)$/.test(file.type) && !(kind === 'favicon' && isIco)) {
      setIconMsg(t('forum_icon_format_err', '图标仅支持 png / jpg / gif / webp / bmp 格式。'));
      return;
    }
    if (file.size > 1024 * 1024) {
      setIconMsg(t('forum_icon_size_err', '图标不能超过 1M。'));
      return;
    }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error(t('forum_icon_read_err', '图片读取失败')));
        fr.readAsDataURL(file);
      });
      if (kind === 'logo') setLogoUrl((await uploadSiteLogo(data)).logo_url);
      else setFaviconUrl((await uploadSiteFavicon(data)).favicon_url);
      setIconMsg('');
      await refresh(); // 顶栏 logo / 标签页 favicon 读全局 setting，同步刷新
    } catch (e) {
      setIconMsg(e instanceof Error ? e.message : t('forum_icon_upload_err', '图标上传失败'));
    }
  };

  /** 恢复默认：清 R2 对象与 setting 键（logo 回落自绘字标，favicon 回落无图标） */
  const resetIcon = async (kind: 'logo' | 'favicon') => {
    try {
      if (kind === 'logo') {
        await deleteSiteLogo();
        setLogoUrl('');
      } else {
        await deleteSiteFavicon();
        setFaviconUrl('');
      }
      setIconMsg('');
      await refresh();
    } catch (e) {
      setIconMsg(e instanceof Error ? e.message : t('forum_icon_reset_err', '恢复默认失败'));
    }
  };

  if (q.isError) return <ErrorState error={q.error} />;
  if (!form) return <Card>{t('setting_loading', '设置加载中…')}</Card>;

  const runlevelKeys = ['runlevel_0', 'runlevel_1', 'runlevel_2', 'runlevel_3', 'runlevel_4', 'runlevel_5'] as const;
  const runlevelOptions = runlevelKeys.map((k, v) => ({ value: v, text: t(k, String(v)) }));
  const yesNo = [
    { value: 1, text: t('yes', '是') },
    { value: 0, text: t('no', '否') },
  ];

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_site_setting', '站点设置')}</PageTitle>
      <TabBar active="base" items={SETTING_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
      <Card>
        <SettingField label={t('sitename', '站点名称')} htmlFor="s-sitename" hint={t('sitename_hint', '显示在浏览器标签页标题和页面顶栏')}>
          <Input id="s-sitename" value={form.sitename ?? ''} onChange={(e) => set('sitename', e.target.value)} />
        </SettingField>
        {/* Logo / Favicon：选图即传（上传即生效），恢复默认即时清空；错误提示两行共用 */}
        <SettingField label={t('setting_logo', '前台 Logo')} hint={t('setting_logo_hint', '显示在页面顶栏、登录/注册页；建议透明底 PNG，高度不低于 40px')} hintInline>
          <div className="flex flex-wrap items-center gap-3">
            {logoUrl ? (
              <img src={logoUrl} alt={t('setting_logo', '前台 Logo')} className="h-10 max-w-[180px] rounded object-contain" />
            ) : (
              <span className="text-sm text-muted-2">{t('forum_icon_default', '内置默认图')}</span>
            )}
            {/* 自定义「选择文件」钮 + 隐藏原生控件：原生 file 控件文案随浏览器语言，不走站点 i18n */}
            <label
              className="inline-flex cursor-pointer items-center rounded bg-muted px-2 py-1 text-xs text-ink transition-colors hover:bg-line"
              aria-label={t('setting_logo', '前台 Logo')}
            >
              {t('choose_file', '选择文件')}
              <input
                type="file"
                multiple={false}
                accept=".jpg,.jpeg,.png,.gif,.webp,.bmp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  void uploadIcon('logo', f);
                }}
              />
            </label>
            {logoUrl && (
              <Button size="sm" variant="default" onClick={() => void resetIcon('logo')}>
                {t('forum_icon_reset', '恢复默认')}
              </Button>
            )}
          </div>
        </SettingField>
        <SettingField label={t('setting_favicon', '站点图标')} hint={t('setting_favicon_hint', '显示在浏览器标签页上；建议 64×64 以上正方形 PNG 或 ICO 图')} hintInline>
          <div className="flex flex-wrap items-center gap-3">
            {faviconUrl ? (
              <img src={faviconUrl} alt={t('setting_favicon', '站点图标')} className="size-10 rounded object-contain" />
            ) : (
              <span className="text-sm text-muted-2">{t('forum_icon_default', '内置默认图')}</span>
            )}
            <label
              className="inline-flex cursor-pointer items-center rounded bg-muted px-2 py-1 text-xs text-ink transition-colors hover:bg-line"
              aria-label={t('setting_favicon', '站点图标')}
            >
              {t('choose_file', '选择文件')}
              <input
                type="file"
                multiple={false}
                accept=".jpg,.jpeg,.png,.gif,.webp,.bmp,.ico"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  void uploadIcon('favicon', f);
                }}
              />
            </label>
            {faviconUrl && (
              <Button size="sm" variant="default" onClick={() => void resetIcon('favicon')}>
                {t('forum_icon_reset', '恢复默认')}
              </Button>
            )}
          </div>
        </SettingField>
        {iconMsg && <p className="text-sm text-danger">{iconMsg}</p>}
        {/* 该提示串在词条源里写的是实体 &lt;br&gt;（输出正好显示成 <br> 字面量），React 走文本节点要先解实体 */}
        <SettingField
          label={t('sitebrief', '站点介绍')}
          htmlFor="s-brief"
          hint={t('sitebrief_tips', '注：支持 HTML 标签，换行请使用 <br>').replace(/&lt;/g, '<').replace(/&gt;/g, '>')}
        >
          <Textarea id="s-brief" className="h-[100px] min-h-0" value={form.brief ?? ''} onChange={(e) => set('brief', e.target.value)} />
        </SettingField>
        <SettingField label={t('runlevel', '站点访问')} hint={t('runlevel_hint', '选择「所有人可读写」以外的级别时，权限不足的访客将被限制访问')} hintInline>
          <RadioGroup name="runlevel" value={form.runlevel ?? RunLevel.NORMAL} options={runlevelOptions} onChange={(v) => set('runlevel', Number(v))} />
        </SettingField>
        <SettingField label={t('user_create_on', '开启注册')}>
          <RadioGroup name="user_create_on" value={form.user_create_on ?? 1} options={yesNo} onChange={(v) => set('user_create_on', Number(v))} />
        </SettingField>
        <SettingField label={t('user_create_email_on', '邮箱验证')}>
          <RadioGroup name="user_create_email_on" value={form.user_create_email_on ?? 0} options={yesNo} onChange={(v) => set('user_create_email_on', Number(v))} />
        </SettingField>
        <SettingField label={t('user_resetpw_on', '找回密码')}>
          <RadioGroup name="user_resetpw_on" value={form.user_resetpw_on ?? 1} options={yesNo} onChange={(v) => set('user_resetpw_on', Number(v))} />
        </SettingField>
        {/* 设备访问三开关：控制手机/平板/电视端能否打开前台（后台 /admin 不受限） */}
        <SettingField label={t('setting_device_phone', '手机访问')} hint={t('setting_device_phone_hint', '关闭后，手机设备访问前台时将显示受限提示页')} hintInline>
          <RadioGroup name="device_phone_on" value={form.device_phone_on ?? 1} options={yesNo} onChange={(v) => set('device_phone_on', Number(v))} />
        </SettingField>
        <SettingField label={t('setting_device_tablet', '平板访问')} hint={t('setting_device_tablet_hint', '关闭后，平板设备访问前台时将显示受限提示页')} hintInline>
          <RadioGroup name="device_tablet_on" value={form.device_tablet_on ?? 1} options={yesNo} onChange={(v) => set('device_tablet_on', Number(v))} />
        </SettingField>
        <SettingField label={t('setting_device_tv', '电视访问')} hint={t('setting_device_tv_hint', '关闭后，电视设备访问前台时将显示受限提示页')} hintInline>
          <RadioGroup name="device_tv_on" value={form.device_tv_on ?? 1} options={yesNo} onChange={(v) => set('device_tv_on', Number(v))} />
        </SettingField>
        <SettingField label={t('setting_front_lang', '前台语言')} htmlFor="s-lang" hint={t('lang_hint', '界面上缺少翻译的词条会自动使用简体中文')}>
          <Select id="s-lang" value={form.lang ?? 'en-us'} onChange={(e) => set('lang', e.target.value)}>
            {AVAILABLE_LOCALES.map((l) => (
              <option key={l} value={l}>
                {t(LANG_NAMES[l] ?? (l as AdminKey), l)}
              </option>
            ))}
          </Select>
        </SettingField>
        {/* 后台语言与前台站点语言相互独立（admin_lang；未配置时跟随上面的站点语言） */}
        <SettingField label={t('setting_admin_lang', '后台语言')} htmlFor="s-admin-lang" hint={t('setting_admin_lang_hint', '管理后台界面语言，与前台站点语言相互独立')}>
          <Select id="s-admin-lang" value={form.admin_lang ?? 'en-us'} onChange={(e) => set('admin_lang', e.target.value)}>
            {AVAILABLE_LOCALES.map((l) => (
              <option key={l} value={l}>
                {t(LANG_NAMES[l] ?? (l as AdminKey), l)}
              </option>
            ))}
          </Select>
        </SettingField>

        {/* 以下四项是本项目要暴露的运行/SEO 开关（§7） */}
        <SettingField label={t('setting_close_reason', '关闭原因')} htmlFor="s-runlevel_reason" hint={t('setting_close_reason_hint', '站点关闭或仅管理员可访问时，显示给访客的提示文字')}>
          <Input id="s-runlevel_reason" value={form.runlevel_reason ?? ''} onChange={(e) => set('runlevel_reason', e.target.value)} />
        </SettingField>
        <SettingField label={t('setting_site_url', '站点网址')} htmlFor="s-url" hint={t('setting_site_url_hint', '绑定了多个域名时填主域名（https:// 开头，只填域名，不带路径）。其他域名访问页面会自动 301 到这里；邮件链接、SEO 规范链接与站点地图、支付回跳也使用此地址。留空则使用当前访问域名')}>
          <Input id="s-url" value={form.url ?? ''} onChange={(e) => set('url', e.target.value)} placeholder="https://www.example.com" />
        </SettingField>
        <SettingField label={t('keyword', '关键词')} htmlFor="s-kw">
          <Input id="s-kw" value={form.kw ?? ''} onChange={(e) => set('kw', e.target.value)} />
        </SettingField>
        <SettingField label={t('setting_site_desc', '站点描述')} htmlFor="s-desc">
          <Textarea id="s-desc" value={form.desc ?? ''} onChange={(e) => set('desc', e.target.value)} />
        </SettingField>
        <SettingField label={t('setting_forum_orderby', '主题排序')} hint={t('setting_forum_orderby_hint', '按顶贴时间：有新回复的主题排到前面（默认）；按发帖时间：新发布的主题排在前面')} hintInline>
          <RadioGroup
            name="forum_orderby"
            value={form.forum_orderby ?? 0}
            options={[
              { value: 0, text: t('forum_orderby_top', '按顶贴时间') },
              { value: 1, text: t('forum_orderby_create', '按发帖时间') },
            ]}
            onChange={(v) => set('forum_orderby', Number(v))}
          />
        </SettingField>
        <SettingField label={t('setting_view_count', '浏览统计')} hint={t('setting_view_count_hint', '关闭后不再统计主题浏览次数，可减少数据库写入')} hintInline>
          <RadioGroup
            name="update_views_on"
            value={form.update_views_on ?? 1}
            options={yesNo}
            onChange={(v) => set('update_views_on', Number(v))}
          />
        </SettingField>
        {/* 内容语言分区：0=关闭（默认，行为不变） 1=开启默认全部 2=开启默认跟随界面语言 */}
        <SettingField
          label={t('setting_content_lang', '内容语言分区')}
          hint={t('setting_content_lang_hint', '按帖子内容语言过滤主题列表。关闭时行为与升级前完全一致；开启后前台出现语言筛选条，发帖时自动识别并可手动修改。存量帖需先在「数据库维护」中回填语言后才会参与过滤')}
        >
          <RadioGroup
            name="content_lang"
            value={form.content_lang ?? 0}
            options={[
              { value: 0, text: t('content_lang_mode_off', '关闭') },
              { value: 1, text: t('content_lang_mode_all', '开启（默认全部语言）') },
              { value: 2, text: t('content_lang_mode_ui', '开启（默认跟随界面语言）') },
            ]}
            onChange={(v) => set('content_lang', Number(v))}
          />
        </SettingField>
        <SettingField label={t('setting_upload_limit', '附件上限')} htmlFor="s-upload" hint={t('setting_upload_limit_hint', '{size} MB（填写单位为字节，最大不超过 100 MB）', { size: ((form.upload_max_size ?? 0) / 1024 / 1024).toFixed(1) })}>
          <Input
            id="s-upload"
            type="number"
            min={0}
            step={1024 * 1024}
            value={String(form.upload_max_size ?? 0)}
            onChange={(e) => set('upload_max_size', Number(e.target.value || 0))}
          />
        </SettingField>

        {/* 与 85px 标签栏 + 8px 行间距对齐（85 + 8 = 93px） */}
        <SubmitRow indentClass="sm:pl-[93px]">
          <Button block loading={save.pending} onClick={() => save.mutate()}>
            {t('confirm', '确定')}
          </Button>
        </SubmitRow>
      </Card>
    </div>
  );
}
