/**
 * 爬虫 UA 分类（§16.4：核心统一分类 searchbot/aibot/human，插件不自维护名单）。
 * 以 bot/spider/slurp 子串判定为基础语义并细分为 searchbot/aibot。
 */

/** 策略名单条目：自描述一条爬虫策略的全部维度（匹配 / 默认供给 / 可否认领 / 历史键） */
export interface PolicyCrawler {
  /** 对外标识：robots.txt 的 `User-agent:` 值，同时是后台开关键名（= 存储键 aiBots[label]） */
  label: string;
  /** UA 匹配子串（小写）。多个即别名：一份策略覆盖同一爬虫的多种自报写法 */
  tokens: readonly string[];
  /**
   * 出厂是否供给预渲染正文。
   * false（AI 训练/索引型）→ 分类为 aibot，只拿 SPA 壳；true（检索/用户服务型）→ 按搜索爬虫拿全文。
   * 显式声明而非「按是否含 AI 字样」推断：名单增删时不会静默改变出厂供给行为。
   */
  prerender: boolean;
  /** 用户触发型：由真实用户的操作引发（如用户在 AI 助手里点开本页），关掉会直接损害那个真人的阅读体验 */
  userTriggered?: boolean;
  /** 该标识不作为真实请求 UA 出现（robots 专用 token）：闸门永不命中，开关只影响 robots 声明 */
  robotsOnly?: boolean;
  /** 历史开关键名：label 更名后仍回读旧配置，避免存量开关设置失效 */
  legacyLabels?: readonly string[];
}

/**
 * 策略名单（**唯一事实源**）：可被 robots 分条开关逐一管控的爬虫。
 *   - geo 插件由此派生后台表单 schema 与 robots.txt 片段；
 *   - 核心由 matchPolicyCrawler 在页面请求上做拒绝闸门（被站长关掉开关者 403，见 modules/seo/core.ts）。
 * ⚠️ label 即后台存储键，更名必须同时登记 legacyLabels。
 */
export const POLICY_CRAWLERS: readonly PolicyCrawler[] = [
  /* ---- ① 训练/索引型：抓取结果进模型训练或 AI 索引，没有人在等这一页 → 默认不给正文（拿 SPA 壳） ---- */
  { label: 'GPTBot', tokens: ['gptbot'], prerender: false },
  { label: 'ClaudeBot', tokens: ['claudebot'], prerender: false },
  { label: 'Claude-Web', tokens: ['claude-web'], prerender: false }, // Anthropic 已弃用的旧 UA，保留以兼容旧抓取
  { label: 'PerplexityBot', tokens: ['perplexitybot'], prerender: false },
  { label: 'CCBot', tokens: ['ccbot'], prerender: false },
  { label: 'AI2Bot', tokens: ['ai2bot'], prerender: false },

  /* ---- ② 检索/用户服务型：结果服务于某处的检索或有人在等这一页 → 默认给正文 ---- */
  /* 字节 Bytespider 兼服务字节系搜索（§19 决策 9/11「默认允许」）。 */
  { label: 'Bytespider', tokens: ['bytespider'], prerender: true },
  /* Amazonbot：据官方 developer.amazon.com/support/amazonbot，Amazon 只公布 Amazonbot / Amzn-SearchBot /
     Amzn-User 三个标识，**没有 aws2bot** —— 旧键既匹配不到真实 UA，robots 行也无人识别，属空开关，故更名；
     aws2bot 降为别名（防个别环境仍以旧写法自报）、AWS2Bot 降为旧键（存量配置继续可读）。
     官方称它「可能用于训练 Amazon AI 模型」（按①的判据应不给正文），但允许它可获 Amazon Content Partners
     权益（联盟佣金加成、AI 流量工具），属商业取舍，故保留默认供给；要拦由站长关开关。 */
  { label: 'Amazonbot', tokens: ['amazonbot', 'aws2bot'], prerender: true, legacyLabels: ['AWS2Bot'] },
  { label: 'Amzn-SearchBot', tokens: ['amzn-searchbot'], prerender: true }, // 官方明确「不用于生成式 AI 训练」
  /* Amzn-User 由用户实时查询触发；官方明说它**可能不遵循 robots.txt** —— 正是 UA 闸门的价值所在。 */
  { label: 'Amzn-User', tokens: ['amzn-user'], prerender: true, userTriggered: true },

  /* ---- ③ AI 助手检索/用户触发型：结果给人看，拒绝等于让真人打不开本站 ---- */
  /* ChatGPT-User：用户在 ChatGPT 里点开链接时触发，受损的是那个真人，故默认给正文。 */
  { label: 'ChatGPT-User', tokens: ['chatgpt'], prerender: true, userTriggered: true },
  { label: 'Claude-User', tokens: ['claude-user'], prerender: true, userTriggered: true },
  { label: 'Perplexity-User', tokens: ['perplexity-user'], prerender: true, userTriggered: true },
  { label: 'OAI-SearchBot', tokens: ['oai-searchbot'], prerender: true }, // ChatGPT 搜索索引，非用户触发

  /* ---- robots 专用 token：不作为 UA 出现，开关只写声明 ---- */
  /* Google-Extended 不是会发请求的爬虫：Google 官方明确它只是 robots 控制 token（管 Gemini/Vertex 训练用途），
     不存在以该标识为 UA 的请求，也无对应 IP / 反向 DNS —— 故不给 tokens，闸门永不命中，开关只写声明。
     另需注意它属「事后」控制：内容须先被 Googlebot 抓走，之后才谈得上是否用于训练。 */
  { label: 'Google-Extended', tokens: [], prerender: false, robotsOnly: true },
];

