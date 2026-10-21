/**
 * 富文本编辑器（T2-10）：TipTap 产出 HTML（doctype=0，服务端写时定稿 sanitize）。
 * 工具栏：粗体/斜体/行内码/代码块/链接/图片上传（POST /api/attachments → 插 <img>，aid 计入 attachAids）。
 * 引用回复：父级传 quoted 摘要展示，提交时自行带 quotepid。
 * turnstile=1 时在提交按钮上方挂人机验证挂件（发帖/回帖用）；token 一次性，提交后一律重挂换发。
 */
import { useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Image as TiptapImage } from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { deleteAttachment, uploadAttachment } from '../lib/api';
import { apiErrorMessage } from '../lib/errors';
import { useT } from '../lib/i18n';
import { Turnstile, turnstileDisabled } from './Turnstile';
import { Button } from './ui';

export interface ComposerChange {
  html: string;
  attachAids: number[];
}
/** 提交载荷：发帖/回帖挂了人机验证时带上一次性 token（token 300s 过期且 siteverify 一次即消耗） */
export interface ComposerSubmit extends ComposerChange {
  turnstileToken: string;
}
export interface QuotedSummary {
  pid: number;
  username: string;
  snippet: string;
}
interface UploadItem {
  aid: number;
  name: string;
  isImage: boolean;
}

/** 表情总数（emoicon 1..126，共 126 张） */
const EMOJI_COUNT = 126;

interface ComposerProps {
  initialHtml?: string;
  quoted?: QuotedSummary | null;
  placeholder?: string;
  submitLabel?: string;
  busy?: boolean;
  /** 发帖/回帖挂 Turnstile；编辑已有内容不挂 */
  turnstile?: boolean;
  /** 收费帖组（allowsell）：工具栏出现「插入付费内容」按钮 */
  allowSell?: boolean;
  onChange?: (c: ComposerChange) => void;
  onSubmit?: (c: ComposerSubmit) => void | Promise<unknown>;
  onCancel?: () => void;
}

function readDims(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ w: 0, h: 0 });
    };
    img.src = url;
  });
}

/* 工具栏按钮：无边框扁平灰字，hover 变蓝，激活态蓝底浅蓝胶囊 */
const btn =
  'rounded-[4px] px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-brand disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring/30';

