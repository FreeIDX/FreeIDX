/**
 * ads 独立插件（T3-9，§17）：广告位管理 + AdSense 集成 + ads.txt，出厂 installed=1、enable=0。
 * 停用即 bootstrap 不注入 `ads` 字段、ads.txt 路由不接线（前端插槽随之收起、零残留）。
 * 数据归插件独占（bbs_ad_slot 表 schema 归核心）；配置 ext:ads:config、密钥 ext:ads:secret（AES-GCM）。
 */
import { RunLevel } from '@freeidx/shared';
import type { ExtSchema } from '@freeidx/shared';
import type { ExtensionApi, ExtensionModule } from '../core/extensions/registry';
import { loadSetting } from '../core/loaders';
import { loadExtConfig, loadExtSecret } from '../core/ext-store';
import type { D1b } from '../core/db';
import type { Cache } from '../core/cache';
import { L } from '../core/i18n';

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** 后台配置表单 schema（插件自声明）：client/publisherId 为私密项，键名与 ext:ads:config/secret 一一对应（勿改名） */
const ADS_SCHEMA: ExtSchema = {
  brief: L(
    '广告位管理与 AdSense 集成：按位置、时段投放 HTML/图片/AdSense 广告，自动输出 ads.txt 授权文件。',
    '廣告位管理與 AdSense 整合：按位置、時段投放 HTML/圖片/AdSense 廣告，自動輸出 ads.txt 授權檔。',
    'Ad slot management with AdSense integration: serve HTML/image/AdSense ads by position and schedule, and auto-publish the ads.txt authorization file.',
    'Управление рекламными местами и интеграция с AdSense: показ HTML/изображений/AdSense по позиции и расписанию, автоматическая выдача файла ads.txt.',
    'จัดการตำแหน่งโฆษณาและเชื่อมต่อ AdSense: แสดงโฆษณา HTML/รูปภาพ/AdSense ตามตำแหน่งและช่วงเวลา พร้อมสร้างไฟล์ ads.txt โดยอัตโนมัติ',
    'Werbeplatz-Verwaltung mit AdSense-Integration: HTML-/Bild-/AdSense-Werbung nach Position und Zeitraum ausspielen und ads.txt automatisch ausgeben.',
    '広告スロット管理と AdSense 連携：位置・期間に応じて HTML/画像/AdSense 広告を配信し、ads.txt を自動出力します。',
    '광고 슬롯 관리 및 AdSense 연동: 위치와 기간별로 HTML/이미지/AdSense 광고를 게재하고 ads.txt 파일을 자동 생성합니다.',
    'Gestión de espacios publicitarios con integración de AdSense: sirve anuncios HTML/imagen/AdSense por posición y horario, y genera automáticamente el archivo ads.txt.',
    'Gestion des emplacements publicitaires avec intégration AdSense : diffuse des annonces HTML/image/AdSense par position et plage horaire, et publie automatiquement le fichier ads.txt.',
  ),
  intro: L(
    '下方只配置 AdSense 账号与全局参数，全部可选：不填时仅 html/图片位投放，ads.txt 返回 404。广告位（位置、类型、投放时段）在本页下方「广告位」表格里管理。',
    '下方只設定 AdSense 帳號與全域參數，全部可選：不填時僅 html/圖片位投放，ads.txt 回傳 404。廣告位（位置、類型、投放時段）在本頁下方「廣告位」表格裡管理。',
    'Below you only configure the AdSense account and global parameters, all optional: when empty, only HTML/image slots serve and ads.txt returns 404. Ad slots (position, type, schedule) are managed in the “Ad slots” table below.',
    'Ниже настраиваются только аккаунт AdSense и глобальные параметры, всё необязательно: если не заполнено, показываются только места html/изображений, а ads.txt возвращает 404. Рекламные места (позиция, тип, расписание) управляются в таблице «Рекламные места» ниже.',
    'ด้านล่างตั้งค่าเฉพาะบัญชี AdSense และพารามิเตอร์ทั่วไป ทั้งหมดไม่บังคับ: หากไม่กรอกจะแสดงเฉพาะสล็อต html/รูปภาพ และ ads.txt คืน 404 ส่วนสล็อตโฆษณา (ตำแหน่ง ประเภท ช่วงเวลา) จัดการในตาราง "สล็อตโฆษณา" ด้านล่างของหน้านี้',
    'Unten werden nur das AdSense-Konto und globale Parameter konfiguriert, alles optional: Ohne Angaben werden nur HTML-/Bildplätze ausgespielt und ads.txt liefert 404. Werbeplätze (Position, Typ, Zeitraum) werden in der Tabelle „Werbeplätze“ weiter unten verwaltet.',
    '以下では AdSense アカウントとグローバルパラメータのみ設定します（すべて任意）：未入力の場合は HTML/画像スロットのみ配信され、ads.txt は 404 を返します。広告スロット（位置・種類・配信期間）はこのページ下部の「広告スロット」テーブルで管理します。',
    '아래에서는 AdSense 계정과 전역 매개변수만 설정하며 모두 선택 사항입니다: 입력하지 않으면 html/이미지 슬롯만 게재되고 ads.txt는 404를 반환합니다. 광고 슬롯(위치, 유형, 게재 기간)은 이 페이지 아래 "광고 슬롯" 표에서 관리합니다.',
    'A continuación solo se configuran la cuenta de AdSense y los parámetros globales, todo opcional: si se deja vacío, solo se sirven espacios html/imagen y ads.txt devuelve 404. Los espacios publicitarios (posición, tipo, horario) se gestionan en la tabla «Espacios» más abajo.',
    'Ci-dessous, seuls le compte AdSense et les paramètres globaux se configurent, tout est optionnel : à vide, seuls les emplacements html/image diffusent et ads.txt renvoie 404. Les emplacements (position, type, plage) se gèrent dans le tableau « Emplacements » plus bas.',
  ),
  fields: [
    {
      key: 'client',
      target: 'secret',
      type: 'password',
      label: L('AdSense 客户端 ID', 'AdSense 客戶端 ID', 'AdSense client ID', 'ID клиента AdSense', 'รหัสไคลเอ็นต์ AdSense', 'AdSense-Client-ID', 'AdSense クライアント ID', 'AdSense 클라이언트 ID', 'ID de cliente de AdSense', 'ID client AdSense'),
      placeholder: L('ca-pub-XXXXXXXXXXXXXXXX，留空保持不变', 'ca-pub-XXXXXXXXXXXXXXXX，留空保持不變', 'ca-pub-XXXXXXXXXXXXXXXX, leave blank to keep unchanged', 'ca-pub-XXXXXXXXXXXXXXXX, оставьте пустым, чтобы не менять', 'ca-pub-XXXXXXXXXXXXXXXX เว้นว่างเพื่อคงค่าเดิม', 'ca-pub-XXXXXXXXXXXXXXXX, leer lassen, um unverändert zu bleiben', 'ca-pub-XXXXXXXXXXXXXXXX、空欄で変更なし', 'ca-pub-XXXXXXXXXXXXXXXX, 비워 두면 변경 없음', 'ca-pub-XXXXXXXXXXXXXXXX, dejar en blanco para mantener el valor', 'ca-pub-XXXXXXXXXXXXXXXX, laisser vide pour conserver'),
      help: L(
        'AdSense 后台 → 广告 → 按广告单元，代码里 data-ad-client 的值（ca-pub- 开头）。填入后 adsense 类型广告位才会投放（未填时此类位自动隐藏）。',
        'AdSense 後台 → 廣告 → 按廣告單元，程式碼裡 data-ad-client 的值（ca-pub- 開頭）。填入後 adsense 類型廣告位才會投放（未填時此類位自動隱藏）。',
        'In the AdSense console → Ads → By ad unit, this is the data-ad-client value in the code (starts with ca-pub-). AdSense-type slots only serve once this is set (they hide automatically otherwise).',
        'В консоли AdSense → Реклама → По рекламным блокам — это значение data-ad-client в коде (начинается с ca-pub-). Места типа adsense показываются только после заполнения (иначе скрываются автоматически).',
        'ในคอนโซล AdSense → โฆษณา → ตามหน่วยโฆษณา คือค่า data-ad-client ในโค้ด (ขึ้นต้นด้วย ca-pub-) เมื่อกรอกแล้วสล็อตประเภท adsense จึงจะแสดง (ถ้าไม่กรอกสล็อตประเภทนี้จะถูกซ่อนอัตโนมัติ)',
        'AdSense-Konsole → Anzeigen → Nach Anzeigenblock: der data-ad-client-Wert im Code (beginnt mit ca-pub-). Anzeigenplätze vom Typ adsense werden erst nach Eingabe ausgespielt (sonst automatisch ausgeblendet).',
        'AdSense 管理画面 → 広告 → ユニット別で、コード内の data-ad-client の値（ca-pub- で始まる）です。入力すると adsense タイプのスロットが配信され、未入力の場合は自動的に非表示になります。',
        'AdSense 콘솔 → 광고 → 단위별에서 코드의 data-ad-client 값입니다(ca-pub-로 시작). 입력하면 adsense 유형 슬롯이 게재되고, 입력하지 않으면 자동으로 숨겨집니다.',
        'En la consola de AdSense → Anuncios → Por unidad de anuncio, es el valor de data-ad-client en el código (empieza por ca-pub-). Los espacios tipo adsense solo se sirven tras rellenarlo (si no, se ocultan automáticamente).',
        'Dans la console AdSense → Annonces → Par bloc d’annonces : la valeur data-ad-client du code (commence par ca-pub-). Les emplacements de type adsense ne diffusent qu’une fois renseigné (sinon masqués automatiquement).',
      ),
    },
    {
      key: 'publisherId',
      target: 'secret',
      type: 'password',
      label: L('ads.txt 发布商 ID', 'ads.txt 發布商 ID', 'ads.txt publisher ID', 'ID издателя ads.txt', 'รหัสผู้เผยแพร่ ads.txt', 'ads.txt-Herausgeber-ID', 'ads.txt パブリッシャー ID', 'ads.txt 게시자 ID', 'ID de editor de ads.txt', 'ID éditeur ads.txt'),
      placeholder: L('pub-XXXXXXXXXXXXXXXX，留空保持不变', 'pub-XXXXXXXXXXXXXXXX，留空保持不變', 'pub-XXXXXXXXXXXXXXXX, leave blank to keep unchanged', 'pub-XXXXXXXXXXXXXXXX, оставьте пустым, чтобы не менять', 'pub-XXXXXXXXXXXXXXXX เว้นว่างเพื่อคงค่าเดิม', 'pub-XXXXXXXXXXXXXXXX, leer lassen, um unverändert zu bleiben', 'pub-XXXXXXXXXXXXXXXX、空欄で変更なし', 'pub-XXXXXXXXXXXXXXXX, 비워 두면 변경 없음', 'pub-XXXXXXXXXXXXXXXX, dejar en blanco para mantener el valor', 'pub-XXXXXXXXXXXXXXXX, laisser vide pour conserver'),
      help: L(
        'AdSense 后台 → 账号 → 设置 → 账户信息里的发布商 ID（pub- 开头，不带 ca- 前缀）。填入后 /ads.txt 才会输出授权行。',
        'AdSense 後台 → 帳號 → 設定 → 帳戶資訊裡的發布商 ID（pub- 開頭，不帶 ca- 前綴）。填入後 /ads.txt 才會輸出授權行。',
        'The publisher ID from AdSense console → Account → Settings → Account information (starts with pub-, without the ca- prefix). /ads.txt only outputs the authorization line once this is set.',
        'ID издателя из консоли AdSense → Аккаунт → Настройки → Сведения об аккаунте (начинается с pub-, без префикса ca-). Строка авторизации в /ads.txt выводится только после заполнения.',
        'รหัสผู้เผยแพร่จากคอนโซล AdSense → บัญชี → การตั้งค่า → ข้อมูลบัญชี (ขึ้นต้นด้วย pub- ไม่มีคำนำหน้า ca-) เมื่อกรอกแล้ว /ads.txt จึงจะแสดงบรรทัดอนุญาต',
        'Die Herausgeber-ID aus AdSense-Konsole → Konto → Einstellungen → Kontoinformationen (beginnt mit pub-, ohne ca--Präfix). /ads.txt gibt die Autorisierungszeile erst nach Eingabe aus.',
        'AdSense 管理画面 → アカウント → 設定 → アカウント情報のパブリッシャー ID（pub- で始まり、接頭辞 ca- は不要）。入力すると /ads.txt に承認行が出力されます。',
        'AdSense 콘솔 → 계정 → 설정 → 계정 정보의 게시자 ID입니다(pub-로 시작, ca- 접두사 제외). 입력해야 /ads.txt에 승인 줄이 출력됩니다.',
        'El ID de editor de la consola de AdSense → Cuenta → Configuración → Información de la cuenta (empieza por pub-, sin el prefijo ca-). /ads.txt solo muestra la línea de autorización tras rellenarlo.',
        'L’ID éditeur de la console AdSense → Compte → Paramètres → Informations du compte (commence par pub-, sans le préfixe ca-). /ads.txt n’affiche la ligne d’autorisation qu’une fois renseigné.',
      ),
    },
    {
      key: 'cmp',
      type: 'switch',
      label: L('同意管理（CMP）标记', '同意管理（CMP）標記', 'Consent management (CMP) flag', 'Флаг согласия (CMP)', 'ธงระบบจัดการความยินยอม (CMP)', 'Consent-Management (CMP)-Flag', '同意管理（CMP）フラグ', '동의 관리(CMP) 플래그', 'Indicador de gestión de consentimiento (CMP)', 'Indicateur de gestion du consentement (CMP)'),
      onValue: 1,
      offValue: 0,
      defaultOn: false,
      help: L(
        '开启后前台 bootstrap 携带 cmp=1，前端可据此对欧盟访客展示 Cookie 同意弹窗（需前台主题支持）。',
        '開啟後前台 bootstrap 攜帶 cmp=1，前端可據此對歐盟訪客展示 Cookie 同意彈窗（需前台主題支援）。',
        'When enabled, the frontend bootstrap carries cmp=1, letting the frontend show a cookie consent dialog to EU visitors (requires theme support).',
        'При включении bootstrap фронтенда передаёт cmp=1, позволяя показывать посетителям из ЕС диалог согласия на cookie (требуется поддержка темой).',
        'เมื่อเปิด bootstrap ฝั่งหน้าจะส่ง cmp=1 มา ทำให้ฟรอนต์แสดงป็อปอัปยินยอม Cookie แก่ผู้เยี่ยมชมจากสหภาพยุโรปได้ (ต้องให้ธีมรองรับ)',
        'Bei Aktivierung überträgt das Frontend-Bootstrap cmp=1, sodass das Frontend EU-Besuchern einen Cookie-Consent-Dialog zeigen kann (Theme-Unterstützung erforderlich).',
        '有効にするとフロントエンドの bootstrap に cmp=1 が付与され、EU 訪問者に Cookie 同意ダイアログを表示できます（テーマの対応が必要）。',
        '활성화하면 프런트엔드 bootstrap이 cmp=1을 전달하여 EU 방문자에게 쿠키 동의 대화상자를 표시할 수 있습니다(테마 지원 필요).',
        'Al activarlo, el bootstrap del frontend incluye cmp=1, lo que permite mostrar un diálogo de consentimiento de cookies a visitantes de la UE (requiere soporte del tema).',
        'Une fois activé, le bootstrap du frontend transmet cmp=1, permettant d’afficher un dialogue de consentement cookies aux visiteurs de l’UE (support du thème requis).',
      ),
    },
    {
      key: 'placeholder',
      type: 'kv',
      label: L('广告位占位高度', '廣告位佔位高度', 'Ad slot placeholder height', 'Высота заполнителя рекламных мест', 'ความสูงตัวแทนของสล็อตโฆษณา', 'Platzhalterhöhe für Werbeplätze', '広告スロットのプレースホルダー高', '광고 슬롯 자리 표시 높이', 'Altura del marcador de posición de los espacios', 'Hauteur du placeholder des emplacements'),
      keyLabel: L('广告位位置', '廣告位位置', 'Slot position', 'Позиция места', 'ตำแหน่งสล็อต', 'Platzposition', 'スロット位置', '슬롯 위치', 'Posición del espacio', 'Position de l’emplacement'),
      valueLabel: L('占位高度 px', '佔位高度 px', 'Placeholder height px', 'Высота заполнителя px', 'ความสูงตัวแทน px', 'Platzhalterhöhe px', 'プレースホルダー高 px', '자리 표시 높이 px', 'Altura del marcador px', 'Hauteur du placeholder px'),
      keyPattern: '^[a-z][a-z0-9_-]{0,30}$',
      numeric: true,
      placeholder: L('如 header', '如 header', 'e.g. header', 'напр. header', 'เช่น header', 'z. B. header', '例: header', '예: header', 'p. ej. header', 'ex. header'),
      help: L(
        '广告未加载时预留的占位高度（数字，单位 px），键为广告位位置标识（与「广告位」页的位置一致，如 header），可减少页面抖动（CLS）。',
        '廣告未載入時預留的佔位高度（數字，單位 px），鍵為廣告位位置標識（與「廣告位」頁的位置一致，如 header），可減少頁面抖動（CLS）。',
        'Reserved placeholder height (number, in px) while ads are not loaded; the key is the slot position identifier (matching the position on the “Ad slots” page, e.g. header), reducing layout shift (CLS).',
        'Зарезервированная высота заполнителя (число, в px), пока реклама не загружена; ключ — идентификатор позиции места (совпадает с позицией на странице «Рекламные места», напр. header), снижает сдвиг макета (CLS).',
        'ความสูงตัวแทนที่สงวนไว้ (ตัวเลข หน่วย px) ขณะโฆษณายังไม่โหลด โดยคีย์คือตัวระบุตำแหน่งสล็อต (ตรงกับตำแหน่งในหน้า "สล็อตโฆษณา" เช่น header) ช่วยลดการกระตุกของหน้า (CLS)',
        'Reservierte Platzhalterhöhe (Zahl, in px), solange Werbung nicht geladen ist; der Schlüssel ist die Positions-ID des Werbeplatzes (identisch mit der Position auf der Seite „Werbeplätze“, z. B. header) und reduziert Layout-Verschiebungen (CLS).',
        '広告が読み込まれるまでの間に確保するプレースホルダーの高さ（数値・px 単位）。キーは広告スロットの位置識別子（「広告スロット」ページの位置と一致、例: header）で、ページのちらつき（CLS）を減らせます。',
        '광고가 로드되기 전까지 확보되는 자리 표시 높이(숫자, px 단위)입니다. 키는 광고 슬롯 위치 식별자("광고 슬롯" 페이지의 위치와 일치, 예: header)이며 페이지 흔들림(CLS)을 줄입니다.',
        'Altura reservada del marcador (número, en px) mientras los anuncios no cargan; la clave es el identificador de posición del espacio (coincide con la posición de la página «Espacios», p. ej. header) y reduce el desplazamiento del diseño (CLS).',
        'Hauteur réservée du placeholder (nombre, en px) tant que les annonces ne sont pas chargées ; la clé est l’identifiant de position de l’emplacement (correspondant à la position de la page « Emplacements », ex. header) pour réduire le décalage de mise en page (CLS).',
      ),
    },
  ],
};

