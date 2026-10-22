/**
 * geo 插件（T4-5，§16.3/§16.4：GEO 生成式引擎优化，出厂启用可停用）。
 * 归属：llms.txt（registerRoute）+ AI 爬虫 robots 分条开关（robots:contribute，读 ext:geo:config 同步预载）
 *   + 开关的**执行侧**（useMiddleware 拒绝闸门：被关掉的爬虫页面请求直接 403，不再供给正文）。
 * 停用后回落核心默认策略：llms.txt 404、robots 无 AI 分条（`User-agent: *` 默认放行）、无拒绝闸门（§19 决策 9/11「默认允许」）。
 * 名单本身归属核心（POLICY_CRAWLERS，§16.4「插件不自维护名单」），本插件只做策略落点。
 * 精华帖全文开放：通过 llms.txt「精华」目录入口暴露（§16.3 line 910）；正文全文仍由核心 searchbot 预渲染统一供给，
 * geo 不重复实现预渲染（§16.4「正文/JSON-LD 唯一归属」原则，插件零依赖）。
 */
import { loadSetting, loadForumlist, loadGrouplist } from '../core/loaders';
import { canonicalBase } from '../core/site';
import { forumListAccessFilter } from '../core/access';
import type { D1b } from '../core/db';
import type { Cache } from '../core/cache';
import { SHARED_UA, edgeLookup, edgeStore, isPersonalRequest, maybeCtx } from '../core/cache/edge';
import type { ExtSchema } from '@freeidx/shared';
import type { ExtensionApi, ExtensionModule } from '../core/extensions/registry';
import { L } from '../core/i18n';
import { POLICY_CRAWLERS, matchPolicyCrawler, type PolicyCrawler } from '../core/crawler';

/** 多语言文案对象（与 core/i18n 的 L() 同形） */
type LocText = Record<string, string>;

/**
 * 开关说明文案片段（10 语言）。拆成片段而非逐条硬写，是因为各条爬虫的**效力不同**：
 * 通用句讲 robots 声明，其余按条目特性追加，避免出现「文案说只写 robots、实际还会 403」的误导。
 */
const HELP_ROBOTS = (label: string): LocText =>
  L(
    `关闭后 robots.txt 会写入 “User-agent: ${label} / Disallow: /”。`,
    `關閉後 robots.txt 會寫入 “User-agent: ${label} / Disallow: /”。`,
    `When turned off, robots.txt gains “User-agent: ${label} / Disallow: /”.`,
    `При выключении в robots.txt добавится “User-agent: ${label} / Disallow: /”.`,
    `เมื่อปิด ระบบจะเขียน “User-agent: ${label} / Disallow: /” ลงใน robots.txt`,
    `Bei Deaktivierung erhält robots.txt „User-agent: ${label} / Disallow: /“.`,
    `オフにすると robots.txt に “User-agent: ${label} / Disallow: /” が書き込まれます。`,
    `끄면 robots.txt에 “User-agent: ${label} / Disallow: /”가 기록됩니다.`,
    `Al desactivarlo, robots.txt incluye “User-agent: ${label} / Disallow: /”.`,
    `Désactivé, robots.txt reçoit « User-agent: ${label} / Disallow: / ».`,
  );

