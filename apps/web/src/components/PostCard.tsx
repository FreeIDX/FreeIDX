import { useState } from 'react';
import { Link } from 'react-router';
import type { PostItem } from '@freeidx/shared';
import { fmtDate, fmtIp } from '../lib/api';
import { useT } from '../lib/i18n';
import { useLight } from '../store/theme';
import { AttachRows } from './AttachRows';
import { Avatar } from './Avatar';
import { Icon } from './icons';
import { VBadge } from './VBadge';
import type { ComposerChange } from './Composer';
import { LazyComposer } from './ComposerAsync';

/** 楼层操作图标（右侧灰图标，hover 变蓝） */
const action =
  'inline-flex size-7 items-center justify-center text-zh-grey transition-colors hover:text-brand disabled:opacity-50';

/**
 * 楼层行：左头像列 + 正文列（头部小字：用户名粗体/日期/N楼 |
 * 右侧引用/编辑/删除灰图标）。写侧控制仅按服务端下发的 p.allowupdate/p.allowdelete/canReply 展示，前端不推断权限。
 * post_func_position=0（默认）操作区在头部行；楼层号 = 灰底徽章（#909399 底白字）。
 */
export function PostCard(props: {
  post: PostItem;
  floor: number;
  canReply?: boolean;
  /** 审核组（see_check）：未过审回帖显示现场审核按钮 */
  seeCheck?: boolean;
  onReply?: (post: PostItem) => void;
  onUpdate?: (pid: number, change: ComposerChange) => Promise<unknown>;
  onDelete?: (post: PostItem) => Promise<unknown>;
  /** 现场审核（act=1 回帖）：opt 1=通过 -1=拒绝 -2=删除 */
  onAudit?: (pid: number, opt: number) => Promise<unknown>;
  /** 楼层「查看所有回复」（show_all_reply）：存在即渲染入口按钮 */
  onShowReplies?: (pid: number) => void;
  /** 楼层点赞：存在即渲染点赞按钮（含计数） */
  onLike?: (post: PostItem) => void;
  likeBusy?: boolean;
  /** 楼层快捷 @ 提及（thread_quick_at）：存在即渲染 @ 钮，点击回填快捷回复框 */
  onQuickAt?: (post: PostItem) => void;
}) {
  const p = props.post;
  const t = useT();
  const light = useLight();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditErr, setAuditErr] = useState('');

  const saveEdit = async (change: ComposerChange) => {
    if (!props.onUpdate) return;
    setBusy(true);
    setErr('');
    try {
      await props.onUpdate(p.pid, change);
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('save_failed'));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!props.onDelete) return;
    if (!window.confirm(t('confirm_delete_q') + (p.isfirst > 0 ? t('delete_op_post_notice') : ''))) return;
    setBusy(true);
    setErr('');
    try {
      await props.onDelete(p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('delete_failed'));
    } finally {
      setBusy(false);
    }
  };

  /* 现场审核（统一 confirm('是否要审核该回帖呢？')） */
  const doAudit = async (opt: number) => {
    if (!props.onAudit) return;
    if (!window.confirm(t('confirm_audit_reply'))) return;
    setAuditBusy(true);
    setAuditErr('');
    try {
      await props.onAudit(p.pid, opt);
    } catch (e) {
      setAuditErr(e instanceof Error ? e.message : t('operation_failed'));
    } finally {
      setAuditBusy(false);
    }
  };

  /* 楼层操作图标组（post_func_position=0 头部行 / =1 正文底部右侧）：@提及/点赞/查看回复/引用/编辑/删除 */
  const actions = (
    <>
      {props.onQuickAt && (
        <button className={action} title={t('quick_at')} onClick={() => props.onQuickAt?.(p)}>
          @
        </button>
      )}
      {props.onLike && (
        <button
          className="inline-flex h-7 items-center gap-0.5 px-1 text-zh-grey transition-colors hover:text-brand disabled:opacity-50"
          style={p.liked ? { color: 'var(--primary)' } : undefined}
          title={p.liked ? t('unlike') : t('like')}
          disabled={props.likeBusy}
          onClick={() => props.onLike?.(p)}
        >
          <Icon name="thumbs_up" className="size-3.5" />
          {p.likes > 0 && <span className="text-[11px] tabular-nums">{p.likes}</span>}
        </button>
      )}
      {props.onShowReplies && (
        <button className={action} title={t('show_all_replies')} onClick={() => props.onShowReplies?.(p.pid)}>
          <Icon name="comment" className="size-3.5" />
        </button>
      )}
      {props.canReply && props.onReply && (
        <button className={action} title={t('quote')} onClick={() => props.onReply?.(p)}>
          <Icon name="reply" className="size-3.5" />
        </button>
      )}
      {p.allowupdate && !editing && (
        <button className={action} title={t('edit')} disabled={busy} onClick={() => setEditing(true)}>
          <Icon name="edit" className="size-3.5" />
        </button>
      )}
      {p.allowdelete && (
        <button className={action} title={t('delete')} disabled={busy} onClick={() => void doDelete()}>
          <Icon name="trash" className="size-3.5" />
        </button>
      )}
    </>
  );

  return (
    <li
      id={`pid-${p.pid}`}
      className="flex scroll-mt-20 items-start gap-2.5 border-b border-zh-line px-5 py-[0.7rem] last:border-b-0 sm:scroll-mt-24"
    >
      <div className="w-10 shrink-0 text-center">
        <Link to={`/user/${p.uid}`} aria-label={p.username} className="inline-block">
          {/* 加V认证徽章（头像右下角 V 标，title=头衔） */}
          <span className="relative inline-block">
            <Avatar uid={p.uid} avatar={p.avatar} username={p.username} size={3} />
            <VBadge v={p.v} size={3} />
          </span>
        </Link>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3 text-xs text-lt-grey">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <Link className="text-sm font-bold text-lt-grey transition-colors hover:text-brand" to={`/user/${p.uid}`}>
              {p.username}
            </Link>
            {!light.postShowTime && <span className="text-lt-grey">{fmtDate(p.createDate)}</span>}
            {p.userip !== undefined && <span title={t('ip_visible_tip')}>IP {fmtIp(p.userip)}</span>}
            {/* 楼层号（.floor-parent.badge.badge-secondary：#909399 底白字胶囊；热门回复卡 floor=0 不显示） */}
            {light.postShowFloors && props.floor > 0 && (
              <span className="rounded-[3px] bg-[#909399] px-1.5 py-0.5 text-[11px] leading-none text-white tabular-nums">
                {props.floor}
                {t('floor')}
              </span>
            )}
          </div>
          {light.postFuncPosition === 0 && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
        </div>
        {/* 发帖时间独立成行（post_show_time） */}
        {light.postShowTime && <div className="mt-0.5 text-xs text-lt-grey">{fmtDate(p.createDate)}</div>}

        {/* 回帖审核提示（alert-secondary 二态 + 现场审核按钮） */}
        {p.ok !== 1 && (
          <div role="alert" className="my-2 rounded-[4px] border border-zh-line bg-zh-notice px-4 py-3 text-xs leading-5 text-zh-notice-ink">
            {p.ok === -1 ? (
              <>
                <Icon name="warning_circle" className="mr-1 inline size-3.5" /> {t('reply_audit_rejected')}
              </>
            ) : (
              <>
                <Icon name="coffee" className="mr-1 inline size-3.5" /> {t('reply_audit_pending')}
              </>
            )}
            {props.seeCheck && props.onAudit && (
              <>
                <hr className="my-2 border-[#cfd2d6]" />
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      [1, t('audit_pass')],
                      [-1, t('audit_reject')],
                      [-2, t('delete')],
                    ] as const
                  ).map(([opt, text]) => (
                    <button
                      key={opt}
                      type="button"
                      disabled={auditBusy}
                      onClick={() => void doAudit(opt)}
                      className="inline-flex h-7 items-center rounded-[4px] border border-[#868e96] px-3 text-xs text-[#868e96] transition-colors hover:bg-[#868e96] hover:text-white disabled:opacity-50"
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </>
            )}
            {auditErr && <p className="mt-2 text-destructive">{auditErr}</p>}
          </div>
        )}

        {p.quoted && (
          /* 引用块（#dfecfe 底 + 左 5px #0084ff） */
          <blockquote className="my-2 border-l-[5px] border-brand bg-zh-quote p-3 text-xs leading-5 text-ink-soft">
            {t('reply')} <span className="font-medium">#{p.quoted.pid}</span> {p.quoted.username}：{p.quoted.messageSnippet}
          </blockquote>
        )}

        {editing ? (
          <div className="mt-2">
            <LazyComposer
              initialHtml={p.message ?? ''}
              submitLabel={t('save')}
              busy={busy}
              onSubmit={(c) => void saveEdit(c)}
              onCancel={() => setEditing(false)}
            />
            {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
          </div>
        ) : (
          <div className="post-body mt-1 break-words text-sm leading-[1.7]" dangerouslySetInnerHTML={{ __html: p.messageFmt }} />
        )}

        {p.attaches && p.attaches.length > 0 && (
          <div className="mt-3 rounded-[4px] border border-zh-line p-2 text-xs">
            <AttachRows attaches={p.attaches} />
          </div>
        )}
        {/* 楼层操作区（post_func_position=1：正文/附件块之后右对齐） */}
        {light.postFuncPosition === 1 && <div className="mt-1.5 flex justify-end">{actions}</div>}
        {/* 楼层页脚信息（thread_footer_info，仅楼主楼层；whitespace-pre-line 保留换行） */}
        {p.isfirst > 0 && light.threadFooterInfo && light.threadFooterInfoContent && (
          <div className="mt-3 whitespace-pre-line rounded-[4px] border border-zh-line bg-zh-notice px-3 py-2 text-xs leading-5 text-zh-notice-ink">
            {light.threadFooterInfoContent}
          </div>
        )}
        {p.isfirst > 0 && <span className="sr-only">{t('landlord_label')}</span>}
      </div>
    </li>
  );
}