interface AdSlotOut {
  id: number;
  position: string;
  type: string;
  config: Record<string, unknown>;
  sort: number;
}

/** 时间窗内、启用、且 adsense 位需已配置 client 方可见（§17.3 未配置 client 自动隐藏全部 adsense 位） */
async function queryActiveSlots(db: D1b, hasClient: boolean): Promise<AdSlotOut[]> {
  const now = nowSec();
  const r = await db
    .prepare<{ id: number; position: string; type: string; config: string; sort: number }>(
      `SELECT id,position,type,config,sort FROM bbs_ad_slot
       WHERE enabled = 1 AND (start_date = 0 OR start_date <= ?) AND (end_date = 0 OR end_date >= ?)
       ORDER BY sort DESC, id ASC LIMIT 50`,
    )
    .bind(now, now)
    .all();
  const out: AdSlotOut[] = [];
  for (const row of r.results) {
    if (row.type === 'adsense' && !hasClient) continue;
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(row.config || '{}') as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    out.push({ id: Number(row.id), position: String(row.position), type: String(row.type), config: cfg, sort: Number(row.sort) });
  }
  return out;
}

function httpDate(v: number): string {
  return new Date(v * 1000).toUTCString();
}

/** ads.txt（契约③ registerRoute）：发布商 ID 存 ext:ads:secret；未配置则 404（不输出空文件干扰收录） */
async function adsTxt(c: unknown): Promise<Response> {
  const ctx = c as { get: (k: string) => unknown; env: { SECRETS_MASTER_KEY?: string } };
  const db = ctx.get('db') as D1b;
  const secret = await loadExtSecret(db, 'ads', ctx.env.SECRETS_MASTER_KEY);
  const publisher = typeof secret.publisherId === 'string' ? secret.publisherId.trim() : '';
  if (!publisher) return new Response(null, { status: 404 });
  const line = `google.com, ${publisher}, DIRECT, f08c47fec0942fa0`;
  return new Response(`${line}\n`, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // HTTP 头不支持括号注释：日期改用标准 last-modified 承载（原 `max-age=3600 (2026-…)` 属畸形指令）
      'cache-control': 'public, max-age=3600, s-maxage=3600',
      'last-modified': httpDate(nowSec()),
    },
  });
}

