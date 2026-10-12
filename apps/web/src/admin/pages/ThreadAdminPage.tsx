/**
 * 主题批量管理（路由 /admin/threads，§4.9 定稿）。
 * 不用「逐页扫描收集 tid + 进度条」的旧范式：Worker 无会话队列，且逐页扫描会把 D1 额度按 totalPage 线性打爆，
 * 故定稿为**搜索-列表-勾选**（GET /api/admin/threads 本身就是分页查询，勾选后一次 POST /api/mod/threads）。
 * 版式：条件卡无卡头（卡体自带 1.25rem 内距），标题是卡内小标题
 * （1.1rem / 400 / margin:0，不浮动），
 * 字段是两列栅格，每格一个 fieldset（mb 1rem，label 独占一行）。
 * 批量按钮 关闭/打开/删除/移动 四个（移动复用前台版务 POST /api/mod/threads 的 action=move）；
 * 单帖行内提供 编辑（标题/正文/版块）、置顶/取消置顶、加精/取消精华（后两者同样复用 /api/mod/threads）。
 * 编辑走本模块直写：GET /api/admin/threads/:tid 回显 → PUT 保存（正文重跑 fmt、fid 变更=移动版块）。
 */
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { getAdminThread, getAdminThreads, modThreads, updateAdminThread } from '../api';
import type { AdminThreadDetail, AdminThreadRow } from '../types';
import { useAdminT } from '../t';
import { useBatchAction } from '../use-action';
import { useAuth } from '../../store/auth';
import { fmtDate } from '../../lib/api';
import { posInt } from '../../lib/params';
import {
  AdminPagination,
  Alert,
  Button,
  Card,
  Checkbox,
  ConfirmModal,
  ErrorState,
  Input,
  Modal,
  PageTitle,
  Select,
  Textarea,
  cardBodyCls,
  cardCls,
  cx,
} from '../ui';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/icons';

/** 置顶角标（三档样式，与前台 ThreadList.tsx 同构）：1=浅橙底、2=橙字、3=浅红底，文案恒为“置顶” */
const TOP_CLS: Record<number, string> = {
  1: 'bg-zh-top1-bg text-zh-top-text',
  2: 'text-top-normal',
  3: 'bg-zh-top3-bg text-zh-top-text',
};

/** date input 的 YYYY-MM-DD → unix 秒（UTC 日界，与服务端 dayStartOf 同口径） */
const dayStart = (v: string): number | undefined => (v ? Math.floor(Date.parse(`${v}T00:00:00Z`) / 1000) : undefined);
const dayEnd = (v: string): number | undefined => (v ? dayStart(v)! + 86399 : undefined);

