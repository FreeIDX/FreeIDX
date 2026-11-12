/**
 * toc 文章目录插件：帖子详情页「右栏作者卡下方」显示首帖的标题目录（h1~h6 可筛层级），
 * 点击平滑滚动到对应标题，滚动时自动高亮当前小节（scroll-spy）。出厂 installed=1、enable=0。
 *
 * 数据面零请求零查询：标题直接从**已渲染的首帖 DOM**（#thread-first-post）里读取，
 * 本插件只经契约⑦ `bootstrap:contribute` 下发展示参数（启用标记 / 层级范围 / 最少条数 / 标题等），
 * 因此不新增接口、不新增表、不占 D1 预算；插件停用或关站时前台整块不渲染。
 *
 * 注意：核心 sanitize 会剥离正文中的 `id` 属性（属性白名单不含 id），故锚点由前端扫描时临时写入，
 * 不依赖帖子作者手写锚点。
 */
import type { ExtSchema } from '@freeidx/shared';
import { RunLevel } from '@freeidx/shared';
import type { ExtensionApi, ExtensionModule } from '../core/extensions/registry';
import { loadSetting } from '../core/loaders';
import { loadExtConfig } from '../core/ext-store';
import type { D1b } from '../core/db';
import type { Cache } from '../core/cache';
import { L } from '../core/i18n';

export const TOC_EXT_ID = 'toc';

/** 解析后的运行态配置（前端按同名字段消费 bootstrap，勿改名） */
export interface TocConfig {
  /** 区块标题（空串 = 前台用多语言默认「文章目录」） */
  title: string;
  /** 起始标题层级（1~3，含） */
  minLevel: number;
  /** 截止标题层级（3~6，含），解析时保证 ≥ minLevel */
  maxLevel: number;
  /** 少于该条数不显示（避免只有一两个标题也占一栏） */
  minCount: number;
  /** 滚动时自动高亮当前小节 */
  scrollSync: boolean;
  /** 目录项前显示序号（默认显示圆点） */
  showIndex: boolean;
}