export const adsPlugin: ExtensionModule = {
  manifest: {
    id: 'ads',
    name: L('广告系统', '廣告系統', 'Ads Extension', 'Рекламная система', 'ระบบโฆษณา', 'Anzeigen-Erweiterung', '広告システム', '광고 시스템', 'Extensión de anuncios', 'Extension publicitaire'),
    version: '1.0.0',
    installed: 1,
    enable: 0, // 出厂停用：论坛默认无广告（§17、决策 8）
    capabilities: { types: ['html', 'image', 'adsense'] },
  },
  schema: ADS_SCHEMA,
  setup(api: ExtensionApi) {
    api.registerRoute('GET', '/ads.txt', adsTxt);
    // 契约 ⑦：已启用广告位配置随核心 bootstrap 一次下发，不产生额外请求
    api.contributeBootstrap(async (ext) => {
      const ctx = api.ctx;
      if (!ctx) return;
      const { db, cache, env } = ctx as { db: D1b; cache: Cache; env?: { SECRETS_MASTER_KEY?: string } };
      // runlevel 关站短路，广告自动停投（§17.4）
      const setting = await loadSetting(cache, db);
      if (setting.runlevel <= RunLevel.CLOSED_SITE) return;
      const [config, secret] = await Promise.all([
        loadExtConfig(cache, db, 'ads'),
        loadExtSecret(db, 'ads', env?.SECRETS_MASTER_KEY),
      ]);
      const client = typeof secret.client === 'string' ? secret.client.trim() : '';
      const slots = await queryActiveSlots(db, client !== '');
      const placeholder = (config.placeholder && typeof config.placeholder === 'object' ? config.placeholder : {}) as Record<string, number>;
      ext['ads'] = {
        client: client || null,
        cmp: config.cmp === 1 ? 1 : 0,
        placeholder,
        slots,
      };
    });
  },
};
