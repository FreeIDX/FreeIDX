/**
 * seo 插件（§16.4 归属表：sitemap/JSON-LD/OG/.htm 301/推送 cron/站点验证 = 插件侧，出厂启用可停用）。
 * 一期（T1-9）：sitemap、JSON-LD、OG、.htm 301、Sitemap robots 行。
 * 二期（T4-5）：站点验证 meta/验证文件（ext:seo:config）+ 多引擎主动推送 cron（token 存 ext:seo:secret）：
 * IndexNow（Bing/Yandex/Seznam 等联合接口，key 自动生成存 ext:seo:config 并托管 /{key}.txt）、
 * 百度、Bing Webmaster API、Google Indexing API。
 * 停用后核心保底仍在：robots.txt 基线、预渲染分发、title/canonical（modules/seo/core.ts）。
 * 作为 §12 契约 ③④⑤⑥ 的真实消费者。
 */
import type { CronRunContext, ExtSchema, PageMeta } from '@freeidx/shared';
import { forumListAccessFilter } from '../core/access';
import type { D1b } from '../core/db';
import type { Cache } from '../core/cache';
import { SHARED_UA, edgeLookup, edgeStore, isPersonalRequest, maybeCtx } from '../core/cache/edge';
import { SUBREQUEST_HARD_LIMIT } from '../core/db/budget';
import { loadForumlist, loadGrouplist, loadSetting } from '../core/loaders';
import { loadExtSecret, saveExtConfig } from '../core/ext-store';
import { canonicalBase, canonicalBaseFromSetting } from '../core/site';
import type { ExtensionApi, ExtensionCtx, ExtensionModule } from '../core/extensions/registry';
import { createApiT } from '../core/i18n';
import { L } from '../core/i18n';
import { escAttr } from '../core/fmt';
import { CRON_DAILY } from '../core/cron-schedule';

/** 站点验证文件名白名单（防路径穿越，仅允许安全字符）；schema 的 verifyFiles.keyPattern 与此同源 */
const SAFE_FILE = /^[A-Za-z0-9._-]{1,80}$/;
/** IndexNow key 合法格式（官方 8~128 位；生成 32 位 hex），自动托管 /{key}.txt 前先校验，杜绝通配注入 */
const INDEXNOW_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;

/** 生成 IndexNow key：32 位随机 hex（站点自拟字符串，公开可见——验证文件本就公开该值） */
function generateIndexNowKey(): string {
  const a = new Uint8Array(16);
  try {
    crypto.getRandomValues(a);
  } catch {
    for (let i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
  }
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** IndexNow 官方端点（key 校验文件由本插件按 config key 自动托管 /{key}.txt，无需站长放置） */
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
/** Bing Webmaster 批量提交端点（key 来自 Bing 站长工具 → 设置 → API 访问） */
const BING_SUBMIT_ENDPOINT = 'https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlBatch';
/** Google Indexing API：OAuth2 令牌端点 + 通知端点（需服务账号，配额默认 200 次/日） */
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_INDEX_ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
/**
 * 逐条 publish 的 Google 部分可用子请求数 = 免费层单 invocation 硬上限 − 本 cron 其它环节的实测上界。
 * 其它环节上界取 20：扩展装配 ≤4 + 水位读写 2 + 主题清单 3 + 密钥 ≤2 + IndexNow 1 + 百度 1 + Bing 分片 ≤4 + OAuth2 换 token 1。
 * 此前写死 100：单次最多用到 ~108 个子请求，越界的 publish 会抛 "Too many subrequests"，
 * 又被逐条的空 catch 吞掉 —— 表现为推送数静默变少且水位照常推进（这些 URL 永不再推）。
 */
const GOOGLE_PUSH_LIMIT = SUBREQUEST_HARD_LIMIT - 20;

/** Bing SubmitUrlBatch 单次提交条数上限（超出整批被拒，故必须分片） */
const BING_PUSH_CHUNK = 500;

/** 按单次上限切分推送清单（避免整批被引擎侧拒绝） */
function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const XML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escXml = (s: string) => s.replace(/[&<>"']/g, (ch) => XML_ESC[ch] ?? '');

/**
 * 遗留 .htm 短链（dash-positional）→ 新路由。
 * 目标只由解析出的数字构成，非法/未知页名回落 `/`（杜绝开放重定向）。
 */
export function mapLegacyPath(path: string): string {
  const name = path.replace(/^\/+/, '').replace(/\.htm$/i, '');
  const seg = name.split('-');
  const num = (v: string | undefined) => (/^\d+$/.test(v ?? '') ? Number(v) : 0);
  switch (seg[0]) {
    case 'thread': {
      const tid = num(seg[1]);
      if (!tid) return '/';
      const page = num(seg[2]);
      return page > 1 ? `/thread/${tid}/p/${page}` : `/thread/${tid}`;
    }
    case 'forum': {
      const fid = num(seg[1]);
      if (!fid) return '/';
      const page = num(seg[2]);
      return page > 1 ? `/forum/${fid}?page=${page}` : `/forum/${fid}`;
    }
    case 'user': {
      const uid = num(seg[1]);
      return uid ? `/user/${uid}` : '/';
    }
    case 'index': {
      const page = num(seg[1]);
      return page > 1 ? `/page/${page}` : '/';
    }
    default:
      return '/';
  }
}

function isoDate(sec: number | string): string {
  return new Date(Number(sec) * 1000).toISOString().slice(0, 10);
}

/** sitemap 边缘缓存 TTL（与响应头 max-age 一致；新主题另由 seo 主动推送 cron 即时提交，不依赖 sitemap 时效） */
const SITEMAP_TTL = 3600;

/**
 * sitemap.xml（契约 ③ 路由）。
 * 全站同值文档（仅游客可读版块 + 已过审主题，与请求方无关）→ 直接吃边缘缓存：
 * 命中即返回，免掉 getExtensions（扩展状态 + 各启用插件配置的读穿）、forumlist/grouplist 读穿，
 * 以及那条 1000 行的 bbs_thread 扫描 —— 这是全站 rows_read 最大的单条查询，爬虫每次抓 sitemap 都会触发。
 * 无 Cache API 环境（workers.dev 直访、单测裸 app.request）恒 miss，退化为原链路，行为不变。
 */
async function sitemapXml(c: unknown): Promise<unknown> {
  const ctx = c as {
    get: (k: string) => unknown;
    env: { SITE_URL?: string };
    req: { url: string; raw: { headers: { get: (name: string) => string | null } } };
  };
  // 带登录轨 Cookie 的请求（站长自查）跳过读缓存，保证配置变更当场可见
  if (!isPersonalRequest(ctx.req.raw.headers)) {
    const hit = await edgeLookup(ctx.req.url, SHARED_UA);
    if (hit) return hit;
  }
  const db = ctx.get('db') as D1b;
  const cache = ctx.get('cache') as Cache;
  // 多域名部署：sitemap 里的绝对地址一律指向主域名（后台「站点网址」优先，SITE_URL 兜底）
  const setting = await loadSetting(cache, db);
  const base = canonicalBase(ctx, setting);
  const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
  // 仅收录游客（gid=0）可读版块，与前台可见性一致（§16.2）
  const visible = forumListAccessFilter(forumlist, 0, grouplist);
  const entries: { loc: string; lastmod?: string; priority: string }[] = [
    { loc: `${base}/`, priority: '1.0' },
  ];
  for (const f of Object.values(visible)) {
    entries.push({ loc: `${base}/forum/${f.fid}`, priority: '0.8' });
  }
  const rows = await db
    .prepare<{ tid: number; last_date: number }>(
      // tt_check：仅收录已过审主题（ok=1）
      'SELECT tid,last_date FROM bbs_thread WHERE ok = 1 ORDER BY last_date DESC LIMIT 1000',
    )
    .all();
  for (const r of rows.results) {
    entries.push({ loc: `${base}/thread/${r.tid}`, lastmod: isoDate(r.last_date), priority: '0.6' });
  }
  const body = entries
    .map(
      (e) =>
        `<url><loc>${escXml(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}<priority>${e.priority}</priority></url>`,
    )
    .join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
  edgeStore(ctx.req.url, SHARED_UA, xml, SITEMAP_TTL, maybeCtx(c), 'application/xml; charset=utf-8');
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': `public, max-age=${SITEMAP_TTL}`,
    },
  });
}

function headContribution(meta: PageMeta): void {
  const home = createApiT(meta.lang ?? 'zh-cn')('seo.home'); // 面包屑首项随站点语言
  const site = (meta.title || '').trim();
  meta.og['og:title'] = meta.title;
  meta.og['og:url'] = meta.canonical;
  meta.og['og:site_name'] = site;
  meta.og['og:type'] = meta.kind === 'thread' ? 'article' : meta.kind === 'user' ? 'profile' : 'website';
  const e = meta.entity;
  if (meta.kind === 'index') {
    meta.jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: meta.title,
      url: meta.canonical,
    });
  } else if (meta.kind === 'thread' && e?.tid) {
    meta.jsonLd.push(
      {
        '@context': 'https://schema.org',
        '@type': 'DiscussionForumPosting',
        headline: e.seoTitle || meta.title,
        url: meta.canonical,
        datePublished: e.lastDate ? new Date(e.lastDate * 1000).toISOString() : undefined,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: home, item: meta.canonical.replace(/\/thread\/.*$/, '/') },
          { '@type': 'ListItem', position: 2, name: meta.title, item: meta.canonical },
        ],
      },
    );
  } else if (meta.kind === 'forum' && e?.fid !== undefined) {
    meta.jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: home, item: meta.canonical.replace(/\/forum\/.*$/, '/') },
        { '@type': 'ListItem', position: 2, name: meta.title, item: meta.canonical },
      ],
    });
  }
}