const TOC_SCHEMA: ExtSchema = {
  brief: L(
    '在帖子右栏显示首帖的标题目录，点击跳转、滚动高亮；层级范围、最少条数、是否自动高亮均可配置。',
    '在帖子右欄顯示首帖的標題目錄，點擊跳轉、滾動高亮；層級範圍、最少條數、是否自動高亮均可設定。',
    'Shows a table of contents for the first post in the thread sidebar: click to jump, auto-highlight while scrolling. Level range, minimum entries and scroll sync are configurable.',
    'Показывает содержание первого поста в правой колонке темы: переход по клику и авто-подсветка при прокрутке. Настраиваются диапазон уровней, минимум пунктов и синхронизация.',
    'แสดงสารบัญของโพสต์แรกในแถบด้านข้างของกระทู้ คลิกเพื่อเลื่อนไปและไฮไลต์ตามการเลื่อน ตั้งช่วงระดับ จำนวนขั้นต่ำ และการไฮไลต์อัตโนมัติได้',
    'Zeigt im Seitenbereich des Themas ein Inhaltsverzeichnis des ersten Beitrags: Klick zum Springen, automatische Hervorhebung beim Scrollen. Ebenenbereich, Mindestanzahl und Scroll-Sync sind einstellbar.',
    'スレッド右側に最初の投稿の見出し目次を表示します。クリックで移動、スクロールで自動ハイライト。階層範囲・最低件数・自動ハイライトを設定できます。',
    '스레드 오른쪽에 첫 게시글의 목차를 표시합니다. 클릭하면 이동하고 스크롤 시 자동으로 강조합니다. 계층 범위, 최소 개수, 자동 강조를 설정할 수 있습니다.',
    'Muestra en la barra lateral del tema un índice de los títulos del primer post: clic para saltar y resaltado automático al desplazarse. El rango de niveles, el mínimo de entradas y la sincronización son configurables.',
    'Affiche dans la colonne latérale du sujet un sommaire des titres du premier message : clic pour y aller, surlignage automatique au défilement. Plage de niveaux, nombre minimum et synchronisation sont réglables.',
  ),
  intro: L(
    '启用后，首帖中的标题（h1~h6，按下方层级范围筛选）会出现在右栏「文章目录」里。标题取自已渲染的正文，不额外请求接口；正文没有足够的标题时整块不显示。目录卡只在桌面端右栏出现（窄屏右栏本身隐藏）。',
    '啟用後，首帖中的標題（h1~h6，按下方層級範圍篩選）會出現在右欄「文章目錄」裡。標題取自已渲染的正文，不額外請求介面；正文沒有足夠的標題時整塊不顯示。目錄卡只在桌面端右欄出現（窄屏右欄本身隱藏）。',
    'Once enabled, headings in the first post (h1–h6, filtered by the level range below) appear in the sidebar table of contents. Headings are read from the already-rendered content — no extra request. The block is hidden when there are not enough headings, and it only appears in the desktop sidebar (the sidebar itself is hidden on narrow screens).',
    'После включения заголовки первого поста (h1–h6, по диапазону ниже) появятся в содержании справа. Они берутся из уже отрисованного текста, без дополнительных запросов. Если заголовков мало, блок не показывается; он виден только в правой колонке на десктопе (на узких экранах колонка скрыта).',
    'เมื่อเปิดใช้งาน หัวข้อในโพสต์แรก (h1–h6 ตามช่วงระดับด้านล่าง) จะแสดงในสารบัญด้านขวา หัวข้ออ่านจากเนื้อหาที่เรนเดอร์แล้ว ไม่มีการเรียก API เพิ่มเติม หากหัวข้อไม่พอจะไม่แสดงบล็อกนี้ และจะแสดงเฉพาะแถบด้านขวาบนเดสก์ท็อป (จอแคบซ่อนแถบนี้อยู่แล้ว)',
    'Nach der Aktivierung erscheinen die Überschriften des ersten Beitrags (h1–h6, gefiltert nach dem Ebenenbereich) im Inhaltsverzeichnis rechts. Sie stammen aus dem bereits gerenderten Inhalt — kein zusätzlicher Request. Bei zu wenigen Überschriften wird der Block ausgeblendet; er erscheint nur in der Desktop-Seitenleiste (auf schmalen Bildschirmen ist diese ausgeblendet).',
    '有効にすると、最初の投稿の見出し（h1〜h6、下の階層範囲で絞り込み）が右側の目次に表示されます。見出しは描画済みの本文から取得するため追加リクエストはありません。見出しが少ない場合はブロックごと非表示になります。デスクトップの右カラムのみに表示されます（狭い画面では右カラム自体が非表示）。',
    '활성화하면 첫 게시글의 제목(h1~h6, 아래 계층 범위로 필터)이 오른쪽 목차에 표시됩니다. 제목은 이미 렌더링된 본문에서 읽으므로 추가 요청이 없습니다. 제목이 부족하면 블록을 표시하지 않으며, 데스크톱 오른쪽 사이드바에서만 나타납니다(좁은 화면에서는 사이드바 자체가 숨김).',
    'Al activarlo, los títulos del primer post (h1–h6, filtrados por el rango de niveles) aparecen en el índice de la barra lateral. Se leen del contenido ya renderizado, sin peticiones adicionales. El bloque se oculta si hay pocos títulos y solo aparece en la barra lateral de escritorio (en pantallas estrechas la barra está oculta).',
    'Une fois activé, les titres du premier message (h1–h6, filtrés par la plage de niveaux) apparaissent dans le sommaire latéral. Ils proviennent du contenu déjà rendu, sans requête supplémentaire. Le bloc est masqué s’il y a trop peu de titres et n’apparaît que dans la colonne latérale sur ordinateur (masquée sur écran étroit).',
  ),
  fields: [
    {
      key: 'title',
      type: 'text',
      label: L('区块标题', '區塊標題', 'Block title', 'Заголовок блока', 'หัวข้อบล็อก', 'Blocktitel', 'ブロック見出し', '블록 제목', 'Título del bloque', 'Titre du bloc'),
      placeholder: L('留空使用默认「文章目录」', '留空使用預設「文章目錄」', 'Empty = default “Contents”', 'Пусто — «Содержание»', 'เว้นว่าง = "สารบัญ"', 'Leer = „Inhalt“', '空欄 = 「目次」', '비워 두면 "목차"', 'Vacío = «Índice»', 'Vide = « Sommaire »'),
      help: L(
        '自定义右栏目录的标题，最长 40 字；留空时按访客界面语言显示「文章目录」。',
        '自訂右欄目錄的標題，最長 40 字；留空時按訪客介面語言顯示「文章目錄」。',
        'Custom title for the sidebar contents, up to 40 characters; when empty it shows “Contents” in the visitor’s language.',
        'Свой заголовок содержания, до 40 символов; если пусто — «Содержание» на языке посетителя.',
        'หัวข้อกำหนดเองของสารบัญ ไม่เกิน 40 ตัวอักษร หากเว้นว่างจะแสดง "สารบัญ" ตามภาษาของผู้เยี่ยมชม',
        'Eigener Titel für das Inhaltsverzeichnis, maximal 40 Zeichen; leer zeigt „Inhalt“ in der Sprache des Besuchers.',
        '右カラム目次の見出しをカスタム（最大 40 文字）。空欄なら訪問者の言語で「目次」を表示します。',
        '오른쪽 목차 제목을 직접 지정합니다(최대 40자). 비워 두면 방문자 언어로 "목차"를 표시합니다.',
        'Título personalizado del índice, hasta 40 caracteres; si está vacío se muestra «Índice» en el idioma del visitante.',
        'Titre personnalisé du sommaire, 40 caractères max ; vide, « Sommaire » s’affiche dans la langue du visiteur.',
      ),
    },
    {
      key: 'minLevel',
      type: 'select',
      label: L('起始层级', '起始層級', 'From level', 'С уровня', 'เริ่มจากระดับ', 'Ab Ebene', '開始階層', '시작 계층', 'Desde nivel', 'À partir du niveau'),
      options: [
        { value: 1, label: L('H1', 'H1', 'H1', 'H1', 'H1', 'H1', 'H1', 'H1', 'H1', 'H1') },
        { value: 2, label: L('H2（推荐）', 'H2（推薦）', 'H2 (recommended)', 'H2 (рекомендуется)', 'H2 (แนะนำ)', 'H2 (empfohlen)', 'H2（推奨）', 'H2(권장)', 'H2 (recomendado)', 'H2 (recommandé)') },
        { value: 3, label: L('H3', 'H3', 'H3', 'H3', 'H3', 'H3', 'H3', 'H3', 'H3', 'H3') },
      ],
      initialValue: 2,
      help: L(
        '从第几级标题开始收录。多数帖子用 H2 作为章节标题，H1 常被当作大标题，故默认从 H2 开始。',
        '從第幾級標題開始收錄。多數帖子用 H2 作為章節標題，H1 常被當作大標題，故預設從 H2 開始。',
        'Which heading level to start from. Most posts use H2 for sections and H1 as a big banner, so H2 is the default.',
        'С какого уровня собирать заголовки. Обычно H2 — разделы, H1 — крупный баннер, поэтому по умолчанию H2.',
        'เริ่มเก็บหัวข้อจากระดับใด โพสต์ส่วนใหญ่ใช้ H2 เป็นหัวข้อตอนและ H1 เป็นป้ายใหญ่ จึงเริ่มที่ H2',
        'Ab welcher Überschriftenebene gesammelt wird. Meist dient H2 als Abschnitt und H1 als großes Banner — daher Standard H2.',
        '何階層から目次に載せるか。多くの投稿は H2 を章見出し、H1 を大見出しに使うため、既定は H2 です。',
        '어느 계층부터 목차에 담을지 정합니다. 대부분 H2를 섹션 제목, H1을 큰 배너로 쓰므로 기본값은 H2입니다.',
        'Desde qué nivel se recogen los títulos. La mayoría usa H2 para secciones y H1 como gran rótulo, por eso el valor por defecto es H2.',
        'À partir de quel niveau collecter les titres. La plupart des messages utilisent H2 pour les sections et H1 comme grand bandeau, d’où H2 par défaut.',
      ),
    },
    {
      key: 'maxLevel',
      type: 'select',
      label: L('截止层级', '截止層級', 'To level', 'По уровень', 'ถึงระดับ', 'Bis Ebene', '終了階層', '끝 계층', 'Hasta nivel', 'Jusqu’au niveau'),
      options: [
        { value: 3, label: L('H3', 'H3', 'H3', 'H3', 'H3', 'H3', 'H3', 'H3', 'H3', 'H3') },
        { value: 4, label: L('H4（推荐）', 'H4（推薦）', 'H4 (recommended)', 'H4 (рекомендуется)', 'H4 (แนะนำ)', 'H4 (empfohlen)', 'H4（推奨）', 'H4(권장)', 'H4 (recomendado)', 'H4 (recommandé)') },
        { value: 5, label: L('H5', 'H5', 'H5', 'H5', 'H5', 'H5', 'H5', 'H5', 'H5', 'H5') },
        { value: 6, label: L('H6', 'H6', 'H6', 'H6', 'H6', 'H6', 'H6', 'H6', 'H6', 'H6') },
      ],
      initialValue: 4,
      help: L(
        '收录到第几级标题为止（含）；若小于起始层级，按起始层级处理。层级越深目录越长。',
        '收錄到第幾級標題為止（含）；若小於起始層級，按起始層級處理。層級越深目錄越長。',
        'Last heading level to include (inclusive); if lower than the start level it is raised to it. Deeper levels make a longer list.',
        'До какого уровня включать (включительно); если меньше начального, поднимается до него. Глубже — длиннее список.',
        'รวมถึงระดับใด (รวมระดับนั้น) หากต่ำกว่าระดับเริ่มต้นจะปรับขึ้นเป็นระดับเริ่มต้น ระดับยิ่งลึกยิ่งยาว',
        'Bis zu welcher Ebene eingeschlossen wird; liegt sie unter der Startebene, wird sie angehoben. Tiefere Ebenen ergeben längere Listen.',
        'どの階層まで含めるか（その階層を含む）。開始階層より小さい場合は開始階層に合わせます。深いほど長くなります。',
        '어느 계층까지 포함할지 정합니다(해당 계층 포함). 시작 계층보다 작으면 시작 계층으로 올립니다. 깊을수록 길어집니다.',
        'Hasta qué nivel incluir (incluido); si es menor que el nivel inicial se eleva a este. Más profundidad implica una lista más larga.',
        'Jusqu’à quel niveau inclure (inclus) ; s’il est inférieur au niveau de départ, il est relevé. Plus profond = liste plus longue.',
      ),
    },
    {
      key: 'minCount',
      type: 'select',
      label: L('最少条数', '最少條數', 'Minimum entries', 'Минимум пунктов', 'จำนวนขั้นต่ำ', 'Mindestanzahl', '最低件数', '최소 개수', 'Mínimo de entradas', 'Nombre minimum'),
      options: [
        { value: 1, label: L('1 条', '1 條', '1 entry', '1 пункт', '1 รายการ', '1 Eintrag', '1 件', '1개', '1 entrada', '1 élément') },
        { value: 2, label: L('2 条（推荐）', '2 條（推薦）', '2 entries (recommended)', '2 пункта (рекомендуется)', '2 รายการ (แนะนำ)', '2 Einträge (empfohlen)', '2 件（推奨）', '2개(권장)', '2 entradas (recomendado)', '2 éléments (recommandé)') },
        { value: 3, label: L('3 条', '3 條', '3 entries', '3 пункта', '3 รายการ', '3 Einträge', '3 件', '3개', '3 entradas', '3 éléments') },
        { value: 4, label: L('4 条', '4 條', '4 entries', '4 пункта', '4 รายการ', '4 Einträge', '4 件', '4개', '4 entradas', '4 éléments') },
      ],
      initialValue: 2,
      help: L(
        '标题数量少于该值时整块不显示，避免只有一两个标题也占一栏。',
        '標題數量少於該值時整塊不顯示，避免只有一兩個標題也佔一欄。',
        'The block is hidden when fewer headings than this exist, so a single heading does not take up a whole column.',
        'Если заголовков меньше — блок не показывается, чтобы один заголовок не занимал колонку.',
        'หากจำนวนหัวข้อน้อยกว่านี้จะไม่แสดงบล็อก เพื่อไม่ให้หัวข้อเดียวเปลืองพื้นที่ทั้งคอลัมน์',
        'Bei weniger Überschriften wird der Block ausgeblendet, damit eine einzelne Überschrift keine ganze Spalte belegt.',
        '見出しがこの数未満ならブロックごと非表示にし、1 件だけで列を占有しないようにします。',
        '제목 수가 이보다 적으면 블록을 표시하지 않아 제목 하나가 칼럼을 차지하지 않습니다.',
        'El bloque se oculta si hay menos títulos que este valor, para que un solo título no ocupe una columna.',
        'Le bloc est masqué s’il y a moins de titres que cette valeur, afin qu’un seul titre n’occupe pas toute la colonne.',
      ),
    },
    {
      key: 'scrollSync',
      type: 'switch',
      label: L('滚动自动高亮', '滾動自動高亮', 'Auto-highlight on scroll', 'Автоподсветка при прокрутке', 'ไฮไลต์อัตโนมัติเมื่อเลื่อน', 'Automatisch hervorheben beim Scrollen', 'スクロールで自動ハイライト', '스크롤 시 자동 강조', 'Resaltado automático al desplazar', 'Surlignage automatique au défilement'),
      onValue: 1,
      offValue: 0,
      defaultOn: true,
      help: L(
        '开启后阅读到哪个章节就高亮哪一条；关闭则只有点击时短暂定位，不跟随滚动。',
        '開啟後閱讀到哪個章節就高亮哪一條；關閉則只有點擊時短暫定位，不跟隨滾動。',
        'When on, the entry for the section in view is highlighted; when off, only the clicked entry is marked.',
        'При включении подсвечивается пункт текущего раздела; при выключении отмечается только кликнутый.',
        'เมื่อเปิด รายการของตอนที่กำลังอ่านจะถูกไฮไลต์ เมื่อปิดจะทำเครื่องหมายเฉพาะรายการที่คลิก',
        'Ein: Der Eintrag des sichtbaren Abschnitts wird hervorgehoben. Aus: Nur der angeklickte Eintrag wird markiert.',
        'オン：閲覧中の章の項目をハイライトします。オフ：クリックした項目のみをマークします。',
        '켜짐: 보고 있는 섹션의 항목을 강조합니다. 꺼짐: 클릭한 항목만 표시합니다.',
        'Activado: se resalta la entrada de la sección visible. Desactivado: solo se marca la entrada pulsada.',
        'Activé : l’entrée de la section visible est surlignée. Désactivé : seul l’élément cliqué est marqué.',
      ),
    },
    {
      key: 'showIndex',
      type: 'switch',
      label: L('显示序号', '顯示序號', 'Show numbers', 'Показывать номера', 'แสดงลำดับเลข', 'Nummern anzeigen', '番号を表示', '번호 표시', 'Mostrar números', 'Afficher les numéros'),
      onValue: 1,
      offValue: 0,
      defaultOn: false,
      help: L(
        '开启后目录项前显示 1、2、3… 序号；关闭则显示圆点（与竖线组成时间轴样式）。',
        '開啟後目錄項前顯示 1、2、3… 序號；關閉則顯示圓點（與豎線組成時間軸樣式）。',
        'When on, entries are numbered 1, 2, 3…; when off, dots are shown (connected by a vertical rail).',
        'При включении пункты нумеруются 1, 2, 3…; при выключении показываются точки на вертикальной линии.',
        'เมื่อเปิดจะมีลำดับ 1, 2, 3… เมื่อปิดจะแสดงจุดบนเส้นแนวตั้ง',
        'Ein: Einträge werden mit 1, 2, 3… nummeriert. Aus: Punkte auf einer vertikalen Linie.',
        'オン：1、2、3… の番号を表示。オフ：縦線上のドットを表示。',
        '켜짐: 1, 2, 3… 번호를 표시합니다. 꺼짐: 세로선 위의 점을 표시합니다.',
        'Activado: las entradas se numeran 1, 2, 3…; desactivado: se muestran puntos sobre una línea vertical.',
        'Activé : les entrées sont numérotées 1, 2, 3… ; désactivé : des points sur un rail vertical.',
      ),
    },
  ],
};

