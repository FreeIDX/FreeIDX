/**
 * i18n 词典分包插件（构建期，web 构建与 api 单测共用）。
 *
 * 背景：单语言词典含 bbs（前台 ~514 词条）与 admin（后台 ~573 词条）两个命名空间，
 * 此前每个语言包把两者打进同一个 chunk，普通访客也要下载后台词条（约单语言体积的一半）。
 *
 * 做法：把 `virtual:freeidx-i18n/{bbs,admin}/<locale>` 暴露为虚拟模块，构建期从
 * `packages/shared/src/i18n/{gen,override}/<locale>.json` 现读现合并（override 覆盖 gen，
 * 与 scripts/lib/load-i18n.mjs 口径一致），每个「命名空间 × 语言」各成一个 chunk。
 * 源词典文件布局不变，audit/check/gen-types 等脚本的读取范围也完全不受影响。
 *
 * 注：本文件刻意不 import 'vite' 的类型——它位于仓库根目录的 scripts/ 下，
 * 而 vite 只装在 apps/web 的 node_modules 里，从本目录解析不到；因此用最小结构类型描述用到的钩子。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 虚拟模块前缀；消费端见 packages/shared/src/i18n/bundles.ts */
export const I18N_VIRTUAL_PREFIX = 'virtual:freeidx-i18n/';

type Namespace = 'bbs' | 'admin';
type Dicts = Record<string, Record<string, string> | undefined>;

/** 已解析模块 id 前缀（Rollup 约定：`\0` 前缀表示虚拟模块，避免被当成真实路径解析） */
const RESOLVED_PREFIX = `\0${I18N_VIRTUAL_PREFIX}`;
const SPEC = /^virtual:freeidx-i18n\/(bbs|admin)\/([a-z]{2}-[a-z]{2})$/;

/** 只声明 dev server 上实际用到的成员（结构上兼容 ViteDevServer） */
interface DevServerLike {
  watcher: {
    add(dir: string): void;
    on(event: string, listener: (file: string) => void): void;
  };
  moduleGraph: {
    idToModuleMap: Map<string, { id?: string | null }>;
    invalidateModule(mod: { id?: string | null }): void;
  };
  ws: { send(payload: { type: 'full-reload' }): void };
}

export interface I18nSplitPlugin {
  name: string;
  enforce: 'pre';
  resolveId(id: string): string | null;
  load(id: string): string | null;
  configureServer(server: DevServerLike): void;
}

function readDict(dir: string, lang: string): Dicts {
  const file = join(dir, `${lang}.json`);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')) as Dicts;
}

/**
 * @param i18nDir 词典根目录（`packages/shared/src/i18n`）
 */
export function i18nSplitPlugin(i18nDir: string): I18nSplitPlugin {
  /** 单个命名空间 × 单语言：gen 打底 + override 覆盖 */
  function namespaceOf(lang: string, ns: Namespace): Record<string, string> {
    const gen = readDict(join(i18nDir, 'gen'), lang)[ns] ?? {};
    const ovr = readDict(join(i18nDir, 'override'), lang)[ns] ?? {};
    return { ...gen, ...ovr };
  }

  return {
    name: 'freeidx:i18n-split',
    enforce: 'pre',
    resolveId(id) {
      if (!SPEC.test(id)) return null;
      return RESOLVED_PREFIX + id.slice(I18N_VIRTUAL_PREFIX.length);
    },
    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null;
      const m = SPEC.exec(id.slice(1));
      if (!m) return null;
      const ns = m[1] as Namespace;
      const lang = m[2] as string;
      return `export default ${JSON.stringify(namespaceOf(lang, ns))};`;
    },
    configureServer(server) {
      /* dev：词典 JSON 改动后重建虚拟模块并整页刷新（生产构建无需热更新） */
      server.watcher.add(i18nDir);
      server.watcher.on('change', (file) => {
        const normalized = file.replace(/\\/g, '/');
        if (!normalized.startsWith(i18nDir.replace(/\\/g, '/'))) return;
        for (const mod of server.moduleGraph.idToModuleMap.values()) {
          if (typeof mod.id === 'string' && mod.id.startsWith(RESOLVED_PREFIX)) {
            server.moduleGraph.invalidateModule(mod);
          }
        }
        server.ws.send({ type: 'full-reload' });
      });
    },
  };
}
