/**
 * related 相关帖子插件：帖子详情页「帖子下方、评论区上方」展示一批相关主题，
 * 展示方式（卡片/文字）可配可切、数量可调、筛选规则可任意组合，出厂 installed=1、enable=0。
 *
 * 筛选规则（后台 `rules` 多选，任意组合，命中任一即算相关；都不选 = 全站范围）：
 *  - forum  同版块：fid 相同
 *  - tags   同标签：当前主题 tags（≤4）任一命中（反规范化列 `tags`，零 JOIN）
 *  - author 同作者：uid 相同
 * 命中强度用于排序（同标签 3 > 同版块 2 > 同作者 1），
 * `fallback=1` 时相关项不足由全站内容按排序时间补齐（不开启则只出命中项）。
 *
 * 数据面：单条 SQL（评分表达式下推 + ok 审核位与可读版块下推），零 N+1、无新表、无迁移。
 * 配置存 ext:related:config（后台「插件中心」表单）；启用标记与展示参数经契约⑦随 bootstrap 下发，
 * 列表数据由 GET /api/related-threads?tid=（modules/plugins/routes.ts，isEnabled 门控）提供。
 */
import type { ExtSchema } from '@freeidx/shared';
import { RunLevel } from '@freeidx/shared';
import type { ExtensionApi, ExtensionModule } from '../core/extensions/registry';
import { loadSetting } from '../core/loaders';
import { loadExtConfig } from '../core/ext-store';
import type { D1b } from '../core/db';
import type { Cache } from '../core/cache';
import { L } from '../core/i18n';

export const RELATED_EXT_ID = 'related';

/** 相关度规则标识（后台 checks 落库值为字符串，逗号分隔） */
export const RELATED_RULES = ['forum', 'tags', 'author'] as const;
export type RelatedRule = (typeof RELATED_RULES)[number];

/** 排序口径：最后回复 / 最新发布 / 回复最多 / 浏览最多 */
const RELATED_ORDERS = ['lastpid', 'tid', 'posts', 'views'] as const;
type RelatedOrder = (typeof RELATED_ORDERS)[number];

/** 解析后的运行态配置（前端也按同名字段消费 bootstrap，勿改名） */
export interface RelatedConfig {
  /** 展示方式：card = 卡片栅格，text = 紧凑文字列表 */
  mode: 'card' | 'text';
  /** 前台是否允许访客在卡片/文字间切换（关闭则固定为 mode） */
  allowSwitch: boolean;
  /** 展示数量（1~20） */
  limit: number;
  /** 生效的筛选规则（空数组 = 全站范围，不做相关性过滤） */
  rules: RelatedRule[];
  /** 命中项不足时是否用全站内容按排序补齐 */
  fallback: boolean;
  /** 时间窗口天数（按最后活跃 last_date；0 = 不限） */
  days: number;
  /** 排序口径 */
  orderby: RelatedOrder;
  /** 卡片/文字项是否展示作者·回复·浏览元信息 */
  showMeta: boolean;
  /** 是否排除付费主题（content_buy > 0） */
  excludePaid: boolean;
  /** 自定义标题（空串 = 前台用多语言默认「相关帖子」） */
  title: string;
}