const clampInt = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.floor(n))) : dflt;
};

/** 后台配置 → 运行态（非法值一律回落默认，配置写错也不会让右栏报错） */
export function parseTocConfig(config: Record<string, unknown>): TocConfig {
  const minLevel = clampInt(config.minLevel, 2, 1, 3);
  const maxLevel = Math.max(minLevel, clampInt(config.maxLevel, 4, 3, 6));
  return {
    title: String(config.title ?? '').trim().slice(0, 40),
    minLevel,
    maxLevel,
    minCount: clampInt(config.minCount, 2, 1, 6),
    scrollSync: config.scrollSync === undefined || config.scrollSync === '' ? true : config.scrollSync === 1 || config.scrollSync === true || config.scrollSync === '1' || config.scrollSync === 'true',
    showIndex: config.showIndex === 1 || config.showIndex === true || config.showIndex === '1' || config.showIndex === 'true',
  };
}

/** 读目录配置（ext:toc:config，三层缓存读穿） */
export function loadTocConfig(cache: Cache, db: D1b): Promise<TocConfig> {
  return loadExtConfig(cache, db, TOC_EXT_ID).then(parseTocConfig);
}

/** 前台下发视图（bootstrap 用） */
export interface TocPublicConfig extends TocConfig {
  enabled: true;
}

