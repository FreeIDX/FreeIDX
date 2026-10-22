/**
 * §12 扩展点契约全集（铁律 5：契约先于插件消费者，M1 定型后不改签名）。
 * 八项：①中间件注册 ②生命周期事件 ③registerRoute ④registerCron
 *      ⑤render:head(PageMeta) ⑥robots:contribute ⑦bootstrap:contribute ⑧前端组件插槽
 */

/** manifest.json 字段定义（§15.5） */
export interface ExtensionManifest {
  id: string;
  name: Record<string, string>;
  version: string;
  /** 出厂安装状态 */
  installed: 0 | 1;
  /** 出厂启用状态（kv ext 启停覆盖） */
  enable: 0 | 1;
  dependencies?: Record<string, string>;
  capabilities?: Record<string, unknown>;
  /**
   * 不在「插件中心」列表中展示（详情/启停接口仍可用）。
   * 用途：主题类插件已由「主题管理」统一呈现（如简蓝主题 light），插件中心再列一次会重复；
   * 但其配置表单仍托管在 /admin/extensions/{id}，故只隐藏列表项，不摘除目录条目。
   */
  hiddenInCatalog?: boolean;
}

/** 生命周期事件（契约 ②） */
interface ExtensionEvents {
  'post:created': { pid: number; tid: number; uid: number; isfirst: number };
  'post:updated': { pid: number; tid: number; uid: number };
  'post:deleted': { pid: number; tid: number; uid: number };
  'thread:created': { tid: number; fid: number; uid: number };
  'thread:deleted': { tid: number; fid: number };
  'user:created': { uid: number; gid: number };
  'user:group-changed': { uid: number; oldGid: number; newGid: number };
  'mod:executed': { uid: number; tid: number; action: string };
  'render:head': PageMeta;
  'robots:contribute': RobotsContribution;
  'bootstrap:contribute': { payload: Record<string, unknown> };
}

export type EventName = keyof ExtensionEvents;
export type EventPayload<N extends EventName> = ExtensionEvents[N];

/**
 * 契约 ⑤ render:head 的上下文（§16.4：核心定义 = 路由类型 + 实体数据 + setting 源）。
 * seo/geo 插件消费同一份 PageMeta，不重复实现数据拉取。
 */
export interface PageMeta {
  kind: 'index' | 'forum' | 'thread' | 'user' | 'mythread';
  canonical: string;
  title: string;
  description: string;
  /** 站点语言（setting.lang），核心保底渲染 <html lang> 用 */
  lang?: string;
  noindex?: boolean;
  /** 各插件贡献的 head 片段，核心有序合并（title/canonical 冲突时核心保底优先） */
  head: string[];
  /** JSON-LD 片段仅 seo 插件输出（§16.4 唯一归属） */
  jsonLd: Record<string, unknown>[];
  og: Record<string, string>;
  entity?: {
    fid?: number;
    tid?: number;
    uid?: number;
    seoTitle?: string;
    seoKeywords?: string;
    lastDate?: number;
    digest?: number;
  };
}

/** 契约 ⑥ robots.txt 片段贡献：核心装配引擎有序合并 + 去重 */
export interface RobotsContribution {
  /** 优先级小者在前；同优先级按注册顺序 */
  order: number;
  lines: string[];
}

/** 契约 ③ registerRoute：插件注册 Worker 路由（sitemap/llms.txt/验证文件/301 层） */
export interface RouteRegistration {
  method: 'GET' | 'POST' | 'ALL';
  path: string;
  /** 处理器以不透明函数引用注入，类型由 api 侧 Hono 收窄 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => unknown;
}

/** 契约 ④ registerCron：插件注册定时任务 */
export interface CronRegistration {
  /** 与 wrangler [triggers].crons 对应的表达式 */
  pattern: string;
  name: string;
  run: (ctx: CronRunContext) => Promise<void>;
}

export interface CronRunContext {
  /** 距上次运行的秒数（核心记录于 kv） */
  sinceLastSec: number;
  now: number;
  waitUntil: (p: Promise<unknown>) => void;
}

/** 契约 ⑧ 前端组件插槽点位（§17.2 广告位复用） */
export const SLOT_POSITIONS = [
  'header',
  'footer',
  'sidebar',
  'thread_top',
  'thread_bottom',
  'post_between',
  'forum_list_between',
] as const;

/** kv `extensions` 配置里的运行态（启停只改 kv、零部署，L1 热插拔） */
export interface ExtensionState {
  installed: 0 | 1;
  enable: 0 | 1;
  config?: Record<string, unknown>;
}

/**
 * 多语言文案：string = 单语言（原样展示，兼容旧插件）；map = locale → 文案（extText 取词）。
 * 服务端插件自声明（manifest.name / schema brief/intro/label/help 等），后台按后台语言（setting.adminLang）渲染。
 */
export type LocText = string | Record<string, string>;

/** LocText 取词：lang → zh-cn → 任一 → 空串（与后台 extName 同策略） */
export function extText(v: LocText | undefined, lang: string): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  return v[lang] ?? v['zh-cn'] ?? Object.values(v)[0] ?? '';
}

/** 后台结构化配置表单的输入控件形态（type 只决定控件，不决定存储桶） */
type ExtFieldType = 'text' | 'textarea' | 'password' | 'switch' | 'kv';

/** 插件自声明的单个配置字段：与服务端 kv 键 ext:{id}:config / ext:{id}:secret 一一对应（勿改名） */
export interface ExtField {
  /** 存储键：config 顶层键或 secret 键；嵌套写入用 path */
  key: string;
  /** 嵌套路径（相对 config 根），如 geo 的 ['aiBots','GPTBot']；缺省 [key] */
  path?: string[];
  /**
   * 落 config 还是 secret。缺省规则：type==='password' ? 'secret' : 'config'；
   * secret 的 text/textarea 字段必须显式写 target:'secret'（服务端下发前统一归一化补全）。
   */
  target?: 'config' | 'secret';
  type: ExtFieldType;
  label: LocText;
  /** 说明方法：告诉管理员去哪拿这个值、填了会发生什么 */
  help?: LocText;
  placeholder?: LocText;
  /** textarea 行数 */
  rows?: number;
  /**
   * 值无需人工填写：服务端在首次使用时自动生成并持久化（如 IndexNow Key 这类站点自拟字符串）。
   * 前端据此渲染只读输入与「自动生成」徽章；已有值的字段管理员可查看（该值本身公开可见）。
   */
  autoGenerate?: boolean;
  /** switch 语义值：on/off 写入的实际值；defaultOn=键不存在时按 on 展示（不预写） */
  onValue?: unknown;
  offValue?: unknown;
  defaultOn?: boolean;
  /** kv 键名白名单（verifyFiles 防路径穿越，与服务端白名单一致） */
  keyPattern?: string;
  keyLabel?: LocText;
  valueLabel?: LocText;
  /** kv 值按数字存储（如占位高度 px） */
  numeric?: boolean;
}

/** 插件自声明的后台配置表单 schema（随模块声明，经 admin API 下发；缺省 = 无结构化表单，降级裸 JSON） */
export interface ExtSchema {
  /** 插件一句话介绍（列表卡片名称下方展示） */
  brief: LocText;
  /** 表单顶部的插件说明：告诉管理员「开箱即用」的部分，消除“必须填配置”的误解 */
  intro: LocText;
  fields: ExtField[];
}