export function ThreadAdminPage() {
  const t = useAdminT();
  const [sp, setSp] = useSearchParams();
  const forumlist = useAuth((s) => s.forumlist);

  const fid = Number(sp.get('fid') ?? 0);
  const keyword = sp.get('keyword') ?? '';
  const userip = sp.get('create_ip') ?? '';
  const uid = Number(sp.get('uid') ?? 0);
  const start = sp.get('start') ?? '';
  const end = sp.get('end') ?? '';
  const page = posInt(sp.get('page'));

  const [form, setForm] = useState({ fid: String(fid), keyword, userip, uid: uid ? String(uid) : '', start, end });
  useEffect(() => {
    setForm({ fid: String(fid), keyword, userip, uid: uid ? String(uid) : '', start, end });
  }, [fid, keyword, userip, uid, start, end]);

  const since = dayStart(start);
  const until = dayEnd(end);
  const q = useQuery({
    queryKey: ['admin', 'threads', { fid, keyword, userip, uid, since, until, page }],
    queryFn: () =>
      getAdminThreads({
        fid: fid || undefined,
        keyword: keyword || undefined,
        create_ip: userip || undefined,
        uid: uid || undefined,
        since,
        until,
        page,
        size: 20,
      }),
    placeholderData: keepPreviousData,
  });

  const batch = useBatchAction([['admin', 'threads'], ['admin', 'runtime']]);
  const [picked, setPicked] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);
  const rows = q.data?.list ?? [];
  useEffect(() => setPicked([]), [q.data]);

  const forumName = useMemo(() => new Map(forumlist.map((f) => [Number(f.fid), f.name])), [forumlist]);

  const buildHref = (p: number): string => {
    const params = new URLSearchParams();
    if (fid) params.set('fid', String(fid));
    if (keyword) params.set('keyword', keyword);
    if (userip) params.set('create_ip', userip);
    if (uid) params.set('uid', String(uid));
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    if (p > 1) params.set('page', String(p));
    const s = params.toString();
    return s ? `/admin/threads?${s}` : '/admin/threads';
  };

  const submit = () => {
    const params = new URLSearchParams();
    if (form.fid !== '0') params.set('fid', form.fid);
    if (form.keyword.trim()) params.set('keyword', form.keyword.trim());
    if (form.userip.trim()) params.set('create_ip', form.userip.trim());
    if (form.uid.trim()) params.set('uid', form.uid.trim());
    if (form.start) params.set('start', form.start);
    if (form.end) params.set('end', form.end);
    setSp(new URLSearchParams(params.toString()));
  };

  const runAction = async (action: 'close', value: number, okText: string) => {
    const targets = rows.filter((r) => picked.includes(r.tid));
    if (!targets.length) {
      batch.setFlash({ tone: 'warn', text: t('admin_thread_select_required', '请勾选要处理的主题') });
      return;
    }
    const ok = await batch.run(
      // 服务端按 tids 数组整批处理，无需逐条循环；这里保持 useBatchAction 的 jobs 形状以便与它页一致
      [() => modThreads({ tids: targets.map((r) => r.tid), action, value })],
      okText,
    );
    if (ok) setPicked([]);
  };

  const deletePicked = async () => {
    const ok = await batch.run([() => modThreads({ tids: picked, action: 'delete' })], t('admin_thread_delete_done', '删除完成'));
    if (ok) {
      setPicked([]);
      setConfirming(false);
    }
  };

  const setField = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const targets = rows.filter((r) => picked.includes(r.tid));

  /* ---------- 单帖行内：编辑弹窗 / 置顶 / 精华 ---------- */
  // 编辑回显：点到某行才拉取（enabled 由 editTid 控制），拉回后灌入表单
  const [editTid, setEditTid] = useState<number | null>(null);
  const [ef, setEf] = useState({ subject: '', message: '', doctype: 0, fid: 0 });
  const detail = useQuery({
    queryKey: ['admin', 'thread', editTid],
    queryFn: () => getAdminThread(editTid as number),
    enabled: editTid !== null,
  });
  useEffect(() => {
    const d: AdminThreadDetail | undefined = detail.data;
    if (d) setEf({ subject: d.subject, message: d.message, doctype: d.doctype, fid: d.fid });
  }, [detail.data]);

  const saveEdit = async () => {
    if (editTid === null) return;
    const ok = await batch.run(
      [() => updateAdminThread(editTid, { subject: ef.subject, message: ef.message, doctype: ef.doctype, fid: Number(ef.fid) })],
      t('admin_save_complete', '保存完成'),
    );
    if (ok) setEditTid(null);
  };

  /** 行内版务：单帖一次 POST /api/mod/threads（top/untop/digest） */
  const runRow = async (action: 'top' | 'untop' | 'digest', tid: number, value: number) => {
    await batch.run([() => modThreads({ tids: [tid], action, value })], t('admin_save_complete', '保存完成'));
  };

  /* ---------- 批量移动 ---------- */
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveFid, setMoveFid] = useState(0);
  const doMove = async () => {
    if (!moveFid) {
      batch.setFlash({ tone: 'warn', text: t('admin_thread_move_target', '目标版块') });
      return;
    }
    const ok = await batch.run(
      [() => modThreads({ tids: picked, action: 'move', value: moveFid })],
      t('admin_thread_move_done', '移动完成'),
    );
    if (ok) {
      setMoveOpen(false);
      setPicked([]);
    }
  };

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_thread_batch', '主题批量管理')}</PageTitle>
      {(batch.flash || q.isError) &&
        (q.isError ? <ErrorState error={q.error} /> : <Alert tone={batch.flash!.tone}>{batch.flash!.text}</Alert>)}

      {/* 条件卡：`card card-body`，卡与内距同一层，无 card-header */}
      <div className={cx(cardCls, cardBodyCls)}>
        {/* 紧凑筛选条：无标题、无标签行，占位文字自述字段；两个日期框带「开始/结束」内联小字区分
            （标签 + 占位文字重复，如「关键词」两处，故去重简化） */}
        <div className="flex flex-wrap items-center gap-x-3">
          {/* 2026-10 用户要求：版块下拉宽度减 1/3（flex grow 0.67 vs 其余 flex-1） */}
          <Select id="fid" aria-label={t('forum', '版块')} className="min-w-[7rem] flex-[.67]" value={form.fid} onChange={setField('fid')}>
            <option value="0">
              {t('all', '全部')}
              {t('forum', '版块')}
            </option>
            {forumlist.map((f) => (
              <option key={f.fid} value={String(f.fid)}>
                {f.name}
              </option>
            ))}
          </Select>
          <Input
            id="keyword"
            aria-label={t('keyword', '关键词')}
            className="min-w-[6.5rem] flex-1"
            type="text"
            placeholder={t('keyword', '关键词')}
            value={form.keyword}
            onChange={setField('keyword')}
          />
          {/* 2026-10 用户要求：日期框仍受挤压 → IP/UID 两框让位（min-w 与 grow 双降），日期框再加宽一档 */}
          <div className="flex min-w-[14.5rem] flex-1 items-center gap-1.5">
            <span className="shrink-0 text-muted">{t('start_date', '开始时间')}：</span>
            <Input
              id="create_date_start"
              aria-label={t('start_date', '开始时间')}
              className="min-w-[9rem] flex-1"
              type="date"
              value={form.start}
              onChange={setField('start')}
            />
          </div>
          <div className="flex min-w-[14.5rem] flex-1 items-center gap-1.5">
            <span className="shrink-0 text-muted">{t('end_date', '结束时间')}：</span>
            <Input
              id="create_date_end"
              aria-label={t('end_date', '结束时间')}
              className="min-w-[9rem] flex-1"
              type="date"
              value={form.end}
              onChange={setField('end')}
            />
          </div>
          <Input
            id="userip"
            aria-label={t('thread_userip', '发帖 IP')}
            className="min-w-[5.5rem] flex-[.6]"
            type="text"
            placeholder={t('thread_userip', '发帖 IP')}
            value={form.userip}
            onChange={setField('userip')}
          />
          <Input
            id="uid"
            aria-label={t('user', '用户')}
            className="min-w-[5.5rem] flex-[.6]"
            type="text"
            placeholder={`${t('user', '用户')} ID`}
            value={form.uid}
            onChange={setField('uid')}
          />
          <Button className="shrink-0" loading={q.isFetching} onClick={submit}>
            <Icon name="search" />
            {t('search', '搜索')}
          </Button>
        </div>
      </div>

      <Card
        noPadding
        title={
          <span className="text-sm text-muted">
            {t('thread_search_result', '结果：{n} 条', { n: q.data?.total ?? 0 })}
          </span>
        }
        tools={
          <div className="flex items-center gap-2">
            <Checkbox
              checked={rows.length > 0 && picked.length === rows.length}
              onChange={(v) => setPicked(v ? rows.map((r) => r.tid) : [])}
              label={t('check_all', '全选')}
            />
            {/* 三个并列按钮（非按钮组：无相邻 -1px、不削圆角） */}
            <Button
              variant="primary"
              size="sm"
              loading={batch.pending}
              disabled={!picked.length}
              onClick={() => void runAction('close', 1, t('admin_thread_close_done', '关闭完成'))}
            >
              <Icon name="lock" />
              {t('close', '关闭')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={batch.pending}
              disabled={!picked.length}
              onClick={() => void runAction('close', 0, t('admin_thread_open_done', '打开完成'))}
            >
              <Icon name="unlock" />
              {t('open', '打开')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!picked.length}
              onClick={() => {
                setMoveFid(0);
                setMoveOpen(true);
              }}
            >
              <Icon name="arrow_right" />
              {t('move', '移动')}
            </Button>
            <Button variant="danger" size="sm" disabled={!picked.length} onClick={() => setConfirming(true)}>
              <Icon name="trash" />
              {t('delete', '删除')}
            </Button>
          </div>
        }
      >
        {/* 结果列表 = 论坛主题列表样式布局：ul 挂 .theme-zh 换取前台整套令牌（品牌色/字体/分隔线），
            作用域只罩本列表，卡头与分页仍是后台样式；行结构同前台 ThreadList.tsx */}
        <ul className="theme-zh m-0">
          {rows.map((r) => (
            <ThreadRow
              key={r.tid}
              row={r}
              forum={forumName.get(Number(r.fid)) ?? `fid ${r.fid}`}
              picked={picked.includes(r.tid)}
              onPick={(v) => setPicked((p) => (v ? [...p, r.tid] : p.filter((x) => x !== r.tid)))}
              onEdit={() => setEditTid(r.tid)}
              onToggleTop={() => void runRow(r.top > 0 ? 'untop' : 'top', r.tid, r.top > 0 ? 0 : 1)}
              onToggleDigest={() => void runRow('digest', r.tid, r.digest > 0 ? 0 : 1)}
            />
          ))}
          {rows.length === 0 && !q.isFetching && (
            <li className="py-12 text-center">
              <span className="text-[15px] text-[#e6e6e6]">{t('admin_thread_empty', '这里是一块未开发的宝地')}</span>
            </li>
          )}
        </ul>
        <div className="px-[1.25rem] pb-[1.25rem]">
          {q.data && <AdminPagination page={q.data.page} totalPage={q.data.totalPage} href={buildHref} />}
        </div>
      </Card>

      <ConfirmModal
        open={confirming}
        loading={batch.pending}
        text={`${t('admin_thread_delete_confirm_prefix', '将永久删除 {n} 个主题及其回帖/附件，并回退作者计数。', { n: targets.length })}${targets
          .slice(0, 5)
          .map((r) => r.subject)
          .join('、')}${targets.length > 5 ? ' …' : ''}${t('admin_thread_delete_confirm_suffix', '。确定继续？')}`}
        onConfirm={() => void deletePicked()}
        onCancel={() => setConfirming(false)}
      />

      {/* 编辑主题：标题 + 版块（含移动）+ 首帖正文 */}
      <Modal
        open={editTid !== null}
        wide
        title={t('admin_thread_edit_title', '编辑主题')}
        onClose={() => setEditTid(null)}
        footer={
          <>
            <Button variant="default" onClick={() => setEditTid(null)} disabled={batch.pending}>
              {t('cancel', '取消')}
            </Button>
            <Button loading={batch.pending} disabled={detail.isFetching} onClick={() => void saveEdit()}>
              {t('save', '保存')}
            </Button>
          </>
        }
      >
        {detail.isFetching && !detail.data ? (
          <p className="py-6 text-center text-sm text-muted">{t('loading', '加载中')}…</p>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-sm text-ink-soft">{t('subject', '标题')}</span>
              <Input value={ef.subject} maxLength={80} onChange={(e) => setEf((f) => ({ ...f, subject: e.target.value }))} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-ink-soft">{t('forum', '版块')}</span>
              <Select value={String(ef.fid)} onChange={(e) => setEf((f) => ({ ...f, fid: Number(e.target.value) }))}>
                {forumlist.map((f) => (
                  <option key={f.fid} value={String(f.fid)}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-ink-soft">{t('admin_thread_content', '内容')}</span>
              <Textarea
                className="min-h-[16rem] font-mono text-[13px]"
                value={ef.message}
                onChange={(e) => setEf((f) => ({ ...f, message: e.target.value }))}
              />
            </label>
          </div>
        )}
      </Modal>

      {/* 批量移动：选中目标版块后一次 POST /api/mod/threads（action=move） */}
      <Modal
        open={moveOpen}
        title={t('admin_thread_move_title', '移动主题')}
        onClose={() => setMoveOpen(false)}
        footer={
          <>
            <Button variant="default" onClick={() => setMoveOpen(false)} disabled={batch.pending}>
              {t('cancel', '取消')}
            </Button>
            <Button loading={batch.pending} disabled={!moveFid} onClick={() => void doMove()}>
              {t('confirm', '确定')}
            </Button>
          </>
        }
      >
        <label className="block">
          <span className="mb-1 block text-sm text-ink-soft">{t('admin_thread_move_target', '目标版块')}</span>
          <Select value={String(moveFid)} onChange={(e) => setMoveFid(Number(e.target.value))}>
            <option value="0">{t('admin_thread_move_target', '目标版块')}</option>
            {forumlist.map((f) => (
              <option key={f.fid} value={String(f.fid)}>
                {f.name}
              </option>
            ))}
          </Select>
        </label>
        <p className="mt-2 text-xs text-muted">{t('admin_thread_select_required', '请勾选要处理的主题')}</p>
      </Modal>
    </div>
  );
}

/**
 * 结果行 = 论坛主题列表行（ThreadList.tsx 同构）：
 * 勾选框 + 头像 + 标题（置顶/精华徽标、图片数、附件/关闭图标）+ 元信息行（版块胶囊/作者·时间/最后回复）+ 浏览/回复。
 * 行本身不可点（后台避免误触离开），标题链 target=_blank 保留后台上下文。
 */
function ThreadRow({
  row,
  forum,
  picked,
  onPick,
  onEdit,
  onToggleTop,
  onToggleDigest,
}: {
  row: AdminThreadRow;
  forum: string;
  picked: boolean;
  onPick: (v: boolean) => void;
  onEdit: () => void;
  onToggleTop: () => void;
  onToggleDigest: () => void;
}) {
  const t = useAdminT();
  const actCls = 'cursor-pointer rounded border border-line px-1.5 py-0.5 text-xs text-muted transition-colors hover:border-brand hover:text-brand';
  return (
    <li className="relative border-b border-line border-l-2 border-l-transparent transition-colors hover:border-l-brand hover:bg-zh-row-hover">
      <div className="flex items-start gap-3 px-[12px] py-[12px]">
        <span className="mt-[1rem] shrink-0 md:mt-[1.2rem]">
          <Checkbox checked={picked} onChange={onPick} title={t('admin_thread_select_prefix', '选择 {subject}', { subject: row.subject })} />
        </span>
        <Link to={`/user/${row.uid}`} aria-label={row.username} className="mt-[.3rem] shrink-0 md:mt-[.5rem]">
          <Avatar uid={row.uid} avatar={row.avatar} username={row.username} size={3} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-1 text-[1.04rem] break-all">
            {row.top > 0 && (
              <span className={cx('mr-1 align-text-bottom rounded px-1 text-[.875rem]', TOP_CLS[row.top] ?? TOP_CLS[3])}>
                {t('top', '置顶')}
              </span>
            )}
            {row.digest > 0 && <span className="mr-1 rounded bg-warning px-1 text-[.7rem] font-bold text-ink">{t('admin_thread_digest_badge', '精华')}</span>}
            <Link className="text-ink transition-colors hover:text-brand" to={`/thread/${row.tid}`} target="_blank">
              {row.subject}
            </Link>
            {row.images > 0 && (
                <span className="ml-1 text-muted" title={t('admin_thread_images_title', '图片')}>
                <Icon name="image" className="inline size-3.5" /> {row.images}P
              </span>
            )}
            {row.files > 0 && <Icon name="file" className="ml-1 inline size-3 text-muted" title={t('admin_thread_files_title', '含附件')} />}
            {row.closed > 0 && <Icon name="lock" className="ml-1 inline size-3 text-muted" title={t('admin_thread_closed_title', '已关闭')} />}
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-[13px]">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2">
              <Link
                to={`/forum/${row.fid}`}
                className="rounded border border-line px-1.5 text-xs text-muted transition-colors hover:text-brand"
              >
                {forum}
              </Link>
              <Link className="font-bold text-muted hover:text-brand" to={`/user/${row.uid}`}>
                {row.username}
              </Link>
              <span className="text-muted">•</span>
              <span className="text-muted-2">{fmtDate(row.create_date)}</span>
              {row.lastpid > 0 && row.lastuid !== row.uid && (
                <span className="flex min-w-0 items-center gap-1 truncate text-muted-2">
                  <Icon name="reply" className="size-3" />
                  <Link className="text-muted hover:text-brand" to={`/user/${row.lastuid}`}>
                    {row.lastusername}
                  </Link>
                  <span className="hidden sm:inline">{t('last_reply', '最后回复')}</span> {fmtDate(row.last_date)}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-muted tabular-nums">
              <Icon name="eye" className="size-3.5" />
              {row.views}
              <Icon name="comment" className="ml-2 size-3.5" />
              {row.posts}
            </span>
            {/* 行内管理动作：编辑 / 置顶(取消) / 精华(取消)。stopPropagation 防触发行容器其他行为 */}
            <span className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                className={actCls}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
              >
                {t('edit', '编辑')}
              </button>
              <button
                type="button"
                className={actCls}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleTop();
                }}
              >
                {row.top > 0 ? t('admin_thread_untop', '取消置顶') : t('top', '置顶')}
              </button>
              <button
                type="button"
                className={actCls}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleDigest();
                }}
              >
                {row.digest > 0 ? t('admin_thread_undigest', '取消精华') : t('admin_thread_digest_badge', '精华')}
              </button>
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}