/** 追加（会走闸门的条目）：声明之外还有真拒绝 */
const HELP_ENFORCED = L(
  '同时本站会直接向该爬虫返回 403、不再供给预渲染正文——声明与执行一并生效，不依赖爬虫自觉遵守 robots。',
  '同時本站會直接向該爬蟲回應 403、不再供給預渲染正文——宣告與執行一併生效，不依賴爬蟲自覺遵守 robots。',
  'The site also answers this crawler with HTTP 403 and stops serving prerendered content — the rule is enforced, not merely declared, so it does not rely on the crawler honouring robots.txt.',
  'Сайт также ответит этому краулеру кодом 403 и перестанет отдавать предрендеренный контент — правило исполняется, а не только объявляется, и не зависит от соблюдения robots.txt.',
  'ไซต์จะตอบกลับครอว์เลอร์นี้ด้วย 403 และหยุดส่งเนื้อหาพรีเรนเดอร์ — บังคับใช้จริง ไม่ได้แค่ประกาศ จึงไม่ต้องพึ่งการเชื่อฟัง robots.txt',
  'Die Seite antwortet diesem Crawler außerdem mit HTTP 403 und liefert keinen vorgerenderten Inhalt mehr — die Regel wird durchgesetzt, nicht nur erklärt, und hängt nicht vom Einhalten der robots.txt ab.',
  'さらに本サイトはこのクローラーに 403 を返し、プリレンダリング済み本文の配信も停止します。宣言と実行が同時に効くため、robots.txt の順守に依存しません。',
  '또한 사이트가 이 크롤러에 403을 반환하고 프리렌더 본문 제공을 중단합니다. 선언과 집행이 함께 적용되므로 robots.txt 준수에 의존하지 않습니다.',
  'Además, el sitio responde a este rastreador con HTTP 403 y deja de servir el contenido prerenderizado: la regla se aplica, no solo se declara, sin depender de que respete robots.txt.',
  'Le site répond en outre à ce crawler par un HTTP 403 et cesse de servir le contenu pré-rendu : la règle est appliquée, pas seulement déclarée, sans dépendre du respect de robots.txt.',
);

/** 追加（robotsOnly 条目，目前是 Google-Extended）：没有可拦的请求，且属事后控制 */
const HELP_ROBOTS_ONLY = L(
  '注意：该标识不会作为真实请求的 User-Agent 出现，Google 不以此标识发起抓取，因此没有可拦截的请求——本开关只影响 robots.txt 声明，且属“事后”控制（内容须先被 Googlebot 抓走）。',
  '注意：該標識不會作為真實請求的 User-Agent 出現，Google 不以此標識發起抓取，因此沒有可攔截的請求——本開關只影響 robots.txt 宣告，且屬「事後」控制（內容須先被 Googlebot 抓走）。',
  'Note: this token never appears as a real request User-Agent — Google does not fetch with it, so there is no request to block. The switch only affects the robots.txt declaration, and it acts retrospectively: the content must first be fetched by Googlebot.',
  'Внимание: этот идентификатор не встречается как User-Agent реальных запросов — Google не обращается с ним, поэтому блокировать нечего. Переключатель влияет только на robots.txt, причём постфактум: контент сначала должен быть получен Googlebot.',
  'หมายเหตุ: ตัวระบุนี้ไม่ปรากฏเป็น User-Agent ของคำขอจริง Google ไม่ได้ใช้มันดึงข้อมูล จึงไม่มีคำขอให้บล็อก สวิตช์นี้มีผลกับ robots.txt เท่านั้น และเป็นแบบย้อนหลัง (เนื้อหาต้องถูก Googlebot ดึงไปก่อน)',
  'Hinweis: Dieser Bezeichner erscheint nie als User-Agent einer echten Anfrage — Google ruft damit nicht ab, es gibt also nichts zu blockieren. Der Schalter betrifft nur die robots.txt-Erklärung und wirkt nachträglich: Inhalte müssen zuerst von Googlebot abgerufen werden.',
  '注意：この識別子は実際のリクエストの User-Agent としては現れません。Google はこれで取得しないため、遮断すべきリクエストがありません。このスイッチは robots.txt の宣言にのみ作用し、しかも遡及的です（内容はまず Googlebot に取得されている必要があります）。',
  '주의: 이 식별자는 실제 요청의 User-Agent로 나타나지 않습니다. Google이 이를 사용해 가져오지 않으므로 차단할 요청이 없습니다. 이 스위치는 robots.txt 선언에만 영향을 주며 사후적입니다(콘텐츠는 먼저 Googlebot이 가져가야 합니다).',
  'Nota: este identificador nunca aparece como User-Agent de una petición real — Google no rastrea con él, así que no hay petición que bloquear. El interruptor solo afecta a la declaración en robots.txt y actúa a posteriori: el contenido debe haber sido rastreado antes por Googlebot.',
  'Remarque : cet identifiant n’apparaît jamais comme User-Agent d’une requête réelle — Google n’explore pas avec, il n’y a donc rien à bloquer. Le réglage n’affecte que la déclaration robots.txt, et de façon rétroactive : le contenu doit d’abord avoir été exploré par Googlebot.',
);

