/**
 * T2-5 写时定稿测试：发帖/回帖内容的写时定稿与 HTML 化。
 */
import { describe, expect, it } from 'vitest';
import { decorateImages, htmlSpecialChars, MESSAGE_MAX_CHARS, postMessageFmt, xnTxtToHtml } from '../src/core/fmt';

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

/* 性能项 16-a：正文图片统一补 loading="lazy" decoding="async"（读路径不二次过滤，只能写时定稿） */
describe('decorateImages（正文图片降级）', () => {
  const PLACEHOLDER = ' loading="lazy" decoding="async"';

  it('普通 img 补两个属性，正文其它部分不动', () => {
    expect(decorateImages('<p>文字</p><img src="/a.png" alt="x">')).toBe(
      `<p>文字</p><img src="/a.png" alt="x"${PLACEHOLDER}>`,
    );
  });

  it('幂等：已带 loading/decoding 不重复插入', () => {
    const once = decorateImages('<img src="/a.png">');
    expect(decorateImages(once)).toBe(once);
    expect(decorateImages('<img src="/a.png" loading="eager" decoding="sync">')).toBe(
      '<img src="/a.png" loading="eager" decoding="sync">',
    );
  });

  it('属性值里的 `>` 不会被当成标签结束（sanitize 只转义双引号，`>` 会原样留下）', () => {
    expect(decorateImages('<img src="/a.png" title="a>b">')).toBe(
      `<img src="/a.png" title="a>b"${PLACEHOLDER}>`,
    );
  });

  it('自闭合写法保留自闭合', () => {
    expect(decorateImages('<img src="/a.png" />')).toBe(`<img src="/a.png"${PLACEHOLDER} />`);
  });

  it('非 img 标签与文本原样返回（含 <imgx 这种前缀干扰）', () => {
    expect(decorateImages('<p>plain</p>')).toBe('<p>plain</p>');
    expect(decorateImages('<imgx>')).toBe('<imgx>');
    expect(decorateImages('&lt;img src="x"&gt;')).toBe('&lt;img src="x"&gt;');
  });

  it('写时定稿：普通用户与管理员通道都补属性，message 原文不受影响', () => {
    const src = '<p><img src="/a.png"></p>';
    /* sanitize 输出单标签用自闭合写法（`<img ... />`），这里对两种写法都容忍 */
    const EXPECT = /<img src="\/a\.png" loading="lazy" decoding="async"\s*\/?>/;
    const user = postMessageFmt({ message: src, doctype: 0 }, 10);
    expect(user.message_fmt).toMatch(EXPECT);
    expect(user.message).toBe(src); // 编辑用原文不带属性
    const admin = postMessageFmt({ message: src, doctype: 0 }, 1);
    expect(admin.message_fmt).toMatch(EXPECT);
  });
});
