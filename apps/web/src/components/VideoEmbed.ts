/**
 * TipTap 视频节点（atom block）：把 B 站 / YouTube / Vimeo / 优酷的分享链接落成
 * <iframe class="video-embed">，编辑器内与前台都直接播放。
 *
 * 铁律：产出的 iframe src 必须命中服务端写时定稿白名单（packages/shared/src/video-embed.ts
 * 的 isVideoEmbedSrc，apps/api/src/core/sanitize.ts 引用同一份），否则发帖后 src 会被清空。
 * 属性只写白名单内的 src/width/height/title/class/frameborder/allowfullscreen。
 */
import { Node, mergeAttributes } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import { isVideoEmbedSrc, toVideoEmbed } from '@freeidx/shared';

export interface VideoEmbedOptions {
  /** 右上角移除按钮的可访问名称（由宿主注入 t(...) 结果，避免与 i18n 脱钩） */
  removeLabel: string;
}

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 360;

export const VideoEmbed = Node.create<VideoEmbedOptions>({
  name: 'videoEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { removeLabel: '' };
  },

  addAttributes() {
    return {
      src: { default: null },
      width: { default: DEFAULT_WIDTH },
      height: { default: DEFAULT_HEIGHT },
      /** 播放器标题（iframe title，读屏用） */
      title: { default: null },
    };
  },

  /* 重新载入已发布正文（编辑态 / 草稿恢复）时，把合规 iframe 还原成节点，避免内容被 schema 丢弃 */
  parseHTML() {
    return [
      {
        tag: 'iframe[src]',
        getAttrs: (el) => {
          const node = el as HTMLElement;
          const src = node.getAttribute('src') ?? '';
          if (!isVideoEmbedSrc(src)) return false;
          return {
            src,
            width: Number(node.getAttribute('width') ?? 0) || DEFAULT_WIDTH,
            height: Number(node.getAttribute('height') ?? 0) || DEFAULT_HEIGHT,
            title: node.getAttribute('title'),
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'iframe',
      mergeAttributes(HTMLAttributes, {
        class: 'video-embed',
        frameborder: '0',
        allowfullscreen: 'true',
      }),
    ];
  },

  /** 编辑器内直接渲染真播放器（非编辑态），右上角提供移除按钮 */
  addNodeView() {
    const options = this.options;
    return ({ node, editor, getPos }) => {
      const wrap = document.createElement('div');
      wrap.className = 'video-embed-wrap';
      wrap.contentEditable = 'false';

      const frame = document.createElement('iframe');
      frame.className = 'video-embed';
      frame.setAttribute('frameborder', '0');
      frame.setAttribute('allowfullscreen', 'true');
      frame.setAttribute('loading', 'lazy');

      const sync = (attrs: Record<string, unknown>) => {
        const src = String(attrs.src ?? '');
        if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
        frame.setAttribute('width', String(attrs.width ?? DEFAULT_WIDTH));
        frame.setAttribute('height', String(attrs.height ?? DEFAULT_HEIGHT));
        const title = attrs.title ? String(attrs.title) : '';
        if (title) frame.setAttribute('title', title);
        else frame.removeAttribute('title');
      };
      sync(node.attrs);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'video-embed-del';
      remove.textContent = '×';
      if (options.removeLabel) {
        remove.title = options.removeLabel;
        remove.setAttribute('aria-label', options.removeLabel);
      }
      // mousedown 先挡掉，否则点按钮会先被编辑器当成落点把节点取消选中
      remove.addEventListener('mousedown', (e) => e.preventDefault());
      remove.addEventListener('click', (e) => {
        e.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (typeof pos !== 'number') return;
        editor
          .chain()
          .focus()
          .deleteRange({ from: pos, to: pos + node.nodeSize })
          .run();
      });

      wrap.append(frame, remove);

      return {
        dom: wrap,
        update: (updated) => {
          if (updated.type.name !== 'videoEmbed') return false;
          sync(updated.attrs);
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },

  /** 粘贴一个纯视频链接（且整段就只有这个链接）时直接落成播放器；其余粘贴行为不变 */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handlePaste: (view, event) => {
            // 代码块里粘贴要保留原文，别把示例链接变成播放器
            const { $from } = view.state.selection;
            if ($from.parent.type.name === 'codeBlock') return false;
            const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
            if (!text || /\s/.test(text)) return false;
            const v = toVideoEmbed(text);
            const type = view.state.schema.nodes.videoEmbed;
            if (!v || !type) return false;
            event.preventDefault();
            view.dispatch(view.state.tr.replaceSelectionWith(type.create({ ...v })));
            return true;
          },
        },
      }),
    ];
  },
});
