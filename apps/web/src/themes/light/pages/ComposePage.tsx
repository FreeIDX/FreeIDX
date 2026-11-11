import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  CONTENT_LANG_NATIVE_NAMES,
  CONTENT_LANGS,
  detectContentLang,
  type ContentLang,
  type ForumNode,
} from '@freeidx/shared';
import { BanScope, effectiveBanScope } from '@freeidx/shared';
import { createThread, fmtDate } from '../../../lib/api';
import { nonNegInt } from '../../../lib/params';
import { Composer, type ComposerSubmit } from '../../../components/Composer';
import { Alert, Button, Card, CardTabs, Modal, TagBadge, cx, inputCls } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { useAuth } from '../../../store/auth';
import { useContentLangMode } from '../../../store/contentLang';
import { useLight } from '../../../store/theme';
import { useAuthModal } from '../../../store/authModal';
import { useForumName, useLocalizedSetting, useT } from '../../../lib/i18n';

/**
 * 分类弹窗单选项（一级 / 二级版块共用）：图标 + 名称；drill = 该版块下还有二级版块，显示下钻箭头。
 * 选中态用品牌色描边 + 淡底，未选中为浅灰底，hover 加深（与弹窗内并排卡片一致）。
 */
function ForumPickCard({ f, on, drill, onClick }: { f: ForumNode; on: boolean; drill?: boolean; onClick: () => void }) {
  const fname = useForumName();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cx(
        'flex min-w-0 items-center gap-1.5 rounded-[8px] border px-2.5 py-2 text-left transition-colors',
        on ? 'border-brand bg-[rgba(41,151,247,0.08)]' : 'border-zh-line bg-lt-soft hover:bg-zh-row-hover',
      )}
    >
      {f.iconUrl ? (
        <img src={f.iconUrl} alt="" className="size-6 shrink-0 rounded-full object-contain" />
      ) : (
        <Icon name="folder" className="size-4 shrink-0 text-zh-grey" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{fname(f)}</span>
      {drill && <Icon name="chevron_right" className="size-4 shrink-0 text-zh-grey" />}
    </button>
  );
}

/** 发帖页（§4.4，/new 或 /forum/:fid/new）：
 *  两栏 —— 左主表单卡（8/12 栅格：版块/标题 + Composer + 标签选择 + 收费设置）、
 *  右功能卡（4/12 栅格，tabs 功能/附件，sticky）。提交仍走 Composer 内按钮 → POST /api/threads（doctype=0）。
 *  版块两级（0018）：一级 + 二级分开选 —— 先在一级列表里选父版块，有二级版块时再进二级列表选目标版块；
 *  一级版块本身没有二级版块则一步到位，提交时 fid 才确定。 */