const RELATED_SCHEMA: ExtSchema = {
  brief: L(
    '在帖子下方、评论区上方展示相关帖子，展示方式（卡片/文字）可切换、数量可调，筛选规则（同版块/同标签/同作者）可任意组合。',
    '在帖子下方、評論區上方展示相關帖子，展示方式（卡片/文字）可切換、數量可調，篩選規則（同版塊/同標籤/同作者）可任意組合。',
    'Shows related threads below the post and above the comments — card/text layout, adjustable count, and any combination of rules (same forum / same tag / same author).',
    'Показывает похожие темы под постом и над комментариями: вид «карточки/текст», настраиваемое количество и любая комбинация правил (тот же раздел / тот же тег / тот же автор).',
    'แสดงกระทู้ที่เกี่ยวข้องใต้โพสต์และเหนือความคิดเห็น รูปแบบการ์ด/ข้อความ จำนวนปรับได้ และรวมกฎได้อิสระ (หมวดเดียวกัน / แท็กเดียวกัน / ผู้เขียนเดียวกัน)',
    'Zeigt ähnliche Themen unter dem Beitrag und über den Kommentaren — Karten-/Textansicht, einstellbare Anzahl und beliebige Kombination der Regeln (gleiches Forum / gleicher Tag / gleicher Autor).',
    '投稿の下・コメント欄の上に関連スレッドを表示します。カード／テキスト表示の切替、件数の調整、ルール（同一版塊／同一タグ／同一投稿者）の自由な組み合わせに対応。',
    '게시글 아래, 댓글 영역 위에 관련 스레드를 표시합니다. 카드/텍스트 보기 전환, 개수 조정, 규칙(같은 게시판/같은 태그/같은 작성자) 자유 조합을 지원합니다.',
    'Muestra temas relacionados debajo del post y encima de los comentarios: vista de tarjetas/texto, cantidad ajustable y cualquier combinación de reglas (mismo foro / misma etiqueta / mismo autor).',
    'Affiche des sujets similaires sous le message et au-dessus des commentaires — affichage cartes/texte, nombre réglable et combinaison libre des règles (même forum / même étiquette / même auteur).',
  ),
  intro: L(
    '启用后帖子详情页会在「主贴下方、评论区上方」出现相关帖子区块。筛选规则可多选并任意组合：勾选的规则之间是「或」关系（命中任意一条即算相关），并按相关度排序（同标签 > 同版块 > 同作者）；一条都不勾 = 全站范围。数量不足时可开启「全站补齐」。没有任何可展示内容时整块不渲染。',
    '啟用後帖子詳情頁會在「主帖下方、評論區上方」出現相關帖子區塊。篩選規則可多選並任意組合：勾選的規則之間是「或」關係（命中任一即算相關），並按相關度排序（同標籤 > 同版塊 > 同作者）；一條都不勾 = 全站範圍。數量不足時可開啟「全站補齊」。沒有任何可展示內容時整塊不渲染。',
    'Once enabled, a related-threads block appears on thread pages between the post and the comments. Rules are multi-select and combine freely: selected rules are OR-ed (match any to be related) and ordered by relevance (same tag > same forum > same author); selecting none means site-wide. Enable “top up site-wide” to fill the list when matches are few. The block is not rendered at all when there is nothing to show.',
    'После включения на странице темы между постом и комментариями появляется блок похожих тем. Правила выбираются и комбинируются свободно: между ними «ИЛИ» (достаточно одного совпадения), сортировка по релевантности (тот же тег > раздел > автор); ничего не выбрано — весь сайт. Включите «дополнять по сайту», если совпадений мало. Если показывать нечего, блок не выводится.',
    'เมื่อเปิดใช้งาน จะมีบล็อกกระทู้ที่เกี่ยวข้องในหน้ากระทู้ ระหว่างโพสต์กับความคิดเห็น กฎเลือกได้หลายข้อและรวมได้อิสระ: ระหว่างกฎเป็น "หรือ" (ตรงข้อใดข้อหนึ่งถือว่าเกี่ยวข้อง) และเรียงตามความเกี่ยวข้อง (แท็กเดียวกัน > หมวดเดียวกัน > ผู้เขียนเดียวกัน); ไม่เลือกเลย = ทั้งเว็บ เปิด "เติมจากทั้งเว็บ" เมื่อผลลัพธ์ไม่พอ หากไม่มีอะไรแสดงจะไม่เรนเดอร์บล็อกนี้',
    'Nach der Aktivierung erscheint auf Themenseiten ein Block ähnlicher Themen zwischen Beitrag und Kommentaren. Regeln sind mehrfach wählbar und frei kombinierbar: zwischen ihnen gilt „ODER“ (eine Übereinstimmung genügt), sortiert nach Relevanz (gleicher Tag > gleiches Forum > gleicher Autor); keine Auswahl = gesamte Website. „Websiteweit auffüllen“ ergänzt bei zu wenigen Treffern. Ohne Inhalte wird der Block gar nicht gerendert.',
    '有効にすると、スレッドページの投稿とコメントの間に「関連スレッド」ブロックが表示されます。ルールは複数選択して自由に組み合わせでき、選択したルール同士は「OR」（いずれか一致で関連）、関連度順（同一タグ > 同一版塊 > 同一投稿者）に並びます。未選択ならサイト全体。件数が足りない場合は「サイト全体で補完」を有効にできます。表示内容が無い場合はブロックごと非表示になります。',
    '활성화하면 스레드 페이지의 게시글과 댓글 사이에 관련 스레드 블록이 표시됩니다. 규칙은 다중 선택 후 자유롭게 조합할 수 있으며 선택한 규칙 간에는 "OR"(하나라도 일치하면 관련), 관련도 순(같은 태그 > 같은 게시판 > 같은 작성자)으로 정렬됩니다. 아무것도 선택하지 않으면 사이트 전체입니다. 결과가 부족하면 "사이트 전체에서 채우기"를 켤 수 있습니다. 표시할 내용이 없으면 블록을 렌더링하지 않습니다.',
    'Al activarlo, en las páginas de tema aparece un bloque de temas relacionados entre el post y los comentarios. Las reglas son multiselección y se combinan libremente: entre ellas hay un «O» (basta una coincidencia) y se ordenan por relevancia (misma etiqueta > mismo foro > mismo autor); sin ninguna marcada = todo el sitio. Activa «completar con todo el sitio» cuando haya pocas coincidencias. Si no hay nada que mostrar, el bloque no se renderiza.',
    'Une fois activé, un bloc de sujets similaires apparaît sur les pages de sujet entre le message et les commentaires. Les règles sont multi-sélection et se combinent librement : elles sont reliées par « OU » (une seule correspondance suffit) et triées par pertinence (même étiquette > même forum > même auteur) ; aucune sélection = tout le site. Activez « compléter avec tout le site » si les correspondances sont rares. Le bloc n’est pas rendu s’il n’y a rien à afficher.',
  ),
  fields: [
    {
      key: 'mode',
      type: 'select',
      label: L('默认展示方式', '預設展示方式', 'Default layout', 'Вид по умолчанию', 'รูปแบบเริ่มต้น', 'Standardansicht', '既定の表示形式', '기본 표시 방식', 'Vista por defecto', 'Affichage par défaut'),
      options: [
        { value: 'card', label: L('卡片', '卡片', 'Cards', 'Карточки', 'การ์ด', 'Karten', 'カード', '카드', 'Tarjetas', 'Cartes') },
        { value: 'text', label: L('文字', '文字', 'Text', 'Текст', 'ข้อความ', 'Text', 'テキスト', '텍스트', 'Texto', 'Texte') },
      ],
      initialValue: 'card',
      help: L(
        '前台默认用卡片栅格还是紧凑文字列表；开启下方「允许前台切换」后访客可自行切换。',
        '前台預設用卡片柵格還是緊湊文字列表；開啟下方「允許前台切換」後訪客可自行切換。',
        'Whether the frontend defaults to a card grid or a compact text list; visitors can switch by themselves when “allow frontend switch” below is on.',
        'Что использовать по умолчанию на фронтенде: сетку карточек или компактный текстовый список. При включённом ниже «разрешить переключение» посетители могут менять вид сами.',
        'ค่าเริ่มต้นฝั่งหน้าเว็บว่าจะใช้การ์ดหรือรายการข้อความแบบกระชับ เมื่อเปิด "อนุญาตให้สลับฝั่งหน้าเว็บ" ด้านล่าง ผู้เยี่ยมชมจะสลับเองได้',
        'Ob das Frontend standardmäßig ein Kartenraster oder eine kompakte Textliste nutzt; bei aktiviertem „Wechsel im Frontend erlauben“ unten können Besucher selbst umschalten.',
        'フロントの既定をカードグリッドにするか、コンパクトなテキストリストにするか。下の「フロントでの切替を許可」を有効にすると訪問者が自分で切り替えられます。',
        '프런트 기본 표시를 카드 그리드로 할지, 간결한 텍스트 목록으로 할지 정합니다. 아래 "프런트 전환 허용"을 켜면 방문자가 직접 전환할 수 있습니다.',
        'Si el frontend usa por defecto una cuadrícula de tarjetas o una lista de texto compacta; con «permitir cambio en el frontend» activado abajo, los visitantes pueden cambiarla.',
        'Affichage par défaut côté frontend : grille de cartes ou liste de texte compacte ; avec « autoriser le changement côté frontend » ci-dessous, les visiteurs peuvent basculer eux-mêmes.',
      ),
    },
    {
      key: 'allowSwitch',
      type: 'switch',
      label: L('允许前台切换展示方式', '允許前台切換展示方式', 'Allow frontend layout switch', 'Разрешить переключение вида', 'อนุญาตให้สลับรูปแบบฝั่งหน้าเว็บ', 'Wechsel im Frontend erlauben', 'フロントでの切替を許可', '프런트 전환 허용', 'Permitir cambio en el frontend', 'Autoriser le changement côté frontend'),
      onValue: 1,
      offValue: 0,
      defaultOn: true,
      help: L(
        '开启后区块右上角出现「卡片/文字」切换按钮，访客的选择记在浏览器本地；关闭则固定为默认展示方式。',
        '開啟後區塊右上角出現「卡片/文字」切換按鈕，訪客的選擇記在瀏覽器本地；關閉則固定為預設展示方式。',
        'When on, a card/text switch appears at the top-right of the block and the visitor’s choice is stored in the browser; when off, the default layout is fixed.',
        'При включении в правом верхнем углу блока появляется переключатель «карточки/текст», выбор посетителя сохраняется в браузере; при выключении вид фиксирован.',
        'เมื่อเปิด จะมีปุ่มสลับ "การ์ด/ข้อความ" ที่มุมขวาบนของบล็อก และตัวเลือกของผู้เยี่ยมชมจะถูกจำไว้ในเบราว์เซอร์ เมื่อปิดจะใช้รูปแบบเริ่มต้นคงที่',
        'Bei Aktivierung erscheint oben rechts im Block ein Umschalter „Karten/Text“, die Auswahl des Besuchers wird im Browser gespeichert; sonst ist die Standardansicht fest.',
        '有効にするとブロック右上に「カード／テキスト」切替が表示され、訪問者の選択はブラウザに保存されます。無効なら既定の表示形式で固定されます。',
        '활성화하면 블록 오른쪽 위에 "카드/텍스트" 전환 버튼이 표시되고 방문자의 선택은 브라우저에 저장됩니다. 비활성화하면 기본 표시 방식으로 고정됩니다.',
        'Al activarlo aparece un conmutador «tarjetas/texto» arriba a la derecha del bloque y la elección del visitante se guarda en el navegador; al desactivarlo se fija la vista por defecto.',
        'Une fois activé, un sélecteur « cartes/texte » apparaît en haut à droite du bloc et le choix du visiteur est conservé dans le navigateur ; sinon l’affichage par défaut est figé.',
      ),
    },
    {
      key: 'limit',
      type: 'text',
      label: L('展示数量', '展示數量', 'Item count', 'Количество', 'จำนวนที่แสดง', 'Anzahl', '表示件数', '표시 개수', 'Cantidad', 'Nombre d’éléments'),
      placeholder: L('如 5（1~20，默认 5）', '如 5（1~20，預設 5）', 'e.g. 5 (1–20, default 5)', 'напр. 5 (1–20, по умолчанию 5)', 'เช่น 5 (1–20 ค่าเริ่มต้น 5)', 'z. B. 5 (1–20, Standard 5)', '例: 5（1〜20、既定 5）', '예: 5(1~20, 기본 5)', 'p. ej. 5 (1–20, por defecto 5)', 'ex. 5 (1–20, par défaut 5)'),
      help: L(
        '区块最多展示的相关帖子条数，超出范围按 1 或 20 处理；留空用默认 5。',
        '區塊最多展示的相關帖子條數，超出範圍按 1 或 20 處理；留空用預設 5。',
        'Maximum number of related threads shown; values outside 1–20 are clamped, empty uses 5.',
        'Максимум похожих тем в блоке; значения вне 1–20 обрезаются, пусто — 5.',
        'จำนวนกระทู้ที่เกี่ยวข้องสูงสุดในบล็อก ค่านอกช่วง 1–20 จะถูกปรับ และเว้นว่างใช้ 5',
        'Maximale Anzahl ähnlicher Themen im Block; Werte außerhalb 1–20 werden begrenzt, leer = 5.',
        'ブロックに表示する関連スレッドの最大件数。1〜20 の範囲外は補正され、空欄は 5 です。',
        '블록에 표시할 관련 스레드 최대 개수입니다. 1~20 범위를 벗어나면 보정되며 비워 두면 5입니다.',
        'Número máximo de temas relacionados mostrados; fuera de 1–20 se ajusta y vacío usa 5.',
        'Nombre maximal de sujets similaires affichés ; hors 1–20 la valeur est ajustée, vide = 5.',
      ),
    },
    {
      key: 'rules',
      type: 'checks',
      label: L('筛选规则（可多选组合）', '篩選規則（可多選組合）', 'Filter rules (multi-select)', 'Правила отбора (мультивыбор)', 'กฎการคัดกรอง (เลือกได้หลายข้อ)', 'Filterregeln (Mehrfachauswahl)', '絞り込みルール（複数選択）', '필터 규칙(다중 선택)', 'Reglas de filtrado (multiselección)', 'Règles de filtrage (multi-sélection)'),
      options: [
        { value: 'forum', label: L('同版块', '同版塊', 'Same forum', 'Тот же раздел', 'หมวดเดียวกัน', 'Gleiches Forum', '同一版塊', '같은 게시판', 'Mismo foro', 'Même forum') },
        { value: 'tags', label: L('同标签', '同標籤', 'Same tag', 'Тот же тег', 'แท็กเดียวกัน', 'Gleicher Tag', '同一タグ', '같은 태그', 'Misma etiqueta', 'Même étiquette') },
        { value: 'author', label: L('同作者', '同作者', 'Same author', 'Тот же автор', 'ผู้เขียนเดียวกัน', 'Gleicher Autor', '同一投稿者', '같은 작성자', 'Mismo autor', 'Même auteur') },
      ],
      separator: ',',
      initialValue: 'forum,tags',
      help: L(
        '勾选多条即「或」组合：命中任意一条就算相关，排序按同标签 > 同版块 > 同作者。一条都不勾 = 全站范围（按下方排序口径取内容）。',
        '勾選多條即「或」組合：命中任一條就算相關，排序按同標籤 > 同版塊 > 同作者。一條都不勾 = 全站範圍（按下方排序口徑取內容）。',
        'Multiple selections are OR-ed: matching any rule counts as related, ordered by same tag > same forum > same author. Selecting none means site-wide (content picked by the sort below).',
        'Несколько выбранных правил объединяются через «ИЛИ»: достаточно одного совпадения; сортировка — тег > раздел > автор. Ничего не выбрано — весь сайт (по сортировке ниже).',
        'เลือกหลายข้อจะเป็นการรวมแบบ "หรือ": ตรงข้อใดข้อหนึ่งถือว่าเกี่ยวข้อง เรียงตามแท็กเดียวกัน > หมวดเดียวกัน > ผู้เขียนเดียวกัน ไม่เลือกเลย = ทั้งเว็บ (ตามการเรียงด้านล่าง)',
        'Mehrere Auswahlmöglichkeiten werden per „ODER“ kombiniert: eine Übereinstimmung genügt, sortiert nach Tag > Forum > Autor. Keine Auswahl = gesamte Website (gemäß Sortierung unten).',
        '複数選択は「OR」で組み合わされます。いずれか一致すれば関連とみなし、同一タグ > 同一版塊 > 同一投稿者の順に並びます。未選択ならサイト全体（下の並び順で取得）。',
        '여러 개를 선택하면 "OR"로 조합됩니다. 하나라도 일치하면 관련으로 간주하며 같은 태그 > 같은 게시판 > 같은 작성자 순으로 정렬합니다. 아무것도 선택하지 않으면 사이트 전체(아래 정렬 기준)입니다.',
        'Varias selecciones se combinan con «O»: basta una coincidencia, ordenado por misma etiqueta > mismo foro > mismo autor. Sin selección = todo el sitio (según el orden de abajo).',
        'Plusieurs sélections sont combinées par « OU » : une seule correspondance suffit, triées par même étiquette > même forum > même auteur. Aucune sélection = tout le site (selon le tri ci-dessous).',
      ),
    },
    {
      key: 'fallback',
      type: 'switch',
      label: L('数量不足时全站补齐', '數量不足時全站補齊', 'Top up site-wide when short', 'Дополнять по сайту', 'เติมจากทั้งเว็บเมื่อไม่พอ', 'Websiteweit auffüllen', '不足時にサイト全体で補完', '부족하면 사이트 전체에서 채우기', 'Completar con todo el sitio', 'Compléter avec tout le site'),
      onValue: 1,
      offValue: 0,
      defaultOn: true,
      help: L(
        '开启：相关帖子不足设定数量时，用全站内容（按下方排序口径）补齐；关闭：只展示真正命中规则的帖子，不足就少展示。',
        '開啟：相關帖子不足設定數量時，用全站內容（按下方排序口徑）補齊；關閉：只展示真正命中規則的帖子，不足就少展示。',
        'On: fill up to the configured count with site-wide content (by the sort below). Off: only truly matching threads are shown, even if fewer than the count.',
        'Вкл.: дополнить до заданного количества контентом со всего сайта (по сортировке ниже). Выкл.: показывать только реально совпавшие темы, даже если их меньше.',
        'เปิด: เติมให้ครบจำนวนด้วยเนื้อหาทั้งเว็บ (ตามการเรียงด้านล่าง) ปิด: แสดงเฉพาะกระทู้ที่ตรงกฎจริง แม้จะน้อยกว่าจำนวนก็ตาม',
        'Ein: Bis zur eingestellten Anzahl mit websiteweiten Inhalten auffüllen (gemäß Sortierung unten). Aus: Nur tatsächlich passende Themen anzeigen, auch wenn es weniger sind.',
        'オン：設定件数に満たない場合、サイト全体の内容（下の並び順）で補完します。オフ：実際にルールに一致したスレッドのみを表示し、件数が少なくてもそのままにします。',
        '켜짐: 설정 개수까지 사이트 전체 콘텐츠(아래 정렬 기준)로 채웁니다. 꺼짐: 실제로 규칙에 맞는 스레드만 표시하며 개수가 적어도 그대로 둡니다.',
        'Activado: completa hasta la cantidad configurada con contenido de todo el sitio (según el orden de abajo). Desactivado: solo se muestran temas que realmente coinciden, aunque sean menos.',
        'Activé : complète jusqu’au nombre configuré avec le contenu de tout le site (selon le tri ci-dessous). Désactivé : seuls les sujets réellement correspondants sont affichés, même s’il y en a moins.',
      ),
    },
    {
      key: 'days',
      type: 'text',
      label: L('时间窗口（天）', '時間視窗（天）', 'Time window (days)', 'Временное окно (дни)', 'ช่วงเวลา (วัน)', 'Zeitfenster (Tage)', '期間（日）', '기간(일)', 'Ventana temporal (días)', 'Fenêtre temporelle (jours)'),
      placeholder: L('如 365，0=不限', '如 365，0=不限', 'e.g. 365; 0 = no limit', 'напр. 365; 0 = без ограничений', 'เช่น 365, 0=ไม่จำกัด', 'z. B. 365; 0 = unbegrenzt', '例: 365、0=無制限', '예: 365, 0=제한 없음', 'p. ej. 365; 0 = sin límite', 'ex. 365 ; 0 = sans limite'),
      help: L(
        '只取最近 N 天内有活动的主题（按最后回复时间）；留空用默认 365，填 0 表示不限时间。',
        '只取最近 N 天內有活動的主題（按最後回覆時間）；留空用預設 365，填 0 表示不限時間。',
        'Only threads active within the last N days (by last reply time); empty uses 365, 0 means no limit.',
        'Брать только темы с активностью за последние N дней (по времени последнего ответа); пусто — 365, 0 — без ограничения.',
        'เอาเฉพาะกระทู้ที่มีกิจกรรมภายใน N วันล่าสุด (ตามเวลาตอบล่าสุด) เว้นว่างใช้ 365, 0=ไม่จำกัด',
        'Nur Themen mit Aktivität in den letzten N Tagen (nach letzter Antwort); leer = 365, 0 = unbegrenzt.',
        '最後の返信が直近 N 日以内のスレッドのみ対象（空欄は 365、0 は無制限）。',
        '최근 N일 이내에 활동한 스레드만 대상으로 합니다(마지막 답글 시간 기준). 비워 두면 365, 0은 제한 없음입니다.',
        'Solo temas con actividad en los últimos N días (por última respuesta); vacío usa 365, 0 = sin límite.',
        'Uniquement les sujets actifs ces N derniers jours (selon la dernière réponse) ; vide = 365, 0 = sans limite.',
      ),
    },
    {
      key: 'orderby',
      type: 'select',
      label: L('排序方式', '排序方式', 'Sort order', 'Сортировка', 'การเรียงลำดับ', 'Sortierung', '並び順', '정렬 기준', 'Orden', 'Tri'),
      options: [
        { value: 'lastpid', label: L('最后回复', '最後回覆', 'Last reply', 'Последний ответ', 'ตอบล่าสุด', 'Letzte Antwort', '最終返信', '최근 답글', 'Última respuesta', 'Dernière réponse') },
        { value: 'tid', label: L('最新发布', '最新發布', 'Newest', 'Новые', 'ใหม่สุด', 'Neueste', '新着', '최신', 'Más recientes', 'Plus récents') },
        { value: 'posts', label: L('回复最多', '回覆最多', 'Most replies', 'Больше ответов', 'ตอบมากสุด', 'Meiste Antworten', '返信が多い', '답글 많은 순', 'Más respuestas', 'Plus de réponses') },
        { value: 'views', label: L('浏览最多', '瀏覽最多', 'Most views', 'Больше просмотров', 'เข้าชมมากสุด', 'Meiste Aufrufe', '閲覧が多い', '조회 많은 순', 'Más vistas', 'Plus de vues') },
      ],
      initialValue: 'lastpid',
      help: L(
        '在相关度（同标签 > 同版块 > 同作者）之后按此口径排序；全站补齐的内容同样按它排序。',
        '在相關度（同標籤 > 同版塊 > 同作者）之後按此口徑排序；全站補齊的內容同樣按它排序。',
        'Applied after relevance (same tag > same forum > same author); site-wide top-up content uses it too.',
        'Применяется после релевантности (тег > раздел > автор); добор по сайту сортируется так же.',
        'ใช้หลังจากความเกี่ยวข้อง (แท็ก > หมวด > ผู้เขียน) และใช้กับการเติมจากทั้งเว็บด้วย',
        'Wird nach der Relevanz (Tag > Forum > Autor) angewendet; websiteweit aufgefüllte Inhalte nutzen sie ebenfalls.',
        '関連度（同一タグ > 同一版塊 > 同一投稿者）の後に適用されます。サイト全体での補完内容も同じ並びです。',
        '관련도(같은 태그 > 같은 게시판 > 같은 작성자) 다음에 적용되며, 사이트 전체 보충 콘텐츠도 같은 기준으로 정렬합니다.',
        'Se aplica después de la relevancia (misma etiqueta > mismo foro > mismo autor); el contenido de relleno también usa este orden.',
        'Appliqué après la pertinence (même étiquette > même forum > même auteur) ; le contenu de complément suit aussi ce tri.',
      ),
    },
    {
      key: 'showMeta',
      type: 'switch',
      label: L('显示元信息', '顯示元資訊', 'Show metadata', 'Показывать метаданные', 'แสดงข้อมูลประกอบ', 'Metadaten anzeigen', 'メタ情報を表示', '메타 정보 표시', 'Mostrar metadatos', 'Afficher les métadonnées'),
      onValue: 1,
      offValue: 0,
      defaultOn: true,
      help: L(
        '开启后每项显示作者、回复数与浏览数；关闭只保留标题，版面更紧凑。',
        '開啟後每項顯示作者、回覆數與瀏覽數；關閉只保留標題，版面更緊湊。',
        'When on, each item shows author, replies and views; when off, only the title is kept for a tighter layout.',
        'При включении у каждого пункта видны автор, число ответов и просмотров; при выключении остаётся только заголовок — компактнее.',
        'เมื่อเปิด แต่ละรายการจะแสดงผู้เขียน จำนวนตอบ และจำนวนเข้าชม เมื่อปิดจะเหลือเฉพาะหัวข้อ ทำให้กระชับขึ้น',
        'Bei Aktivierung zeigt jeder Eintrag Autor, Antworten und Aufrufe; sonst bleibt nur der Titel — kompakter.',
        '有効にすると各項目に投稿者・返信数・閲覧数を表示します。無効ならタイトルのみで、よりコンパクトになります。',
        '활성화하면 각 항목에 작성자, 답글 수, 조회 수를 표시합니다. 비활성화하면 제목만 남아 더 간결합니다.',
        'Al activarlo, cada elemento muestra autor, respuestas y vistas; al desactivarlo solo queda el título, más compacto.',
        'Une fois activé, chaque élément affiche l’auteur, les réponses et les vues ; sinon seul le titre reste, plus compact.',
      ),
    },
    {
      key: 'excludePaid',
      type: 'switch',
      label: L('排除付费主题', '排除付費主題', 'Exclude paid threads', 'Исключить платные темы', 'ไม่รวมกระทู้แบบชำระเงิน', 'Kostenpflichtige Themen ausschließen', '有料スレッドを除外', '유료 스레드 제외', 'Excluir temas de pago', 'Exclure les sujets payants'),
      onValue: 1,
      offValue: 0,
      defaultOn: false,
      help: L(
        '开启后 content_buy > 0 的付费主题不出现在相关列表里（避免把付费内容变成免费入口）。',
        '開啟後 content_buy > 0 的付費主題不出現在相關列表裡（避免把付費內容變成免費入口）。',
        'When on, threads with content_buy > 0 are excluded from the related list (keeps paid content behind its paywall).',
        'При включении темы с content_buy > 0 не попадают в список похожих (платный контент не становится бесплатным входом).',
        'เมื่อเปิด กระทู้ที่มี content_buy > 0 จะไม่แสดงในรายการที่เกี่ยวข้อง (ไม่ให้เนื้อหาแบบชำระเงินกลายเป็นทางเข้าฟรี)',
        'Bei Aktivierung werden Themen mit content_buy > 0 aus der Liste ausgeschlossen (bezahlte Inhalte bleiben hinter der Paywall).',
        '有効にすると content_buy > 0 の有料スレッドは関連リストに表示されません（有料コンテンツが無料の入口にならないようにします）。',
        '활성화하면 content_buy > 0인 유료 스레드는 관련 목록에 표시되지 않습니다(유료 콘텐츠가 무료 진입점이 되지 않도록).',
        'Al activarlo, los temas con content_buy > 0 se excluyen de la lista de relacionados (el contenido de pago sigue tras su muro).',
        'Une fois activé, les sujets avec content_buy > 0 sont exclus de la liste (le contenu payant reste derrière son paywall).',
      ),
    },
    {
      key: 'title',
      type: 'text',
      label: L('区块标题', '區塊標題', 'Block title', 'Заголовок блока', 'หัวข้อบล็อก', 'Blocktitel', 'ブロック見出し', '블록 제목', 'Título del bloque', 'Titre du bloc'),
      placeholder: L('留空使用默认「相关帖子」', '留空使用預設「相關帖子」', 'Empty = default “Related threads”', 'Пусто — «Похожие темы»', 'เว้นว่าง = "กระทู้ที่เกี่ยวข้อง"', 'Leer = „Ähnliche Themen“', '空欄 = 「関連スレッド」', '비워 두면 "관련 스레드"', 'Vacío = «Temas relacionados»', 'Vide = « Sujets similaires »'),
      help: L(
        '自定义区块标题，最长 40 字；留空时前台按访客界面语言显示「相关帖子」。',
        '自訂區塊標題，最長 40 字；留空時前台按訪客介面語言顯示「相關帖子」。',
        'Custom block title, up to 40 characters; when empty the frontend shows “Related threads” in the visitor’s language.',
        'Свой заголовок блока, до 40 символов; если пусто, фронтенд покажет «Похожие темы» на языке посетителя.',
        'หัวข้อบล็อกกำหนดเอง ไม่เกิน 40 ตัวอักษร หากเว้นว่างฝั่งหน้าเว็บจะแสดง "กระทู้ที่เกี่ยวข้อง" ตามภาษาของผู้เยี่ยมชม',
        'Eigener Blocktitel, maximal 40 Zeichen; leer zeigt das Frontend „Ähnliche Themen“ in der Sprache des Besuchers.',
        'ブロック見出しをカスタム（最大 40 文字）。空欄なら訪問者の言語で「関連スレッド」を表示します。',
        '블록 제목을 직접 지정합니다(최대 40자). 비워 두면 방문자 언어로 "관련 스레드"를 표시합니다.',
        'Título personalizado del bloque, hasta 40 caracteres; si está vacío, el frontend muestra «Temas relacionados» en el idioma del visitante.',
        'Titre de bloc personnalisé, 40 caractères max ; vide, le frontend affiche « Sujets similaires » dans la langue du visiteur.',
      ),
    },
  ],
};

