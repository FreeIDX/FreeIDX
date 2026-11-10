/**
 * 语言元数据 + 浏览器语言匹配 + 内置用户组名判定（唯一事实源）。
 *
 * 词典加载策略：**本模块不静态引入任何语言包**。10 个语言包（gen + override 合并后）源码体积
 * 约 740KB，此前被整体打进前端主包（主包 837KB 的绝大部分）。按需加载器在同目录 ./bundles.ts，
 * 经子路径 `@freeidx/shared/i18n/bundles` 只由前端引用，后端不会把 JSON 拉进 Worker 包。
 *
 * 为保持本模块零「完整词典」依赖：语言清单改为静态常量，内置组名判定改走预生成的
 * ./group-names.json（14 键 × 10 语言 ≈ 2KB 数据），因此 builtinGroupName 仍是同步纯函数，
 * 且不再依赖任何词典是否已加载。
 */
import groupNames from './group-names.json';

const GROUP_NAME_TABLE = groupNames.table as Record<string, Record<string, string>>;

export const DEFAULT_LOCALE = 'en-us';

/**
 * 可选语言清单。
 * 注意：顺序即语言切换器的展示顺序，与改版前词典表的声明顺序逐项一致（不可随意调整）。
 */
export const AVAILABLE_LOCALES: string[] = [
  'zh-cn',
  'zh-tw',
  'en-us',
  'ru-ru',
  'th-th',
  'de-de',
  'ja-jp',
  'ko-kr',
  'es-es',
  'fr-fr',
];

/**
 * 语言原生名（前台右上角语言切换器展示用）。
 * 原生名是语言自身的「专名」（Deutsch/English/…），不随界面语言翻译，故为固定数据而非 UI 词条。
 */
export const NATIVE_LANG_NAMES: Record<string, string> = {
  'zh-cn': '简体中文',
  'zh-tw': '正體中文',
  'en-us': 'English',
  'ru-ru': 'Русский',
  'th-th': 'ไทย',
  'de-de': 'Deutsch',
  'ja-jp': '日本語',
  'ko-kr': '한국어',
  'es-es': 'Español',
  'fr-fr': 'Français',
};

/**
 * 浏览器语言标签 → 站点可选 locale（无命中返回 null）。
 *
 * 语言协商链的唯一匹配实现：前端 `lib/i18n` 的 initialLocale/useLang、后端 Accept-Language
 * 协商、以及 SPA 壳的内联首屏脚本（内联脚本无法 import，是这里的镜像，改规则须同步两处）。
 *
 * 三条规则（按优先级逐条对每个标签尝试）：
 *  1. 完全一致：`en-us` → `en-us`；
 *  2. 中文特例：`zh` / `zh-*` 按字形与地区分流 —— 含 hant/tw/hk/mo → `zh-tw`，其余（含 hans）→ `zh-cn`。
 *     不能走规则 3（`AVAILABLE_LOCALES` 里 zh-cn 在前，会把所有 zh-* 判成简体）；
 *  3. 同主语言：`de-AT` → `de-de`、`es-419` → `es-es`、`en-GB` → `en-us`，取清单里该主语言的第一项。
 *
 * 标签顺序即用户偏好顺序（Accept-Language 需先按 q 值排序，见 parseAcceptLanguage）；
 * 全部未命中时由调用方回落站点语言。
 */
export function matchBrowserLocale(tags: readonly string[] | null | undefined): string | null {
  if (!tags?.length) return null;
  for (const raw of tags) {
    const tag = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/_/g, '-');
    if (!tag || tag === '*') continue;
    if (AVAILABLE_LOCALES.includes(tag)) return tag;
    const base = tag.split('-')[0];
    if (!base) continue;
    if (base === 'zh') return /(?:hant|tw|hk|mo)/.test(tag) ? 'zh-tw' : 'zh-cn';
    const hit = AVAILABLE_LOCALES.find((l) => l.split('-')[0] === base);
    if (hit) return hit;
  }
  return null;
}

/**
 * `Accept-Language` 头 → 按 q 值降序的语言标签数组（`*` 通配与 q=0 的标签剔除）。
 * 服务端语言协商的第二档依据（cookie 偏好 > 浏览器 > 站点语言），见 apps/api/src/index.ts。
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  const out: { tag: string; q: number }[] = [];
  for (const part of header.split(',')) {
    const [rawTag, ...params] = part.split(';');
    const tag = (rawTag ?? '').trim();
    if (!tag || tag === '*') continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    if (!(q > 0)) continue;
    out.push({ tag, q });
  }
  return out.sort((a, b) => b.q - a.q).map((x) => x.tag);
}

/**
 * 内置用户组名展示（随站点语言切换）：
 *  - DB 里 bbs_group.name 只是数据（默认种子），展示层命中 `group_{gid}` 词条时按当前语言翻译；
 *  - 只有当 DB 名与任一语言包的同键译文一致（即站长未自定义组名）才翻译，自定义名原样返回；
 *  - 词条缺失（自定义组）或 DB 名为空兜底回 DB 名。
 * 实现改走 GROUP_NAME_TABLE：只含 group_* 键的跨语言索引，无需加载任何完整词典。
 */
export function builtinGroupName(gid: number, name: string, lang: string): string {
  if (!name) return name;
  const key = `group_${gid}`;
  let isBuiltinName = false;
  for (const table of Object.values(GROUP_NAME_TABLE)) {
    if (table[key] === name) {
      isBuiltinName = true;
      break;
    }
  }
  if (!isBuiltinName) return name;
  return GROUP_NAME_TABLE[lang]?.[key] ?? name;
}
