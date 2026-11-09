/**
 * mcp 插件：把论坛能力以 MCP（Model Context Protocol）暴露给 AI 客户端。
 *
 * 定位：本插件只做「协议 + 鉴权 + 出口」，具体能力由各插件经契约 ⑨ 贡献
 * （contributeMcpTool / contributeMcpResource），因此新增能力不需要改这个文件。
 *
 * 装配要点（与核心中间件链的三处硬约束，改任何一处都会让 /mcp 失效）：
 *  1. 路径必须是 `/mcp` 而非 `/api/mcp`：契约 ③ registerRoute 只接管非 /api 路径，
 *     且 csrf 只校验 /api/*（MCP 客户端没有 cookie，走不到双提交）；
 *  2. runlevel 对 /mcp 豁免（它没有 cookie，loadViewer 判不出身份）——
 *     档位语义在 auth.runlevelDeny 里复刻，保证「站点只读 → AI 也写不进来」；
 *  3. 出厂 enable=0：没配令牌前不暴露任何入口；启用后仍需令牌才能调用。
 *
 * 无状态：不发 Mcp-Session-Id、不落会话、不用 Durable Object —— 一次 POST 一次响应，
 * 免费层不产生任何长连接时长与额外计费资源。
 */
import { L } from '../../core/i18n';
import type { ExtSchema } from '@freeidx/shared';
import { getExtensions } from '../../core/extensions';
import type { ExtensionApi, ExtensionModule } from '../../core/extensions/registry';
import type { Cache } from '../../core/cache';
import type { D1b } from '../../core/db';
import type { Env } from '../../types/env';
import { loadSetting } from '../../core/loaders';
import { CRON_DAILY } from '../../core/cron-schedule';
import {
  allowRequest,
  approvalDeny,
  authenticate,
  banDeny,
  ipFingerprint,
  runlevelDeny,
  shouldTouch,
  touchToken,
  unauthorized,
} from './auth';
import { MCP_PROTOCOL_VERSION, RPC_ERROR, rpcError } from './protocol';
import { dispatchBatch, parseConfig, type DispatchDeps, type McpConfig } from './server';
import { CORE_MCP_RESOURCES, CORE_MCP_TOOLS } from './tools';
import { MCP_FORUM_TOOL_NAMES, MCP_FORUM_TOOLS } from './forum';
import { MCP_WRITE_TOOLS } from './write';
import { ipToLong } from '../../core/auth/session';
import type { ApiT } from '../../core/i18n';

/** 请求体上限：MCP 参数都是短文本，256KB 足够且能挡住内存放大攻击 */
const MAX_BODY = 256 * 1024;