/** 追加（出厂按检索类供给正文的条目）：说明默认给正文 */
const HELP_PRERENDER = L(
  '该爬虫出厂按检索类供给完整正文，只有关掉本开关后才不再供给。',
  '該爬蟲出廠按檢索類供給完整正文，只有關掉本開關後才不再供給。',
  'By default this crawler is treated as search-like and receives the full prerendered content; it stops only once you turn this switch off.',
  'По умолчанию этот краулер отнесён к поисковым и получает полный предрендеренный контент; он перестанет получать его только после отключения переключателя.',
  'ค่าเริ่มต้นถือว่าครอว์เลอร์นี้เป็นแบบค้นหาและได้รับเนื้อหาพรีเรนเดอร์เต็มรูปแบบ จะหยุดก็ต่อเมื่อปิดสวิตช์นี้',
  'Standardmäßig gilt dieser Crawler als suchmaschinenartig und erhält den vollständigen vorgerenderten Inhalt; erst nach Ausschalten dieses Schalters nicht mehr.',
  '既定ではこのクローラーは検索系として扱われ、プリレンダリング済み本文を完全に受け取ります。受け取らなくなるのはこのスイッチを切った後だけです。',
  '기본적으로 이 크롤러는 검색형으로 취급되어 프리렌더 본문 전체를 받습니다. 이 스위치를 끈 뒤에야 받지 않습니다.',
  'Por defecto este rastreador se trata como de búsqueda y recibe el contenido prerenderizado completo; solo deja de recibirlo al desactivar este interruptor.',
  'Par défaut, ce crawler est traité comme un moteur de recherche et reçoit l’intégralité du contenu pré-rendu ; il ne cesse de le recevoir qu’après désactivation de ce réglage.',
);

/** 追加（用户触发型条目）：关掉会直接损害真人，属需明示的副作用 */
const HELP_USER_TRIGGERED = L(
  '该爬虫由真实用户的操作触发（例如用户在 AI 助手里点开本站链接），关掉后这些用户将无法看到本站内容。',
  '該爬蟲由真實使用者的操作觸發（例如使用者在 AI 助理裡點開本站連結），關掉後這些使用者將無法看到本站內容。',
  'This crawler is triggered by a real user’s action (for example, someone opening a link to this site inside an AI assistant); turning it off means those users cannot see the content.',
  'Этот краулер запускается действием реального пользователя (например, когда он открывает ссылку на сайт внутри ИИ-ассистента); при отключении такие пользователи не увидят содержимое.',
  'ครอว์เลอร์นี้ถูกเรียกโดยการกระทำของผู้ใช้จริง (เช่น ผู้ใช้เปิดลิงก์ของไซต์ในผู้ช่วย AI) หากปิด ผู้ใช้เหล่านั้นจะไม่เห็นเนื้อหา',
  'Dieser Crawler wird durch die Aktion eines echten Nutzers ausgelöst (z. B. wenn jemand einen Link zu dieser Seite in einem KI-Assistenten öffnet); nach dem Ausschalten sehen diese Nutzer die Inhalte nicht.',
  'このクローラーは実ユーザーの操作（AI アシスタント内で本サイトのリンクを開くなど）で起動します。オフにすると、それらのユーザーは本サイトの内容を閲覧できなくなります。',
  '이 크롤러는 실제 사용자의 동작(AI 어시스턴트에서 사이트 링크를 여는 등)으로 실행됩니다. 끄면 그 사용자들은 사이트 내용을 볼 수 없습니다.',
  'Este rastreador se activa por la acción de un usuario real (por ejemplo, al abrir un enlace de este sitio dentro de un asistente de IA); al desactivarlo, esos usuarios no verán el contenido.',
  'Ce crawler est déclenché par l’action d’un véritable utilisateur (par exemple l’ouverture d’un lien vers ce site dans un assistant IA) ; désactivé, ces utilisateurs ne verront pas le contenu.',
);

