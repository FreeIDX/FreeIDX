/**
 * T2-5 写时定稿测试：发帖/回帖内容的写时定稿与 HTML 化。
 */
import { describe, expect, it } from 'vitest';
import { htmlSpecialChars, MESSAGE_MAX_CHARS, postMessageFmt, xnTxtToHtml } from '../src/core/fmt';

describe('htmlSpecialChars（htmlspecialchars ENT_QUOTES 等价）', () => {
  it('五字符转义，& 优先', () => {
    expect(htmlSpecialChars(`<a href="x" title='y'>&z</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;z&lt;/a&gt;',
    );
  });
});

describe('doctype 通道', () => {
  it('doctype=0 普通用户走白名单，管理员 gid=1 原文放行', () => {
    const src = '<b>粗</b><script>alert(1)</script>';
    expect(postMessageFmt({ message: src, doctype: 0 }, 10).message_fmt).toBe('<b>粗</b>');
    expect(postMessageFmt({ message: src, doctype: 0 }, 1).message_fmt).toBe(src);
  });
  it('doctype=1 txt 通道：nbsp/tab/换行（顺序敏感）', () => {
    expect(xnTxtToHtml('a b\tc\r\nd')).toBe('a&nbsp;b &nbsp; &nbsp; &nbsp; &nbsp;c<br>d');
    expect(postMessageFmt({ message: '<x> & y\nz', doctype: 1 }, 10).message_fmt).toBe(
      '&lt;x&gt;&nbsp;&amp;&nbsp;y<br>z',
    );
  });
  it('doctype=2/3（md/ubb）无源码转换器 → 转义通道，前端兼容渲染', () => {
    expect(postMessageFmt({ message: '# 标题\n**b**', doctype: 2 }, 10).message_fmt).toBe(
      '# 标题\n**b**',
    );
    expect(postMessageFmt({ message: '[b]x[/b]', doctype: 3 }, 10).message_fmt).toBe('[b]x[/b]');
  });
});

describe('截断与引用前置', () => {
  it('超长按码点截断 2028000，message 原文同步截断', () => {
    const long = '字'.repeat(MESSAGE_MAX_CHARS + 100) + 'END';
    const r = postMessageFmt({ message: long, doctype: 1 }, 10);
    expect([...r.message].length).toBe(MESSAGE_MAX_CHARS);
    expect(r.message_fmt).not.toContain('END');
  });
  it('quotepid>0 前置引用块；quotepid=0 不加', () => {
    const q = '<div class="quote">QUOTE</div>';
    expect(postMessageFmt({ message: 'body', doctype: 1, quotepid: 42 }, 10, q).message_fmt).toBe(
      '<div class="quote">QUOTE</div>body',
    );
    expect(postMessageFmt({ message: 'body', doctype: 1, quotepid: 0 }, 10, q).message_fmt).toBe('body');
  });
});
