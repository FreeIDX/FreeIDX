/**
 * 本地 ESLint 插件：i18n 相关规则。
 *
 * no-hardcoded-zh 规则：
 *   检测 JSX 文本、字符串字面量、模板字符串中的中文，若未包裹在 t()/T()/t0() 调用内则报错。
 *   存量（已在 baseline 中登记的）静默放行；仅拦截【新增】硬编码 → 开发时即时红线。
 *
 *   配置示例（flat config）：
 *     plugins: { i18n: i18nPlugin },
 *     rules: { 'i18n/no-hardcoded-zh': 'error' }
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const norm = (s) => s.replace(/\s+/g, ' ').trim();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(root, 'scripts', 'i18n-hardcoded-baseline.json');


let _baseline = null;
function loadBaseline() {
  if (_baseline !== null) return _baseline;
  if (!existsSync(BASELINE_PATH)) { _baseline = new Set(); return _baseline; }
  const data = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  _baseline = new Set(data.entries ?? []);
  return _baseline;
}

function isInsideTCall(node) {
  let p = node.parent;
  while (p) {
    if (p.type === 'CallExpression' && p.callee.type === 'Identifier' &&
        (p.callee.name === 't' || p.callee.name === 'T' || p.callee.name === 't0' || p.callee.name === 'translate')) {
      return true;
    }
    p = p.parent;
  }
  return false;
}

function isInsideImport(node) {
  let p = node.parent;
  while (p) {
    if (p.type === 'ImportDeclaration' || p.type === 'ExportNamedDeclaration') return true;
    p = p.parent;
  }
  return false;
}

const noHardcodedZh = {
  meta: {
    type: 'problem',
    docs: { description: '禁止硬编码中文（未走 t() 国际化）' },
    schema: [],
    messages: {
      hardcoded: '硬编码中文 "{{text}}"，请改用 t(\'key\', \'{{text}}\') 并补充词典词条',
    },
  },
  create(context) {
    const abs = (context.filename || context.getFilename?.() || '').replace(/\\/g, '/');
    const rootNorm = root.replace(/\\/g, '/');
    const filename = abs.startsWith(rootNorm + '/') ? abs.slice(rootNorm.length + 1) : abs;
    const baseline = loadBaseline();

    const reportIfNew = (node, text) => {
      const n = norm(text);
      if (!n || !CJK.test(n)) return;
      const key = `${filename}::${n}`;
      if (baseline.has(key)) return;

      context.report({
        node,
        messageId: 'hardcoded',
        data: { text: n.slice(0, 40) },
      });
    };

    return {
      JSXText(node) {
        reportIfNew(node, node.value);
      },
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (isInsideTCall(node) || isInsideImport(node)) return;
        reportIfNew(node, node.value);
      },
      TemplateLiteral(node) {
        if (isInsideTCall(node)) return;
        const full = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
        reportIfNew(node, full);
      },
    };
  },
};

export default {
  rules: {
    'no-hardcoded-zh': noHardcodedZh,
  },
};