const MCP_SCHEMA: ExtSchema = {
  brief: L(
    '把论坛内容以 MCP 协议提供给 AI 客户端（Claude Desktop / Cursor 等），工具能力受令牌与权限引擎双重约束。',
    '把論壇內容以 MCP 協定提供給 AI 用戶端（Claude Desktop / Cursor 等），工具能力受權杖與權限引擎雙重約束。',
    'Expose forum content to AI clients (Claude Desktop, Cursor…) over MCP, with every tool gated by token scope and the permission engine.',
    'Открывает содержимое форума AI-клиентам (Claude Desktop, Cursor…) по протоколу MCP; каждый инструмент ограничен правами токена и движком доступа.',
    'เปิดเนื้อหาฟอรัมให้ไคลเอนต์ AI (Claude Desktop, Cursor…) ผ่าน MCP โดยทุกเครื่องมือถูกจำกัดด้วยสิทธิ์โทเคนและระบบสิทธิ์ของเว็บ',
    'Stellt Foreninhalte KI-Clients (Claude Desktop, Cursor…) über MCP bereit; jedes Werkzeug ist durch Token-Rechte und die Rechte-Engine begrenzt.',
    'フォーラムの内容を MCP 経由で AI クライアント（Claude Desktop / Cursor など）に提供します。各ツールはトークン権限と権限エンジンの二重制約下にあります。',
    '포럼 콘텐츠를 MCP로 AI 클라이언트(Claude Desktop, Cursor 등)에 제공합니다. 모든 도구는 토큰 권한과 권한 엔진의 이중 제약을 받습니다.',
    'Expone el contenido del foro a clientes de IA (Claude Desktop, Cursor…) mediante MCP; cada herramienta queda limitada por el token y el motor de permisos.',
    'Expose le contenu du forum aux clients IA (Claude Desktop, Cursor…) via MCP ; chaque outil est encadré par les droits du jeton et le moteur de permissions.',
  ),
  intro: L(
    '启用后，在下方「访问令牌」区域创建令牌，把它填入 AI 客户端的 MCP 配置即可（地址：本站 /mcp，请求头 Authorization: Bearer <令牌>）。令牌只在创建时显示一次；工具始终按令牌持有者的真实版块权限、审核状态与付费墙过滤，写类工具默认全部关闭。停用插件即刻关闭入口，无需部署。',
    '啟用後，在下方「存取權杖」區域建立權杖，將它填入 AI 用戶端的 MCP 設定即可（位址：本站 /mcp，標頭 Authorization: Bearer <權杖>）。權杖僅在建立時顯示一次；工具始終依權杖持有者的真實版塊權限、審核狀態與付費牆過濾，寫入類工具預設全部關閉。停用外掛即刻關閉入口，無需部署。',
    'Once enabled, create a token in the "Access tokens" section below and paste it into your AI client MCP config (endpoint: this site /mcp, header Authorization: Bearer <token>). The token is shown only once; tools always follow the owner real forum permissions, moderation state and paywall, and write tools stay disabled by default. Disabling the plugin closes the endpoint immediately without redeploy.',
    'После включения создайте токен в блоке «Токены доступа» ниже и вставьте его в настройки MCP вашего AI-клиента (адрес: /mcp этого сайта, заголовок Authorization: Bearer <токен>). Токен показывается только один раз; инструменты всегда учитывают реальные права владельца, статус модерации и платный контент, а инструменты записи по умолчанию отключены. Отключение плагина сразу закрывает точку входа без переразвёртывания.',
    'เมื่อเปิดใช้งาน ให้สร้างโทเคนในส่วน "โทเคนการเข้าถึง" ด้านล่าง แล้วใส่ในคอนฟิก MCP ของไคลเอนต์ AI (ปลายทาง: /mcp ของไซต์นี้, หัวข้อ Authorization: Bearer <โทเคน>) โทเคนจะแสดงเพียงครั้งเดียว เครื่องมือจะยึดสิทธิ์บอร์ด สถานะตรวจสอบ และเพย์วอลล์จริงของผู้ถือเสมอ และเครื่องมือเขียนถูกปิดโดยค่าเริ่มต้น การปิดปลั๊กอินจะปิดปลายทางทันทีโดยไม่ต้องดีพลอย',
    'Nach dem Aktivieren erstellen Sie unten im Bereich „Zugriffstoken“ ein Token und tragen es in die MCP-Konfiguration Ihres KI-Clients ein (Endpunkt: /mcp dieser Site, Header Authorization: Bearer <Token>). Das Token wird nur einmal angezeigt; Werkzeuge folgen stets den echten Forenrechten, dem Moderationsstatus und der Bezahlschranke des Inhabers, Schreibwerkzeuge bleiben standardmäßig aus. Deaktivieren schließt den Endpunkt sofort ohne Redeploy.',
    '有効にしたら、下の「アクセストークン」でトークンを作成し、AI クライアントの MCP 設定に貼り付けます（エンドポイント: 本サイトの /mcp、ヘッダー Authorization: Bearer <トークン>）。トークンは作成時に一度だけ表示されます。ツールは常にトークン所有者の実際のフォーラム権限・審査状態・ペイウォールに従い、書き込み系ツールは既定で無効です。プラグインを無効化するとデプロイなしで即座に入口が閉じます。',
    '활성화한 뒤 아래 "액세스 토큰"에서 토큰을 만들어 AI 클라이언트의 MCP 설정에 붙여넣으세요(엔드포인트: 이 사이트의 /mcp, 헤더 Authorization: Bearer <토큰>). 토큰은 생성 시 한 번만 표시됩니다. 도구는 항상 토큰 소유자의 실제 게시판 권한, 심사 상태, 유료 장벽을 따르며 쓰기 도구는 기본적으로 꺼져 있습니다. 플러그인을 비활성화하면 재배포 없이 즉시 입구가 닫힙니다.',
    'Tras activarlo, cree un token en la sección «Tokens de acceso» y péguelo en la configuración MCP de su cliente de IA (endpoint: /mcp de este sitio, cabecera Authorization: Bearer <token>). El token se muestra una sola vez; las herramientas respetan siempre los permisos reales del propietario, el estado de moderación y el muro de pago, y las de escritura están desactivadas por defecto. Desactivar el plugin cierra el endpoint al instante sin desplegar.',
    'Une fois activé, créez un jeton dans la section « Jetons d’accès » ci-dessous et collez-le dans la configuration MCP de votre client IA (point d’entrée : /mcp du site, en-tête Authorization: Bearer <jeton>). Le jeton n’est affiché qu’une fois ; les outils respectent toujours les droits réels du propriétaire, l’état de modération et le paywall, et les outils d’écriture restent désactivés par défaut. Désactiver le plugin ferme immédiatement l’accès, sans redéploiement.',
  ),
  fields: [
    {
      key: 'enabledScopes',
      type: 'text',
      label: L(
        '开放档位', '開放檔位', 'Enabled scopes', 'Разрешённые уровни', 'ระดับที่เปิด', 'Freigegebene Stufen', '公開レベル', '허용 범위', 'Niveles habilitados', 'Niveaux autorisés',
      ),
      placeholder: L('read', 'read', 'read', 'read', 'read', 'read', 'read', 'read', 'read', 'read'),
      help: L(
        '逗号分隔：read=只读，write=含写入，admin=含版务。写类工具需同时满足令牌档位，默认只开 read。',
        '逗號分隔：read=唯讀，write=含寫入，admin=含版務。寫入類工具需同時滿足權杖檔位，預設只開 read。',
        'Comma separated: read = read-only, write = allow writes, admin = allow moderation. Write tools also require the token scope; read only by default.',
        'Через запятую: read — только чтение, write — запись, admin — модерация. Инструменты записи дополнительно требуют уровень токена; по умолчанию только read.',
        'คั่นด้วยจุลภาค: read=อ่านอย่างเดียว, write=อนุญาตเขียน, admin=อนุญาตจัดการ เครื่องมือเขียนต้องมีระดับของโทเคนด้วย ค่าเริ่มต้นเปิดเฉพาะ read',
        'Kommagetrennt: read = nur lesen, write = Schreiben erlauben, admin = Moderation erlauben. Schreibwerkzeuge brauchen zusätzlich die Token-Stufe; standardmäßig nur read.',
        'カンマ区切り: read=読み取りのみ、write=書き込み可、admin=モデレーション可。書き込み系はトークンのレベルも必要です。既定は read のみ。',
        '쉼표 구분: read=읽기 전용, write=쓰기 허용, admin=관리 허용. 쓰기 도구는 토큰 범위도 충족해야 하며 기본값은 read만.',
        'Separado por comas: read = solo lectura, write = permitir escritura, admin = permitir moderación. Las herramientas de escritura también requieren el token; por defecto solo read.',
        'Séparés par des virgules : read = lecture seule, write = écriture autorisée, admin = modération autorisée. Les outils d’écriture exigent aussi le niveau du jeton ; read seul par défaut.',
      ),
    },
    {
      key: 'forumWriteOn',
      type: 'switch',
      label: L(
        '允许修改版块文案',
        '允許修改版塊文案',
        'Allow forum text editing',
        'Разрешить правку текстов разделов',
        'อนุญาตแก้ไขข้อความบอร์ด',
        'Forumtexte bearbeiten erlauben',
        'フォーラム文案の編集を許可',
        '게시판 문구 수정 허용',
        'Permitir editar textos del foro',
        'Autoriser la modification des textes du forum',
      ),
      onValue: 1,
      offValue: 0,
      defaultOn: false,
      help: L(
        '打开后，具备 admin 档位的管理员令牌可调用 forum_get / forum_update 读写版块简介、公告、SEO 标题与关键词（含多语言）。需同时把「开放档位」设为含 admin；默认关闭。',
        '開啟後，具備 admin 檔位的管理員權杖可呼叫 forum_get / forum_update 讀寫版塊簡介、公告、SEO 標題與關鍵詞（含多語言）。需同時把「開放檔位」設為含 admin；預設關閉。',
        'When on, an administrator token with the admin scope may call forum_get / forum_update to read and edit forum brief, announcement, SEO title and keywords (including translations). "Enabled scopes" must also include admin; off by default.',
        'Если включено, токен администратора с уровнем admin может вызывать forum_get / forum_update для чтения и правки описания, объявления, SEO-заголовка и ключевых слов раздела (включая переводы). В «Разрешённых уровнях» должен быть admin; по умолчанию выключено.',
        'เมื่อเปิด โทเคนผู้ดูแลที่มีระดับ admin จะเรียก forum_get / forum_update เพื่ออ่านและแก้ไขคำอธิบาย ประกาศ SEO title และ keywords ของบอร์ด (รวมหลายภาษา) ได้ ต้องตั้ง "ระดับที่เปิด" ให้มี admin ด้วย ค่าเริ่มต้นปิด',
        'Wenn aktiv, darf ein Admin-Token mit Stufe admin forum_get / forum_update aufrufen, um Kurzbeschreibung, Ankündigung, SEO-Titel und Keywords (inkl. Übersetzungen) zu lesen und zu ändern. „Freigegebene Stufen“ muss admin enthalten; standardmäßig aus.',
        'オンの場合、admin レベルの管理者トークンが forum_get / forum_update でフォーラムの概要・告知・SEO タイトル・キーワード（多言語含む）を読み書きできます。「公開レベル」にも admin が必要です。既定はオフ。',
        '켜면 admin 범위의 관리자 토큰이 forum_get / forum_update로 게시판 설명, 공지, SEO 제목, 키워드(다국어 포함)를 읽고 수정할 수 있습니다. "허용 범위"에도 admin이 있어야 하며 기본값은 꺼짐입니다.',
        'Si está activo, un token de administrador con nivel admin puede llamar a forum_get / forum_update para leer y editar la descripción, el anuncio, el título SEO y las palabras clave del foro (incluidas traducciones). «Niveles habilitados» debe incluir admin; desactivado por defecto.',
        'Si activé, un jeton administrateur de niveau admin peut appeler forum_get / forum_update pour lire et modifier la description, l’annonce, le titre SEO et les mots-clés d’un forum (traductions incluses). « Niveaux autorisés » doit inclure admin ; désactivé par défaut.',
      ),
    },
    {
      key: 'toolDenylist',
      type: 'text',
      label: L(
        '工具黑名单', '工具黑名單', 'Tool denylist', 'Чёрный список инструментов', 'เครื่องมือที่ห้าม', 'Werkzeug-Sperrliste', 'ツール拒否リスト', '도구 차단 목록', 'Lista de bloqueo', 'Liste de refus',
      ),
      help: L(
        '逗号分隔的工具名，命中即不向客户端展示（如 search）。',
        '逗號分隔的工具名，命中即不向用戶端展示（如 search）。',
        'Comma-separated tool names hidden from clients (e.g. search).',
        'Имена инструментов через запятую, скрываемые от клиентов (например, search).',
        'ชื่อเครื่องมือคั่นด้วยจุลภาคที่จะไม่แสดงต่อไคลเอนต์ (เช่น search)',
        'Kommagetrennte Werkzeugnamen, die Clients nicht sehen (z. B. search).',
        'クライアントに表示しないツール名をカンマ区切りで指定（例: search）。',
        '클라이언트에 표시하지 않을 도구 이름을 쉼표로 구분(예: search).',
        'Nombres de herramientas separados por comas que no se muestran (p. ej. search).',
        'Noms d’outils séparés par des virgules, masqués aux clients (ex. search).',
      ),
    },
    {
      key: 'rateLimitPerMin',
      type: 'text',
      label: L(
        '每令牌每分钟上限', '每權杖每分鐘上限', 'Requests per minute', 'Запросов в минуту', 'คำขอต่อนาที', 'Anfragen pro Minute', '1分あたりの上限', '분당 요청 수', 'Peticiones por minuto', 'Requêtes par minute',
      ),
      placeholder: L('60', '60', '60', '60', '60', '60', '60', '60', '60', '60'),
      help: L(
        '单个令牌每分钟可发起的调用数，0 = 不限。',
        '單一權杖每分鐘可發起的呼叫數，0 = 不限。',
        'Calls allowed per token per minute; 0 = unlimited.',
        'Вызовов на токен в минуту; 0 — без ограничений.',
        'จำนวนการเรียกต่อโทเคนต่อนาที 0 = ไม่จำกัด',
        'Aufrufe pro Token und Minute; 0 = unbegrenzt.',
        'トークンごとの1分あたりの呼び出し数。0 = 無制限。',
        '토큰당 분당 호출 수, 0 = 무제한.',
        'Llamadas por token y minuto; 0 = sin límite.',
        'Appels par jeton et par minute ; 0 = illimité.',
      ),
    },
    {
      key: 'exposeResources',
      type: 'switch',
      label: L(
        '开放资源', '開放資源', 'Expose resources', 'Открыть ресурсы', 'เปิด resource', 'Ressourcen anbieten', 'リソースを公開', '리소스 노출', 'Exponer recursos', 'Exposer les ressources',
      ),
      onValue: 1,
      offValue: 0,
      defaultOn: true,
      help: L(
        '允许客户端以 freeidx:// 资源形式直接挂载主题/版块内容。',
        '允許用戶端以 freeidx:// 資源形式直接掛載主題/版塊內容。',
        'Let clients mount thread/forum content as freeidx:// resources.',
        'Позволяет клиентам подключать темы/разделы как ресурсы freeidx://.',
        'ให้ไคลเอนต์แนบเนื้อหากระทู้/บอร์ดเป็น resource freeidx://',
        'Clients können Themen/Foren als freeidx://-Ressourcen einbinden.',
        'クライアントがスレッド/フォーラムを freeidx:// リソースとして直接参照できます。',
        '클라이언트가 스레드/게시판을 freeidx:// 리소스로 직접 붙일 수 있습니다.',
        'Permite montar temas/foros como recursos freeidx://.',
        'Permet de monter sujets/forums comme ressources freeidx://.',
      ),
    },
  ],
};