/**
 * 分类用 AI 名单：默认**不**供给预渲染正文（与 human 同样只拿 SPA 壳）。
 * 由名单的 prerender 声明派生（不再手工增删，也不再靠「排除某个 token」的隐式规则）。
 * 站长要屏蔽其中的爬虫走后台开关（被拒后由预渲染闸门 403），而非在分类层改判——
 * 后者会改变所有站点的出厂行为。
 */
const AI_BOTS = POLICY_CRAWLERS.filter((c) => !c.prerender).flatMap((c) => c.tokens);

/**
 * 分类用「供给正文」名单：名单里显式声明 prerender=true 的爬虫（检索型 + 用户触发型）。
 * 必须参与分类：这些 UA 大多不含 `bot`/`spider` 字样（Amzn-User、Claude-User、Perplexity-User 等），
 * 只靠下面的泛化兜底会把它们判成 human，从而既不供给正文、也**绕过预渲染闸门**（开关静默失效）。
 *
 * ⚠️ 结构性不变量：名单里任一有 tokens 的条目，命中它的 UA 必被归入本表（searchbot）或 AI_BOTS（aibot），
 * 永不为 human —— 闸门（只对 aibot/searchbot 运行）因此总有执行机会。
 * 改本文件须保持该不变量，test/geo-plugin.test.ts 有对应守卫用例。
 */
const PRERENDER_BOTS = POLICY_CRAWLERS.filter((c) => c.prerender).flatMap((c) => c.tokens);

const SEARCH_BOTS = [
  'googlebot',
  'bingbot',
  'baiduspider',
  'sogou',
  '360spider',
  'yandexbot',
  'duckduckbot',
  'slurp',
];

export type UaClass = 'searchbot' | 'aibot' | 'human';

export function classifyUserAgent(ua: string): UaClass {
  const s = ua.toLowerCase();
  if (AI_BOTS.some((t) => s.includes(t))) return 'aibot';
  if (PRERENDER_BOTS.some((t) => s.includes(t))) return 'searchbot';
  if (SEARCH_BOTS.some((t) => s.includes(t))) return 'searchbot';
  // 兜底：泛化 token（大小写不敏感扩展）
  if (s.includes('spider') || s.includes('bot')) return 'searchbot';
  return 'human';
}

/**
 * 策略名单匹配：UA 命中任一策略爬虫即返回该条目，否则 null。
 * 供预渲染闸门先零成本判断「本请求是否需要装载插件策略」——名单外的 Googlebot 等
 * 完全不产生额外 KV/D1 读（铁律 3 预算）。robotsOnly 条目（无 tokens）永不命中。
 */
export function matchPolicyCrawler(ua: string): PolicyCrawler | null {
  const s = ua.toLowerCase();
  return POLICY_CRAWLERS.find((c) => c.tokens.some((t) => s.includes(t))) ?? null;
}

/** 核心预渲染接管的页面路由（§10.2 只读页） */
export function pageRoute(path: string): { kind: 'index' | 'forum' | 'thread' | 'user'; id?: number; page?: number } | null {
  let m = /^\/page\/(\d+)\/?$/.exec(path);
  if (m) return { kind: 'index', page: Number(m[1]) };
  if (path === '/' || path === '') return { kind: 'index' };
  m = /^\/forum\/(\d+)\/?$/.exec(path);
  if (m) return { kind: 'forum', id: Number(m[1]) };
  m = /^\/thread\/(\d+)(?:\/p\/(\d+))?\/?$/.exec(path);
  if (m) return { kind: 'thread', id: Number(m[1]), page: m[2] ? Number(m[2]) : 1 };
  m = /^\/user\/(\d+)\/?$/.exec(path);
  if (m) return { kind: 'user', id: Number(m[1]) };
  return null;
}

/** 插件注册路径匹配：精确或含 `*` 通配（如 `*.htm` 的 301 层） */
export function matchRegisteredPath(pattern: string, path: string): boolean {
  if (!pattern.includes('*')) return pattern === path;
  const re = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
  return re.test(path);
}
