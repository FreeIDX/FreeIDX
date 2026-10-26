import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { CONTENT_LANG_NATIVE_NAMES, CONTENT_LANGS, detectContentLang, type ContentLang } from '@freeidx/shared';
import { BanScope, effectiveBanScope } from '@freeidx/shared';
import { createThread } from '../../../lib/api';
import { Composer, type ComposerSubmit } from '../../../components/Composer';
import { Alert, Button, Card, CardTabs, Modal, TagBadge, cx, inputCls } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { useAuth } from '../../../store/auth';
import { useContentLangMode } from '../../../store/contentLang';
import { useLight } from '../../../store/theme';
import { useAuthModal } from '../../../store/authModal';
import { useT } from '../../../lib/i18n';

/** 发帖页（§4.4，/new 或 /forum/:fid/new）：
 *  两栏 —— 左主表单卡（8/12 栅格：版块/标题 + Composer + 标签选择 + 收费设置）、
 *  右功能卡（4/12 栅格，tabs 功能/附件，sticky）。提交仍走 Composer 内按钮 → POST /api/threads（doctype=0）。 */
export function ComposePage() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const routeParams = useParams();
  const [search] = useSearchParams();
  const forumlist = useAuth((s) => s.forumlist);
  const grouplist = useAuth((s) => s.grouplist);
  const me = useAuth((s) => s.me);
  const loaded = useAuth((s) => s.loaded);
  const setting = useAuth((s) => s.setting);
  const openAuth = useAuthModal((s) => s.openAuth);
  const refresh = useAuth((s) => s.refresh);
  const light = useLight();
  const tags = light.tags;
  /* 站点「内容语言」开关：0=关闭 → 整个语言行不渲染（与升级前一致）；>0=开启 → 显示/锁定 */
  const langMode = useContentLangMode();

  // 冷加载 /new 时 forumlist 尚未就绪，useState 初值会永远停在 0 ⇒ 目标版块改为派生，用户手选才覆盖
  const [pickedFid, setPickedFid] = useState(0);
  const fid = pickedFid || Number(routeParams.fid ?? search.get('fid') ?? forumlist[0]?.fid ?? 0);
  /* 当前选中版块（分类弹窗与触发器共用） */
  const currentForum = forumlist.find((f) => f.fid === fid);
  /* 版块生效内容语言（0024，自身绑定或继承父版块）：非空时发帖语言锁定为该语言，服务端同样强制 */
  const boundLang = (currentForum?.lang ?? '') as ContentLang | '';
  const [subject, setSubject] = useState('');
  const [err, setErr] = useState('');
  /* 收费帖设置（仅 allowsell 组渲染；content_num_status 0=否 1=是） */
  const canSell = me ? grouplist.find((g) => g.gid === me.gid)?.allowsell === 1 : false;
  const [sellOn, setSellOn] = useState(false);
  const [sellNum, setSellNum] = useState('');
  const [sellType, setSellType] = useState(1);
  /* 标签（idx_tag）：多选 ≤4，随 createThread 提交 */
  const [selTags, setSelTags] = useState<string[]>([]);
  /* 内容语言：'' = 自动识别（按标题+正文），用户可手动覆盖；正文由 Composer onChange 回传 */
  const [body, setBody] = useState('');
  const [langSel, setLangSel] = useState('');
  const detected = detectContentLang(`${subject} ${body}`);
  const [tab, setTab] = useState<'fn' | 'file'>('fn');
  /* 分类弹窗（#staticBackdrop：版块卡横向滚动列表 + 单选） */
  const [fidDlg, setFidDlg] = useState(false);

  const create = useMutation({
    mutationFn: (change: ComposerSubmit) =>
      createThread({
        fid,
        subject,
        message: change.html,
        doctype: 0,
        attachAids: change.attachAids,
        // 收费设置（未开启组服务端静默忽略）
        contentBuy: sellOn ? Number(sellNum || 0) : 0,
        contentBuyType: sellType,
        turnstileToken: change.turnstileToken,
        tags: selTags,
        // 内容语言：版块绑定优先（服务端强制），否则手动选择，最后用前端预判结果（与服务端检测同源同实现）
        lang: boundLang || langSel || detected || undefined,
      }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void qc.invalidateQueries({ queryKey: ['thread'] });
      void refresh();
      navigate(`/thread/${d.tid}`);
    },
  });

  // bootstrap 未完成前 me 必为 null，先等加载，避免首帧闪「请先登录」
  if (!loaded) return null;
  if (!me) {
    return (
      <div className="mx-auto w-full lg:w-[83.333%]">
        <Card header={<span className="font-medium">{t('thread_create')}</span>}>
          <Alert tone="secondary" icon="warning">
            {t('please_login_to_post')}
          </Alert>
          <Button className="mt-3" onClick={() => openAuth('login')}>
            {t('go_to_login')}
          </Button>
        </Card>
      </div>
    );
  }

  /* 小黑屋（0025）：禁言/禁访/禁登都不可发帖。服务端 banGuard 同样会拒，这里提前给出可读原因，避免白填表单 */
  const banScope = effectiveBanScope(me.banScope, me.banUntil, Math.floor(Date.now() / 1000));
  if (banScope & (BanScope.MUTE | BanScope.READ | BanScope.LOGIN)) {
    return (
      <div className="mx-auto w-full lg:w-[83.333%]">
        <Card header={<span className="font-medium">{t('thread_create')}</span>}>
          <Alert tone="warning" icon="warning">
            {t('compose_muted_hint')}{' '}
            {me.banUntil && me.banUntil > 0
              ? t('ban_until_label', { date: new Date(me.banUntil * 1000).toLocaleString() })
              : t('ban_permanent')}
            {me.banReason ? ` · ${t('ban_reason_label', { reason: me.banReason })}` : ''}
          </Alert>
          <Button className="mt-3" onClick={() => navigate('/')}>
            {t('back_to_home')}
          </Button>
        </Card>
      </div>
    );
  }

  const submit = async (change: ComposerSubmit) => {
    if (!fid) {
      setErr(t('please_select_forum'));
      return;
    }
    if (!subject.trim()) {
      setErr(t('please_input_subject'));
      return;
    }
    setErr('');
    // 服务端报错由 Composer 展示并重挂挂件换新 token（一次性 token 已被 siteverify 消耗）
    await create.mutateAsync(change);
  };

  /** 标签切换：最多 4 个，超出忽略 */
  const toggleTag = (name: string) =>
    setSelTags((s) => (s.includes(name) ? s.filter((x) => x !== name) : s.length >= 4 ? s : [...s, name]));

  /* 版块下拉（沿用输入框基元尺寸，宽度自适应） */
  const selectCls = 'h-[38px] min-w-0 rounded-[4px] border border-input-line bg-card px-3 text-sm text-foreground outline-none transition-colors focus:border-brand focus:ring-3 focus:ring-[rgba(64,158,255,0.25)] disabled:cursor-not-allowed';

  return (
    <div className="flex flex-col gap-5 lg:flex-row">
      {/* 主表单卡（8/12 栅格） */}
      <div className="min-w-0 lg:w-2/3">
        <Card
          header={
            <>
              <span className="font-medium">{t('thread_create')}</span>
              <Link className="ml-auto text-xs text-lt-grey transition-colors hover:text-brand" to="/">
                {t('cancel_label')}
              </Link>
            </>
          }
        >
          {/* 第一行：版块（分类弹窗触发器）+ 标题 */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              className={cx(selectCls, 'flex w-auto items-center gap-1.5 text-left')}
              onClick={() => setFidDlg(true)}
              aria-label={t('select_category')}
            >
              {currentForum?.iconUrl ? (
                <img src={currentForum.iconUrl} alt="" className="size-5 shrink-0 rounded-full object-contain" />
              ) : (
                <Icon name="folder" className="size-4 shrink-0 text-zh-grey" />
              )}
              <span className="max-w-[10rem] truncate">{currentForum?.name ?? t('select_category')}</span>
              <Icon name="chevron_down" className="size-4 shrink-0 text-zh-grey" />
            </button>
            <input
              className={cx(inputCls, 'min-w-0 flex-1')}
              placeholder={t('subject')}
              maxLength={128}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          {/* 发帖页公告（light.postAnnouncement，表单上方） */}
          {light.postAnnouncement && (
            <Alert tone="primary" icon="megaphone" className="mt-3 whitespace-pre-line">
              {light.postAnnouncement}
            </Alert>
          )}

          <div className="mt-3">
            <Composer
              turnstile
              submitLabel={t('thread_create')}
              busy={create.isPending}
              allowSell={canSell && sellOn}
              onChange={(c) => setBody(c.html)}
              onSubmit={submit}
              placeholder={t('content_placeholder')}
            />
          </div>

          {/* 标签选择区（标签定义来自后台 light 扩展） */}
          {tags.length > 0 && (
            <div className="mt-3 border-t border-zh-line pt-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-card-header-ink">{t('tag_label')}</span>
                <span className="text-xs text-lt-grey">{t('tags_max_hint', { count: 4 })}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {tags.map((tg) => {
                  const on = selTags.includes(tg.name);
                  return on ? (
                    <button key={tg.name} type="button" className="cursor-pointer" onClick={() => toggleTag(tg.name)}>
                      <TagBadge name={tg.name} style={tg.style} />
                    </button>
                  ) : (
                    <button
                      key={tg.name}
                      type="button"
                      className="inline-flex shrink-0 cursor-pointer items-center rounded-full border border-zh-line bg-lt-soft px-2.5 py-[3px] text-xs leading-none text-ink-soft transition-colors hover:bg-zh-row-hover"
                      onClick={() => toggleTag(tg.name)}
                    >
                      {tg.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 内容语言：仅站点开关开启时渲染（关闭 = 与升级前完全一致，服务端仍按绑定/检测写 lang）。
              开启时：版块绑定（0024，含父版块继承）→ 锁定为该语言（服务端同样强制）；
              未绑定 → 默认自动识别（标题+正文，和服务端同一检测函数），可手动覆盖。 */}
          {langMode > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zh-line pt-3 text-sm">
              <span className="text-ink-soft">{t('content_lang_label')}</span>
              {boundLang ? (
                <select
                  className={cx(selectCls, 'h-[33px] w-auto px-2')}
                  value={boundLang}
                  disabled
                  aria-label={t('content_lang_label')}
                >
                  <option value={boundLang}>{CONTENT_LANG_NATIVE_NAMES[boundLang]}</option>
                </select>
              ) : (
                <select
                  className={cx(selectCls, 'h-[33px] w-auto px-2')}
                  value={langSel}
                  onChange={(e) => setLangSel(e.target.value)}
                  aria-label={t('content_lang_label')}
                >
                  <option value="">
                    {t('content_lang_auto')}
                    {detected ? ` · ${CONTENT_LANG_NATIVE_NAMES[detected as ContentLang]}` : ''}
                  </option>
                  {CONTENT_LANGS.map((l) => (
                    <option key={l} value={l}>
                      {CONTENT_LANG_NATIVE_NAMES[l]}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* 收费设置（仅 allowsell 组渲染；「购买 :」+ 是/否 radio，选「是」时现数字与币种） */}
          {canSell && (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <span className="text-ink-soft">{t('buy_label')}</span>
              <label className="flex cursor-pointer items-center gap-1">
                <input type="radio" name="sell" checked={!sellOn} onChange={() => setSellOn(false)} />
                {t('no')}
              </label>
              <label className="flex cursor-pointer items-center gap-1">
                <input type="radio" name="sell" checked={sellOn} onChange={() => setSellOn(true)} />
                {t('yes_label')}
              </label>
              {sellOn && (
                <>
                  <input
                    className={cx(selectCls, 'h-[33px] w-[5.5rem] px-2')}
                    maxLength={10}
                    placeholder="0"
                    inputMode="numeric"
                    value={sellNum}
                    onChange={(e) => {
                      // 输入约束：剔非数字、封顶 9999999
                      let v = e.target.value.replace(/\D/g, '').slice(0, 10);
                      if (Number(v) > 9999999) v = '9999999';
                      setSellNum(v);
                    }}
                  />
                  <select
                    className={cx(selectCls, 'h-[33px] w-auto px-1.5')}
                    value={sellType}
                    onChange={(e) => setSellType(Number(e.target.value))}
                  >
                    <option value={1}>{t('credits_experience')}</option>
                    <option value={2}>{t('credits_gold')}</option>
                    <option value={3}>{t('credits_rmb')}</option>
                  </select>
                </>
              )}
            </div>
          )}
          {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
        </Card>
      </div>

      {/* 功能卡（4/12 栅格，sticky） */}
      <aside className="w-full shrink-0 self-start lg:sticky lg:top-[88px] lg:w-1/3">
        <Card
          header={
            <CardTabs
              items={[
                { k: 'fn', text: t('function_label'), active: tab === 'fn', onClick: () => setTab('fn') },
                { k: 'file', text: t('attach_short'), active: tab === 'file', onClick: () => setTab('file') },
              ]}
            />
          }
          bodyClass="p-0"
        >
          {tab === 'fn' ? (
            <div className="p-3">
              <div className="flex items-center gap-1.5 text-sm font-medium text-card-header-ink">
                <Icon name="warning" className="size-4 text-brand" />
                {t('warm_tip')}
              </div>
              <p className="mt-2 text-xs leading-[2] text-zh-grey">{setting?.brief || t('no_brief_yet')}</p>
              {selTags.length > 0 && (
                <>
                  <div className="mt-4 text-sm font-medium text-card-header-ink">{t('tag_label')}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selTags.map((n) => (
                      <TagBadge key={n} name={n} style={tags.find((x) => x.name === n)?.style ?? 'primary'} />
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="p-3">
              <div className="flex flex-col items-center gap-1.5 rounded-[5px] border border-dashed border-lt-dashed px-3 py-5 text-center text-xs text-lt-grey">
                <Icon name="attachment" className="size-5" />
                {t('attach_list')}
              </div>
            </div>
          )}
        </Card>
      </aside>

      {/* 分类弹窗（#staticBackdrop：版块卡横向滚动列表 + 单选 + 关闭） */}
      {fidDlg && (
        <Modal
          title={t('select_category')}
          onClose={() => setFidDlg(false)}
          footer={
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setFidDlg(false)}>
                {t('close_label')}
              </Button>
            </div>
          }
        >
          <div className="flex overflow-x-auto pb-1">
            {forumlist.map((f) => (
              <label
                key={f.fid}
                className="mr-2.5 flex shrink-0 cursor-pointer flex-col items-center rounded-[10px] bg-lt-soft p-5 text-center transition-colors hover:bg-zh-row-hover"
              >
                <input
                  type="radio"
                  name="compose-fid"
                  className="cursor-pointer accent-brand"
                  checked={f.fid === fid}
                  onChange={() => setPickedFid(f.fid)}
                />
                {f.iconUrl ? (
                  <img src={f.iconUrl} alt="" className="mt-1 size-10 rounded-full object-contain" />
                ) : (
                  <span className="mt-1 grid size-10 place-items-center rounded-full bg-card">
                    <Icon name="folder" className="size-5 text-zh-grey" />
                  </span>
                )}
                <span className="mt-1.5 whitespace-nowrap text-sm text-foreground">{f.name}</span>
              </label>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}