export function ComposePage() {
  const t = useT();
  /* 版块名多语言（0027）：按当前界面语言取词 */
  const fname = useForumName();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const routeParams = useParams();
  const [search] = useSearchParams();
  const forumlist = useAuth((s) => s.forumlist);
  const grouplist = useAuth((s) => s.grouplist);
  const me = useAuth((s) => s.me);
  const loaded = useAuth((s) => s.loaded);
  /* 站点介绍等基础设置按当前界面语言取词 */
  const setting = useLocalizedSetting();
  const openAuth = useAuthModal((s) => s.openAuth);
  const refresh = useAuth((s) => s.refresh);
  const light = useLight();
  const tags = light.tags;
  /* 站点「内容语言」开关：0=关闭 → 整个语言行不渲染（与升级前一致）；>0=开启 → 显示/锁定 */
  const langMode = useContentLangMode();

  // 冷加载 /new 时 forumlist 尚未就绪，useState 初值会永远停在 0 ⇒ 目标版块改为派生，用户手选才覆盖
  const [pickedFid, setPickedFid] = useState(0);
  /* 二级版块（0018，仅两级）：一级 = 父版块不可见的孤儿也算一级（与侧栏/后台口径一致，避免入口丢失） */
  const topForums = useMemo(() => {
    const fids = new Set(forumlist.map((f) => f.fid));
    return forumlist.filter((f) => !f.parentFid || !fids.has(f.parentFid));
  }, [forumlist]);
  const kidsOf = (topFid: number) => forumlist.filter((f) => f.parentFid === topFid);
  /* 期望版块：用户手选 > 路由/查询参数 > 版块列表首个（bootstrap 到位后才有值） */
  const wantedFid = pickedFid || nonNegInt(routeParams.fid ?? search.get('fid'), forumlist[0]?.fid ?? 0);
  /* 期望版块所属的一级版块：选中的是子版块则取其父，否则自身 */
  const currentTop = useMemo(() => {
    const f = forumlist.find((x) => x.fid === wantedFid);
    if (!f) return undefined;
    return f.parentFid ? (topForums.find((p) => p.fid === f.parentFid) ?? f) : f;
  }, [forumlist, topForums, wantedFid]);
  /* 当前一级版块下的二级版块；为空 = 单级版块，一步即可选定 */
  const currentKids = currentTop ? kidsOf(currentTop.fid) : [];
  /* 目标版块：一级版块有二级版块时必须落到某个二级版块才算选定（先一级、再二级，两级分开选） */
  const currentKid = currentKids.find((k) => k.fid === wantedFid);
  const fid = currentTop && (currentKids.length === 0 || currentKid) ? wantedFid : 0;
  /* 当前选中版块（收费/语言等按最终 fid 取） */
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
  /* 分类弹窗（#staticBackdrop：一级 → 二级两步单选） */
  const [fidDlg, setFidDlg] = useState(false);
  /** 弹窗层级：0 = 一级版块列表；>0 = 该一级版块下的二级版块列表 */
  const [dlgTop, setDlgTop] = useState(0);
  /** 弹窗当前正在浏览的一级版块（二级列表标题用） */
  const dlgTopForum = forumlist.find((f) => f.fid === dlgTop);
  /** 打开分类弹窗（topFid > 0 时直接进该一级版块的二级列表，供二级触发器复用） */
  const openFidDlg = (topFid = 0) => {
    setDlgTop(topFid);
    setFidDlg(true);
  };
  /** 选定版块（一级无子版块 / 二级都是终点）：选中即关窗回到表单 */
  const pickForum = (f: ForumNode) => {
    setPickedFid(f.fid);
    setDlgTop(0);
    setFidDlg(false);
  };
  /** 弹窗内点一级版块：有二级版块则下钻到二级列表，否则直接选定 */
  const pickTop = (f: ForumNode) => {
    if (kidsOf(f.fid).length) setDlgTop(f.fid);
    else pickForum(f);
  };

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
              ? t('ban_until_label', { date: fmtDate(me.banUntil) })
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
      /* 已选一级版块、缺二级版块时给出更具体的提示（两级分开选，缺哪级说哪级） */
      setErr(currentKids.length > 0 ? t('please_select_sub_forum') : t('please_select_forum'));
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
          {/* 第一行：版块（一级 + 二级分开选，分类弹窗触发器）+ 标题 */}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button
              type="button"
              className={cx(selectCls, 'flex w-auto items-center gap-1.5 text-left')}
              onClick={() => openFidDlg()}
              aria-label={t('forum_top_label')}
              title={t('forum_top_label')}
            >
              {currentTop?.iconUrl ? (
                <img src={currentTop.iconUrl} alt="" className="size-5 shrink-0 rounded-full object-contain" />
              ) : (
                <Icon name="folder" className="size-4 shrink-0 text-zh-grey" />
              )}
              <span className="max-w-[10rem] truncate">{currentTop ? fname(currentTop) : t('select_category')}</span>
              <Icon name="chevron_down" className="size-4 shrink-0 text-zh-grey" />
            </button>
            {/* 二级版块：选中的一级版块下有子版块时才出现（先一级、再二级） */}
            {currentKids.length > 0 && (
              <button
                type="button"
                className={cx(selectCls, 'flex w-auto items-center gap-1.5 text-left')}
                onClick={() => openFidDlg(currentTop?.fid ?? 0)}
                aria-label={t('forum_sub_label')}
                title={t('forum_sub_label')}
              >
                {currentKid?.iconUrl ? (
                  <img src={currentKid.iconUrl} alt="" className="size-5 shrink-0 rounded-full object-contain" />
                ) : (
                  <Icon name="folder" className="size-4 shrink-0 text-zh-grey" />
                )}
                <span className={cx('max-w-[10rem] truncate', !currentKid && 'text-lt-grey')}>
                  {currentKid ? fname(currentKid) : t('forum_sub_label')}
                </span>
                <Icon name="chevron_down" className="size-4 shrink-0 text-zh-grey" />
              </button>
            )}
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

      {/* 分类弹窗（#staticBackdrop）：一级版块 →（有子版块时下钻）二级版块，两步分开单选 */}
      {fidDlg && (
        <Modal
          title={t('select_category')}
          onClose={() => setFidDlg(false)}
          width="max-w-[600px]"
          footer={
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={() => setFidDlg(false)}>
                {t('close_label')}
              </Button>
            </div>
          }
        >
          {dlgTop === 0 ? (
            <>
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-card-header-ink">
                <Icon name="folder" className="size-4 text-brand" />
                {t('forum_top_label')}
              </p>
              <div className="grid max-h-[60vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                {topForums.map((f) => (
                  <ForumPickCard
                    key={f.fid}
                    f={f}
                    on={f.fid === currentTop?.fid}
                    drill={kidsOf(f.fid).length > 0}
                    onClick={() => pickTop(f)}
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              {/* 返回一级列表：二级版块按所属一级版块展示，避免平铺后分不清归属 */}
              <button
                type="button"
                className="mb-2 flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-brand"
                onClick={() => setDlgTop(0)}
              >
                <Icon name="chevron_left" className="size-4" />
                {t('forum_top_label')}
              </button>
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium text-card-header-ink">
                <Icon name="folder" className="size-4 text-brand" />
                {t('forum_sub_label')}
                <span className="truncate font-normal text-lt-grey">· {dlgTopForum ? fname(dlgTopForum) : ''}</span>
              </p>
              <div className="grid max-h-[60vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
                {kidsOf(dlgTop).map((f) => (
                  <ForumPickCard key={f.fid} f={f} on={f.fid === currentKid?.fid} onClick={() => pickForum(f)} />
                ))}
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}