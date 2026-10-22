/**
 * T2-5 快照/安全测试：HTML 白名单净化（HTML_White + 默认 SAX 装配）。
 * DoD：危险协议/事件属性剥离；管理员原文放行在 fmt 层（见 fmt.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import { xnHtmlSafe } from '../src/core/sanitize';

describe('危险内容剥离（DoD）', () => {
  it('<script> 标签连同内容整体删除', () => {
    expect(xnHtmlSafe('<b>ok</b><script>alert(1)</script>tail')).toBe('<b>ok</b>tail');
  });
  it('事件属性剥离（白名单外属性不输出）', () => {
    expect(xnHtmlSafe('<b onclick="alert(1)" onmouseover=alert(2)>x</b>')).toBe('<b>x</b>');
  });
  it('javascript: 协议回落空 href；实体编码冒号同样拦截（加固偏差 1）', () => {
    expect(xnHtmlSafe('<a href="javascript:alert(1)">x</a>')).toBe('<a href="">x</a>');
    expect(xnHtmlSafe('<a href="javascript&#58;alert(1)">x</a>')).toBe('<a href="">x</a>');
    expect(xnHtmlSafe('<a href="javascript&colon;alert(1)">x</a>')).toBe('<a href="">x</a>');
  });
  it('style 中 expression/backslash/注释清除，非白名单 CSS 键丢弃', () => {
    const out = xnHtmlSafe('<table style="width:120px; expression(alert(1)); POSITION:absolute;"><tr><td>a</td></tr></table>');
    expect(out).toContain('width:120px');
    expect(out).not.toMatch(/expression/i);
    expect(out).not.toMatch(/position/i);
  });
  it('iframe/embed 非 youku 播放器 src 清空', () => {
    expect(xnHtmlSafe('<iframe src="http://player.youku.com/embed/XMTIz"></iframe>')).toBe(
      '<iframe src="http://player.youku.com/embed/XMTIz"></iframe>',
    );
    expect(xnHtmlSafe('<iframe src="http://evil.example/e"></iframe>')).toBe('<iframe src=""></iframe>');
  });
  it('data URI 仅放行 data:image/png;base64 形态（pattern 尾无 "=" → 带 padding 亦拒绝，口径保留）', () => {
    expect(xnHtmlSafe('<img src="data:image/png;base64,iVBORw0KGgo">')).toContain('data:image/png;base64,iVBORw0KGgo');
    expect(xnHtmlSafe('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe('<img src="" />');
    expect(xnHtmlSafe('<img src="data:image/svg+xml;base64,PHN2Zz4">')).toBe('<img src="" />');
  });
});

describe('预处理（parse 头部）', () => {
  it('裸 < 后跟非标签起始字符转 &lt;；\\x00 剥离；泰文按 th-th 语言包原样保留', () => {
    expect(xnHtmlSafe('5 < 6 and 7<a')).toBe('5 &lt; 6 and 7<a></a>');
    expect(xnHtmlSafe('a\u0000b')).toBe('ab');
    expect(xnHtmlSafe('สวัสดีสวัสดี')).toBe('สวัสดีสวัสดี');
  });
  it('value 属性按 pcre 词法校验（字母数字/+/斜杠/连字符），非法值回落空串', () => {
    expect(xnHtmlSafe('<embed value="abc-1/2+">')).toBe('<embed value="abc-1/2+"></embed>');
    expect(xnHtmlSafe('<embed value="x onerror=alert(1)">')).toBe('<embed value=""></embed>');
  });
  it('数据段仅 > 转 &gt;，& 与 " 原样保留（同装配默认行为）', () => {
    expect(xnHtmlSafe('a>b&c"d')).toBe('a&gt;b&c"d');
  });
});

describe('标签结构（开/闭标签处理器等价）', () => {
  it('未闭合标签在输出末尾自动补闭合；多余闭合被吞', () => {
    expect(xnHtmlSafe('<div><p>x')).toBe('<div><p>x</p></div>');
    expect(xnHtmlSafe('x</div></b>')).toBe('x');
  });
  it('块级标签打开时关闭在栈中的 <p>（closeParagraph）', () => {
    expect(xnHtmlSafe('<p>abc<div>d</div>')).toBe('<p>abc</p><div>d</div>');
  });
  it('table 计数守卫仅在此前出现过 <table> 时生效（isset quirk：从未有 table 时散 <td> 照常输出）', () => {
    expect(xnHtmlSafe('<td>x</td>')).toBe('<td>x</td>');
    expect(xnHtmlSafe('<table><tr><td>a</td></tr></table><td>b</td>')).toBe(
      '<table><tr><td>a</td></tr></table>b', // table 计数归零后散 <td> 标签被守卫丢弃（文本保留）
    );
    expect(xnHtmlSafe('<table><tbody><tr><td>a</td></tr></tbody></table>')).toBe(
      '<table><tbody><tr><td>a</td></tr></tbody></table>',
    );
  });
  it('单标签输出自闭合形态；br 同层嵌套 li 关闭规则', () => {
    expect(xnHtmlSafe('<br><img src="http://a/b.png">')).toBe('<br /><img src="http://a/b.png" />');
    expect(xnHtmlSafe('<ul><li>a<li>b</ul>')).toBe('<ul><li>a</li><li>b</li></ul>');
  });
  it('白名单外标签连内容删除直到匹配闭合（dcStack 门），其间一切（含白名单标签）丢弃', () => {
    expect(xnHtmlSafe('<div>a<style>b<i>c</i></style>d<b>keep</b></div>')).toBe('<div>ad<b>keep</b></div>');
    expect(xnHtmlSafe('<div>a<style>noend')).toBe('<div>a</div>'); // 残留栈在 getXHTML 收尾补闭合
  });
});

describe('属性管线（style/src/通用三分支）', () => {
  it('属性名大小写敏感：HREF 整体丢弃、href 保留（默认装配不折叠）', () => {
    expect(xnHtmlSafe('<a HREF="http://x.com/">x</a>')).toBe('<a>x</a>');
  });
  it('range 属性：px 保留并钳制，越界回落默认值；CSS width 超 table_max_width 转 100%（style 拼接保留尾部 ";"）', () => {
    expect(xnHtmlSafe('<img width="100px">')).toBe('<img width="100px" />');
    expect(xnHtmlSafe('<img width="9999px">')).toBe('<img width="4096px" />');
    expect(xnHtmlSafe('<img width="abc">')).toBe('<img width="" />');
    expect(xnHtmlSafe('<table style="width:1126px"><tr><td>a</td></tr></table>')).toBe(
      '<table style="width:100%;"><tr><td>a</td></tr></table>',
    );
    expect(xnHtmlSafe('<table style="width:500px"><tr><td>a</td></tr></table>')).toBe(
      '<table style="width:500px;"><tr><td>a</td></tr></table>',
    );
  });
  it('list 属性回落默认；target 仅 _blank/_self', () => {
    expect(xnHtmlSafe('<a href="http://x/" target="_top">t</a>')).toBe('<a href="http://x/" target="_self">t</a>');
  });
  it('裸属性回退为属性名（is_null → $value=$name）', () => {
    expect(xnHtmlSafe('<a href>x</a>')).toBe('<a href="href">x</a>');
    expect(xnHtmlSafe('<iframe allowfullscreen src="http://player.youku.com/embed/X1"></iframe>')).toBe(
      '<iframe allowfullscreen="allowfullscreen" src="http://player.youku.com/embed/X1"></iframe>',
    );
  });
  it('非白名单标签整体丢弃但白名单内属性值仍按规则处理；style 为空不输出', () => {
    expect(xnHtmlSafe('<b style="">x</b>')).toBe('<b>x</b>');
  });
  it('引号无法通过任何 pcre 白名单（safe/url 均排除引号）→ 值整体回落默认，&quot; 转义兜底', () => {
    expect(xnHtmlSafe('<a href="http://x/" title=a"b>t</a>')).toBe('<a href="http://x/" title="">t</a>');
  });
  it('ed2k:// 协议 href 放行；magnet:? 形态 pattern 要求 :// → 不放行（口径保留）', () => {
    expect(xnHtmlSafe('<a href="ed2k://server/file">e</a>').includes('ed2k://server/file')).toBe(true);
    expect(xnHtmlSafe('<a href="magnet:?xt=abc">m</a>')).toBe('<a href="">m</a>');
  });
  it('CSS height:auto 走字符串比较钳制（quirk 保留 → 80000）', () => {
    expect(xnHtmlSafe('<div style="height:auto">x</div>')).toBe('<div style="height:80000;">x</div>');
  });
});

describe('color/background 白名单锚点（审计修复：交替拆散 ^…$）', () => {
  it('合法取值放行：#hex / rgb() / 长命名色 / transparent', () => {
    expect(xnHtmlSafe('<font color="#ff0000">x</font>')).toContain('color="#ff0000"');
    expect(xnHtmlSafe('<font color="rgb(1,2,3)">x</font>')).toContain('color="rgb(1,2,3)"');
    expect(xnHtmlSafe('<font color="transparent">x</font>')).toContain('color="transparent"');
  });
  it('旧正则（`^(#\\w{3,6})|(rgb(...)|(\\w{3,10}))$`）放行的非法值现被拒（值回落默认）', () => {
    // 旧写法只要值「以 3~10 个 \w 结尾」即通过（锚点被交替拆散），故 light-blue / evil-xyz 都能过
    expect(xnHtmlSafe('<font color="light-blue">x</font>')).not.toContain('light-blue');
    expect(xnHtmlSafe('<div style="color:evil-xyz">x</div>')).not.toContain('evil-xyz');
  });
});

describe('快照（CI 回归基线，T2-5 工单要求）', () => {
  const cases: Record<string, string> = {
    rich_post:
      '<div class="quote"><p>引用行&nbsp;&nbsp;加粗</p><table style="width:1033px;background:url(1.jpg) no-repeat;"><tbody><tr><td width="60"><img src="http://cdn.example.com/a.png" width="54" height="54" /></td></tr></tbody></table></div>',
    mixed_attack:
      '<b onclick="x">粗</b><a href="javascript&#58;alert(1)">链接</a><style>body{}</style><iframe src="//evil/x"></iframe><script src="http://a"></script>',
    code_block: '<pre><code>if (a &lt; b) { console.log(1); }</code></pre>',
    list_nested: '<ul><li>一<ul><li>内</li></ul></li><li>二</li></ul>',
    font_legacy: '<font face="微软雅黑" size="5" color="#ff0000">旧编辑器</font>',
  };
  for (const [name, input] of Object.entries(cases)) {
    it(name, () => expect(xnHtmlSafe(input)).toMatchSnapshot(name));
  }
});

describe('CPU 护栏（§7 纯计算路径：写侧 sanitize）', () => {
  it('典型 5KB 富文本帖子 sanitize < 8ms', () => {
    const row = '<tr><td style="padding:0.5rem 0.75rem;"><a href="http://example.com/p" target="_blank"><img src="http://cdn.example.com/icon.png" width="54" height="54"></a><span class="small" style="font-size:13px;">示例内容文本示例内容文本</span></td></tr>';
    const post = `<table class="table" style="width:800px;"><tbody>${row.repeat(40)}</tbody></table>`;
    const t0 = performance.now();
    const out = xnHtmlSafe(post);
    const dt = performance.now() - t0;
    expect(out.length).toBeGreaterThan(1000);
    expect(dt).toBeLessThan(8);
  });
});