/** 同语言拼接多段文案（L() 返回按语言键控的对象，键集恒为 10 语言） */
function joinLoc(...parts: LocText[]): LocText {
  const out: LocText = {};
  for (const p of parts) for (const [k, v] of Object.entries(p)) out[k] = (out[k] ?? '') + v;
  return out;
}

/** 单条开关的完整说明 = 通用 robots 声明 + 按条目特性追加（robotsOnly / 闸门效力 / 默认供给 / 用户触发） */
function helpFor(entry: PolicyCrawler): LocText {
  const parts = [HELP_ROBOTS(entry.label)];
  if (entry.robotsOnly) {
    parts.push(HELP_ROBOTS_ONLY);
  } else {
    parts.push(HELP_ENFORCED);
    if (entry.prerender) parts.push(HELP_PRERENDER);
    if (entry.userTriggered) parts.push(HELP_USER_TRIGGERED);
  }
  return joinLoc(...parts);
}

/** 后台配置表单 schema（插件自声明）：爬虫开关由核心策略名单 POLICY_CRAWLERS 派生，
 *  键名即其 label，与 ext:geo:config.aiBots 一一对应（更名须在核心名单登记 legacyLabels） */
const GEO_SCHEMA: ExtSchema = {
  brief: L(
    '面向 AI 生成式引擎优化：输出 /llms.txt 站点摘要，并可对 GPTBot 等 AI 爬虫逐一允许或禁止抓取。',
    '面向 AI 生成式引擎最佳化：輸出 /llms.txt 站點摘要，並可對 GPTBot 等 AI 爬蟲逐一允許或禁止抓取。',
    'Generative-engine optimisation: publishes a /llms.txt site summary and lets you allow or block AI crawlers like GPTBot individually.',
    'Оптимизация под генеративные движки: публикует сводку сайта /llms.txt и позволяет отдельно разрешать или запрещать ИИ-краулерам вроде GPTBot.',
    'เพิ่มประสิทธิภาพสำหรับเอนจินเจนเนอราทีฟ: เผยแพร่สรุปไซต์ที่ /llms.txt และเลือกอนุญาตหรือบล็อก AI ครอว์เลอร์อย่าง GPTBot ได้เป็นรายตัว',
    'Optimierung für generative Engines: veröffentlicht eine /llms.txt-Site-Zusammenfassung und erlaubt/blockiert AI-Crawler wie GPTBot einzeln.',
    '生成系エンジン最適化：/llms.txt のサイト要約を出力し、GPTBot などの AI クローラーを個別に許可/拒否できます。',
    '생성형 엔진 최적화: /llms.txt 사이트 요약을 공개하고 GPTBot 등 AI 크롤러를 개별적으로 허용하거나 차단할 수 있습니다.',
    'Optimización para motores generativos: publica un resumen del sitio en /llms.txt y permite permitir o bloquear rastreadores de IA como GPTBot uno por uno.',
    'Optimisation pour moteurs génératifs : publie un résumé du site sur /llms.txt et permet d’autoriser ou de bloquer un à un les crawlers IA comme GPTBot.',
  ),
  intro: L(
    '启用即自动生效：/llms.txt 站点摘要、AI 爬虫 robots 分条（默认全部**允许**抓取）。以下是可选调整，不填即用默认策略。',
    '啟用即自動生效：/llms.txt 站點摘要、AI 爬蟲 robots 分條（預設全部**允許**抓取）。以下是可選調整，不填即用預設策略。',
    'Effective automatically once enabled: the /llms.txt summary and per-crawler robots entries (all AI crawlers **allowed** by default). Everything below is optional — the default policy applies if left untouched.',
    'Работает сразу после включения: сводка /llms.txt и записи robots для ИИ-краулеров (по умолчанию всем **разрешено**). Ниже — необязательные настройки; без них действует политика по умолчанию.',
    'เปิดใช้งานแล้วทำงานทันที: สรุปไซต์ /llms.txt และรายการ robots ราย AI ครอว์เลอร์ (ค่าเริ่มต้น**อนุญาต**ทั้งหมด) ด้านล่างเป็นตัวเลือกเสริม ไม่กรอกก็ใช้นโยบายเริ่มต้น',
    'Wirkt automatisch nach der Aktivierung: /llms.txt-Zusammenfassung und robots-Einträge je Crawler (standardmäßig alles **erlaubt**). Alles darunter ist optional — ohne Änderung gilt die Standardpolitik.',
    '有効化するだけで自動動作します：/llms.txt のサイト要約と AI クローラー別の robots 設定（既定はすべて**許可**）。以下は任意の調整で、未設定なら既定ポリシーが適用されます。',
    '활성화하면 자동으로 동작합니다: /llms.txt 사이트 요약과 AI 크롤러별 robots 항목(기본값은 전부**허용**). 아래는 선택적 조정이며, 설정하지 않으면 기본 정책이 적용됩니다.',
    'Efectivo automáticamente al activarlo: el resumen /llms.txt y las entradas de robots por crawler (todos los crawlers de IA **permitidos** por defecto). Lo siguiente es opcional: sin cambios, se aplica la política predeterminada.',
    'Efficace automatiquement une fois activé : le résumé /llms.txt et les entrées robots par crawler (tous les crawlers IA **autorisés** par défaut). Ce qui suit est optionnel — sans modification, la politique par défaut s’applique.',
  ),
  fields: [
    ...POLICY_CRAWLERS.map((entry): ExtSchema['fields'][number] => ({
      key: entry.label,
      path: ['aiBots', entry.label],
      type: 'switch',
      label: L(
        `允许 ${entry.label} 抓取`,
        `允許 ${entry.label} 抓取`,
        `Allow ${entry.label}`,
        `Разрешить ${entry.label}`,
        `อนุญาต ${entry.label}`,
        `${entry.label} erlauben`,
        `${entry.label} を許可`,
        `${entry.label} 허용`,
        `Permitir ${entry.label}`,
        `Autoriser ${entry.label}`,
      ),
      onValue: 'allow',
      offValue: 'deny',
      defaultOn: true,
      help: helpFor(entry),
    })),
    {
      key: 'contentLicense',
      type: 'textarea',
      rows: 3,
      label: L(
        '内容授权声明',
        '內容授權聲明',
        'Content license statement',
        'Заявление о лицензии контента',
        'ข้อความอนุญาตเนื้อหา',
        'Inhaltslizenz-Hinweis',
        'コンテンツライセンス宣言',
        '콘텐츠 라이선스 선언',
        'Declaración de licencia de contenido',
        'Déclaration de licence de contenu',
      ),
      placeholder: L(
        '留空使用默认声明（署名转载 + 原链回源）',
        '留空使用預設聲明（署名轉載 + 原鏈回源）',
        'Leave blank for the default (attribution + link back to source)',
        'Оставьте пустым для варианта по умолчанию (атрибуция + ссылка на источник)',
        'เว้นว่างเพื่อใช้ข้อความเริ่มต้น (ระบุที่มา + ลิงก์กลับแหล่งเดิม)',
        'Leer lassen für den Standard (Namensnennung + Link zur Quelle)',
        '空欄で既定文を使用（出典明記 + 原リンク）',
        '비워 두면 기본 문구 사용(출처 표기 + 원본 링크)',
        'Dejar en blanco para el texto predeterminado (atribución + enlace a la fuente)',
        'Laisser vide pour le texte par défaut (attribution + lien vers la source)',
      ),
      help: L(
        '显示在 /llms.txt 末尾的 Content License 段，用于告知 AI 引擎你的内容转载政策。',
        '顯示在 /llms.txt 末尾的 Content License 段，用於告知 AI 引擎你的內容轉載政策。',
        'Shown in the Content License section at the end of /llms.txt, telling AI engines your content reuse policy.',
        'Показывается в разделе Content License в конце /llms.txt и сообщает ИИ-движкам вашу политику переиспользования контента.',
        'แสดงในส่วน Content License ท้าย /llms.txt เพื่อแจ้งนโยบายการนำเนื้อหาไปใช้ให้เอนจิน AI ทราบ',
        'Erscheint im Content-License-Abschnitt am Ende von /llms.txt und teilt AI-Engines die Richtlinie zur Weiternutzung mit.',
        '/llms.txt 末尾の Content License セクションに表示され、AI エンジンにコンテンツ再利用ポリシーを伝えます。',
        '/llms.txt 끝의 Content License 섹션에 표시되어 AI 엔진에 콘텐츠 재사용 정책을 알립니다.',
        'Se muestra en la sección Content License al final de /llms.txt e informa a los motores de IA tu política de reutilización.',
        'Affichée dans la section Content License à la fin de /llms.txt pour informer les moteurs IA de votre politique de réutilisation.',
      ),
    },
  ],
};