/** 布尔位解析：缺省/空串按 fallback，仅明确的真值算 1 */
function boolOf(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  return v === 1 || v === true || v === '1' || v === 'true' || v === 'on';
}

/** 后台配置 → 运行态（非法值一律回落默认，绝不因配置写错让区块 500） */
export function parseRelatedConfig(config: Record<string, unknown>): RelatedConfig {
  const limitRaw = Number(config.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(20, Math.floor(limitRaw)) : 5;
  const daysRaw = Number(config.days);
  const days = config.days === undefined || config.days === '' || !Number.isFinite(daysRaw) ? 365 : Math.max(0, Math.min(3650, Math.floor(daysRaw)));
  const rules = String(config.rules ?? 'forum,tags')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is RelatedRule => (RELATED_RULES as readonly string[]).includes(s));
  // 显式留空（空串）= 全站范围，与「未配置」的默认值区分开
  const picked = config.rules === '' ? [] : [...new Set(rules)];
  const orderRaw = String(config.orderby ?? 'lastpid');
  const orderby = (RELATED_ORDERS as readonly string[]).includes(orderRaw) ? (orderRaw as RelatedOrder) : 'lastpid';
  return {
    mode: config.mode === 'text' ? 'text' : 'card',
    allowSwitch: boolOf(config.allowSwitch, true),
    limit,
    rules: picked,
    fallback: boolOf(config.fallback, true),
    days,
    orderby,
    showMeta: boolOf(config.showMeta, true),
    excludePaid: boolOf(config.excludePaid, false),
    title: String(config.title ?? '').trim().slice(0, 40),
  };
}