/** 最小上下文面（registerRoute 注入的是 Hono Context，这里只用到这几个成员） */
interface McpCtx {
  env: Env;
  req: { method: string; header: (k: string) => string | undefined; raw: Request };
  get: (k: string) => unknown;
}

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      ...extra,
    },
  });
}

/** 单帧 SSE：部分客户端在 Accept 里强制要求 text/event-stream，回一帧后立即结束（不占长连接） */
function sseResponse(body: unknown): Response {
  const payload = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  return new Response(payload, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    },
  });
}

export const mcpPlugin: ExtensionModule = {
  manifest: {
    id: 'mcp',
    name: L(
      'MCP 服务', 'MCP 服務', 'MCP server', 'MCP-сервер', 'เซิร์ฟเวอร์ MCP', 'MCP-Server', 'MCP サーバー', 'MCP 서버', 'Servidor MCP', 'Serveur MCP',
    ),
    version: '1.0.0',
    installed: 1,
    enable: 0, // 出厂停用：未配令牌前不暴露入口
    capabilities: { transport: 'streamable-http-stateless', protocol: MCP_PROTOCOL_VERSION, endpoint: '/mcp' },
  },
  schema: MCP_SCHEMA,
  setup(api: ExtensionApi) {
    const config = parseConfig(api.config);
    for (const tool of CORE_MCP_TOOLS) api.contributeMcpTool(tool);
    // 写工具照常贡献：可见性由「令牌档位 ∩ 站点 enabledScopes ∩ 站点写闸门」在请求期裁剪
    for (const tool of MCP_WRITE_TOOLS) api.contributeMcpTool(tool);
    // 版块文案配置（admin）：另受站点点开关 forumWriteOn 控制，关闭时请求期整组摘除
    for (const tool of MCP_FORUM_TOOLS) api.contributeMcpTool(tool);
    for (const res of CORE_MCP_RESOURCES) api.contributeMcpResource(res);
    api.registerRoute('POST', '/mcp', makeHandler(config));

    // 审计表保留 30 天：只用于排障与限流溯源，长期留存对免费层的写额度是纯负担
    api.registerCron({
      pattern: CRON_DAILY,
      name: 'mcp:audit-gc',
      run: async (cron) => {
        const db = api.ctx?.db;
        if (!db) return;
        const cutoff = cron.now - 30 * 86400;
        cron.waitUntil(db.prepare('DELETE FROM bbs_mcp_audit WHERE create_date < ?').bind(cutoff).run().catch(() => undefined));
      },
    });
  },
};

