/**
 * 语言元数据 + 内置用户组名判定（唯一事实源）。
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
