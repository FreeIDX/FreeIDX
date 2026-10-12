/**
 * 楼层附件行（主题首帖 Attaches 与 PostCard 共用）：
 *  - 免费图片 → `GET /api/attachments/:aid/preview` 内联预览（新窗口）；
 *  - 文件与付费图片（credits>0）→ `GET /api/attachments/:aid/download`，由服务端做
 *    allowdown + 付费主题未购 + 付费附件扣分三重校验。
 * 详情接口刻意不下发 R2 对象 key，因此此处不存在 `/files/attach/*` 直链，
 * 付费/权限附件无法被匿名直取（付费附件的预览同样需购买）。
 */
import { useState } from 'react';
import type { AttachItem } from '@freeidx/shared';
import { downloadAttachment } from '../lib/api';
import { useT } from '../lib/i18n';
import { Icon } from './icons';

function kb(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

export function AttachRows({ attaches }: { attaches: AttachItem[] }) {
  const t = useT();
  const [busyAid, setBusyAid] = useState(0);
  const [err, setErr] = useState('');

  const download = async (aid: number, credits: number) => {
    if (credits > 0 && !window.confirm(t('download_attach_credits_confirm', { credits }))) return;
    setBusyAid(aid);
    setErr('');
    try {
      await downloadAttachment(aid);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('download_failed'));
    } finally {
      setBusyAid(0);
    }
  };

  return (
    <>
      {attaches.map((a) =>
        a.isimage && !a.credits ? (
          <a
            key={a.aid}
            className="flex flex-wrap items-center justify-between gap-3 rounded-[4px] px-3 py-2 transition-colors hover:bg-zh-row-hover"
            href={`/api/attachments/${a.aid}/preview`}
            target="_blank"
            rel="noreferrer"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon name="eye" className="size-3.5 shrink-0 text-lt-grey" />
              <span className="min-w-0 truncate text-sm text-zh-deep-link">{a.orgfilename}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-lt-grey">{kb(a.filesize)}</span>
          </a>
        ) : (
          <button
            key={a.aid}
            type="button"
            disabled={busyAid === a.aid}
            className="flex w-full flex-wrap items-center justify-between gap-3 rounded-[4px] px-3 py-2 text-left transition-colors hover:bg-zh-row-hover disabled:opacity-60"
            onClick={() => void download(a.aid, a.credits ?? 0)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon name="file" className="size-3.5 shrink-0 text-lt-grey" />
              <span className="min-w-0 truncate text-sm text-zh-deep-link">{a.orgfilename}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-lt-grey">
              {kb(a.filesize)}
              {a.credits ? <span className="font-medium text-destructive">{t('attach_credits', { credits: a.credits })}</span> : null}
              {busyAid === a.aid ? t('downloading_dots') : t('download_dots')}
            </span>
          </button>
        ),
      )}
      {err && <p className="px-3 pb-1 text-xs text-destructive">{err}</p>}
    </>
  );
}
