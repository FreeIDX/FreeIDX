/**
 * 外链图片本地化（R2 转存）：正文里 `<img src="http(s)://…">` 在写时定稿前下载并转存到 R2
 * （tmp/ 暂存 + bbs_attach.status=0），再把 src 重写为 `/api/attachments/:aid/preview`，
 * 随 associateAttachments() 走正常的 tmp→attach 迁移、计数、删除与 GC。
 *
 * 为什么不放前端：跨域图片受 CORS 限制，浏览器读不到字节；只有服务端能可靠转存。
 * 为什么写时做：本项目读路径零二次清洗（写时定稿），改写必须发生在 postMessageFmt 之前，
 * 且 message / message_fmt / image_urls / summary / SEO 都基于改写后的正文。
 *
 * 安全与限额：
 *  - 只接受魔数确认的位图（png/jpeg/gif/bmp/webp）；SVG/AVIF 等一律跳过（前者可携带脚本，
 *    后者无 MIME 映射），保留原外链；
 *  - SSRF：仅 http(s)、仅 80/443、拒绝本机/内网/云元数据地址字面量，重定向逐跳复检；
 *  - 单张 ≤10MB、单帖 ≤5 张 / 总量 ≤24MB、10s 超时、并发 3；
 *    （每张 = 1 fetch + 1 R2 put + 关联时 3 次 R2，成本与用户自带附件同档，故按附件量留余量）
 *  - D1 预算见预算守卫：接近单次 invocation 上限即停止转存，宁可留外链也不让发帖失败；
 *  - 任一图片失败保留原外链，绝不阻断发帖。
 */
import type { D1b } from '../../core/db';
import type { Env } from '../../types/env';
import { attachType, storageExt, tmpKey } from './core';

/** 单帖最多转存张数（每张 1 fetch + 1 R2 put + 关联 3 次 R2，受 Workers 子请求预算约束） */
const MAX_REMOTE_IMAGES = 5;
/** 单张上限（公开图床极少超过；与附件上传 20MB 上限区分，控制并发内存） */
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
/** 单帖转存总量上限（并发读到内存的峰值约为 3 × 单张） */
const MAX_REMOTE_TOTAL_BYTES = 24 * 1024 * 1024;
/** D1 查询预留线：余下额度留给关联/计分/收尾，超线停止转存（留外链不影响发帖） */
const D1_HEADROOM = 38;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const DOWNLOAD_CONCURRENCY = 3;

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const SRC_ATTR_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export interface RemoteImageDeps {
  db: D1b;
  env: Env;
}

export interface RemoteLocalizeResult {
  /** 改写后的正文（无外链或全部失败时原样返回） */
  message: string;
  /** 新建的暂存附件 aid，调用方需并入 attachAids 交给 associateAttachments */
  aids: number[];
}

/**
 * 把正文里的外链图片下载转存到 R2，并把 src 重写为站内预览地址。
 * 失败静默降级（保留外链），不向外抛错——转存只是增强，不能影响发帖成功率。
 */
export async function localizeRemoteImages(
  deps: RemoteImageDeps,
  opts: { uid: number; message: string },
): Promise<RemoteLocalizeResult> {
  const srcs = collectRemoteSrcs(opts.message);
  if (!srcs.length || opts.uid <= 0) return { message: opts.message, aids: [] };
  const bucket = (deps.env as { FILES?: unknown } | undefined)?.FILES as { put?: unknown; delete?: unknown } | undefined;
  if (!bucket || typeof bucket.put !== 'function') return { message: opts.message, aids: [] }; // 未绑定 R2：跳过
  if (typeof fetch !== 'function') return { message: opts.message, aids: [] };

  const local = new Map<string, string>();
  const aids: number[] = [];
  let total = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= srcs.length) return;
      const url = srcs[i];
      if (!url || total >= MAX_REMOTE_TOTAL_BYTES) return;
      // 预算已接近单次 invocation 上限：停手（剩余图片保留外链，发帖不能因子请求超限失败）
      if (deps.db.stats.d1Queries >= D1_HEADROOM) return;
      try {
        const got = await downloadImage(url);
        if (!got) continue;
        if (total + got.bytes.length > MAX_REMOTE_TOTAL_BYTES) continue;
        total += got.bytes.length;
        const aid = await storeImage(deps, bucket, opts.uid, got);
        if (!aid) continue;
        aids.push(aid);
        local.set(url, `/api/attachments/${aid}/preview`);
      } catch {
        /* 单张失败：保留原外链 */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, srcs.length) }, () => worker()));

  if (!local.size) return { message: opts.message, aids: [] };
  return { message: rewriteSrcs(opts.message, local), aids };
}

/* ------------------------------- 正文解析 ------------------------------- */

/** 提取 `<img src>` 中的绝对 http(s) 外链（去重、限量、跳过站内附件地址） */
export function collectRemoteSrcs(message: string): string[] {
  const out: string[] = [];
  for (const tag of message.match(IMG_TAG_RE) ?? []) {
    if (out.length >= MAX_REMOTE_IMAGES) break;
    const m = SRC_ATTR_RE.exec(tag);
    if (!m) continue;
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) continue; // 相对路径 / data: / blob: 不处理
    const url = raw.replace(/&amp;/g, '&');
    if (out.includes(url) || isOwnAssetUrl(url)) continue;
    out.push(url);
  }
  return out;
}

