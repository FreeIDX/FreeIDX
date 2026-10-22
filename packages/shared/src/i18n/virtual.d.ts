/**
 * 虚拟模块类型声明：每个模块只含「单语言 × 单命名空间」的词条。
 * 实现见 scripts/i18n-split.plugin.ts，消费端见 ./bundles.ts。
 */
declare module 'virtual:freeidx-i18n/bbs/*' {
  const dict: Record<string, string>;
  export default dict;
}

declare module 'virtual:freeidx-i18n/admin/*' {
  const dict: Record<string, string>;
  export default dict;
}