/** 读相关帖子配置（ext:related:config，三层缓存读穿） */
export function loadRelatedConfig(cache: Cache, db: D1b): Promise<RelatedConfig> {
  return loadExtConfig(cache, db, RELATED_EXT_ID).then(parseRelatedConfig);
}

/** 前台下发视图（bootstrap 用；与列表接口字段口径一致，仅去掉查询侧字段） */
export interface RelatedPublicConfig {
  enabled: true;
  mode: 'card' | 'text';
  allowSwitch: boolean;
  limit: number;
  showMeta: boolean;
  title: string;
}

export function publicRelatedConfig(cfg: RelatedConfig): RelatedPublicConfig {
  return { enabled: true, mode: cfg.mode, allowSwitch: cfg.allowSwitch, limit: cfg.limit, showMeta: cfg.showMeta, title: cfg.title };
}

/** 相关列表行（显式投影，绝不触碰 post 正文列） */
interface RelatedRow {
  tid: number;
  fid: number;
  uid: number;
  username: string;
  subject: string;
  posts: number;
  views: number;
  create_date: number;
  last_date: number;
  content_buy: number;
  tags: string;
}

export interface RelatedItem {
  tid: number;
  fid: number;
  subject: string;
  username: string;
  posts: number;
  views: number;
  createDate: number;
  lastDate: number;
  /** 命中的相关度来源（tags/forum/author；全站补齐为空数组），前端可据此展示徽标 */
  reasons: RelatedRule[];
}

