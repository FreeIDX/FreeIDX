/**
 * 富文本编辑器（T2-10）：TipTap 产出 HTML（doctype=0，服务端写时定稿 sanitize）。
 * 工具栏：粗体/斜体/行内码/代码块/链接/图片上传（POST /api/attachments → 插 <img>，aid 计入 attachAids）/
 *         插入视频（B 站 / YouTube / Vimeo / 优酷，落成可播放 iframe，见 VideoEmbed.ts）。
 * 引用回复：父级传 quoted 摘要展示，提交时自行带 quotepid。
 * turnstile=1 时在提交按钮上方挂人机验证挂件（发帖/回帖用）；token 一次性，提交后一律重挂换发。
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Image as TiptapImage } from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { toVideoEmbed } from '@freeidx/shared';
import { deleteAttachment, uploadAttachment } from '../lib/api';
import { apiErrorMessage } from '../lib/errors';
import { fileToWebpThumb } from '../lib/image';
import { useT } from '../lib/i18n';
import { Turnstile, turnstileDisabled } from './Turnstile';
import { VideoEmbed } from './VideoEmbed';
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
  /** 正文区高度类（默认 min-h-[8rem]；发帖页传固定高，把编辑区拉长到 700px 并在内部滚动） */
  editorHeightClass?: string;
  /** 隐藏底部提交栏（发帖页把「发表主题」并入内容语言行，右对齐显示） */
  hideSubmitBar?: boolean;
  /** 隐藏提交栏时的外部入口：页面按钮调用该 ref 即触发内部 submit（空正文 / 人机验证校验保持一致） */
  submitRef?: MutableRefObject<(() => void) | null>;
  onChange?: (c: ComposerChange) => void;
  onSubmit?: (c: ComposerSubmit) => void | Promise<unknown>;
  onCancel?: () => void;
}

/**
 * 剪贴板/拖拽里的图片文件（截图、本地文件）：命中即由前端先传到 R2 再插入正文。
 * 带 text/html 的「网页内容」不拦截——保留默认粘贴（外链图片由服务端写时转存，
 * 前端硬拦会连正文文字一起吞掉）。
 */
function imageFilesOf(dt: DataTransfer | null): File[] {
  if (!dt || dt.types.includes('text/html')) return [];
  const out: File[] = [];
  const push = (f: File | null) => {
    if (!f || !/^image\//i.test(f.type)) return;
    if (out.some((x) => x.name === f.name && x.size === f.size)) return;
    out.push(f);
  };
  for (const f of Array.from(dt.files ?? [])) push(f);
  if (!out.length) for (const it of Array.from(dt.items ?? [])) if (it.kind === 'file') push(it.getAsFile());
  return out;
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
    editorHeightClass = 'min-h-[8rem]',
    hideSubmitBar = false,
    submitRef,
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
  /* editorProps 只在实例创建时读取一次，闭包里拿到的会是首帧的 onPickImage（editor 仍为 null）。
     用 ref 转发每次渲染的最新实现，避免粘贴/拖入落空。 */
  const pasteImagesRef = useRef<(files: File[]) => void>(() => undefined);

  const emit = (editor: Editor | null, list: UploadItem[]) => {
    onChangeRef.current?.({ html: editor ? editor.getHTML() : '', attachAids: list.map((a) => a.aid) });
  };

  /**
   * TipTap 的 `content` 只在挂载时读取一次：同一实例被复用到另一篇帖子（编辑态跨 tid 切换、
   * 服务端刷新了 op.message）时，编辑器会继续显示旧内容，提交时把旧正文写到新 pid 上。
   * 这里监听 initialHtml 变化显式 setContent（emitUpdate:false 防止回调污染父级状态）。
   */
  const appliedHtmlRef = useRef(initialHtml);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TiptapImage,
      VideoEmbed.configure({ removeLabel: t('video_remove') }),
      Placeholder.configure({ placeholder }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: {
        class: `${editorHeightClass} px-3 py-2 text-sm leading-6 text-foreground focus:outline-none break-words post-body`,
      },
      // 粘贴/拖入图片文件（截图、拷自其它应用）→ 直接上传 R2 并插入站内地址；顺序上传保证图片次序
      handlePaste: (_view, event) => {
        const files = imageFilesOf(event.clipboardData);
        if (!files.length) return false;
        event.preventDefault();
        pasteImagesRef.current(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = imageFilesOf(event.dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        pasteImagesRef.current(files);
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      appliedHtmlRef.current = e.getHTML();
      emit(e, attachRef.current);
    },
  });

  useEffect(() => {
    if (!editor || initialHtml === appliedHtmlRef.current) return;
    appliedHtmlRef.current = initialHtml;
    editor.commands.setContent(initialHtml, { emitUpdate: false });
  }, [editor, initialHtml]);

  const insertLink = () => {
    if (!editor) return;
    if (editor.isActive('link')) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt(t('enter_link_url'), 'https://')?.trim();
    if (!url) return;
    // 协议白名单：只接受 http(s) 与站内绝对路径，阻断 javascript:/data: 等可执行伪协议
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    emit(editor, attachRef.current);
  };

  /** 插入视频：分享链接 → 平台播放器 iframe（白名单与写时定稿共用 isVideoEmbedSrc） */
  const insertVideo = () => {
    if (!editor) return;
    const raw = window.prompt(t('enter_video_url'), 'https://')?.trim();
    if (!raw) return;
    const v = toVideoEmbed(raw);
    if (!v) {
      setError(t('unsupported_video_url'));
      return;
    }
    setError('');
    editor.chain().focus().insertContent({ type: 'videoEmbed', attrs: { ...v } }).run();
    emit(editor, attachRef.current);
  };

  const onPickImage = async (file: File | undefined) => {
    if (!file || !editor) return;
    setUploading(true);
    setError('');
    try {
      /* 尺寸与缩略图并行算：缩略图失败返回 null，上传照常（列表回退原图） */
      const [{ w, h }, thumb] = await Promise.all([readDims(file), fileToWebpThumb(file)]);
      const r = await uploadAttachment(file, { isImage: true, width: w, height: h, thumb });
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
  // 每次渲染刷新粘贴/拖入的上传实现（editorProps 闭包只持有 ref，见上方说明）
  pasteImagesRef.current = (files) => {
    void (async () => {
      for (const f of files) await onPickImage(f);
    })();
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
    // 纯视频帖（正文只有一个播放器）也算有内容，不能被「请输入内容」拦下
    const hasVideo = /<iframe[^>]*\bsrc="[^"]+"/i.test(html);
    if (!text && !hasVideo) {
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

  /**
   * 外部按钮入口（发帖页把「发表主题」并入内容语言行）：渲染期同步最新闭包，
   * 页面按钮调用 ref 即走本组件 submit —— 空正文 / 人机验证未完成的拦截与提示仍留在编辑器内。
   */
  if (submitRef) submitRef.current = () => void submit();

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
        {/* 插入视频：粘贴/输入 B 站、YouTube 等分享链接，正文里落成可播放的 iframe */}
        <button type="button" className={btn} disabled={!editor} onClick={insertVideo}>
          {t('insert_video')}
        </button>
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
      {!hideSubmitBar && onSubmit && (
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
