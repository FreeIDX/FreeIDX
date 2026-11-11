/**
 * 视频外链 → 内嵌播放器（B 站 / YouTube / Vimeo / 优酷）。
 *
 * 单一事实来源：前端「插入视频」按钮用 toVideoEmbed 把分享链接换算成播放器地址，
 * 服务端 xnHtmlSafe（apps/api/src/core/sanitize.ts）用同一份白名单校验 iframe/embed 的 src。
 * 两边不同步的后果是「编辑器里能播、发出去被清空」，改动只需改本文件。
 */

/** 允许内嵌的播放器地址白名单（iframe/embed 的 src） */
const EMBED_SRC_PATTERNS: RegExp[] = [
  /^https?:\/\/player\.youku\.com\/embed\/[\w=]+$/i,
  /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[\w-]+(?:\?[^'"\\<>\s]*)?$/i,
  /^https?:\/\/player\.bilibili\.com\/player\.html\?[^'"\\<>\s]+$/i,
  /^https?:\/\/player\.vimeo\.com\/video\/\d+(?:\?[^'"\\<>\s]*)?$/i,
];

/** 内嵌播放器默认尺寸（16:9），前端落库时同时写入 width/height 属性 */
const EMBED_WIDTH = 640;
const EMBED_HEIGHT = 360;

/** src 是否命中内嵌白名单（服务端写时定稿与前端解析共用） */
export function isVideoEmbedSrc(src: string): boolean {
  const s = src.trim();
  return s !== '' && EMBED_SRC_PATTERNS.some((re) => re.test(s));
}

export interface VideoEmbed {
  /** 可内嵌播放的绝对地址 */
  src: string;
  width: number;
  height: number;
  /** 播放器标题（供 iframe title，读屏可辨） */
  title: string;
}

const YT_ID = /^[\w-]{6,20}$/;
const BILI_BV = /^BV[0-9A-Za-z]{10}$/;

function embed(src: string, title: string): VideoEmbed {
  return { src, width: EMBED_WIDTH, height: EMBED_HEIGHT, title };
}

function parseUrl(text: string): URL | null {
  const withProto = /^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    return new URL(withProto);
  } catch {
    return null;
  }
}

/** YouTube 起播秒数（t=90 / t=90s / start=90 都兼容，取不到则不带参数） */
function ytStart(u: URL): string {
  const raw = u.searchParams.get('t') ?? u.searchParams.get('start') ?? '';
  const sec = Math.trunc(Number(String(raw).replace(/s$/, '')));
  return Number.isFinite(sec) && sec > 0 ? `?start=${sec}` : '';
}

/** 已带 https 前缀的播放器地址原样收下（用户直接把播放器链接粘进来的情况） */
function asEmbedUrl(src: string): string {
  return src.replace(/^http:\/\//i, 'https://');
}

/**
 * 分享链接 → 内嵌播放器属性；不认识或解析不出视频 ID 时返回 null。
 * 支持：youtu.be / youtube.com/watch|shorts|live|embed、bilibili.com/video/BV…|av…、
 * vimeo.com/…、v.youku.com/v_show/id_….html。
 */
export function toVideoEmbed(raw: string): VideoEmbed | null {
  const text = raw.trim();
  if (!text) return null;
  const u = parseUrl(text);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');

  if (host === 'youtu.be') {
    const id = path.slice(1);
    return YT_ID.test(id) ? embed(`https://www.youtube.com/embed/${id}${ytStart(u)}`, 'YouTube') : null;
  }

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    if (path === '/watch') {
      const id = u.searchParams.get('v') ?? '';
      return YT_ID.test(id) ? embed(`https://www.youtube.com/embed/${id}${ytStart(u)}`, 'YouTube') : null;
    }
    const m = /^\/(?:embed|shorts|live|v)\/([\w-]{6,20})$/.exec(path);
    return m ? embed(`https://www.youtube.com/embed/${m[1]}${ytStart(u)}`, 'YouTube') : null;
  }

  if (host === 'bilibili.com' || host === 'm.bilibili.com' || host === 'player.bilibili.com') {
    if (host === 'player.bilibili.com') return isVideoEmbedSrc(u.href) ? embed(asEmbedUrl(u.href), 'Bilibili') : null;
    const page = Math.max(1, Math.trunc(Number(u.searchParams.get('p') ?? 1)) || 1);
    const bv = /^\/video\/(BV[0-9A-Za-z]{10})/.exec(path)?.[1] ?? '';
    const av = /^\/video\/av(\d+)/i.exec(path)?.[1] ?? '';
    const key = BILI_BV.test(bv) ? `bvid=${bv}` : av ? `aid=${av}` : '';
    if (!key) return null;
    // high_quality=1：默认拉高码率；autoplay=0：不在正文里突然出声
    const query = `${key}&page=${page}&high_quality=1&autoplay=0`;
    return embed(`https://player.bilibili.com/player.html?${query}`, 'Bilibili');
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /^\/(?:video\/)?(\d{6,12})$/.exec(path);
    return m ? embed(`https://player.vimeo.com/video/${m[1]}`, 'Vimeo') : null;
  }

  // v.youku.com / m.youku.com / player.youku.com 都是同一个播放器的入口，按尾域判定
  if (host === 'youku.com' || host.endsWith('.youku.com')) {
    if (host === 'player.youku.com') return isVideoEmbedSrc(u.href) ? embed(asEmbedUrl(u.href), 'Youku') : null;
    const m = /^\/v_show\/id_([\w=]+)\.html$/.exec(path);
    return m ? embed(`https://player.youku.com/embed/${m[1]}`, 'Youku') : null;
  }

  return null;
}
