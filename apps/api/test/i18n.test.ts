/**
 * API 词条库单测：完整性（10 语言全量非空）、回落链（lang 命中 → zh-cn → 键名）、{param} 插值，
 * 以及浏览器语言协商（Accept-Language → 可选 locale）。
 */
import { describe, expect, it } from 'vitest';
import { matchBrowserLocale, parseAcceptLanguage, type ApiKey } from '@freeidx/shared';
import { API_MESSAGES, LOCALES, acceptLangOf, createApiT, t0 } from '../src/core/i18n';

describe('API 词条库（i18n 基建）', () => {
  it('完整性：每个键 zh-cn 必填且 10 语言全量非空', () => {
    for (const [key, dict] of Object.entries(API_MESSAGES)) {
      expect(dict['zh-cn'], `zh-cn missing: ${key}`).toBeTruthy();
      for (const l of LOCALES) expect(dict[l], `${l} missing: ${key}`).toBeTruthy();
    }
  });

  it('回落链：lang 命中 → 未知语言回落 zh-cn / 空语言回落站点默认 en-us → 未知键返回键名', () => {
    expect(createApiT('en-us')('thread.liked')).toBe('Liked');
    expect(createApiT('de-de')('seo.nextPage')).toBe('Nächste Seite');
    expect(createApiT('zh-tw')('thread.liked')).toBe('已按讚');
    expect(createApiT('fr-XX')('thread.liked')).toBe('已点赞');
    expect(createApiT('')('thread.liked')).toBe('Liked');
    expect(createApiT('en-us')('no.such.key' as ApiKey)).toBe('no.such.key');
  });

  it('插值：{param} 替换（字符串与数字）', () => {
    expect(createApiT('en-us')('seo.replies', { n: 3 })).toBe('3 replies');
    expect(createApiT('zh-cn')('credits.insufficientWithType', { credit: '金币' })).toBe('您的金币不足，无法执行此操作!');
    expect(createApiT('de-de')('admin.groupUpdated', { old: 100, new: 101 })).toBe('Gruppe aktualisiert: 100 → 101');
    expect(createApiT('zh-cn')('auth.codeMailBody', { site: 'Demo', code: '123456' })).toBe(
      '【Demo】您的验证码：123456，该验证码5分钟内有效。',
    );
  });

  it('t0 与 zh-cn 翻译器一致（核心纯函数缺省参数/测试直调兼容）', () => {
    expect(t0('auth.passwordWrong')).toBe('密码错误');
    expect(t0('common.pleaseLogin')).toBe('请先登录');
  });
});

describe('浏览器语言协商（用户偏好 > 浏览器 > 站点语言 的第二档）', () => {
  it('完全一致优先，其次同主语言（地区变体归一）', () => {
    expect(matchBrowserLocale(['en-US'])).toBe('en-us');
    expect(matchBrowserLocale(['en-GB'])).toBe('en-us');
    expect(matchBrowserLocale(['de-AT'])).toBe('de-de');
    expect(matchBrowserLocale(['es-419'])).toBe('es-es');
    expect(matchBrowserLocale(['ru'])).toBe('ru-ru');
  });

  it('中文按字形/地区分流（不能一律判简体）', () => {
    expect(matchBrowserLocale(['zh'])).toBe('zh-cn');
    expect(matchBrowserLocale(['zh-Hans-CN'])).toBe('zh-cn');
    expect(matchBrowserLocale(['zh-Hant-TW'])).toBe('zh-tw');
    expect(matchBrowserLocale(['zh-HK'])).toBe('zh-tw');
    expect(matchBrowserLocale(['zh_TW'])).toBe('zh-tw'); // 下划线写法归一
  });

  it('按标签顺序取首个命中；全不命中返回 null（由调用方回落站点语言）', () => {
    expect(matchBrowserLocale(['pt-BR', 'uk-UA', 'ja'])).toBe('ja-jp');
    expect(matchBrowserLocale(['pt-BR', 'uk-UA'])).toBeNull();
    expect(matchBrowserLocale(['*'])).toBeNull();
    expect(matchBrowserLocale([])).toBeNull();
    expect(matchBrowserLocale(null)).toBeNull();
  });

  it('Accept-Language 解析：按 q 降序、剔除通配与 q=0', () => {
    expect(parseAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8')).toEqual(['zh-CN', 'zh', 'en']);
    expect(parseAcceptLanguage('fr;q=0.5,de;q=0.9,*;q=0.1')).toEqual(['de', 'fr']);
    expect(parseAcceptLanguage('en;q=0,ja;q=0.3')).toEqual(['ja']);
    expect(parseAcceptLanguage(null)).toEqual([]);
  });

  it('acceptLangOf：头 → resolve 到可选 locale（无命中/无头返回 null）', () => {
    expect(acceptLangOf('ja-JP,en;q=0.7')).toBe('ja-jp');
    expect(acceptLangOf('pt-BR')).toBeNull();
    expect(acceptLangOf(null)).toBeNull();
  });
});
