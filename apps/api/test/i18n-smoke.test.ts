/**
 * i18n locale 冒烟测试：校验词典质量，专抓“未翻译/复制粘贴中文/空译文”这类漏翻。
 *  - 非中文 locale（zh-cn/zh-tw 除外）的译文不得含中文字符；
 *  - 所有 locale、所有 key 非空，且不是回落成键名；
 * 硬编码文案（未走 t）由 scripts/check-hardcoded-zh.mjs 负责，这里只查两端词典。
 * 注：词典已改为按需加载（packages/shared/src/i18n/bundles.ts），故此处先全量预载再断言。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE, type LocaleBundles } from '@freeidx/shared';
import { getLoadedBundle, loadAllLocaleBundles } from '@freeidx/shared/i18n/bundles';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const NON_CJK = AVAILABLE_LOCALES.filter((l) => l !== 'zh-cn' && l !== 'zh-tw' && l !== 'ja-jp');
const flatten = (loc: string): Record<string, string> => {
  const b: LocaleBundles | undefined = getLoadedBundle(loc);
  if (!b) return {};
  return { ...b.bbs, ...b.admin };
};

beforeAll(async () => {
  await loadAllLocaleBundles();
});

describe('i18n locale 冒烟', () => {
  it('非中文 locale 的译文不含中文（防复制未翻译）', () => {
    const bad = [];
    for (const loc of NON_CJK) {
      for (const [k, v] of Object.entries(flatten(loc))) {
        if (k.startsWith('lang_')) continue;
        if (CJK.test(v)) bad.push(`${loc}/${k} = ${v}`);
      }
    }
    expect(bad.slice(0, 40), `非中文 locale 出现中文译文 ${bad.length} 处`).toEqual([]);
  });

  it('所有 locale、所有 key 非空且不回落成键名', () => {
    const bad = [];
    for (const loc of AVAILABLE_LOCALES) {
      for (const [k, v] of Object.entries(flatten(loc))) {
        if (!v || v === k) bad.push(`${loc}/${k}`);
      }
    }
    expect(bad.slice(0, 40), `存在空译文或等于键名 ${bad.length} 处`).toEqual([]);
  });

  it('zh-cn 源语言键集非空', () => {
    const src = getLoadedBundle(DEFAULT_LOCALE);
    expect(src).toBeTruthy();
    expect(Object.keys(src!.bbs).length).toBeGreaterThan(0);
    expect(Object.keys(src!.admin).length).toBeGreaterThan(0);
  });
});