export interface RelatedQueryOpts {
  tid: number;
  fid: number;
  uid: number;
  /** 当前主题标签（已按 ≤4 截断） */
  tags: string[];
  /** 当前访问者组可读的版块 fid 集合（权限下推） */
  readableFids: number[];
  viewerUid: number;
  seeCheck: boolean;
  cfg: RelatedConfig;
}

/**
 * 相关主题查询：单条 SQL 完成「可读版块 + 审核可见性 + 时间窗 + 付费过滤 + 规则 OR + 相关度排序」。
 * 评分表达式与匹配条件共用同一批参数（先 SELECT 后 WHERE，故 selectParams / whereParams 分开绑定）。
 */
export async function queryRelatedThreads(db: D1b, opts: RelatedQueryOpts): Promise<RelatedItem[]> {
  const { cfg } = opts;
  if (!opts.readableFids.length || cfg.limit <= 0) return [];
  const selectParams: unknown[] = [];
  const scoreParts: string[] = [];
  const matchParts: string[] = [];
  const whereParams: unknown[] = [];

  // 评分与匹配条件必须同一口径：命中同标签 3 分、同版块 2 分、同作者 1 分
  if (cfg.rules.includes('tags') && opts.tags.length) {
    for (const tag of opts.tags) {
      scoreParts.push(`(CASE WHEN instr(','||tags||',', ?) > 0 THEN 3 ELSE 0 END)`);
      selectParams.push(`,${tag},`);
      matchParts.push(`instr(','||tags||',', ?) > 0`);
      whereParams.push(`,${tag},`);
    }
  }
  if (cfg.rules.includes('forum') && opts.fid > 0) {
    scoreParts.push(`(CASE WHEN fid = ? THEN 2 ELSE 0 END)`);
    selectParams.push(opts.fid);
    matchParts.push('fid = ?');
    whereParams.push(opts.fid);
  }
  if (cfg.rules.includes('author') && opts.uid > 0) {
    scoreParts.push(`(CASE WHEN uid = ? THEN 1 ELSE 0 END)`);
    selectParams.push(opts.uid);
    matchParts.push('uid = ?');
    whereParams.push(opts.uid);
  }

  const score = scoreParts.length ? `(${scoreParts.join(' + ')})` : '0';
  const ph = opts.readableFids.map(() => '?').join(',');
  const okCond = opts.seeCheck ? ' AND ok <> -2' : ' AND (ok = 1 OR (uid = ? AND ok <> -2))';
  const okParams: unknown[] = opts.seeCheck ? [] : [opts.viewerUid];
  const daysCond = cfg.days > 0 ? ' AND last_date >= ?' : '';
  const daysParams: unknown[] = cfg.days > 0 ? [Math.floor(Date.now() / 1000) - cfg.days * 86400] : [];
  const paidCond = cfg.excludePaid ? ' AND content_buy <= 0' : '';
  // 配了规则却一条可判定条件都建不出来（如只勾「同标签」但本帖无标签）：不补齐时直接空，
  // 否则会把「全站内容」当成命中项展示，与「只展示真正命中规则的帖子」语义冲突。
  if (!cfg.fallback && cfg.rules.length > 0 && matchParts.length === 0) return [];
  // fallback=1：不按规则过滤，仅靠 score 把命中项排在前面（score=0 的全站内容在后补齐）
  const match = !cfg.fallback && matchParts.length ? ` AND (${matchParts.join(' OR ')})` : '';
  const order = cfg.orderby;
  const sql =
    `SELECT tid,fid,uid,username,subject,posts,views,create_date,last_date,content_buy,tags,${score} AS score` +
    ` FROM bbs_thread WHERE tid <> ? AND fid IN (${ph})${okCond}${daysCond}${paidCond}${match}` +
    ` ORDER BY score DESC, ${order} DESC, tid DESC LIMIT ?`;
  const bindParams = [
    ...selectParams,
    opts.tid,
    ...opts.readableFids,
    ...okParams,
    ...daysParams,
    ...(match ? whereParams : []),
    cfg.limit,
  ];
  const r = await db.prepare<RelatedRow & { score: number }>(sql).bind(...bindParams).all();

  const rules = cfg.rules;
  return r.results.map((row) => {
    const tags = String(row.tags ?? '');
    const reasons: RelatedRule[] = [];
    if (rules.includes('tags') && opts.tags.some((tag) => tags.split(',').includes(tag))) reasons.push('tags');
    if (rules.includes('forum') && Number(row.fid) === opts.fid) reasons.push('forum');
    if (rules.includes('author') && Number(row.uid) === opts.uid) reasons.push('author');
    return {
      tid: Number(row.tid),
      fid: Number(row.fid),
      subject: String(row.subject),
      username: String(row.username),
      posts: Number(row.posts),
      views: Number(row.views),
      createDate: Number(row.create_date),
      lastDate: Number(row.last_date),
      reasons,
    };
  });
}

