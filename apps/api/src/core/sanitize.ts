/**
 * HTML 白名单净化器（T2-5，写时定稿专用）：标签/属性白名单 + SAX 解析装配。
 *
 * 装配要点：
 *  - SAX 选项全默认关闭：标签名不折叠大小写（白名单查表自行 strtolower → 标签大小写不敏感），
 *    属性名保留原样（白名单查表大小写敏感，`HREF=` 会被整体丢弃）；
 *  - 数据回调收到原始文本，仅 '>' → '&gt;'；注释/CDATA/PI/JASP 一律丢弃；
 *  - 非白名单标签连内容一起删除（dcStack 门），直到匹配的闭合标签出现；
 *  - 白名单外的属性直接不输出（事件属性、on* 由此剥离）。
 *
 * 在装配之上的安全加固（最终审计报告已登记）：
 *  1. 属性值先做数字实体 + &colon; 解码再校验（否则 href="javascript&#58;alert(1)" /
 *     "javascript&colon;..." 可绕过 url 白名单，浏览器会二次解码）；
 *  2. 白名单正则中 ([^x]+?)* 折叠为 [^x]*（语言等价，消除回溯放大）；
 *  3. 字节语义 ord/chr 越界取 %256 兜底，避免 Worker 抛异常。
 *
 * 严禁在读路径调用（§8.3 写时定稿硬规则）；仅 post_message_fmt 写侧使用。
 */

