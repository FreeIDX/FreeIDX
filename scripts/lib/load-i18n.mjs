/**
 * 共享 i18n 词典加载库：合并 gen（PHP 源生成）与 override（项目新增词条）两层，
 * 供 audit / check-i18n / gen-i18n-types / 冒烟测试等脚本复用，避免各脚本读取范围不一致。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const GEN = (root) => join(root, 'packages', 'shared', 'src', 'i18n', 'gen');
const OVR = (root) => join(root, 'packages', 'shared', 'src', 'i18n', 'override');

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

/** @returns {{ locales: string[], dicts: Record<string, {bbs: Record<string,string>, admin: Record<string,string>}> }} */
export function loadMergedDicts(root) {
  const genDir = GEN(root);
  const ovrDir = OVR(root);
  const locales = readdirSync(genDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
  const dicts = {};
  for (const loc of locales) {
    const gen = readJson(join(genDir, `${loc}.json`), { bbs: {}, admin: {} });
    const ovr = readJson(join(ovrDir, `${loc}.json`), { bbs: {}, admin: {} });
    dicts[loc] = {
      bbs: { ...(gen.bbs ?? {}), ...(ovr.bbs ?? {}) },
      admin: { ...(gen.admin ?? {}), ...(ovr.admin ?? {}) },
    };
  }
  return { locales, dicts };
}