/**
 * 后台配置表单 schema（插件自声明，经 /api/admin/extensions 下发）。
 * 键名与 ext:seo:config / ext:seo:secret 一一对应（勿改名）；password 恒为 secret，
 * secret 的 text/textarea（Google 服务账号凭据）必须显式 target:'secret'。
 * indexnowKey 例外存 config（公开值）+ autoGenerate：cron 首推自动生成，setup 据此托管 /{key}.txt。
 */
const SEO_SCHEMA: ExtSchema = {
  brief: L(
    '自动生成 sitemap.xml、JSON-LD 结构化数据与 OG 分享标签，旧 .htm 链接 301 跳转；可选站点验证与每日收录推送。',
    '自動產生 sitemap.xml、JSON-LD 結構化資料與 OG 分享標籤，舊 .htm 連結 301 跳轉；可選站點驗證與每日收錄推送。',
    'Auto-generates sitemap.xml, JSON-LD structured data and OG sharing tags; legacy .htm links 301-redirect. Optional site verification and daily index push.',
    'Автоматически создаёт sitemap.xml, микроразметку JSON-LD и OG-теги; старые ссылки .htm перенаправляет 301-редиректом. Опционально — верификация сайта и ежедневная отправка на индексацию.',
    'สร้าง sitemap.xml, ข้อมูลโครงสร้าง JSON-LD และแท็กแชร์ OG โดยอัตโนมัติ ลิงก์ .htm เก่าเปลี่ยนเส้นทาง 301; เลือกได้ว่าจะยืนยันเว็บไซต์และดันเข้าดัชนีรายวัน',
    'Erzeugt automatisch sitemap.xml, JSON-LD-strukturierte Daten und OG-Sharing-Tags; alte .htm-Links mit 301-Weiterleitung. Optionale Seitenverifizierung und täglicher Index-Push.',
    'sitemap.xml、JSON-LD 構造化データ、OG 共有タグを自動生成し、旧 .htm リンクは 301 リダイレクトします。サイト認証と毎日のインデックス送信は任意。',
    'sitemap.xml, JSON-LD 구조화 데이터, OG 공유 태그를 자동 생성하고 기존 .htm 링크는 301 리디렉션합니다. 사이트 인증과 매일 색인 푸시는 선택 사항.',
    'Genera automáticamente sitemap.xml, datos estructurados JSON-LD y etiquetas OG para compartir; los enlaces .htm antiguos redirigen con 301. Verificación de sitio y envío diario de indexación opcionales.',
    'Génère automatiquement sitemap.xml, les données structurées JSON-LD et les balises de partage OG ; les anciens liens .htm sont redirigés en 301. Vérification de site et pousses d’indexation quotidiennes optionnelles.',
  ),
  intro: L(
    '启用即自动生效：sitemap.xml、JSON-LD 结构化数据、OG 分享标签、.htm 旧链接 301 跳转均无需配置。以下全是**可选增强**，不填不影响使用。',
    '啟用即自動生效：sitemap.xml、JSON-LD 結構化資料、OG 分享標籤、.htm 舊連結 301 跳轉均無需設定。以下全是**可選增強**，不填不影響使用。',
    'Works automatically once enabled: sitemap.xml, JSON-LD, OG tags and .htm 301 redirects need no configuration. Everything below is an **optional enhancement** — leaving it blank has no impact.',
    'Работает сразу после включения: sitemap.xml, JSON-LD, OG-теги и 301-редиректы .htm не требуют настройки. Всё ниже — **необязательные улучшения**, можно не заполнять.',
    'เปิดใช้งานแล้วทำงานทันที: sitemap.xml, JSON-LD, แท็ก OG และการเปลี่ยนเส้นทาง 301 ของ .htm ไม่ต้องตั้งค่า ทั้งหมดด้านล่างเป็น**ส่วนเสริมที่ไม่บังคับ** ไม่กรอกก็ไม่กระทบการใช้งาน',
    'Funktioniert sofort nach der Aktivierung: sitemap.xml, JSON-LD, OG-Tags und .htm-301-Weiterleitungen erfordern keine Konfiguration. Alles unten ist **optionale Erweiterung** — leere Felder sind unproblematisch.',
    '有効化するだけで自動動作します：sitemap.xml、JSON-LD、OG タグ、.htm 旧リンクの 301 リダイレクトは設定不要です。以下はすべて**任意の拡張**で、未入力でも影響ありません。',
    '활성화하면 자동으로 동작합니다: sitemap.xml, JSON-LD, OG 태그, .htm 구 링크 301 리디렉션은 설정이 필요 없습니다. 아래는 모두**선택적 확장**이며, 비워 둬도 영향이 없습니다.',
    'Funciona automáticamente al activarlo: sitemap.xml, JSON-LD, etiquetas OG y las redirecciones 301 de .htm no requieren configuración. Todo lo siguiente es una **mejora opcional**; dejarlo en blanco no afecta.',
    'Fonctionne automatiquement une fois activé : sitemap.xml, JSON-LD, balises OG et redirections 301 des .htm ne nécessitent aucune configuration. Tout ce qui suit est une **amélioration optionnelle** ; laisser vide n’a aucun impact.',
  ),
  fields: [
    {
      key: 'indexnow',
      type: 'switch',
      label: L('IndexNow 推送', 'IndexNow 推送', 'IndexNow push', 'Отправка в IndexNow', 'ดัน IndexNow', 'IndexNow-Push', 'IndexNow 送信', 'IndexNow 푸시', 'Envío a IndexNow', 'Pousse IndexNow'),
      onValue: true,
      offValue: false,
      defaultOn: true,
      help: L(
        '开启后每天自动把近期新帖推送给 IndexNow（Bing/Yandex 等联合接口）。Key 由系统自动生成、验证文件自动托管，无需人工填写。',
        '開啟後每天自動把近期新帖推送給 IndexNow（Bing/Yandex 等聯合介面）。Key 由系統自動產生、驗證檔案自動託管，無需人工填寫。',
        'When enabled, recent threads are pushed daily to IndexNow (the joint API of Bing/Yandex and others). The key is generated automatically and the verification file is hosted automatically — nothing to fill in.',
        'После включения новые темы ежедневно отправляются в IndexNow (единый API Bing/Yandex и др.). Ключ генерируется автоматически, файл верификации размещается автоматически — заполнять ничего не нужно.',
        'เมื่อเปิดใช้งาน ระบบจะดันกระทู้ใหม่ล่าสุดไปที่ IndexNow (API ร่วมของ Bing/Yandex ฯลฯ) ทุกวัน โดยระบบสร้าง Key ให้อัตโนมัติและโฮสต์ไฟล์ยืนยันให้เอง ไม่ต้องกรอก',
        'Nach der Aktivierung werden neue Beiträge täglich an IndexNow (gemeinsame API von Bing/Yandex u. a.) gepusht. Der Schlüssel wird automatisch erzeugt und die Verifizierungsdatei automatisch gehostet — nichts auszufüllen.',
        '有効にすると、最近の新規スレッドを毎日 IndexNow（Bing/Yandex などの共通 API）へ自動送信します。Key は自動生成、検証ファイルも自動ホスティングのため入力不要です。',
        '활성화하면 최근 새 스레드를 매일 IndexNow(Bing/Yandex 등 공동 API)로 자동 푸시합니다. Key는 자동 생성되고 검증 파일도 자동 호스팅되므로 입력할 필요가 없습니다.',
        'Al activarlo, los hilos recientes se envían cada día a IndexNow (API conjunta de Bing/Yandex, etc.). La clave se genera automáticamente y el archivo de verificación se aloja solo; no hay nada que rellenar.',
        'Une fois activé, les sujets récents sont poussés chaque jour vers IndexNow (API commune de Bing/Yandex, etc.). La clé est générée automatiquement et le fichier de vérification hébergé automatiquement — rien à saisir.',
      ),
    },
    {
      key: 'indexnowKey',
      target: 'config',
      type: 'text',
      autoGenerate: true,
      label: L('IndexNow Key（自动生成）', 'IndexNow Key（自動產生）', 'IndexNow key (auto-generated)', 'Ключ IndexNow (создаётся автоматически)', 'IndexNow Key (สร้างอัตโนมัติ)', 'IndexNow-Key (automatisch erzeugt)', 'IndexNow Key（自動生成）', 'IndexNow Key(자동 생성)', 'Clave de IndexNow (generada automáticamente)', 'Clé IndexNow (générée automatiquement)'),
      placeholder: L('无需填写——首次推送时自动生成', '無需填寫——首次推送時自動產生', 'No need to fill in — generated on first push', 'Заполнять не нужно — создаётся при первой отправке', 'ไม่ต้องกรอก — สร้างอัตโนมัติเมื่อดันครั้งแรก', 'Nicht auszufüllen — wird beim ersten Push erzeugt', '入力不要——初回送信時に自動生成', '입력 불필요 — 첫 푸시 시 자동 생성', 'No hace falta rellenarlo — se genera en el primer envío', 'Inutile de remplir — généré lors de la première pousse'),
      help: L(
        'IndexNow 的 Key 是站点自拟字符串（公开可见，验证文件 /{key}.txt 本就公开该值）。留空时系统在首次推送 cron 自动生成 32 位随机值并持久化到 ext:seo:config，同时自动托管 /{key}.txt 供引擎验证。如需在合作引擎后台登记，可复制此值。',
        'IndexNow 的 Key 是站點自擬字串（公開可見，驗證檔案 /{key}.txt 本就公開該值）。留空時系統在首次推送 cron 自動產生 32 位隨機值並持久化到 ext:seo:config，同時自動託管 /{key}.txt 供引擎驗證。如需在合作引擎後台登記，可複製此值。',
        'The IndexNow key is a site-defined string (public by design — the verification file /{key}.txt exposes it anyway). If left blank, the system generates a random 32-char value on the first push cron, persists it in ext:seo:config and hosts /{key}.txt for engine verification. Copy it if you need to register it in a partner engine’s dashboard.',
        'Ключ IndexNow — строка, задаваемая сайтом (публична по определению: файл верификации /{key}.txt и так её раскрывает). Если оставить пустым, система при первом cron-запуске создаст случайное 32-символьное значение, сохранит его в ext:seo:config и автоматически разместит /{key}.txt для верификации. Скопируйте значение, если нужно зарегистрировать его в панели движка-партнёра.',
        'Key ของ IndexNow เป็นสตริงที่ไซต์กำหนดเอง (เป็นค่าสาธารณะอยู่แล้ว เพราะไฟล์ยืนยัน /{key}.txt เปิดเผยค่านี้อยู่แล้ว) หากเว้นว่าง ระบบจะสร้างค่าสุ่ม 32 ตัวอักษรใน cron ดันครั้งแรก เก็บถาวรไว้ที่ ext:seo:config และโฮสต์ /{key}.txt ให้เองสำหรับยืนยันกับเอนจิน หากต้องลงทะเบียนในแผงควบคุมของเอนจินก็คัดลอกค่านี้ไปใช้ได้',
        'Der IndexNow-Schlüssel ist eine seitenspezifische Zeichenkette (öffentlich sichtbar — die Verifizierungsdatei /{key}.txt legt den Wert ohnehin offen). Bleibt er leer, erzeugt das System beim ersten Push-Cron einen 32-stelligen Zufallswert, speichert ihn in ext:seo:config und hostet /{key}.txt automatisch zur Verifizierung. Zum Registrieren im Partner-Dashboard kann der Wert kopiert werden.',
        'IndexNow の Key はサイトが自由に決める文字列です（公開情報です。検証ファイル /{key}.txt 自体がこの値を公開します）。空欄の場合、初回送信 cron で 32 桁のランダム値が自動生成され ext:seo:config に保存され、/{key}.txt も自動ホスティングされます。提携エンジンの管理画面に登録する場合はこの値をコピーしてください。',
        'IndexNow Key는 사이트가 직접 정하는 문자열입니다(공개 값이며, 검증 파일 /{key}.txt 자체가 이 값을 공개합니다). 비워 두면 첫 푸시 cron에서 32자리 무작위 값이 자동 생성되어 ext:seo:config에 저장되고, /{key}.txt도 자동 호스팅됩니다. 제휴 엔진 대시보드에 등록하려면 이 값을 복사하세요.',
        'La clave de IndexNow es una cadena definida por el sitio (pública por diseño: el archivo de verificación /{key}.txt expone ese valor). Si se deja en blanco, el sistema genera un valor aleatorio de 32 caracteres en el primer cron de envío, lo persiste en ext:seo:config y aloja /{key}.txt automáticamente para la verificación. Copia este valor si necesitas registrarlo en el panel de un motor asociado.',
        'La clé IndexNow est une chaîne définie par le site (publique par nature — le fichier de vérification /{key}.txt expose déjà cette valeur). Si elle reste vide, le système génère une valeur aléatoire de 32 caractères lors du premier cron de pousse, la stocke dans ext:seo:config et héberge automatiquement /{key}.txt pour la vérification. Copiez cette valeur si vous devez l’enregistrer dans le tableau de bord d’un moteur partenaire.',
      ),
    },
    {
      key: 'baidu',
      type: 'switch',
      label: L('百度主动推送', '百度主動推送', 'Baidu active push', 'Активная отправка в Baidu', 'ดันเข้า Baidu แบบเชิงรุก', 'Aktiver Baidu-Push', 'Baidu 能動送信', '바이두 능동 푸시', 'Envío activo a Baidu', 'Pousse active vers Baidu'),
      onValue: true,
      offValue: false,
      defaultOn: true,
      help: L(
        '开启后每天自动把近期新帖推送到百度「普通收录」接口。需在下方填入 token，否则自动跳过。',
        '開啟後每天自動把近期新帖推送到百度「普通收錄」介面。需在下方填入 token，否則自動跳過。',
        'When enabled, recent threads are pushed daily to Baidu’s standard indexing API. Requires the token below, otherwise it is skipped automatically.',
        'После включения новые темы ежедневно отправляются в обычный API индексации Baidu. Требуется token ниже, иначе шаг пропускается.',
        'เมื่อเปิดใช้งาน ระบบจะดันกระทู้ใหม่ล่าสุดไปที่ API จัดทำดัชนีทั่วไปของ Baidu ทุกวัน ต้องกรอก token ด้านล่าง มิฉะนั้นจะข้ามโดยอัตโนมัติ',
        'Nach der Aktivierung werden neue Beiträge täglich an die Standard-Indexierungs-API von Baidu gepusht. Erfordert den Token unten, sonst wird der Schritt übersprungen.',
        '有効にすると、最近の新規スレッドを毎日 Baidu の「通常収録」API へ自動送信します。下の token が未入力の場合は自動スキップされます。',
        '활성화하면 최근 새 스레드를 매일 바이두 “일반 수록” API로 자동 푸시합니다. 아래 token 입력이 없으면 자동으로 건너뜁니다.',
        'Al activarlo, los hilos recientes se envían cada día a la API de indexación estándar de Baidu. Requiere el token de abajo; si falta, se omite automáticamente.',
        'Une fois activé, les sujets récents sont poussés chaque jour vers l’API d’indexation standard de Baidu. Nécessite le token ci-dessous, sinon l’étape est ignorée.',
      ),
    },
    {
      key: 'baiduToken',
      target: 'secret',
      type: 'password',
      label: L('百度推送 Token', '百度推送 Token', 'Baidu push token', 'Token отправки Baidu', 'Token ดันเข้า Baidu', 'Baidu-Push-Token', 'Baidu 送信トークン', '바이두 푸시 토큰', 'Token de envío a Baidu', 'Token de pousse Baidu'),
      placeholder: L('百度搜索资源平台的 token，留空保持不变', '百度搜索資源平臺的 token，留空保持不變', 'Token from Baidu Search Resource Platform; leave blank to keep unchanged', 'Token из платформы Baidu Search Resource; оставьте пустым, чтобы не менять', 'Token จาก Baidu Search Resource Platform เว้นว่างเพื่อคงค่าเดิม', 'Token der Baidu Search Resource Platform; leer lassen zum Beibehalten', 'Baidu 検索リソースプラットフォームのトークン。空欄で変更なし', '바이두 서치 리소스 플랫폼의 token, 비워 두면 변경되지 않음', 'Token de la plataforma Baidu Search Resource; dejar en blanco para conservar', 'Token de la plateforme Baidu Search Resource ; laisser vide pour conserver'),
      help: L(
        '登录百度搜索资源平台（ziyuan.baidu.com）→ 普通收录 → API 推送，复制接口地址里的 token= 后那段填入。',
        '登入百度搜索資源平臺（ziyuan.baidu.com）→ 普通收錄 → API 推送，複製介面位址裡 token= 後那段填入。',
        'Log in to Baidu Search Resource Platform (ziyuan.baidu.com) → standard indexing → API push, and paste the part after token= in the endpoint URL.',
        'Войдите на платформу Baidu Search Resource (ziyuan.baidu.com) → обычная индексация → API-отправка, скопируйте часть после token= в адресе интерфейса.',
        'เข้าสู่ระบบ Baidu Search Resource Platform (ziyuan.baidu.com) → จัดทำดัชนีทั่วไป → API ดันเข้า แล้วคัดลอกส่วนหลัง token= ใน URL ของอินเทอร์เฟซมากรอก',
        'Auf der Baidu Search Resource Platform (ziyuan.baidu.com) anmelden → Standard-Indexierung → API-Push, den Teil hinter token= aus der Endpunkt-URL kopieren und einfügen.',
        'Baidu 検索リソースプラットフォーム（ziyuan.baidu.com）にログイン → 通常収録 → API 送信 で、エンドポイント URL の token= 以降の部分をコピーして貼り付けます。',
        '바이두 서치 리소스 플랫폼(ziyuan.baidu.com) 로그인 → 일반 수록 → API 푸시에서 엔드포인트 URL의 token= 뒷부분을 복사해 붙여넣으세요.',
        'Inicia sesión en la plataforma Baidu Search Resource (ziyuan.baidu.com) → indexación estándar → envío por API, y pega la parte posterior a token= en la URL del endpoint.',
        'Connectez-vous à la plateforme Baidu Search Resource (ziyuan.baidu.com) → indexation standard → pousse API, puis collez la partie après token= dans l’URL de l’endpoint.',
      ),
    },
    {
      key: 'bing',
      type: 'switch',
      label: L('Bing API 推送', 'Bing API 推送', 'Bing API push', 'Отправка через Bing API', 'ดันผ่าน Bing API', 'Bing-API-Push', 'Bing API 送信', 'Bing API 푸시', 'Envío por API de Bing', 'Pousse via l’API Bing'),
      onValue: true,
      offValue: false,
      defaultOn: true,
      help: L(
        '开启后每天自动调用 Bing 站长工具的批量提交 API。需在下方填入 API Key，否则自动跳过（IndexNow 已覆盖 Bing 时可不填）。',
        '開啟後每天自動呼叫 Bing 站長工具的批次提交 API。需在下方填入 API Key，否則自動跳過（IndexNow 已覆蓋 Bing 時可不填）。',
        'When enabled, Bing Webmaster Tools’ batch submission API is called daily. Requires the API key below, otherwise skipped (optional if IndexNow already covers Bing).',
        'После включения ежедневно вызывается пакетный API Bing Webmaster Tools. Требуется ключ API ниже, иначе пропуск (необязательно, если Bing уже покрыт IndexNow).',
        'เมื่อเปิดใช้งาน ระบบจะเรียก API ส่งแบบกลุ่มของ Bing Webmaster Tools ทุกวัน ต้องกรอก API Key ด้านล่าง มิฉะนั้นจะข้ามโดยอัตโนมัติ (ถ้า IndexNow ครอบคลุม Bing แล้วไม่กรอกก็ได้)',
        'Nach der Aktivierung wird täglich die Batch-Übermittlungs-API der Bing Webmaster Tools aufgerufen. Erfordert den API-Schlüssel unten, sonst Überspringen (optional, wenn IndexNow Bing bereits abdeckt).',
        '有効にすると、Bing 站長ツールの一括送信 API を毎日呼び出します。下の API Key が必要で、未入力なら自動スキップ（IndexNow で Bing をカバー済みなら不要）。',
        '활성화하면 Bing 웹마스터 도구의 일괄 제출 API를 매일 호출합니다. 아래 API Key 입력이 필요하며 없으면 자동 건너뜁니다(IndexNow가 Bing을 이미 커버하면 생략 가능).',
        'Al activarlo, se llama cada día a la API de envío por lotes de Bing Webmaster Tools. Requiere la clave API de abajo; si falta, se omite (opcional si IndexNow ya cubre Bing).',
        'Une fois activé, l’API de soumission par lots des Bing Webmaster Tools est appelée chaque jour. Nécessite la clé API ci-dessous, sinon ignoré (facultatif si IndexNow couvre déjà Bing).',
      ),
    },
    {
      key: 'bingApiKey',
      target: 'secret',
      type: 'password',
      label: L('Bing API Key', 'Bing API Key', 'Bing API key', 'Ключ Bing API', 'Bing API Key', 'Bing-API-Schlüssel', 'Bing API Key', 'Bing API Key', 'Clave API de Bing', 'Clé API Bing'),
      placeholder: L('Bing 站长工具的 API Key，留空保持不变', 'Bing 站長工具的 API Key，留空保持不變', 'API key from Bing Webmaster Tools; leave blank to keep unchanged', 'Ключ API из Bing Webmaster Tools; оставьте пустым, чтобы не менять', 'API Key จาก Bing Webmaster Tools เว้นว่างเพื่อคงค่าเดิม', 'API-Schlüssel der Bing Webmaster Tools; leer lassen zum Beibehalten', 'Bing 站長ツールの API Key。空欄で変更なし', 'Bing 웹마스터 도구의 API Key, 비워 두면 변경되지 않음', 'Clave API de Bing Webmaster Tools; dejar en blanco para conservar', 'Clé API des Bing Webmaster Tools ; laisser vide pour conserver'),
      help: L(
        '登录 Bing 站长工具（bing.com/webmaster）→ 设置 → API 访问 → API Key 复制填入。注意 API Key 对应站点的 siteUrl 必须与验证站点完全一致。',
        '登入 Bing 站長工具（bing.com/webmaster）→ 設定 → API 存取 → API Key 複製填入。注意 API Key 對應站點的 siteUrl 必須與驗證站點完全一致。',
        'Log in to Bing Webmaster Tools (bing.com/webmaster) → Settings → API access, copy the API key. Note: the key’s siteUrl must exactly match the verified site.',
        'Войдите в Bing Webmaster Tools (bing.com/webmaster) → Настройки → Доступ API, скопируйте ключ. Важно: siteUrl ключа должен полностью совпадать с верифицированным сайтом.',
        'เข้าสู่ระบบ Bing Webmaster Tools (bing.com/webmaster) → การตั้งค่า → การเข้าถึง API แล้วคัดลอก API Key มากรอก หมายเหตุ: siteUrl ของ Key ต้องตรงกับไซต์ที่ยืนยันแล้วทุกประการ',
        'In den Bing Webmaster Tools (bing.com/webmaster) anmelden → Einstellungen → API-Zugriff, API-Schlüssel kopieren. Hinweis: Die siteUrl des Schlüssels muss exakt der verifizierten Seite entsprechen.',
        'Bing 站長ツール（bing.com/webmaster）にログイン → 設定 → API アクセス で API Key をコピーして入力します。Key の siteUrl は検証済みサイトと完全に一致している必要があります。',
        'Bing 웹마스터 도구(bing.com/webmaster) 로그인 → 설정 → API 액세스에서 API Key를 복사해 입력하세요. 주의: Key의 siteUrl은 검증된 사이트와 정확히 일치해야 합니다.',
        'Inicia sesión en Bing Webmaster Tools (bing.com/webmaster) → Configuración → Acceso API, copia la clave API. Ojo: la siteUrl de la clave debe coincidir exactamente con el sitio verificado.',
        'Connectez-vous aux Bing Webmaster Tools (bing.com/webmaster) → Paramètres → Accès API, copiez la clé API. Attention : la siteUrl de la clé doit correspondre exactement au site vérifié.',
      ),
    },
    {
      key: 'google',
      type: 'switch',
      label: L('Google Indexing API 推送', 'Google Indexing API 推送', 'Google Indexing API push', 'Отправка через Google Indexing API', 'ดันผ่าน Google Indexing API', 'Google-Indexing-API-Push', 'Google Indexing API 送信', 'Google Indexing API 푸시', 'Envío por Google Indexing API', 'Pousse via l’API Google Indexing'),
      onValue: true,
      offValue: false,
      defaultOn: true,
      help: L(
        '开启后每天自动通过 Google Indexing API 通知新帖。需在下方填入服务账号凭据，否则自动跳过。Google 官方该接口面向招聘/直播内容，普通页面不保证即时收录，sitemap 仍是主力通道。',
        '開啟後每天自動透過 Google Indexing API 通知新帖。需在下方填入服務帳號憑證，否則自動跳過。Google 官方該介面面向招募/直播內容，普通頁面不保證即時收錄，sitemap 仍是主力通道。',
        'When enabled, new threads are announced daily via the Google Indexing API. Requires the service-account credentials below, otherwise skipped. Google officially targets job postings/livestreams with this API; instant indexing of ordinary pages is not guaranteed — sitemap remains the main channel.',
        'После включения новые темы ежедневно анонсируются через Google Indexing API. Требуются учётные данные сервисного аккаунта ниже, иначе пропуск. Официально API предназначен для вакансий/трансляций; мгновенная индексация обычных страниц не гарантируется — основной канал остаётся sitemap.',
        'เมื่อเปิดใช้งาน ระบบจะแจ้งกระทู้ใหม่ผ่าน Google Indexing API ทุกวัน ต้องกรอกข้อมูลรับรองบัญชีบริการด้านล่าง มิฉะนั้นจะข้ามโดยอัตโนมัติ API นี้ทาง Google ออกแบบมาสำหรับประกาศงาน/ไลฟ์สด หน้าทั่วไปไม่รับประกันว่าจะเข้าดัชนีทันที sitemap ยังเป็นช่องทางหลัก',
        'Nach der Aktivierung werden neue Beiträge täglich über die Google Indexing API gemeldet. Erfordert die Dienstkonto-Zugangsdaten unten, sonst Überspringen. Die API ist offiziell für Stellenanzeigen/Livestreams gedacht; sofortige Indexierung normaler Seiten ist nicht garantiert — der Sitemap bleibt der Hauptkanal.',
        '有効にすると、新規スレッドを毎日 Google Indexing API で通知します。下のサービスアカウント認証情報が必要で、未入力なら自動スキップ。この API は Google 公式には求人/ライブ配信向けで、通常ページの即時インデックスは保証されません。sitemap が主な経路です。',
        '활성화하면 새 스레드를 매일 Google Indexing API로 알립니다. 아래 서비스 계정 자격 증명 입력이 필요하며 없으면 자동 건너뜁니다. 이 API는 Google 공식 기준 채용/라이브 방송용이라 일반 페이지의 즉시 색인은 보장되지 않으며, sitemap이 여전히 주 채널입니다.',
        'Al activarlo, los hilos nuevos se notifican cada día mediante la Google Indexing API. Requiere las credenciales de la cuenta de servicio de abajo; si faltan, se omite. Google destina oficialmente esta API a ofertas de empleo/directos; la indexación instantánea de páginas normales no está garantizada — el sitemap sigue siendo el canal principal.',
        'Une fois activé, les nouveaux sujets sont notifiés chaque jour via l’API Google Indexing. Nécessite les identifiants du compte de service ci-dessous, sinon ignoré. Google destine officiellement cette API aux offres d’emploi/directs ; l’indexation immédiate des pages ordinaires n’est pas garantie — le sitemap reste le canal principal.',
      ),
    },
    {
      key: 'googleClientEmail',
      target: 'secret',
      type: 'text',
      label: L('Google 服务账号邮箱', 'Google 服務帳號信箱', 'Google service-account email', 'Email сервисного аккаунта Google', 'อีเมลบัญชีบริการ Google', 'Google-Dienstkonto-E-Mail', 'Google サービスアカウントのメール', 'Google 서비스 계정 이메일', 'Email de la cuenta de servicio de Google', 'E-mail du compte de service Google'),
      placeholder: L('xxx@yyy.iam.gserviceaccount.com，留空保持不变', 'xxx@yyy.iam.gserviceaccount.com，留空保持不變', 'xxx@yyy.iam.gserviceaccount.com; leave blank to keep unchanged', 'xxx@yyy.iam.gserviceaccount.com; оставьте пустым, чтобы не менять', 'xxx@yyy.iam.gserviceaccount.com เว้นว่างเพื่อคงค่าเดิม', 'xxx@yyy.iam.gserviceaccount.com; leer lassen zum Beibehalten', 'xxx@yyy.iam.gserviceaccount.com。空欄で変更なし', 'xxx@yyy.iam.gserviceaccount.com, 비워 두면 변경되지 않음', 'xxx@yyy.iam.gserviceaccount.com; dejar en blanco para conservar', 'xxx@yyy.iam.gserviceaccount.com ; laisser vide pour conserver'),
      help: L(
        'Google Cloud 建服务账号并开启 Indexing API 后，取服务账号的邮箱（形如 name@project.iam.gserviceaccount.com）。填完需在 Search Console 把该邮箱加为站点所有者。',
        'Google Cloud 建服務帳號並開啟 Indexing API 後，取服務帳號的信箱（形如 name@project.iam.gserviceaccount.com）。填完需在 Search Console 把該信箱加為站點所有者。',
        'After creating a service account in Google Cloud and enabling the Indexing API, take the account’s email (like name@project.iam.gserviceaccount.com). Then add it as a site owner in Search Console.',
        'После создания сервисного аккаунта в Google Cloud и включения Indexing API возьмите его email (вида name@project.iam.gserviceaccount.com). Затем добавьте его как владельца сайта в Search Console.',
        'หลังสร้างบัญชีบริการใน Google Cloud และเปิด Indexing API ให้ใช้อีเมลของบัญชีบริการ (รูปแบบ name@project.iam.gserviceaccount.com) จากนั้นเพิ่มอีเมลนี้เป็นเจ้าของไซต์ใน Search Console',
        'Nach dem Anlegen eines Dienstkontos in Google Cloud und der Aktivierung der Indexing API die E-Mail des Kontos übernehmen (Form name@project.iam.gserviceaccount.com). Anschließend in der Search Console als Seiteninhaber hinzufügen.',
        'Google Cloud でサービスアカウントを作成し Indexing API を有効化したら、そのメール（name@project.iam.gserviceaccount.com 形式）を入力します。入力後、Search Console でそのメールをサイトのオーナーに追加してください。',
        'Google Cloud에서 서비스 계정을 만들고 Indexing API를 활성화한 뒤 해당 계정의 이메일(name@project.iam.gserviceaccount.com 형식)을 입력하세요. 입력 후 Search Console에서 이 이메일을 사이트 소유자로 추가해야 합니다.',
        'Tras crear una cuenta de servicio en Google Cloud y activar la Indexing API, usa el email de la cuenta (formato name@project.iam.gserviceaccount.com). Después añádelo como propietario del sitio en Search Console.',
        'Après avoir créé un compte de service dans Google Cloud et activé l’API Indexing, utilisez l’e-mail du compte (format name@project.iam.gserviceaccount.com). Ajoutez ensuite cet e-mail comme propriétaire du site dans la Search Console.',
      ),
    },
    {
      key: 'googlePrivateKey',
      target: 'secret',
      type: 'textarea',
      rows: 4,
      label: L('Google 服务账号私钥', 'Google 服務帳號私鑰', 'Google service-account private key', 'Приватный ключ сервисного аккаунта Google', 'คีย์ส่วนตัวของบัญชีบริการ Google', 'Privater Schlüssel des Google-Dienstkontos', 'Google サービスアカウントの秘密鍵', 'Google 서비스 계정 개인 키', 'Clave privada de la cuenta de servicio de Google', 'Clé privée du compte de service Google'),
      placeholder: L('-----BEGIN PRIVATE KEY-----…（JSON 密钥文件里的 private_key，整段粘贴），留空保持不变', '-----BEGIN PRIVATE KEY-----…（JSON 金鑰檔案裡的 private_key，整段貼上），留空保持不變', '-----BEGIN PRIVATE KEY-----… (the private_key from the JSON key file, pasted in full); leave blank to keep unchanged', '-----BEGIN PRIVATE KEY-----… (поле private_key из JSON-файла ключа, вставить целиком); оставьте пустым, чтобы не менять', '-----BEGIN PRIVATE KEY-----… (private_key จากไฟล์คีย์ JSON วางทั้งบล็อก) เว้นว่างเพื่อคงค่าเดิม', '-----BEGIN PRIVATE KEY-----… (private_key aus der JSON-Schlüsseldatei, vollständig einfügen); leer lassen zum Beibehalten', '-----BEGIN PRIVATE KEY-----…（JSON キーファイルの private_key を丸ごと貼り付け）。空欄で変更なし', '-----BEGIN PRIVATE KEY-----…(JSON 키 파일의 private_key를 통째로 붙여넣기), 비워 두면 변경되지 않음', '-----BEGIN PRIVATE KEY-----… (el private_key del archivo JSON, pegado completo); dejar en blanco para conservar', '-----BEGIN PRIVATE KEY-----… (le private_key du fichier de clé JSON, collé en entier) ; laisser vide pour conserver'),
      help: L(
        '服务账号 JSON 密钥文件里 private_key 字段的完整内容（含 BEGIN/END 行）。这是敏感凭据，只存加密的私密项且永不回显。',
        '服務帳號 JSON 金鑰檔案裡 private_key 欄位的完整內容（含 BEGIN/END 行）。這是敏感憑證，只存加密的私密項且永不回顯。',
        'The full private_key field from the service account’s JSON key file (including the BEGIN/END lines). This is a sensitive credential — stored only in the encrypted secret store and never displayed back.',
        'Полное содержимое поля private_key из JSON-файла ключа сервисного аккаунта (включая строки BEGIN/END). Чувствительные данные: хранятся только в зашифрованном хранилище и никогда не отображаются обратно.',
        'เนื้อหาเต็มของฟิลด์ private_key จากไฟล์คีย์ JSON ของบัญชีบริการ (รวมบรรทัด BEGIN/END) เป็นข้อมูลรับรองที่อ่อนไหว เก็บในร้านค่าลับแบบเข้ารหัสเท่านั้นและไม่แสดงกลับอีก',
        'Der vollständige Inhalt des Felds private_key aus der JSON-Schlüsseldatei des Dienstkontos (inkl. BEGIN/END-Zeilen). Sensible Zugangsdaten — nur im verschlüsselten Secret-Speicher abgelegt und nie wieder angezeigt.',
        'サービスアカウントの JSON キーファイルにある private_key フィールドの全文（BEGIN/END 行を含む）。機密情報のため、暗号化された秘密項目にのみ保存され、再表示はされません。',
        '서비스 계정 JSON 키 파일의 private_key 필드 전체 내용(BEGIN/END 줄 포함)입니다. 민감한 자격 증명이므로 암호화된 시크릿 저장소에만 저장되며 다시 표시되지 않습니다.',
        'El contenido íntegro del campo private_key del archivo JSON de la cuenta de servicio (incluidas las líneas BEGIN/END). Es una credencial sensible: solo se guarda cifrada en el almacén de secretos y nunca se vuelve a mostrar.',
        'Le contenu intégral du champ private_key du fichier de clé JSON du compte de service (lignes BEGIN/END incluses). Donnée sensible : stockée uniquement chiffrée dans le coffre de secrets et jamais réaffichée.',
      ),
    },
    {
      key: 'verifyMeta',
      type: 'kv',
      label: L('站点验证 meta', '站點驗證 meta', 'Site verification meta', 'Мета-теги верификации сайта', 'meta ยืนยันไซต์', 'Meta zur Seitenverifizierung', 'サイト認証 meta', '사이트 인증 meta', 'Meta de verificación del sitio', 'Méta de vérification du site'),
      keyLabel: L('meta name', 'meta name', 'meta name', 'meta name', 'meta name', 'meta name', 'meta name', 'meta name', 'meta name', 'meta name'),
      valueLabel: L('content', 'content', 'content', 'content', 'content', 'content', 'content', 'content', 'content', 'content'),
      keyPattern: '^[\\w:.-]{1,80}$',
      placeholder: L('如 google-site-verification', '如 google-site-verification', 'e.g. google-site-verification', 'напр. google-site-verification', 'เช่น google-site-verification', 'z. B. google-site-verification', '例: google-site-verification', '예: google-site-verification', 'p. ej. google-site-verification', 'p. ex. google-site-verification'),
      help: L(
        '各搜索引擎站长平台验证站点时选「HTML 标签」方式，把给出的 <meta> 的 name 和 content 分别填成一行。保存后该 meta 会注入全站 <head>。',
        '各搜尋引擎站長平臺驗證站點時選「HTML 標籤」方式，把給出的 <meta> 的 name 和 content 分別填成一行。儲存後該 meta 會注入全站 <head>。',
        'In each search engine’s webmaster platform choose the “HTML tag” verification method and enter the <meta>’s name and content, one pair per row. After saving, the meta is injected into every page’s <head>.',
        'В панели вебмастера каждого поисковика выберите способ «HTML-тег» и внесите name и content выданного <meta> по одной паре в строке. После сохранения мета-тег добавляется в <head> всех страниц.',
        'ในแพลตฟอร์มเว็บมาสเตอร์ของเสิร์ชเอนจินแต่ละตัว เลือกวิธียืนยันแบบ “HTML tag” แล้วกรอก name และ content ของ <meta> ที่ได้ คู่ละหนึ่งแถว บันทึกแล้วระบบจะแทรก meta นี้ลงใน <head> ของทุกหน้า',
        'Wählen Sie in der Webmaster-Plattform jeder Suchmaschine die Methode „HTML-Tag“ und tragen Sie name und content des gelieferten <meta> je Zeile ein. Nach dem Speichern wird das Meta in den <head> aller Seiten injiziert.',
        '各検索エンジンのサーチコンソールで「HTML タグ」認証を選び、発行された <meta> の name と content を 1 行に 1 組ずつ入力します。保存すると全ページの <head> に注入されます。',
        '각 검색 엔진 웹마스터 플랫폼에서 “HTML 태그” 인증 방식을 선택하고 발급된 <meta>의 name과 content를 한 줄에 한 쌍씩 입력하세요. 저장하면 모든 페이지의 <head>에 주입됩니다.',
        'En la plataforma para webmasters de cada buscador elige la verificación por «etiqueta HTML» e introduce el name y content del <meta>, un par por línea. Al guardar, la meta se inyecta en el <head> de todas las páginas.',
        'Dans la plateforme pour webmasters de chaque moteur, choisissez la vérification par « balise HTML » et saisissez le name et le content du <meta>, une paire par ligne. Après enregistrement, la méta est injectée dans le <head> de toutes les pages.',
      ),
    },
    {
      key: 'verifyFiles',
      type: 'kv',
      label: L('站点验证文件', '站點驗證檔案', 'Site verification files', 'Файлы верификации сайта', 'ไฟล์ยืนยันไซต์', 'Verifizierungsdateien', 'サイト認証ファイル', '사이트 인증 파일', 'Archivos de verificación del sitio', 'Fichiers de vérification du site'),
      keyLabel: L('验证文件名', '驗證檔名', 'file name', 'имя файла', 'ชื่อไฟล์', 'Dateiname', 'ファイル名', '파일 이름', 'nombre del archivo', 'nom du fichier'),
      valueLabel: L('文件内容', '檔案內容', 'file content', 'содержимое', 'เนื้อหาไฟล์', 'Dateiinhalt', 'ファイル内容', '파일 내용', 'contenido del archivo', 'contenu du fichier'),
      keyPattern: SAFE_FILE.source,
      placeholder: L('如 googleabc123.html', '如 googleabc123.html', 'e.g. googleabc123.html', 'напр. googleabc123.html', 'เช่น googleabc123.html', 'z. B. googleabc123.html', '例: googleabc123.html', '예: googleabc123.html', 'p. ej. googleabc123.html', 'p. ex. googleabc123.html'),
      help: L(
        '站长平台选「HTML 文件」验证方式：把下载文件的文件名与文件内容分别填成一行，站点会自动托管该路径供平台回访。文件名仅允许字母数字点下划线连字符。',
        '站長平臺選「HTML 檔案」驗證方式：把下載檔案的檔名與檔案內容分別填成一行，站點會自動託管該路徑供平臺回訪。檔名僅允許字母數字點下劃線連字號。',
        'Choose the “HTML file” verification method in the webmaster platform: enter the downloaded file’s name and content, one pair per row; the site hosts that path automatically for the platform to fetch. File names allow letters, digits, dots, underscores and hyphens only.',
        'Выберите в панели вебмастера способ «HTML-файл»: внесите имя и содержимое скачанного файла по одной паре в строке — сайт автоматически разместит этот путь для проверки платформой. В имени файла допустимы буквы, цифры, точка, подчёркивание и дефис.',
        'เลือกวิธียืนยันแบบ “HTML file” ในแพลตฟอร์มเว็บมาสเตอร์ แล้วกรอกชื่อไฟล์และเนื้อหาไฟล์ที่ดาวน์โหลดมา คู่ละหนึ่งแถว ไซต์จะโฮสต์พาธนั้นให้เองเพื่อให้แพลตฟอร์มเข้ามาตรวจ ชื่อไฟล์อนุญาตเฉพาะตัวอักษร ตัวเลข จุด ขีดล่าง และขีดกลาง',
        'Wählen Sie in der Webmaster-Plattform die Verifizierung per „HTML-Datei“: Namen und Inhalt der heruntergeladenen Datei je Zeile eintragen — die Seite hostet diesen Pfad automatisch, damit die Plattform ihn abrufen kann. Dateinamen erlauben nur Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich.',
        'サーチコンソールで「HTML ファイル」認証を選んだ場合は、ダウンロードしたファイルの名前と内容を 1 行に 1 組ずつ入力します。サイトがそのパスを自動ホスティングし、プラットフォームが取得できます。ファイル名は英数字・ドット・アンダースコア・ハイフンのみ使用できます。',
        '웹마스터 플랫폼에서 “HTML 파일” 인증 방식을 선택했다면, 다운로드한 파일의 이름과 내용을 한 줄에 한 쌍씩 입력하세요. 사이트가 해당 경로를 자동 호스팅하여 플랫폼이 접근합니다. 파일 이름은 영숫자, 점, 밑줄, 하이픈만 허용됩니다.',
        'Elige la verificación por «archivo HTML» en la plataforma para webmasters: introduce el nombre y el contenido del archivo descargado, un par por línea; el sitio aloja esa ruta automáticamente para que la plataforma la consulte. Los nombres solo admiten letras, dígitos, puntos, guiones bajos y guiones.',
        'Choisissez la vérification par « fichier HTML » dans la plateforme pour webmasters : saisissez le nom et le contenu du fichier téléchargé, une paire par ligne ; le site héberge automatiquement ce chemin pour que la plateforme le consulte. Les noms de fichiers n’admettent que lettres, chiffres, points, tirets bas et traits d’union.',
      ),
    },
  ],
};

