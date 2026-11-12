/**
 * 站点图标（favicon）上传载荷：在浏览器里把原图裁成正方形并导出 32 / 180 / 192 三档 PNG。
 *
 * 为什么必须在前端做：Worker 里没有图片解码/缩放能力，原图直传的后果是**每次首访**都要为
 * 「标签页上的一个小图标」下载原图（线上实测 830KB，占首访总流量的 60%，还和首屏 JS/字体抢带宽）。
 * 三档尺寸对齐浏览器实际用途：32 = 标签页，180 = apple-touch-icon，192 = Android 桌面图标。
 *
 * 服务端按 `site/favicon-<n>.png` 固定 key 落库（见 apps/api/src/modules/admin/routes.ts），
 * 壳页与 SEO 产物按同一 base 派生 link 标签（apps/api/src/core/fmt.ts 的 iconLinkTags）。
 *
 * 失败（.ico 解不出来 / 老浏览器没有 createImageBitmap）一律回落原图单文件路径 —— 与改动前行为一致，
 * 不会因为浏览器能力差异让功能不可用。
 */
export interface FaviconPayload {
  /** 32×32 PNG（多尺寸方案）或原图 data URL（回落） */
  data: string;
  /** 缺省即走服务端的老路径（单文件 `site/favicon.{ext}`） */
  variants?: Record<string, string>;
}

const SIZES = [32, 180, 192] as const;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('read failed'));
    fr.readAsDataURL(file);
  });
}

/** 居中裁正方形 → 三档 PNG（data URL）。解码失败由调用方兜底 */
async function squarePngs(file: File): Promise<Record<number, string>> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const out: Record<number, string> = {};
    for (const size of SIZES) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
      out[size] = canvas.toDataURL('image/png');
    }
    return out;
  } finally {
    bitmap.close();
  }
}

export async function buildFaviconPayload(file: File): Promise<FaviconPayload> {
  const isIco =
    file.type === 'image/x-icon' || file.type === 'image/vnd.microsoft.icon' || /\.ico$/i.test(file.name);
  if (isIco) return { data: await readAsDataUrl(file) };
  try {
    const pngs = await squarePngs(file);
    const small = pngs[32];
    const touch = pngs[180];
    const large = pngs[192];
    if (!small || !touch || !large) return { data: await readAsDataUrl(file) };
    return { data: small, variants: { '180': touch, '192': large } };
  } catch {
    return { data: await readAsDataUrl(file) };
  }
}