export const relatedPlugin: ExtensionModule = {
  manifest: {
    id: RELATED_EXT_ID,
    name: L('相关帖子', '相關帖子', 'Related Threads', 'Похожие темы', 'กระทู้ที่เกี่ยวข้อง', 'Ähnliche Themen', '関連スレッド', '관련 스레드', 'Temas relacionados', 'Sujets similaires'),
    version: '1.0.0',
    installed: 1,
    enable: 0, // 出厂停用：后台「插件中心」启用后生效（与 ads/checkin 一致）
    capabilities: { positions: ['thread_bottom'], layouts: ['card', 'text'], rules: [...RELATED_RULES] },
  },
  schema: RELATED_SCHEMA,
  setup(api: ExtensionApi) {
    // 契约 ⑦：启用标记 + 展示参数随核心 bootstrap 一次下发（与访客无关，可随游客边缘缓存共享）
    api.contributeBootstrap(async (ext) => {
      const ctx = api.ctx;
      if (!ctx) return;
      const { db, cache } = ctx as { db: D1b; cache: Cache };
      // runlevel 关站短路（§17.4）：关站时区块自动收起
      const setting = await loadSetting(cache, db);
      if (setting.runlevel <= RunLevel.CLOSED_SITE) return;
      ext['related'] = publicRelatedConfig(await loadRelatedConfig(cache, db));
    });
  },
};