export function Composer(props: ComposerProps) {
  const t = useT();
  const {
    initialHtml = '',
    quoted,
    placeholder = t('body_placeholder'),
    submitLabel = t('publish_btn'),
    busy,
    turnstile = false,
    allowSell = false,
    onChange,
    onSubmit,
    onCancel,
  } = props;

  const attachRef = useRef<UploadItem[]>([]);
  const [attach, setAttach] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [tsToken, setTsToken] = useState('');
  const [tsNonce, setTsNonce] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const fileRef = useRef<HTMLInputElement>(null);
  const rawRef = useRef<HTMLInputElement>(null);

  const emit = (editor: Editor | null, list: UploadItem[]) => {
    onChangeRef.current?.({ html: editor ? editor.getHTML() : '', attachAids: list.map((a) => a.aid) });
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TiptapImage,
      Placeholder.configure({ placeholder }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: { class: 'min-h-[8rem] px-3 py-2 text-sm leading-6 text-foreground focus:outline-none break-words post-body' },
    },
    onUpdate: ({ editor: e }) => emit(e, attachRef.current),
  });

  const insertLink = () => {
    if (!editor) return;
    if (editor.isActive('link')) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt(t('enter_link_url'), 'https://');
    if (!url) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    emit(editor, attachRef.current);
  };

  const onPickImage = async (file: File | undefined) => {
    if (!file || !editor) return;
    setUploading(true);
    setError('');
    try {
      const { w, h } = await readDims(file);
      const r = await uploadAttachment(file, { isImage: true, width: w, height: h });
      editor.chain().focus().setImage({ src: r.url, alt: r.orgfilename }).run();
      const next = [...attachRef.current, { aid: r.aid, name: r.orgfilename, isImage: true }];
      attachRef.current = next;
      setAttach(next);
      emit(editor, next);
    } catch (e) {
      setError(apiErrorMessage(e, t('image_upload_failed')));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** 任意类型附件（§9 白名单由服务端把关，名单外自动改名 `_ext`）：仅入 attachAids，不插正文 */
  const onPickFile = async (file: File | undefined) => {
    if (!file || !editor) return;
    setUploading(true);
    setError('');
    try {
      const r = await uploadAttachment(file, { isImage: false });
      const next = [...attachRef.current, { aid: r.aid, name: r.orgfilename, isImage: false }];
      attachRef.current = next;
      setAttach(next);
      emit(editor, next);
    } catch (e) {
      setError(apiErrorMessage(e, t('attach_upload_failed')));
    } finally {
      setUploading(false);
      if (rawRef.current) rawRef.current.value = '';
    }
  };

  const removeAttach = (aid: number) => {
    // 尽力而为地立即回收暂存附件（R2 对象 + 行；仅 status=0 可删）；失败静默——attachGc 24h 兜底，不阻断前端移除
    void deleteAttachment(aid).catch(() => undefined);
    const next = attachRef.current.filter((a) => a.aid !== aid);
    attachRef.current = next;
    setAttach(next);
    emit(editor, next);
  };

  const submit = async () => {
    if (!editor) return;
    const html = editor.getHTML();
    const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!text) {
      setError(t('please_input_message'));
      return;
    }
    // 挂件在场却没 token（未加载/已过期）⇒ 与服务端口径一致地拦下，省一次必然失败的请求
    if (turnstile && !turnstileDisabled() && !tsToken) {
      setError(t('please_complete_captcha'));
      return;
    }
    setError('');
    try {
      await onSubmit?.({ html, attachAids: attach.map((a) => a.aid), turnstileToken: tsToken });
    } catch (e) {
      setError(apiErrorMessage(e, t('submit_failed')));
    } finally {
      // token 一次性（官方口径：300s 过期、siteverify 校验一次即消耗）⇒ 不论成败都重挂换发
      if (turnstile) {
        setTsToken('');
        setTsNonce((n) => n + 1);
      }
    }
  };

  const T = (name: string) => (editor?.isActive(name) ? 'bg-[rgba(41,151,247,0.1)] text-brand' : '');

  return (
    <div className="rounded-[4px] border border-input-line bg-card transition-colors focus-within:border-[#a0cfff] focus-within:ring-3 focus-within:ring-[rgba(64,158,255,0.25)]">
      {quoted && (
        <blockquote className="mx-3 mt-3 border-l-[5px] border-brand bg-zh-quote px-3 py-2 text-xs text-ink-soft">
          {t('reply')} <span className="font-medium">#{quoted.pid}</span> {quoted.username}：{quoted.snippet}
        </blockquote>
      )}
      <div className="flex flex-wrap gap-1 border-b border-zh-line px-2 py-1.5">
        <button type="button" className={`${btn} ${T('bold')}`} disabled={!editor} onClick={() => editor?.chain().focus().toggleBold().run()}>
          {t('bold_label')}
        </button>
        <button type="button" className={`${btn} ${T('italic')}`} disabled={!editor} onClick={() => editor?.chain().focus().toggleItalic().run()}>
          {t('italic_label')}
        </button>
        <button type="button" className={`${btn} ${T('code')}`} disabled={!editor} onClick={() => editor?.chain().focus().toggleCode().run()}>
          {t('inline_code')}
        </button>
        <button type="button" className={`${btn} ${T('codeBlock')}`} disabled={!editor} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>
          {t('code_block')}
        </button>
        <button type="button" className={`${btn} ${T('link')}`} disabled={!editor} onClick={insertLink}>
          {t('link_label')}
        </button>
        <button type="button" className={`${btn} ${T('blockquote')}`} disabled={!editor} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>
          {t('quote')}
        </button>
        <button type="button" className={btn} disabled={!editor || uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? t('uploading_dots') : t('insert_image')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void onPickImage(e.target.files?.[0])}
        />
        <button type="button" className={btn} disabled={!editor || uploading} onClick={() => rawRef.current?.click()}>
          {uploading ? t('uploading_dots') : t('attach_short')}
        </button>
        <input ref={rawRef} type="file" className="hidden" onChange={(e) => void onPickFile(e.target.files?.[0])} />
        {/* 表情面板：126 张 emoicon，插入 <img class="em_icon"> */}
        <button type="button" className={`${btn} ${emojiOpen ? 'bg-[rgba(41,151,247,0.1)] text-brand' : ''}`} disabled={!editor} onClick={() => setEmojiOpen((v) => !v)}>
          {t('emoji_label')}
        </button>
        {/* 插入付费内容（正文中插入 [ttPay] 标记段） */}
        {allowSell && (
          <button
            type="button"
            className={btn}
            disabled={!editor}
            onClick={() => {
              editor?.chain().focus().insertContent(`[ttPay]${t('paid_content_placeholder')}[/ttPay]`).run();
              emit(editor, attachRef.current);
            }}
          >
            {t('insert_paid_content')}
          </button>
        )}
      </div>
      {/* 表情面板（高 145px 滚动，hover 放大 1.5） */}
      {emojiOpen && editor && (
        <div className="qqface-panel mx-3 mt-2 grid grid-cols-9 gap-1.5 rounded-[5px] bg-lt-aid p-2.5" role="group" aria-label={t('emoji_label')}>
          {Array.from({ length: EMOJI_COUNT }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              className="flex items-center justify-center rounded-[3px] p-0.5 transition-transform hover:scale-125"
              aria-label={`emoji ${n}`}
              onClick={() => {
                editor.chain().focus().insertContent(`<img src="/emoicon/${n}.png" alt="em_${n}" class="em_icon">`).run();
                emit(editor, attachRef.current);
              }}
            >
              <img src={`/emoicon/${n}.png`} alt="" className="size-6" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <EditorContent editor={editor} />
      {attach.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          {attach.map((a) => (
            <span key={a.aid} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
              {a.isImage ? t('image_short') : t('file_short')} {a.name}
              <button type="button" className="ml-1.5 text-muted-foreground transition-colors hover:text-destructive" onClick={() => removeAttach(a.aid)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {turnstile && <Turnstile key={tsNonce} onToken={setTsToken} />}
      {error && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
      {onSubmit && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <Button
            type="button"
            loading={busy}
            loadingText={t('submitting_dots')}
            disabled={busy || uploading || !editor}
            onClick={() => void submit()}
          >
            {submitLabel}
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              {t('cancel_label')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