/**
 * 某爬虫是否被站长关掉。键名 = 条目 label；该键不存在时回读 legacyLabels（更名前的旧键），
 * 保证更名不会让存量开关设置失联。取首个**存在**的键判定，缺省 allow。
 * 同一判定同时喂给 robots 片段与拒绝闸门，保证「声明」与「执行」永不分叉。
 */
function isDeniedEntry(aiBots: unknown, entry: PolicyCrawler): boolean {
  if (!aiBots || typeof aiBots !== 'object') return false;
  const bag = aiBots as Record<string, unknown>;
  for (const key of [entry.label, ...(entry.legacyLabels ?? [])]) {
    const v = bag[key];
    if (v !== undefined) return String(v).toLowerCase() === 'deny';
  }
  return false;
}

/** robots 片段：每 bot 一条 `User-agent` + Allow/Disallow，默认允许（config.aiBots[bot]==='deny' 才关） */
export function aiCrawlerRobots(aiBots: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const entry of POLICY_CRAWLERS) {
    lines.push(`User-agent: ${entry.label}`, isDeniedEntry(aiBots, entry) ? 'Disallow: /' : 'Allow: /');
  }
  return lines;
}

const esc = (s: string): string => s.replace(/[\[\]()]/g, (ch) => `\\${ch}`).replace(/\r?\n/g, ' ');

