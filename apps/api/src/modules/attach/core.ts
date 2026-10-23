/**
 * 附件核心纯函数（T2-8，§9）：白名单/分类/扩展名/R2 key/时间戳目录。
 * 上传白名单（'all' 白名单 + 分类）与名单外前缀 `_` 防执行策略。
 * CPU 归零原则：全部无 I/O，路由层只做编排。
 */
import type { Env } from '../../types/env';

/** 上传上限 20480000（≈20M） */
export const ATTACH_MAX_BYTES = 20_480_000;

/** 上传扩展名白名单 */
const ATTACH_WHITELIST = [
  'av', 'wmv', 'wav', 'wma', 'avi', 'rm', 'rmvb', 'mp4', 'mp3', 'exe', 'bin', 'swf', 'fla', 'as',
  'gif', 'jpg', 'jpeg', 'png', 'bmp', 'doc', 'xls', 'ppt', 'docx', 'xlsx', 'pptx', 'pdf',
  'c', 'cpp', 'cc', 'txt', 'tar', 'zip', 'gz', 'rar', '7z', 'bz', 'chm', 'bt', 'torrent',
  'ttf', 'font', 'fon',
];
const WHITELIST_SET = new Set(ATTACH_WHITELIST);

const IMAGE_EXTS = ['gif', 'jpg', 'jpeg', 'png', 'bmp'];

/** 附件分类表（attach_type 用），image 集合另用于 MIME */
const ATTACH_CATEGORIES: Record<string, string[]> = {
  video: ['av', 'wmv', 'wav', 'wma', 'avi', 'rm', 'rmvb', 'mp4'],
  music: ['mp3', 'mp4'],
  exe: ['exe', 'bin'],
  flash: ['swf', 'fla', 'as'],
  image: IMAGE_EXTS,
  office: ['doc', 'xls', 'ppt', 'docx', 'xlsx', 'pptx'],
  pdf: ['pdf'],
  text: ['c', 'cpp', 'cc', 'txt'],
  zip: ['tar', 'zip', 'gz', 'rar', '7z', 'bz'],
  book: ['chm'],
  torrent: ['bt', 'torrent'],
  font: ['ttf', 'font', 'fon'],
};

const IMAGE_MIME: Record<string, string> = {
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  bmp: 'image/bmp',
  webp: 'image/webp',
};

/** 取扩展名：末段 '.' 后、小写、仅留 a-z0-9、截断 7 */
export function fileExt(name: string, max = 7): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, max);
}

/** 是否在白名单（名单外→改名 `_ext` 防执行） */
export const isAllowedExt = (ext: string): boolean => WHITELIST_SET.has(ext);

/** 存储用扩展名：名单内原样，名单外加 `_` 前缀（防执行策略） */
export function storageExt(ext: string): string {
  return isAllowedExt(ext) ? ext : `_${ext}`;
}

/** attach_type 分类 */
export function attachType(ext: string): string {
  for (const [cat, list] of Object.entries(ATTACH_CATEGORIES)) {
    if (list.includes(ext)) return cat;
  }
  return 'other';
}

/** 预览/直链 Content-Type：图片按实际 MIME，其余统一二进制（防内容嗅探执行） */
export function mimeFor(ext: string): string {
  return IMAGE_MIME[ext] ?? 'application/octet-stream';
}

/** 15 位小写字母数字随机串（crypto 随机） */
function randToken(len = 15): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  return out;
}

/** attach 正式目录规则 attach_dir_save_rule='Ym' → YYYYMM（UTC） */
export function ymDir(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 上传暂存 R2 key：tmp/{uid}_{rand15}.{ext}（§9 前缀分区） */
export const tmpKey = (uid: number, ext: string): string => `tmp/${uid}_${randToken(15)}.${ext}`;

/** 正式附件 R2 key：attach/{YYYYmm}/{rand}.{ext} */
export const attachKey = (ym: string, ext: string): string => `attach/${ym}/${randToken(20)}.${ext}`;

/** R2 list 的单页结果（只投影维护页需要的字段：key / 上传时间） */
export interface FilesListPage {
  objects: { key: string; size?: number; uploaded?: Date | string }[];
  truncated?: boolean;
  cursor?: string;
}

/** R2 桶访问的最小面（真实 R2Bucket 结构兼容；测试替身同形） */
interface FilesBucket {
  put: (key: string, value: ArrayBufferView | string, options?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
  get: (key: string) => Promise<{ body: ReadableStream | Uint8Array | null; httpMetadata?: { contentType?: string } } | null>;
  /** 单个 key 或批量（R2 单次最多 1000 个 key，见 Workers API reference） */
  delete: (key: string | string[]) => Promise<unknown>;
  /**
   * 分页枚举（后台「R2 存储维护」用）。真实 R2Bucket.list 兼容；
   * 测试替身可省略 —— 维护模块会显式判空并回落「存储不支持枚举」。
   */
  list?: (options: { prefix?: string; cursor?: string; limit?: number }) => Promise<FilesListPage>;
}

export const filesBucket = (env: Env): FilesBucket => env.FILES as unknown as FilesBucket;