// ── 属性值校验规则（PCRE → JS，i 保留；s 标志无 '.' 参与，省略） ──
const P = {
  img_url: /^(((https?:\/\/[^'"\\<>:\s]+(:\d+)?)?[^'"\\<>:\s]*)|(data:image\/png;base64,[\w\/+]+))$/i,
  url: /^(https?:\/\/[^'"\\<>:\s]+(:\d+)?)?[^'"\\<>:\s]*$/i,
  ed2k: /^(?:ed2k|thunder|qvod|magnet):\/\/[^\s'"\\<>]+$/i,
  // 整体锚定 + 严格枚举：原写法 `^(#\w{3,6})|(rgb(...)|(\w{3,10}))$` 因交替优先级把锚点拆散
  //（等价 `(^#\w{3,6}) | (...\w{3,10})$`），任意以 3~10 个 \w 结尾的 CSS 值都能通过，白名单形同失效。
  color: /^(#\w{3,6}|rgb\(\d+,\s*\d+,\s*\d+\)|\w{3,20})$/i,
  safe: /^[\w\-:;.\s\x7f-\uffff]+$/i,
  css: /^[(,)\#;\w\-.\s\x7f-\uffff]+$/i,
  word: /^[\w\-\x7f-\uffff]+$/i,
} as const;

// 仅放行该 youku http 播放器串（src 属性特例）
const YOUKU_SRC = /^http:\/\/player\.youku\.com\/embed\/[\w=]+$/i;

// ── 标签白名单 ──
const WHITE_TAG = new Set([
  'a', 'b', 'i', 'u', 'font', 'strong', 'em', 'span',
  'table', 'tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'caption',
  'ol', 'ul', 'li', 'dl', 'dt', 'dd', 'menu', 'multicol',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'p', 'div', 'pre',
  'br', 'img', 'area', 'embed', 'code', 'blockquote', 'iframe', 'section', 'fieldset', 'legend',
]);

// ── HTML 结构常量（表格/段落闭合/列表/单标签集合） ──
const TABLE_TAGS = new Set(['caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);
const CLOSE_PARAGRAPH = new Set([
  'address', 'blockquote', 'center', 'dd', 'dir', 'div',
  'dl', 'dt', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'isindex', 'listing', 'marquee',
  'menu', 'multicol', 'ol', 'p', 'plaintext', 'pre',
  'table', 'ul', 'xmp',
]);
const LIST_TAGS = new Set(['dir', 'menu', 'ol', 'ul', 'dl']);
const SINGLE_TAGS = new Set(['area', 'br', 'img', 'input', 'hr', 'wbr']);

type Rule =
  | ['range', string | number, [number, number]]
  | ['list', string, string[]]
  | ['pcre', string, RegExp[]];

// ── 属性值白名单。重复键 allowfullscreen 以 range 规则生效 ──
const WHITE_VALUE = new Map<string, Rule>([
  ['href', ['pcre', '', [P.url, P.ed2k]]],
  ['src', ['pcre', '', [P.img_url]]],
  ['width', ['range', '', [0, 4096]]],
  ['height', ['range', 'auto', [0, 80000]]],
  ['size', ['range', 4, [-10, 10]]],
  ['border', ['range', 0, [0, 10]]],
  ['family', ['pcre', '', [P.word]]],
  ['class', ['pcre', '', [P.safe]]],
  ['face', ['pcre', '', [P.word]]],
  ['color', ['pcre', '', [P.color]]],
  ['alt', ['pcre', '', [P.safe]]],
  ['label', ['pcre', '', [P.safe]]],
  ['title', ['pcre', '', [P.safe]]],
  ['target', ['list', '_self', ['_blank', '_self']]],
  ['type', ['pcre', '', [/^[\w/\-]+$/]]],
  ['wmode', ['list', 'transparent', ['transparent', '']]],
  ['allowscriptaccess', ['list', 'never', ['never']]],
  // type 同款词法：字母数字/+/斜杠/连字符
  ['value', ['pcre', '', [/^[\w+/\-]+$/]]],
  ['cellspacing', ['range', 0, [0, 10]]],
  ['cellpadding', ['range', 0, [0, 10]]],
  ['frameborder', ['range', 0, [0, 10]]],
  ['allowfullscreen', ['range', 0, [0, 10]]],
  ['align', ['list', 'left', ['left', 'center', 'right']]],
  ['valign', ['list', 'middle', ['middle', 'top', 'bottom']]],
  ['name', ['pcre', '', [P.word]]],
]);

// ── CSS 属性白名单 ──
const WHITE_CSS = new Map<string, Rule>([
  ['font', ['pcre', 'none', [P.safe]]],
  ['font-style', ['pcre', 'none', [P.safe]]],
  ['font-weight', ['pcre', 'none', [P.safe]]],
  ['font-family', ['pcre', 'none', [P.word]]],
  ['font-size', ['range', 12, [6, 48]]],
  ['width', ['range', '100%', [1, 1800]]],
  ['height', ['range', '', [1, 80000]]],
  ['min-width', ['range', 1, [1, 80000]]],
  ['min-height', ['range', 400, [1, 80000]]],
  ['max-width', ['range', 1800, [1, 80000]]],
  ['max-height', ['range', 80000, [1, 80000]]],
  ['line-height', ['range', '14px', [1, 50]]],
  ['color', ['pcre', '#000000', [P.color]]],
  ['background', ['pcre', 'none', [P.color, /^url\((https?:\/\/[^'"\\<>]+?:?:\d?)?[^'"\\<>:]*\)[\w\s\-]*$/i]]],
  ['background-color', ['pcre', 'none', [P.color]]],
  ['background-image', ['pcre', 'none', [P.img_url]]],
  ['background-position', ['pcre', 'none', [P.safe]]],
  ['border', ['pcre', 'none', [P.css]]],
  ['border-left', ['pcre', 'none', [P.css]]],
  ['border-right', ['pcre', 'none', [P.css]]],
  ['border-top', ['pcre', 'none', [P.css]]],
  ['border-left-color', ['pcre', 'none', [P.css]]],
  ['border-right-color', ['pcre', 'none', [P.css]]],
  ['border-top-color', ['pcre', 'none', [P.css]]],
  ['border-bottom-color', ['pcre', 'none', [P.css]]],
  ['border-left-width', ['pcre', 'none', [P.css]]],
  ['border-right-width', ['pcre', 'none', [P.css]]],
  ['border-top-width', ['pcre', 'none', [P.css]]],
  ['border-bottom-width', ['pcre', 'none', [P.css]]],
  ['border-bottom-style', ['pcre', 'none', [P.css]]],
  ['margin-left', ['range', 0, [0, 100]]],
  ['margin-right', ['range', 0, [0, 100]]],
  ['margin-top', ['range', 0, [0, 100]]],
  ['margin-bottom', ['range', 0, [0, 100]]],
  ['margin', ['pcre', '', [P.safe]]],
  ['padding', ['pcre', '', [P.safe]]],
  ['padding-left', ['range', 0, [0, 100]]],
  ['padding-right', ['range', 0, [0, 100]]],
  ['padding-top', ['range', 0, [0, 100]]],
  ['padding-bottom', ['range', 0, [0, 100]]],
  ['zoom', ['range', 1, [1, 10]]],
  ['list-style', ['list', 'none', ['disc', 'circle', 'square', 'decimal', 'lower-roman', 'upper-roman', 'none']]],
  ['text-align', ['list', 'left', ['left', 'right', 'center', 'justify']]],
  ['text-indent', ['range', 0, [0, 100]]],
]);

// ── PHP 数值/字符串混合比较（PHP 8：数字串按数值比，非数字串把 number 转串比） ──
const isNumericStr = (s: string): boolean => /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(s);
function phpCmp(a: string | number, b: number): number {
  if (typeof a === 'number' || isNumericStr(a)) {
    const d = Number(a) - b;
    return d < 0 ? -1 : d > 0 ? 1 : 0;
  }
  const bs = String(b);
  return a < bs ? -1 : a > bs ? 1 : 0;
}

// PHP intval()：前导空白 + 符号 + 前缀整数，无数字 → 0
const intval = (s: string): number => {
  const m = /^\s*[-+]?\d+/.exec(s);
  return m ? Math.trunc(Number(m[0])) : 0;
};

// 偏差 1：校验前解码数字实体与 &colon;（浏览器属性值二次解码的绕过面）
function decodeEntities(v: string): string {
  return v
    .replace(/&#(\d+);?/g, (_m, d: string) => String.fromCharCode(Number(d) % 256))
    .replace(/&#x([0-9a-f]+);?/gi, (_m, d: string) => String.fromCharCode(parseInt(d, 16) % 256))
    .replace(/&colon;/gi, ':');
}

type Attrs = Map<string, string | null>;

class HtmlWhite {
  private readonly stack: string[] = [];
  private readonly dcStack: string[] = [];
  private readonly dcCounter = new Map<string, number>();
  private readonly counter = new Map<string, number>();
  private readonly liStack: number[] = [];
  private listScope = 0;
  private xhtml = '';

  // 光标（对齐 XML_HTMLSax3_StateParser position/rawtext）
  private raw = '';
  private pos = 0;
  private len = 0;

  constructor(private readonly tableMaxWidth: number) {}

  parse(doc: string): string {
    let s = doc;
    // parse() 预处理三连（原第四步泰语剥离已移除：th-th 为受支持语言，
    // 全盘剥离会清空正常泰语内容；本实现标签解析为字面量 '<' 扫描、
    // 实体解码仅处理数字实体，泰语字符不构成绕过面）
    s = s.replace(/<(?=[^a-zA-Z/!?%])/g, '&lt;');
    s = s.split('\x00').join('');
    s = s.split('\u00c0\u00bc').join('&lt;'); // \xC0\xBC（Opera6 乱码 '<'）字节等位

    this.raw = s;
    this.pos = 0;
    this.len = s.length;
    this.tokenize();
    return this.getXHTML();
  }

  private getXHTML(): string {
    let tag: string | undefined;
    while ((tag = this.stack.pop()) !== undefined) this.closeTag(tag);
    return this.xhtml;
  }

  // ── SAX 状态机（起始 / 标签 / 闭标签 / 开标签 / 转义 五态装配） ──
  private tokenize(): void {
    while (this.pos < this.len) {
      const data = this.scanUntilChars('<');
      if (data !== '') this.onData(data);
      if (this.pos >= this.len) break;
      this.pos++; // 吃掉 '<'
      const c = this.pos < this.len ? this.raw[this.pos] : undefined;
      if (c === '/') {
        this.pos++;
        this.onClosingTag();
      } else if (c === '?' || c === '%') {
        this.skipUntil('>'); // PI / JASP：默认装配下回调为空处理 → 整段丢弃
      } else if (c === '!') {
        this.skipEscape();
      } else {
        this.onOpeningTag();
      }
    }
  }

  private scanUntilChars(delims: string): string {
    const start = this.pos;
    while (this.pos < this.len && !delims.includes(this.raw[this.pos] as string)) this.pos++;
    return this.raw.slice(start, this.pos);
  }

  private scanUntilString(str: string): string {
    const idx = this.raw.indexOf(str, this.pos);
    const start = this.pos;
    this.pos = idx === -1 ? this.len : idx;
    return this.raw.slice(start, this.pos);
  }

  private scanChar(): string | null {
    return this.pos < this.len ? (this.raw[this.pos++] as string) : null;
  }

  private ignoreWhitespace(): void {
    while (this.pos < this.len && ' \n\r\t'.includes(this.raw[this.pos] as string)) this.pos++;
  }

  private skipUntil(str: string): void {
    this.scanUntilString(str);
    if (this.pos < this.len) this.pos += str.length;
  }

  private skipEscape(): void {
    // EscapeState：'<!--' → '-->'；'<!-' → '>'；'<![' → ']>'；其余 → '>'
    this.pos++; // 吃掉 '!'
    if (this.raw[this.pos] === '-') {
      if (this.raw[this.pos + 1] === '-') this.skipUntil('-->');
      else this.skipUntil('>');
    } else if (this.raw[this.pos] === '[') {
      this.skipUntil(']>');
    } else {
      this.skipUntil('>');
    }
    // _escapeHandler 丢弃
  }

  private onClosingTag(): void {
    const tag = this.scanUntilChars('/>'); // 注意：不吞空格，'</b >' 的名字为 'b ' → 无效关闭（既有行为）
    if (tag !== '') {
      if (this.scanChar() === '/') {
        const next = this.scanChar();
        if (next !== null && next !== '>') this.pos--;
      }
      this.onClose(strtolower(tag));
    }
  }

  private onOpeningTag(): void {
    const tag = this.scanUntilChars('/> \n\r\t');
    if (tag === '') return;
    const attrs = this.parseAttributes();
    const selfClosing = this.scanChar() === '/';
    if (selfClosing) {
      const next = this.scanChar();
      if (next !== null && next !== '>') this.pos--;
      this.onOpen(strtolower(tag), attrs);
      this.onClose(strtolower(tag));
    } else {
      this.onOpen(strtolower(tag), attrs);
    }
  }

  // 属性解析 —— 属性名原样保留（大小写敏感），裸属性值 = null
  private parseAttributes(): Attrs {
    const attrs: Attrs = new Map();
    this.ignoreWhitespace();
    let name = this.scanUntilChars('=/> \n\r\t');
    while (name !== '') {
      let value: string | null = null;
      this.ignoreWhitespace();
      const ch = this.scanChar();
      if (ch === '=') {
        this.ignoreWhitespace();
        const q = this.scanChar();
        if (q === '"') {
          value = this.scanUntilString('"');
          if (this.pos < this.len) this.pos++;
        } else if (q === "'") {
          value = this.scanUntilString("'");
          if (this.pos < this.len) this.pos++;
        } else {
          if (q !== null) this.pos--;
          value = this.scanUntilChars('> \n\r\t');
        }
      } else if (ch !== null) {
        value = null;
        this.pos--;
      }
      attrs.set(name, value);
      this.ignoreWhitespace();
      name = this.scanUntilChars('=/> \n\r\t');
    }
    return attrs;
  }

  // ── HTML_White 三回调 ──
  private onOpen(rawName: string, attrs: Attrs): void {
    const name = rawName;
    if (!WHITE_TAG.has(name)) {
      this.dcStack.push(name);
      this.dcCounter.set(name, (this.dcCounter.get(name) ?? 0) + 1);
    }
    if (this.dcStack.length !== 0) return;

    if (SINGLE_TAGS.has(name)) {
      this.xhtml += '<' + name;
      this.writeAttrs(attrs, name);
      this.xhtml += ' />';
      return;
    }

    // 表外 tableTags 丢弃
    const tableCount = this.counter.get('table');
    if (tableCount !== undefined && tableCount <= 0 && TABLE_TAGS.has(name)) return;

    if (CLOSE_PARAGRAPH.has(name) && this.stack.includes('p')) this.onClose('p');

    if (
      name === 'li' &&
      this.liStack.length > 0 &&
      this.listScope === (this.liStack[this.liStack.length - 1] as number)
    ) {
      this.onClose('li');
    }

    if (LIST_TAGS.has(name)) this.listScope++;
    if (name === 'li') this.liStack.push(this.listScope);

    this.xhtml += '<' + name;
    this.writeAttrs(attrs, name);
    this.xhtml += '>';
    this.stack.push(name);
    this.counter.set(name, (this.counter.get(name) ?? 0) + 1);
  }

  private onClose(name: string): void {
    const dcCount = this.dcCounter.get(name);
    if (dcCount !== undefined && dcCount > 0 && !WHITE_TAG.has(name)) {
      let tag = '';
      while ((tag = this.dcStack.pop() as string) !== name) this.dcCounter.set(tag, (this.dcCounter.get(tag) ?? 0) - 1);
      this.dcCounter.set(name, dcCount - 1);
    }
    if (this.dcStack.length !== 0) return;

    const count = this.counter.get(name);
    if (count !== undefined && count > 0) {
      let tag = '';
      while ((tag = this.stack.pop() as string) !== name) this.closeTag(tag);
      this.closeTag(name);
    }
  }

  private onData(data: string): void {
    if (this.dcStack.length === 0) this.xhtml += data.split('>').join('&gt;');
  }

  private closeTag(tag: string): void {
    // noClose 为空数组 → 恒输出
    this.xhtml += '</' + tag + '>';
    this.counter.set(tag, (this.counter.get(tag) ?? 0) - 1);
    if (LIST_TAGS.has(tag)) this.listScope--;
    if (tag === 'li') this.liStack.pop();
  }

  // ── 属性写出：style / src / 通用白名单 三分管线（裸属性值=NULL：校验按 ''/数值 0 等价走，输出时回退为属性名） ──
  private writeAttrs(attrs: Attrs, tagname: string): void {
    for (const [name, raw] of attrs) {
      let value: string | number | null = raw;

      if (name === 'style') {
        value = this.filterStyle(raw === null ? '' : String(raw));
        if (value === '') continue; // 空 style 不输出
      } else {
        // 偏差 1 实现：校验对象 = 实体解码后的值（防浏览器二次解码绕过）；
        // 校验通过则输出原始值（NULL 保留，供 is_null 回退）
        const vs0 = decodeEntities(raw === null ? '' : String(raw));
        if (name === 'src') {
          const rule = WHITE_VALUE.get('src');
          let ok = false;
          if (rule && rule[0] === 'pcre') for (const p of rule[2]) if (p.test(vs0)) { ok = true; break; }
          if ((tagname === 'embed' || tagname === 'iframe') && !YOUKU_SRC.test(vs0)) value = '';
          else if (!ok) value = rule ? rule[1] : '';
        } else {
          const rule = WHITE_VALUE.get(name);
          if (!rule) continue; // 白名单外属性（onclick 等）剥离
          if (rule[0] === 'range') {
            if (raw !== null && String(raw).toLowerCase().endsWith('px')) {
              value = intval(vs0);
              if (value < rule[2][0]) value = rule[2][0];
              else if (value > rule[2][1]) value = rule[2][1];
              value = `${value}px`;
            } else if (raw === null) {
              // PHP：NULL 与 0/10 数值比较恒不触发钳制 → 保持 NULL → 输出段回退属性名
            } else if (phpCmp(vs0, rule[2][0]) < 0 || phpCmp(vs0, rule[2][1]) > 0) {
              value = rule[1];
            }
          } else if (rule[0] === 'list') {
            if (!rule[2].includes(vs0)) value = rule[1];
          } else if (rule[0] === 'pcre') {
            let ok = false;
            for (const p of rule[2]) if (p.test(vs0)) { ok = true; break; }
            if (!ok) value = rule[1];
          } else {
            continue;
          }
        }
      }

      // 布尔/空值属性 → 用属性名补值
      if (value === null) value = name;
      const out = String(value).split('"').join('&quot;');
      this.xhtml += ' ' + name + '="' + out + '"';
    }
  }

  // style 属性：反斜杠剥离 → 注释剥离 → & 重编码 → 键值对提取（重复键后覆盖前、保持首位置） → 白名单校验 → "k:v; " 拼接
  private filterStyle(input: string): string {
    let v = input.split('\\').join('');
    for (;;) {
      const nv = v.replace(/\/\*[\s\S]*?\*\//g, '');
      if (nv === v) break;
      v = nv;
    }
    v = v.split('&amp;').join('&');
    v = v.split('&').join('&amp;');

    const csskv = new Map<string, string>();
    const re = /\s*([\w-]+)\s*:\s*([^;]+)\s*;?\s*/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v)) !== null) csskv.set(m[1] as string, m[2] as string);

    for (const [cssname, rawVal] of csskv) {
      const rule = WHITE_CSS.get(cssname);
      if (!rule) {
        csskv.delete(cssname);
        continue;
      }
      let cssvalue: string | number = rawVal;
      if (rule[0] === 'range') {
        let px = 0;
        if (String(cssvalue).toLowerCase().endsWith('px')) {
          cssvalue = intval(String(cssvalue));
          px = 1;
        }
        const vs = String(cssvalue);
        if (phpCmp(vs, rule[2][0]) < 0) cssvalue = rule[2][0];
        else if (phpCmp(vs, rule[2][1]) > 0) cssvalue = rule[2][1];
        if ((cssname === 'width' || cssname === 'min-width') && px === 1 && Number(cssvalue) > this.tableMaxWidth) {
          cssvalue = '100%';
          px = 0;
        }
        if (px === 1) cssvalue = String(cssvalue) + 'px';
      } else if (rule[0] === 'list') {
        if (!rule[2].includes(String(cssvalue))) cssvalue = rule[1];
      } else if (rule[0] === 'pcre') {
        let ok = false;
        for (const p of rule[2]) if (p.test(String(cssvalue))) { ok = true; break; }
        cssvalue = ok ? String(cssvalue) : rule[1];
      } else {
        continue;
      }
      csskv.set(cssname, String(cssvalue));
    }

    let out = '';
    for (const [k, val] of csskv) out += `${k}:${val}; `;
    return out.length > 0 ? out.slice(0, -1) : '';
  }
}

const strtolower = (s: string): string => s.toLowerCase();

/** 入口；table_max_width 默认 746（回帖区宽度） */
export function xnHtmlSafe(doc: string, opts: { tableMaxWidth?: number } = {}): string {
  return new HtmlWhite(opts.tableMaxWidth ?? 746).parse(doc);
}