/** 把命中的外链 src 换成站内地址（保留原有引号形式；同一 URL 多处出现一并替换） */
export function rewriteSrcs(message: string, local: Map<string, string>): string {
  return message.replace(IMG_TAG_RE, (tag) => {
    const m = SRC_ATTR_RE.exec(tag);
    if (!m) return tag;
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    const target = local.get(value.replace(/&amp;/g, '&'));
    if (!target) return tag;
    const quote = m[2] !== undefined ? "'" : '"';
    return tag.replace(SRC_ATTR_RE, () => `src=${quote}${target}${quote}`);
  });
}

/** 站内已有附件/静态资源（绝对地址形式）不再重复转存 */
function isOwnAssetUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return /^\/api\/attachments\/\d+\/(?:preview|download)$/.test(u.pathname) || /^\/files\//.test(u.pathname);
  } catch {
    return false;
  }
}

/* ------------------------------- 下载与校验 ------------------------------- */

interface DownloadedImage {
  bytes: Uint8Array;
  ext: string;
  name: string;
}

/** 下载外链图片：手动跟随重定向（逐跳 SSRF 复检）、超时、体积上限、魔数确认类型 */
async function downloadImage(raw: string): Promise<DownloadedImage | null> {
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeRemoteUrl(url)) return null;
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'image/png,image/jpeg,image/gif,image/bmp,image/webp;q=0.9,*/*;q=0.1' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) return null;
    // 防盗链常见 text/html 占位页：提前拒绝，省一次读流
    const declared = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (declared.startsWith('text/')) return null;
    const bytes = await readLimited(res, MAX_REMOTE_IMAGE_BYTES);
    if (!bytes?.length) return null;
    const kind = sniffImage(bytes);
    if (!kind) return null;
    return { bytes, ext: kind, name: fileNameFromUrl(url, kind) };
  }
  return null;
}

/** 限长读流：超过上限立即取消，避免把超大响应读进内存 */
async function readLimited(res: Response, max: number): Promise<Uint8Array | null> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > max) return null;
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  if (!total) return null;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 魔数识别位图（不信任 content-type）：返回存储扩展名，非白名单位图返回 null */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 12 && String.fromCharCode(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0) === 'RIFF') {
    if (String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0) === 'WEBP') return 'webp';
  }
  return null;
}

/** URL 末段文件名（去掉参数与非法字符）；无扩展名时回退 remote.<ext>，供「另存为」使用 */
function fileNameFromUrl(raw: string, ext: string): string {
  let base = '';
  try {
    const u = new URL(raw);
    base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    base = '';
  }
  base = base.replace(/[^\w.\-\u4e00-\u9fa5]/g, '').slice(0, 80);
  return base && base.includes('.') ? base : `remote.${ext}`;
}

/* ------------------------------- SSRF 防护 ------------------------------- */

/** 是否允许作为转存目标（仅 http(s) + 80/443 + 非内网字面量） */
export function isSafeRemoteUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== '80' && u.port !== '443') return false;
  return !isPrivateHost(u.hostname);
}

/**
 * 本机/内网/保留地址判定（按 URL 解析后的字面量，含 IPv4/IPv6）：
 * 覆盖 127/8、10/8、172.16/12、192.168/16、169.254/16（含云元数据）、100.64/10、
 * 0/8、保留与组播段，以及 ::1、fc00::/7、fe80::/10 与 IPv4 映射地址。
 * 说明：不做 DNS 解析后的 IP 复检（Workers 无同步解析接口），域名指向内网仍可能被放行——
 * 目标仅为阻断最常见的内网探测/元数据抓取，转存内容最终还要过魔数校验。
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const p = host.split('.').map(Number);
    const [a, b] = p;
    if (p.some((n) => n > 255) || a === undefined || b === undefined) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || b === 0)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^f[cd]/.test(host)) return true; // fc00::/7 唯一本地地址
    if (/^fe[89ab]/.test(host)) return true; // fe80::/10 链路本地
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    if (mapped?.[1]) return isPrivateHost(mapped[1]);
    return false;
  }
  // 单标签主机名（内网短名）一律拒绝；公网域名必然含点
  return !host.includes('.');
}

/* ------------------------------- R2 落盘 ------------------------------- */

/** 写 tmp/ 对象 + status=0 行（与 POST /api/attachments 同构，便于复用 GC/关联/权限闸门） */
async function storeImage(
  deps: RemoteImageDeps,
  bucket: { put?: unknown; delete?: unknown },
  uid: number,
  got: DownloadedImage,
): Promise<number> {
  const key = tmpKey(uid, storageExt(got.ext));
  const put = bucket.put as (k: string, v: Uint8Array, o: { httpMetadata: { contentType: string } }) => Promise<unknown>;
  await put.call(bucket, key, got.bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
  const row = await deps.db
    .prepare<{ aid: number }>(
      `INSERT INTO bbs_attach (tid,pid,uid,filesize,width,height,filename,orgfilename,filetype,create_date,downloads,isimage,status,credits)
       VALUES (0,0,?,?,0,0,?,?,?,?,0,1,0,0) RETURNING aid`,
    )
    .bind(uid, got.bytes.length, key, got.name, attachType(got.ext), Math.floor(Date.now() / 1000))
    .first<{ aid: number }>();
  const aid = Number(row?.aid ?? 0);
  if (!aid) {
    // 行写失败：回收刚落的对象，避免留下无主 tmp 对象
    const del = bucket.delete as ((k: string) => Promise<unknown>) | undefined;
    if (typeof del === 'function') await del.call(bucket, key).catch(() => undefined);
    return 0;
  }
  return aid;
}
