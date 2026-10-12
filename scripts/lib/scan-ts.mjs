/**
 * 基于 TypeScript 编译器 API 的源码扫描：精确提取 t() 引用的 key 与未国际化的中文文本。
 * 相比正则：天然排除注释、只在 AST 节点上判定、可区分 t() 参数（fallback）与普通字面量。
 */
import ts from 'typescript';

const CJK = /[㐀-䶿一-鿿]/;
// t/t0：取词函数，首参是词条键
const isT = (expr) => ts.isIdentifier(expr) && (expr.text === 't' || expr.text === 't0');
// M/L：后端位置式 10 语言构造器，实参本就需要含中文源文，不计入硬编码
const isTextCtor = (expr) => ts.isIdentifier(expr) && (expr.text === 'M' || expr.text === 'L');
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const LOCALE_CODE = /^[a-z]{2}-[a-z]{2}$/;

/** 语言码为键的对象（插件 manifest 文案、语言原生名表）其值就是各语言译文，含中文属正常 */
function isLocaleMapValue(node) {
  const p = node.parent;
  return ts.isPropertyAssignment(p) && p.initializer === node && ts.isStringLiteralLike(p.name) && LOCALE_CODE.test(p.name.text);
}

/** 节点是否位于某个取词/构造调用的实参子树内（用于放行中文源文） */
function insideTCall(node) {
  const s = node.getStart();
  const e = node.getEnd();
  let p = node.parent;
  while (p) {
    if (ts.isCallExpression(p) && (isT(p.expression) || isTextCtor(p.expression))) {
      return p.arguments.some((a) => s >= a.getStart() && e <= a.getEnd());
    }
    p = p.parent;
  }
  return false;
}

/**
 * @param {string} file 文件绝对路径
 * @param {string} code 文件内容
 * @returns {{ calls: string[], dynamic: string[], textKeys: string[], hardcoded: string[] }}
 *  - calls：t('key') 中的静态 key
 *  - dynamic：t(`prefix_${x}`) 的模板前缀
 *  - textKeys：`textKey: 'key'` 常量（后台 Tab/Menu/搜索类型等）
 *  - hardcoded：含中文但未走 t() 的文本（JSX 文本、字符串/模板字面量、属性等）
 */
export function scanSource(file, code) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
  const calls = [];
  const dynamic = [];
  const textKeys = [];
  const hardcoded = [];

  const visit = (node) => {
    if (ts.isCallExpression(node) && isT(node.expression)) {
      const a0 = node.arguments[0];
      if (a0) {
        if (ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0)) calls.push(a0.text);
        else if (ts.isTemplateExpression(a0)) dynamic.push(a0.head.text);
      }
    }

    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'textKey' && ts.isStringLiteralLike(node.initializer)) {
      textKeys.push(node.initializer.text);
    }

    if (ts.isJsxText(node)) {
      const t = norm(node.text);
      if (t && CJK.test(t)) hardcoded.push(t);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (CJK.test(node.text) && !insideTCall(node) && !isLocaleMapValue(node)) hardcoded.push(norm(node.text));
    } else if (ts.isTemplateExpression(node)) {
      if (!insideTCall(node)) {
        const lit = node.head.text + node.templateSpans.map((s) => s.literal.text).join('');
        if (CJK.test(lit)) hardcoded.push(norm(lit));
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { calls, dynamic, textKeys, hardcoded };
}