function makeHandler(bootConfig: McpConfig) {
  return async (raw: unknown): Promise<unknown> => {
    const c = raw as McpCtx;
    const db = c.get('db') as D1b;
    const cache = c.get('cache') as Cache;

    // ① 身份：令牌是唯一载体（无 cookie），失败一律 401 + WWW-Authenticate
    const auth = await authenticate(db, c.req.header('authorization'));
    if (!auth.ok) return unauthorized(auth.message);
    const actor = auth.actor;

    // ② 站点策略：runlevel / 小黑屋 / 注册审核（与核心中间件同口径，见 auth.ts 注释）
    const setting = await loadSetting(cache, db);
    const level = Number(setting.runlevel ?? 5);
    const readDeny = banDeny(actor, false) ?? runlevelDeny(level, actor, false);
    if (readDeny) return jsonResponse(rpcError(null, RPC_ERROR.INVALID_REQUEST, readDeny), 403);
    // 写口径：MUTE / 待审账号 / 只读档位 → 写类工具整体不出现（模型不会误选）
    const writeDeny = banDeny(actor, true) ?? approvalDeny(actor, true) ?? runlevelDeny(level, actor, true);

    // ③ 限流：per-isolate 内存计数，零外部写（config 随本次装配，见 setup 的闭包说明）
    const cfg = bootConfig;
    if (!allowRequest(actor.tokenId, cfg.rateLimitPerMin)) {
      return jsonResponse(rpcError(null, RPC_ERROR.INVALID_REQUEST, 'Rate limit exceeded'), 429, { 'retry-after': '60' });
    }

    // ④ 请求体：先看声明长度，再按实际长度复检（防 chunked 绕过）
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_BODY) return jsonResponse(rpcError(null, RPC_ERROR.INVALID_REQUEST, 'Request body too large'), 413);
    let body: unknown;
    try {
      const text = await c.req.raw.text();
      if (text.length > MAX_BODY) return jsonResponse(rpcError(null, RPC_ERROR.INVALID_REQUEST, 'Request body too large'), 413);
      body = text.trim() ? JSON.parse(text) : null;
    } catch {
      return jsonResponse(rpcError(null, RPC_ERROR.PARSE_ERROR, 'Parse error'), 400);
    }

    // ⑤ 工具表：请求期读已装配好的运行时（此时所有启用插件的 setup 都已完成，顺序无关）
    const rt = await getExtensions(cache, db, c.env);
    const clientIp = c.req.header('cf-connecting-ip') ?? '';
    // 版块文案工具受站点点开关控制：关闭时整组摘除（tools/list 与 tools/call 同源，模型不会误选）
    const tools = cfg.forumWriteOn ? rt.mcpTools : rt.mcpTools.filter((t) => !MCP_FORUM_TOOL_NAMES.includes(t.name));
    const deps: DispatchDeps = {
      db,
      cache,
      env: c.env,
      lang: String(setting.lang ?? 'zh-cn'),
      actor,
      config: { ...cfg, enabledScopes: writeDeny ? 'read' : cfg.enabledScopes },
      tools,
      resources: rt.mcpResources,
      ipHash: await ipFingerprint(clientIp),
      // 写工具要把 IP 落到 userip 等风控列，口径与 HTTP 端 ipLongOf(c) 完全一致
      ip: clientIp ? ipToLong(clientIp) : 0,
      t: c.get('t') as ApiT,
    };

    const result = await dispatchBatch(body, deps);
    // last_used_at 节流写（60s 窗口），避免每个请求一次 D1 写
    const now = Math.floor(Date.now() / 1000);
    if (shouldTouch(actor.lastUsedAt, now)) await touchToken(db, actor.tokenId, now);

    if (result === null) return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
    const accept = c.req.header('accept') ?? '';
    return accept.includes('text/event-stream') ? sseResponse(result) : jsonResponse(result);
  };
}
