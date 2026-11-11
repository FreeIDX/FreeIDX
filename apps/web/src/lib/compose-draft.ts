/**
 * 发帖草稿（本地暂存）：正文编辑过程中自动写入 localStorage，刷新 / 误关页面后可继续编辑。
 * 服务端没有草稿表，「草稿」仅指本机未发布的表单快照；按 uid 分键，避免同一浏览器多账号串稿。
 * 所有读写都吞掉异常（隐私模式、配额满），暂存失败不得影响发帖。
 */
export interface ComposeDraft {
  subject: string;
  /** TipTap 产出的 HTML */
  html: string;
  /** 手选内容语言；''=自动识别 */
  lang: string;
  tags: string[];
  fid: number;
  sellOn: boolean;
  sellNum: string;
  sellType: number;
  /** 最近一次保存时间（ms），仅用于「已存草稿」提示 */
  savedAt: number;
}

const PREFIX = 'freeidx:compose-draft:';

const keyOf = (uid: number) => `${PREFIX}${uid}`;

/** 读取草稿：无草稿 / 解析失败 / 字段类型不符一律按无草稿处理（并就地清理脏数据） */
export function readComposeDraft(uid: number): ComposeDraft | null {
  try {
    const raw = localStorage.getItem(keyOf(uid));
    if (!raw) return null;
    const d: unknown = JSON.parse(raw);
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      clearComposeDraft(uid);
      return null;
    }
    const o = d as Partial<ComposeDraft>;
    return {
      subject: typeof o.subject === 'string' ? o.subject : '',
      html: typeof o.html === 'string' ? o.html : '',
      lang: typeof o.lang === 'string' ? o.lang : '',
      tags: Array.isArray(o.tags) ? o.tags.filter((x): x is string => typeof x === 'string') : [],
      fid: typeof o.fid === 'number' && o.fid > 0 ? o.fid : 0,
      sellOn: o.sellOn === true,
      sellNum: typeof o.sellNum === 'string' ? o.sellNum : '',
      sellType: typeof o.sellType === 'number' ? o.sellType : 1,
      savedAt: typeof o.savedAt === 'number' ? o.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/** 写入草稿，返回保存时间（写入失败也返回，提示文案照常显示，仅代表「本次已尝试暂存」） */
export function writeComposeDraft(uid: number, d: Omit<ComposeDraft, 'savedAt'>): number {
  const savedAt = Date.now();
  try {
    localStorage.setItem(keyOf(uid), JSON.stringify({ ...d, savedAt }));
  } catch {
    /* 隐私模式 / 配额满：静默降级为内存态，不阻断发帖 */
  }
  return savedAt;
}

/** 清空草稿（发布成功后调用） */
export function clearComposeDraft(uid: number): void {
  try {
    localStorage.removeItem(keyOf(uid));
  } catch {
    /* 忽略 */
  }
}