/** llms.txt 边缘缓存 TTL（与响应头 max-age 一致） */
const LLMS_TTL = 3600;

function makeLlmsHandler(contentLicense: string) {
  return async (c: unknown): Promise<Response> => {
    const ctx = c as {
      get: (k: string) => unknown;
      env: { SITE_URL?: string };
      req: { url: string; raw: { headers: { get: (name: string) => string | null } } };
    };
    // 边缘缓存前置：llms.txt 是全站同值文档、且是 AI 爬虫（GPTBot/CCBot/ClaudeBot 等）的回访入口文件 ——
    // 命中即省掉 setting/forumlist/grouplist 读穿与那条 100 条精华主题扫描。
    // 带登录轨 Cookie 的请求（站长自查）跳过读缓存；无 Cache API 环境恒 miss，退化为原链路。
    if (!isPersonalRequest(ctx.req.raw.headers)) {
      const hit = await edgeLookup(ctx.req.url, SHARED_UA);
      if (hit) return hit;
    }
    const db = ctx.get('db') as D1b;
    const cache = ctx.get('cache') as Cache;
    const [setting, forumlist, grouplist] = await Promise.all([
      loadSetting(cache, db),
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
    ]);
    // llms.txt 的链接同样用主域名（后台「站点网址」优先，SITE_URL 兜底，最后回落当前请求域）
    const base = canonicalBase(ctx, setting);
    const visible = forumListAccessFilter(forumlist, 0, grouplist);
    const digest = await db
      .prepare<{ tid: number; subject: string }>(
        // tt_check：仅列出已过审主题（ok=1）
        'SELECT tid,subject FROM bbs_thread WHERE digest > 0 AND ok = 1 ORDER BY digest DESC, tid DESC LIMIT 100',
      )
      .all();

    const out: string[] = [`# ${setting.sitename || 'Site'}`, ''];
    const intro = (setting.brief || setting.desc || '').trim();
    if (intro) out.push(`> ${intro.replace(/\r?\n/g, ' ')}`, '');

    out.push('## Forums', '');
    for (const f of Object.values(visible)) {
      out.push(`- [${esc(f.name)}](${base}/forum/${f.fid}): ${esc(f.brief || '')}`);
    }
    out.push('');

    out.push('## Digest (featured threads)', '');
    for (const t of digest.results) {
      out.push(`- [${esc(t.subject)}](${base}/thread/${t.tid})`);
    }
    out.push('');

    out.push('## Content License', '');
    out.push(
      contentLicense.trim() ||
        'All threads are community-contributed; cite with attribution and link back to the source URL.',
    );

    const body = out.join('\n') + '\n';
    edgeStore(ctx.req.url, SHARED_UA, body, LLMS_TTL, maybeCtx(c), 'text/plain; charset=utf-8');
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': `public, max-age=${LLMS_TTL}`,
      },
    });
  };
}