export function publicTocConfig(cfg: TocConfig): TocPublicConfig {
  return { enabled: true, ...cfg };
}

export const tocPlugin: ExtensionModule = {
  manifest: {
    id: TOC_EXT_ID,
    name: L('文章目录', '文章目錄', 'Table of Contents', 'Содержание', 'สารบัญ', 'Inhaltsverzeichnis', '目次', '목차', 'Índice', 'Sommaire'),
    version: '1.0.0',
    installed: 1,
    enable: 0, // 出厂停用：后台「插件中心」启用后生效（与 ads/checkin/related 一致）
    capabilities: { positions: ['sidebar'], source: 'thread_first_post', levels: [1, 6] },
  },
  schema: TOC_SCHEMA,
  setup(api: ExtensionApi) {
    // 契约 ⑦：启用标记 + 展示参数随核心 bootstrap 一次下发（游客与登录用户同值，可共享边缘缓存）
    api.contributeBootstrap(async (ext) => {
      const ctx = api.ctx;
      if (!ctx) return;
      const { db, cache } = ctx as { db: D1b; cache: Cache };
      // runlevel 关站短路：关站时目录区块自动收起
      const setting = await loadSetting(cache, db);
      if (setting.runlevel <= RunLevel.CLOSED_SITE) return;
      ext['toc'] = publicTocConfig(await loadTocConfig(cache, db));
    });
  },
};