export const seoPlugin: ExtensionModule = {
  manifest: {
    id: 'seo',
    name: L('SEO 收录增强', 'SEO 收錄增強', 'SEO Extension', 'SEO-расширение', 'ส่วนขยาย SEO', 'SEO-Erweiterung', 'SEO 拡張', 'SEO 확장', 'Extensión SEO', 'Extension SEO'),
    version: '1.0.0',
    installed: 1,
    enable: 1, // 出厂启用（§15.5）；kv extensions 可停用，核心保底不受影响
  },
  schema: SEO_SCHEMA,
  setup(api: ExtensionApi) {
    api.registerRoute('GET', '/sitemap.xml', sitemapXml);
    api.registerRoute('GET', '*.htm', async (c) => {
      const ctx = c as {
        get: (k: string) => unknown;
        env: { SITE_URL?: string };
        req: { url: string; path: string };
      };
      const target = mapLegacyPath(ctx.req.path);
      // 旧链 301 也跳主域名：登录态 host-only + SEO 唯一地址，避免备用域继续产出重复链接
      const setting = await loadSetting(ctx.get('cache') as Cache, ctx.get('db') as D1b);
      return new Response(null, { status: 301, headers: { location: `${canonicalBase(ctx, setting)}${target}` } });
    });
    // {SITE_URL} 占位由核心 robots 路由请求期替换（装配引擎归核心）
    api.contributeRobots(20, ['Sitemap: {SITE_URL}/sitemap.xml']);
    api.contributeHead(headContribution);
    api.contributeBootstrap((ext) => {
      ext['seo'] = { sitemap: 1 };
    });

    // —— 二期（T4-5）：站点验证 + 主动推送，配置来自 ext:seo:config（同步预载）——
    const cfg = api.config;
    const verifyMeta = (cfg.verifyMeta ?? {}) as Record<string, unknown>;
    const metaPairs = Object.entries(verifyMeta)
      .map(([k, v]) => ({ name: String(k), content: String(v) }))
      .filter((p) => /^[\w:.-]{1,80}$/.test(p.name) && p.content);
    if (metaPairs.length) {
      api.contributeHead((meta: PageMeta) => {
        for (const p of metaPairs) {
          const tag = `<meta name="${escAttr(p.name)}" content="${escAttr(p.content)}">`;
          if (!meta.head.includes(tag)) meta.head.push(tag);
        }
      });
    }
    const verifyFiles = (cfg.verifyFiles ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(verifyFiles)) {
      if (!SAFE_FILE.test(name)) continue; // 拒绝非法文件名，杜绝穿越
      const content = String(value ?? '');
      if (!content) continue;
      api.registerRoute('GET', `/${name}`, () => new Response(content, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    }
    // IndexNow key 验证文件自动托管（引擎回访 /{key}.txt 校验站点所有权）：key 来自 config（自动生成/手动自拟皆可），
    // 校验合法格式后按精确路径注册——插件路由仅在核心 404 后接管，不与 robots.txt/llms.txt 冲突。
    const indexnowKey = String(cfg.indexnowKey ?? '');
    if (INDEXNOW_KEY_RE.test(indexnowKey)) {
      api.registerRoute('GET', `/${indexnowKey}.txt`, () =>
        new Response(indexnowKey, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
      );
    }
    api.registerCron(makePushCron(api.ctx, cfg));
  },
};

/** 近段更新主题的绝对 URL 列表（供 IndexNow/百度推送；仅可读版块 + 主题详情，≤2000 条） */
async function recentThreadUrls(db: D1b, cache: Cache, base: string, sinceTs: number): Promise<string[]> {
  const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
  const visible = forumListAccessFilter(forumlist, 0, grouplist);
  const rows = await db
    .prepare<{ tid: number; fid: number }>(
      // tt_check：仅推送已过审主题（ok=1）
      'SELECT tid,fid FROM bbs_thread WHERE last_date > ? AND ok = 1 ORDER BY last_date DESC LIMIT 2000',
    )
    .bind(sinceTs)
    .all();
  return rows.results.filter((r) => visible[r.fid] !== undefined).map((r) => `${base}/thread/${r.tid}`);
}

/** PEM 私钥（PKCS#8）→ RS256 签名的 JWT（Google 服务账号 OAuth2 用） */
async function signJwtRs256(privateKeyPem: string, claims: Record<string, unknown>): Promise<string> {
  const enc = new TextEncoder();
  const b64u = (buf: ArrayBuffer | Uint8Array): string => {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const der = Uint8Array.from(
    atob(privateKeyPem.replace(/-----[^\n-]+-----/g, '').replace(/\s+/g, '')),
    (ch) => ch.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = b64u(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${payload}`));
  return `${head}.${payload}.${b64u(sig)}`;
}

function makePushCron(
  ctx: ExtensionCtx | undefined,
  config: Record<string, unknown>,
): { pattern: string; name: string; run: (c: CronRunContext) => Promise<void> } {
  return {
    pattern: CRON_DAILY, // 复用每日档触发器（§14 未新增 wrangler 触发）；表达式取自 core/cron-schedule
    name: 'seo:index_push',
    async run(cron: CronRunContext): Promise<void> {
      const db = ctx?.db;
      const cache = ctx?.cache;
      const env = ctx?.env;
      if (!db || !cache) return; // 无请求态上下文（装配期未注入）→ 短路
      // 主域名取后台「站点网址」优先（多域名部署），SITE_URL 兜底；都未配置则不推送（避免推错域名）
      const setting = await loadSetting(cache, db);
      const base = canonicalBaseFromSetting(setting, env);
      if (!base) return;
      const host = new URL(base).host;
      const since = cron.now - Math.max(1, cron.sinceLastSec);
      const urls = await recentThreadUrls(db, cache, base, since);
      if (!urls.length) return;
      const secret = await loadExtSecret(db, 'seo', env?.SECRETS_MASTER_KEY);
      // IndexNow（key 公开可见，存 ext:seo:config；缺失时自动生成并持久化——管理员零配置）。
      // 一份 key 覆盖 Bing/Yandex/Seznam/Naver 等所有 IndexNow 成员引擎；secret 里的存量旧 key 自动迁移到 config。
      const cfg = config;
      /** 本次未被引擎接受的部分：非空则抛错 → core/cron.ts 不推进水位，下轮重覆盖同一窗口（避免静默丢弃） */
      const failures: string[] = [];
      let anyConfigured = false;
      if (cfg.indexnow !== false) {
        let indexnowKey = String(cfg.indexnowKey ?? '');
        if (!INDEXNOW_KEY_RE.test(indexnowKey)) {
          const legacy = String(secret.indexnowKey ?? '');
          indexnowKey = INDEXNOW_KEY_RE.test(legacy) ? legacy : generateIndexNowKey();
          await saveExtConfig(db, cache, 'seo', { ...config, indexnowKey });
          config.indexnowKey = indexnowKey; // 闭包同步：本次推送立即生效，验证文件下次请求即托管
          console.log('[seo:push] indexnow key auto-provisioned');
        }
        anyConfigured = true;
        // IndexNow 规范单次上限 10000 条，本站清单上界 2000 → 单请求即可，无需分片
        try {
          const r = await fetch(INDEXNOW_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ host, key: indexnowKey, urlList: urls }),
          });
          console.log(`[seo:push] indexnow urls=${urls.length} status=${r.status}`);
          if (!r.ok) failures.push(`indexnow:${r.status}`);
        } catch (e) {
          failures.push('indexnow:network');
          console.warn('[seo:push] indexnow failed:', (e as Error).message);
        }
      }
      // 百度普通收录推送（token 存 ext:seo:secret；单次条数由百度侧按当日配额裁定，超出部分体现在返回体 remain）
      const baiduToken = String(secret.baiduToken ?? '');
      if (baiduToken && cfg.baidu !== false) {
        anyConfigured = true;
        try {
          const r = await fetch(`http://data.zz.baidu.com/urls?site=${encodeURIComponent(host)}&token=${encodeURIComponent(baiduToken)}`, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: urls.join('\n'),
          });
          console.log(`[seo:push] baidu urls=${urls.length} status=${r.status}`);
          if (!r.ok) failures.push(`baidu:${r.status}`);
        } catch (e) {
          failures.push('baidu:network');
          console.warn('[seo:push] baidu failed:', (e as Error).message);
        }
      }
      // Bing Webmaster 批量提交（API key 存 ext:seo:secret；siteUrl 必须与站长平台验证站点一致）。
      // SubmitUrlBatch 对单次条数有上限（远小于本站清单上界 2000），超出整批被拒 → 按 BING_PUSH_CHUNK 分片。
      const bingApiKey = String(secret.bingApiKey ?? '');
      if (bingApiKey && cfg.bing !== false) {
        anyConfigured = true;
        const batches = chunk(urls, BING_PUSH_CHUNK);
        let accepted = 0;
        let failedBatches = 0;
        for (const batch of batches) {
          try {
            const r = await fetch(`${BING_SUBMIT_ENDPOINT}?apikey=${encodeURIComponent(bingApiKey)}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ siteUrl: base, urlList: batch }),
            });
            if (r.ok) accepted += batch.length;
            else failedBatches++;
          } catch (e) {
            failedBatches++;
            console.warn('[seo:push] bing batch failed:', (e as Error).message);
          }
        }
        console.log(`[seo:push] bing batches=${batches.length} accepted=${accepted}/${urls.length} failedBatches=${failedBatches}`);
        if (failedBatches) failures.push(`bing:${failedBatches}/${batches.length}`);
      }
      // Google Indexing API（服务账号 client email + PKCS#8 私钥存 ext:seo:secret）。
      // 该接口不支持批量（1 URL/请求），条数上限由子请求预算推导 → GOOGLE_PUSH_LIMIT。
      const googleClientEmail = String(secret.googleClientEmail ?? '');
      const googlePrivateKey = String(secret.googlePrivateKey ?? '');
      if (googleClientEmail && googlePrivateKey && cfg.google !== false) {
        anyConfigured = true;
        try {
          const now = Math.floor(Date.now() / 1000);
          const assertion = await signJwtRs256(googlePrivateKey, {
            iss: googleClientEmail,
            scope: 'https://www.googleapis.com/auth/indexing',
            aud: GOOGLE_TOKEN_ENDPOINT,
            iat: now,
            exp: now + 3600,
          });
          const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
          });
          const accessToken = String(((await tokenRes.json()) as { access_token?: unknown }).access_token ?? '');
          if (!accessToken) {
            failures.push(`google:token:${tokenRes.status}`);
            console.warn(`[seo:push] google token exchange failed status=${tokenRes.status}`);
          } else {
            const gUrls = urls.slice(0, GOOGLE_PUSH_LIMIT);
            let ok = 0;
            let failed = 0;
            let lastReason = '';
            for (const u of gUrls) {
              try {
                const r = await fetch(GOOGLE_INDEX_ENDPOINT, {
                  method: 'POST',
                  headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
                  body: JSON.stringify({ url: u, type: 'URL_UPDATED' }),
                });
                if (r.ok) ok++;
                else {
                  failed++;
                  lastReason = `status=${r.status}`;
                }
              } catch (e) {
                // 单条失败不中断余下推送；原因计入末尾汇总（此前是空 catch，失败被完全吞掉）
                failed++;
                lastReason = (e as Error).message.slice(0, 80);
              }
            }
            console.log(
              `[seo:push] google ok=${ok}/${gUrls.length} failed=${failed} limit=${GOOGLE_PUSH_LIMIT}${lastReason ? ` last=${lastReason}` : ''}`,
            );
            if (failed) failures.push(`google:${failed}/${gUrls.length}`);
            // 预算上限导致的截断：不判为失败（否则水位永不推进、窗口无限增长，且每天都只会重推最新的同一批），
            // 但必须显式记日志，避免「推送数悄悄变少」不可见。
            if (urls.length > gUrls.length) {
              console.log(
                `[seo:push] google truncated: pushed=${gUrls.length}/${urls.length} (subrequest budget ${SUBREQUEST_HARD_LIMIT}; Google Indexing API accepts one URL per call)`,
              );
            }
          }
        } catch (e) {
          failures.push('google');
          console.warn('[seo:push] google failed:', (e as Error).message);
        }
      }
      if (!anyConfigured) {
        console.log(`[seo:push] pending urls=${urls.length} (no search-engine credentials configured)`);
        return; // 未配置任何引擎不算失败，照常推进水位
      }
      /* 有引擎配置但未被全部接受 → 抛错：core/cron.ts 的失败隔离会记录它并跳过水位推进，
         下轮仍覆盖同一窗口（与 cronMarkRun 的既有语义一致），从而不会把 URL 永久跳过。 */
      if (failures.length) throw new Error(`${failures.join('; ')} (urls=${urls.length} since=${since})`);
    },
  };
}
