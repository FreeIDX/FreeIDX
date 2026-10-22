/**
 * API 词条库单测：完整性（10 语言全量非空）、回落链（lang 命中 → zh-cn → 键名）、{param} 插值。
 */
import { describe, expect, it } from 'vitest';
import type { ApiKey } from '@freeidx/shared';
import { API_MESSAGES, LOCALES, createApiT, t0 } from '../src/core/i18n';

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
