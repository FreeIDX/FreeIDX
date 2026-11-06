/**
 * 头像客户端裁切/缩放：后端 POST /api/me/avatar 限 40KB base64 前的字节，
 * 故上传前用 canvas 居中裁成正方形、缩放到目标边长，并迭代缩小直到 ≤maxBytes，输出 image/png dataURL。
 */
import { uiT } from './api';

const AVATAR_MAX_BYTES = 40_000;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(uiT('image_decode_failed')));
    };
    img.src = url;
  });
}

function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((b64.length * 3) / 4);
}

function drawSquare(img: HTMLImageElement, dim: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(uiT('canvas_unavailable'));
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, dim, dim);
  return canvas.toDataURL('image/png');
}

export async function fileToPngDataUrlResize(file: File, size = 128, maxBytes = AVATAR_MAX_BYTES): Promise<string> {
  const img = await loadImage(file);
  let dim = size;
  let url = drawSquare(img, dim);
  while (dataUrlBytes(url) > maxBytes && dim > 24) {
    dim = Math.max(24, Math.floor(dim * 0.8));
    url = drawSquare(img, dim);
  }
  return url;
}

/* ---------------- 列表缩略图（性能项 C6） ----------------
 * 主题列表里的 <img> 只有 100px 高，却直接引原图（实测单张 410KB，占满整页流量）。
 * 缩略图在**客户端**生成后随原件一起上传：Workers 没有图像编解码器，服务端只能校验与落盘。
 */

/** 长边上限：列表三列栅格在 2x 屏下约 320px，400 足够；与服务端 ATTACH_THUMB_MAX_BYTES 对齐 */
const THUMB_MAX_SIDE = 400;
const THUMB_MAX_BYTES = 60_000;

/** 等比缩放到长边 ≤maxSide 并编码为 WebP（不放大：原图更小时直接按原尺寸编码） */
function drawScaledWebp(img: HTMLImageElement, maxSide: number): Promise<Blob | null> {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return Promise.resolve(null);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/webp', 0.8);
  });
}

/**
 * 生成列表缩略图（WebP）：长边 ≤400px，超过 60KB 逐级缩小。
 *
 * 返回 null 的三种情况都表示「放弃缩略图」，上传照常进行、列表回退原图——
 * 缩略图是纯优化，任何环节失败都不该影响功能：
 *  - 解码失败（损坏文件 / 非图片）；
 *  - 编码失败或浏览器不支持 WebP 编码（Safari 老版本 toBlob 会退回 PNG）；
 *  - 缩到 120px 仍然超限（近乎纯噪点的图，缩略图不会比原图小多少）。
 */
export async function fileToWebpThumb(file: File, maxSide = THUMB_MAX_SIDE): Promise<Blob | null> {
  try {
    const img = await loadImage(file);
    let side = maxSide;
    for (;;) {
      const blob = await drawScaledWebp(img, side);
      // 服务端按 RIFF/WEBP 魔数校验，非 WebP 一律丢弃，这里提前拦下省一次无效上传
      if (!blob || blob.type !== 'image/webp') return null;
      if (blob.size <= THUMB_MAX_BYTES || side <= 120) return blob;
      side = Math.max(120, Math.floor(side * 0.75));
    }
  } catch {
    return null;
  }
}