export const geoPlugin: ExtensionModule = {
  manifest: {
    id: 'geo',
    name: L(
      'GEO 生成式引擎优化',
      'GEO 生成式引擎優化',
      'GEO Extension',
      'GEO-расширение',
      'ส่วนขยาย GEO',
      'GEO-Erweiterung',
      'GEO 拡張',
      'GEO 확장',
      'Extensión GEO',
      'Extension GEO',
    ),
    version: '1.0.0',
    installed: 1,
    enable: 1,
  },
  schema: GEO_SCHEMA,
  setup(api: ExtensionApi) {
    const aiBots = (api.config.aiBots ?? {}) as Record<string, unknown>;
    api.registerRoute('GET', '/llms.txt', makeLlmsHandler(String(api.config.contentLicense ?? '')));
    api.contributeRobots(30, aiCrawlerRobots(aiBots));
    /* 契约 ①：robots 开关的**执行**侧（§16.4 强化）。
       此前开关只写 robots.txt，属「请求」——不守规矩的爬虫照抓不误；且核心兜底规则
       （UA 含 bot/spider → searchbot）会把 Bytespider 这类假搜索爬虫判成「给全文」，
       于是出现「后台已禁止、正文照样给」。此处把开关落成真拒绝：命中名单且被关掉 → 403，
       预渲染、模板兜底与 R2 产物一律不触达，且带 no-store 不会污染边缘缓存。
       核心只在 UA 命中 POLICY_CRAWLERS 的页面请求上调用本组中间件（人类请求与名单外爬虫零开销）。 */
    api.useMiddleware(async (c, next) => {
      const ua = (c as { req: { header: (k: string) => string | undefined } }).req.header('user-agent') ?? '';
      const hit = matchPolicyCrawler(ua);
      if (hit && isDeniedEntry(aiBots, hit)) {
        (c as { res: Response }).res = new Response('403 Forbidden: blocked by the site crawler policy\n', {
          status: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
        return;
      }
      await next();
    });
  },
};
