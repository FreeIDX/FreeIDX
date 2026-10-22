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
