/**
 * 三个遗留功能扩展（manifest 仅供后台扩展目录可见）：
 *  - idx_view_boost                    虚拟点击：浏览量自增倍数（thread/routes.ts 读路由增量 ceil(beishu)）
 *  - idx_quick_reply   快速回复限制：单帖单用户回帖上限拦截（write/routes.ts）+ 前台下拉数据公开端点
 *  - idx_insert_code           插入代码：八个页面注入位原始 HTML 的公开读取端点（GET /api/insert-codes）
 * 与支付通道同理不进 EXTENSION_MODULES（不贡献 bootstrap/事件/注册路由，避免热路径预载 config）；
 * 行为侧由核心路由经 isEnabled(manifest, state) 判定启停，配置存 ext:{id}:config（后台通用表单读写）。
 */
import type { ExtensionManifest, ExtSchema, ExtField } from '@freeidx/shared';
import type { ExtensionApi, ExtensionModule } from '../core/extensions/registry';
import { L } from '../core/i18n';

const manifestOf = (id: string, name: Record<string, string>): ExtensionManifest => ({
  id,
  name,
  version: '1.0.0',
  installed: 1,
  enable: 0, // 出厂停用：浏览倍增/回帖拦截/代码注入均非常规默认，后台启用后才生效
});

/** 虚拟点击扩展：配置 { beishu }，浏览量增量 = ceil(beishu) */
export const IDX_EXT_ID = 'idx_view_boost';
export const IDX_MANIFEST: ExtensionManifest = manifestOf(IDX_EXT_ID, L('虚拟点击', '虛擬點擊', 'Virtual Views', 'Виртуальные просмотры', 'ยอดเข้าชมเสมือน', 'Virtuelle Aufrufe', 'バーチャル閲覧数', '가상 조회수', 'Vistas virtuales', 'Vues virtuelles'));
const IDX_SCHEMA: ExtSchema = {
  brief: L(
    '虚拟点击：帖子浏览量按设定的倍数自动增加，用于前台热度展示。',
    '虛擬點擊：帖子瀏覽量按設定的倍數自動增加，用於前台熱度展示。',
    'Virtual views: thread view counts auto-increase by a configured multiplier, for frontend popularity display.',
    'Виртуальные просмотры: счётчик просмотров тем автоматически растёт с заданным множителем — для показа «популярности» на фронтенде.',
    'ยอดเข้าชมเสมือน: ยอดเข้าชมของกระทู้เพิ่มขึ้นอัตโนมัติตามตัวคูณที่ตั้งไว้ ใช้แสดงความนิยมฝั่งหน้าเว็บ',
    'Virtuelle Aufrufe: Die Aufrufzahl von Threads steigt automatisch um einen konfigurierten Faktor — für die Popularitätsanzeige im Frontend.',
    'バーチャル閲覧数：スレッドの閲覧数が設定した倍率で自動増加します。フロントの人気表示用。',
    '가상 조회수: 스레드 조회수가 설정한 배수로 자동 증가합니다. 프런트 인기 표시용.',
    'Vistas virtuales: las vistas de los temas aumentan automáticamente según un multiplicador configurado, para mostrar popularidad en el frontend.',
    'Vues virtuelles : le nombre de vues des sujets augmente automatiquement selon un multiplicateur configuré, pour l’affichage de popularité côté frontend.',
  ),
  intro: L(
    '启用后每次浏览会按倍数增加浏览量：填 3 → 每次浏览 +3；填 0.5 → 每次浏览 +1（小数会向上取整）。倍数留空或 ≤0 时按 1（即正常计数）。',
    '啟用後每次瀏覽會按倍數增加瀏覽量：填 3 → 每次瀏覽 +3；填 0.5 → 每次瀏覽 +1（小數會向上取整）。倍數留空或 ≤0 時按 1（即正常計數）。',
    'Once enabled, each view increases the view count by the multiplier: enter 3 → +3 per view; enter 0.5 → +1 per view (fractions round up). Leave empty or ≤0 for 1 (normal counting).',
    'После включения каждый просмотр увеличивает счётчик на множитель: введите 3 → +3 за просмотр; 0,5 → +1 за просмотр (дробные округляются вверх). Пусто или ≤0 — как 1 (обычный счёт).',
    'เมื่อเปิดใช้งาน ยอดเข้าชมจะเพิ่มตามตัวคูณ: ใส่ 3 → แต่ละครั้ง +3; ใส่ 0.5 → แต่ละครั้ง +1 (ทศนิยมปัดขึ้น) เว้นว่างหรือ ≤0 ถือเป็น 1 (นับปกติ)',
    'Nach der Aktivierung erhöht jeder Aufruf die Zahl um den Faktor: 3 eingeben → +3 pro Aufruf; 0,5 → +1 pro Aufruf (Brüche werden aufgerundet). Leer oder ≤0 gilt als 1 (normale Zählung).',
    '有効にすると閲覧のたびに倍率分だけ閲覧数が増えます：3 を入力 → 閲覧ごと +3；0.5 を入力 → 閲覧ごと +1（小数は切り上げ）。空欄または ≤0 は 1（通常カウント）として扱います。',
    '활성화하면 조회할 때마다 배수만큼 조회수가 증가합니다: 3 입력 → 조회당 +3, 0.5 입력 → 조회당 +1(소수는 올림). 비워 두거나 ≤0이면 1(일반 카운트)로 처리됩니다.',
    'Una vez activado, cada vista aumenta el contador según el multiplicador: 3 → +3 por vista; 0.5 → +1 por vista (los decimales se redondean hacia arriba). Vacío o ≤0 equivale a 1 (recuento normal).',
    'Une fois activé, chaque vue augmente le compteur selon le multiplicateur : 3 → +3 par vue ; 0.5 → +1 par vue (les décimales sont arrondies au supérieur). Vide ou ≤0 équivaut à 1 (comptage normal).',
  ),
  fields: [
    {
      key: 'beishu',
      type: 'text',
      label: L('浏览量倍数', '瀏覽量倍數', 'View multiplier', 'Множитель просмотров', 'ตัวคูณยอดเข้าชม', 'Aufruf-Faktor', '閲覧数倍率', '조회수 배수', 'Multiplicador de vistas', 'Multiplicateur de vues'),
      placeholder: L('如 3（留空或 ≤0 按 1）', '如 3（留空或 ≤0 按 1）', 'e.g. 3 (empty or ≤0 counts as 1)', 'напр. 3 (пусто или ≤0 — как 1)', 'เช่น 3 (เว้นว่างหรือ ≤0 ถือเป็น 1)', 'z. B. 3 (leer oder ≤0 gilt als 1)', '例: 3（空欄または ≤0 は 1）', '예: 3(비워 두거나 ≤0이면 1)', 'p. ej. 3 (vacío o ≤0 cuenta como 1)', 'ex. 3 (vide ou ≤0 compte pour 1)'),
      help: L(
        '每次浏览增加的浏览量倍数，填正数生效。注意：仅用于前台展示，不代表真实访问量。',
        '每次瀏覽增加的瀏覽量倍數，填正數生效。注意：僅用於前台展示，不代表真實訪問量。',
        'Multiplier added per view; only positive numbers take effect. Note: for frontend display only, does not reflect real traffic.',
        'Множитель, добавляемый за каждый просмотр; действует только положительное число. Внимание: только для показа на фронтенде, не отражает реальный трафик.',
        'ตัวคูณที่เพิ่มต่อการเข้าชม ต้องใส่เลขบวกจึงมีผล หมายเหตุ: ใช้แสดงผลฝั่งหน้าเว็บเท่านั้น ไม่สะท้อนการเข้าชมจริง',
        'Faktor, der pro Aufruf addiert wird; nur positive Werte sind wirksam. Hinweis: nur für die Frontend-Anzeige, kein Abbild des echten Traffics.',
        '閲覧ごとに加算される倍率です。正の数を入力すると有効になります。注意：フロント表示専用で、実際のアクセス数を表しません。',
        '조회할 때마다 더해지는 배수이며 양수를 입력해야 효과가 있습니다. 주의: 프런트 표시용일 뿐 실제 트래픽을 반영하지 않습니다.',
        'Multiplicador añadido por vista; solo surte efecto con números positivos. Nota: solo para mostrar en el frontend, no refleja el tráfico real.',
        'Multiplicateur ajouté par vue ; seuls les nombres positifs sont effectifs. Attention : réservé à l’affichage frontend, ne reflète pas le trafic réel.',
      ),
    },
  ],
};
export const idxViewBoostModule: ExtensionModule = {
  manifest: IDX_MANIFEST,
  schema: IDX_SCHEMA,
  setup(_api: ExtensionApi): void {
    /* 行为接在核心 thread 读路由（views 增量），无注册点 */
  },
};

/** 快速回复限制扩展：配置键为存储键（勿改名） */
export const QUICK_REPLY_EXT_ID = 'idx_quick_reply';
export const QUICK_REPLY_MANIFEST: ExtensionManifest = manifestOf(QUICK_REPLY_EXT_ID, L('快速回复限制', '快速回覆限制', 'Quick Reply Limit', 'Лимит быстрых ответов', 'จำกัดการตอบด่วน', 'Schnellantwort-Limit', 'クイック返信制限', '빠른 답글 제한', 'Límite de respuesta rápida', 'Limite de réponse rapide'));
const QUICK_REPLY_SCHEMA: ExtSchema = {
  brief: L(
    '快速回复限制：同一用户在单帖内的回帖数达上限后禁止继续回帖，并为回帖框提供常用语下拉。',
    '快速回覆限制：同一使用者在單帖內的回覆數達上限後禁止繼續回覆，並為回覆框提供常用語下拉。',
    'Quick reply limit: blocks a user from replying further in a thread once their reply count reaches the cap, and adds a common-phrases dropdown to the reply box.',
    'Лимит быстрых ответов: запрещает пользователю отвечать дальше в теме по достижении лимита ответов и добавляет в поле ответа выпадающий список частых фраз.',
    'จำกัดการตอบด่วน: ห้ามผู้ใช้ตอบต่อในกระทู้เมื่อจำนวนตอบของเขาถึงขีดจำกัด และเพิ่มดรอปดาวน์วลีที่ใช้บ่อยให้กล่องตอบ',
    'Schnellantwort-Limit: sperrt Nutzer nach Erreichen der Antwortobergrenze in einem Thread und ergänzt das Antwortfeld um ein Dropdown mit häufigen Formulierungen.',
    'クイック返信制限：同一ユーザーのスレッド内返信数が上限に達すると返信を禁止し、返信ボックスに定型句ドロップダウンを追加します。',
    '빠른 답글 제한: 한 사용자의 스레드 내 답글 수가 상한에 도달하면 추가 답글을 차단하고 답글 상자에 자주 쓰는 문구 드롭다운을 추가합니다.',
    'Límite de respuesta rápida: impide que un usuario siga respondiendo en un tema al alcanzar su límite de respuestas, y añade un desplegable de frases habituales al cuadro de respuesta.',
    'Limite de réponse rapide : empêche un utilisateur de continuer à répondre dans un sujet une fois son quota atteint, et ajoute un menu déroulant de formules courantes à la zone de réponse.',
  ),
  intro: L(
    '启用后：回帖前校验「单帖回帖上限」——当帖子回帖数达到上限且该用户在本帖的回帖数也已达到上限时拦截；同时前台可按「默认回复语 + 备选回复语」渲染快速回复下拉。',
    '啟用後：回覆前校驗「單帖回覆上限」——當帖子回覆數達到上限且該使用者在本帖的回覆數也已達到上限時攔截；同時前台可按「預設回覆語 + 備選回覆語」渲染快速回覆下拉。',
    'Once enabled, the per-thread reply cap is validated before posting — replies are blocked when the thread has reached its cap and the user has also reached their own cap in it. The frontend can also render a quick-reply dropdown from “default phrase + alternatives”.',
    'После включения перед ответом проверяется «лимит ответов в теме»: если у темы достигнут лимит и данный пользователь исчерпал свой лимит в ней, ответ блокируется. Фронтенд также может отрисовать выпадающий список быстрых ответов из «фразы по умолчанию + варианты».',
    'เมื่อเปิดใช้งาน จะตรวจ "ขีดจำกัดการตอบต่อกระทู้" ก่อนโพสต์ — จะบล็อกเมื่อกระทู้ถึงขีดจำกัดและผู้ใช้คนนี้ตอบในกระทู้นี้ครบขีดจำกัดเช่นกัน พร้อมทั้งฝั่งหน้าเว็บแสดงดรอปดาวน์ตอบด่วนจาก "วลีเริ่มต้น + วลีสำรอง"',
    'Nach der Aktivierung wird vor dem Antworten die „Antwortobergrenze pro Thread“ geprüft — Antworten werden blockiert, wenn der Thread sein Limit erreicht hat und der Nutzer sein eigenes Limit ebenfalls. Das Frontend kann zudem ein Schnellantwort-Dropdown aus „Standardformulierung + Alternativen“ rendern.',
    '有効にすると返信前に「スレッド内返信上限」を検証します——スレッドの返信数が上限に達し、かつ当該ユーザーのこのスレッド内返信数も上限に達していれば遮断します。同時にフロントは「既定の返信文 + 代替返信文」からクイック返信ドロップダウンを描画できます。',
    '활성화하면 답글 작성 전 "스레드당 답글 상한"을 검사합니다 — 스레드 답글 수가 상한에 달했고 해당 사용자의 이 스레드 내 답글 수도 상한에 달했으면 차단합니다. 동시에 프런트는 "기본 답글 문구 + 대체 문구"로 빠른 답글 드롭다운을 렌더링할 수 있습니다.',
    'Una vez activado, se valida el «límite de respuestas por tema» antes de publicar: se bloquea cuando el tema alcanza su límite y el usuario también alcanza el suyo. El frontend también puede mostrar un desplegable de respuesta rápida con «frase por defecto + alternativas».',
    'Une fois activé, le « plafond de réponses par sujet » est validé avant publication — les réponses sont bloquées lorsque le sujet atteint son plafond et que l’utilisateur a lui aussi atteint le sien. Le frontend peut aussi afficher un menu de réponse rapide à partir des « formule par défaut + alternatives ».',
  ),
  fields: [
    {
      key: 'is_quick_reply_message',
      type: 'switch',
      label: L('启用限制与快捷语', '啟用限制與快捷語', 'Enable limit and quick phrases', 'Включить лимит и быстрые фразы', 'เปิดใช้จำกัดและวลีด่วย', 'Limit und Schnellformeln aktivieren', '制限と定型句を有効化', '제한 및 빠른 문구 활성화', 'Activar límite y frases rápidas', 'Activer limite et formules rapides'),
      onValue: 1,
      offValue: 0,
      defaultOn: false,
      help: L(
        '开启后达到上限的用户回帖会被拦截，前台快速回复下拉同步生效。',
        '開啟後達到上限的使用者回覆會被攔截，前台快速回覆下拉同步生效。',
        'When on, users at the cap are blocked from replying and the frontend quick-reply dropdown activates in sync.',
        'При включении ответы достигших лимита пользователей блокируются, а выпадающий список быстрых ответов на фронтенде активируется синхронно.',
        'เมื่อเปิด ผู้ใช้ที่ถึงขีดจำกัดจะถูกบล็อกไม่ให้ตอบ และดรอปดาวน์ตอบด่วนฝั่งหน้าเว็บจะทำงานพร้อมกัน',
        'Bei Aktivierung werden Antworten von Nutzern am Limit blockiert, und das Frontend-Dropdown für Schnellantworten wird synchron aktiviert.',
        'オンにすると上限に達したユーザーの返信が遮断され、フロントのクイック返信ドロップダウンも連動して有効になります。',
        '켜면 상한에 도달한 사용자의 답글이 차단되고 프런트 빠른 답글 드롭다운도 함께 활성화됩니다.',
        'Al activarlo, se bloquean las respuestas de usuarios en el límite y el desplegable de respuesta rápida del frontend se activa a la vez.',
        'Une fois activé, les réponses des utilisateurs au plafond sont bloquées et le menu de réponse rapide du frontend s’active en même temps.',
      ),
    },
    {
      key: 'quick_reply_message_default',
      type: 'text',
      label: L('默认回复语', '預設回覆語', 'Default phrase', 'Фраза по умолчанию', 'วลีเริ่มต้น', 'Standardformulierung', '既定の返信文', '기본 답글 문구', 'Frase por defecto', 'Formule par défaut'),
      placeholder: L('如：感谢分享！', '如：感謝分享！', 'e.g. Thanks for sharing!', 'напр. Спасибо за публикацию!', 'เช่น: ขอบคุณสำหรับการแชร์!', 'z. B. Danke fürs Teilen!', '例：共有ありがとうございます！', '예: 공유 감사합니다!', 'p. ej. ¡Gracias por compartir!', 'ex. Merci du partage !'),
      help: L(
        '下拉框第一项（默认选中），保存时不能为空。',
        '下拉框第一項（預設選中），儲存時不能為空。',
        'First dropdown item (selected by default); cannot be empty when saving.',
        'Первый пункт списка (выбран по умолчанию); при сохранении не может быть пустым.',
        'รายการแรกของดรอปดาวน์ (เลือกไว้เริ่มต้น) ห้ามว่างตอนบันทึก',
        'Erster Eintrag des Dropdowns (standardmäßig ausgewählt); darf beim Speichern nicht leer sein.',
        'ドロップダウンの先頭項目（既定選択）。保存時は空にできません。',
        '드롭다운 첫 항목(기본 선택). 저장 시 비워 둘 수 없습니다.',
        'Primer elemento del desplegable (seleccionado por defecto); no puede quedar vacío al guardar.',
        'Premier élément du menu (sélectionné par défaut) ; ne peut pas être vide à l’enregistrement.',
      ),
    },
    {
      key: 'quick_reply_message',
      type: 'textarea',
      rows: 4,
      label: L('备选回复语', '備選回覆語', 'Alternative phrases', 'Альтернативные фразы', 'วลีสำรอง', 'Alternative Formulierungen', '代替返信文', '대체 답글 문구', 'Frases alternativas', 'Formules alternatives'),
      placeholder: L('多条用 # 分隔，如：谢谢分享#学到了#顶一个', '多條用 # 分隔，如：謝謝分享#學到了#頂一個', 'Separate multiple with #, e.g. Thanks#Learned something#Bump', 'Разделяйте символом #, напр. Спасибо#Узнал новое#Поддерживаю', 'คั่นหลายรายการด้วย # เช่น ขอบคุณที่แชร์#ได้รู้ใหม่#ดันกระทู้', 'Mehrere mit # trennen, z. B. Danke#Wieder was gelernt#Nach oben', '複数は # で区切る。例：共有感謝#勉強になった#良いね', '여러 개는 #로 구분. 예: 공유 감사#배웠다#추천', 'Separa varias con #, p. ej. Gracias#Aprendí algo#Arriba', 'Séparez par #, ex. Merci du partage#Appris quelque chose#Up'),
      help: L(
        '下拉框其余选项，多条之间用 # 分隔。',
        '下拉框其餘選項，多條之間用 # 分隔。',
        'Remaining dropdown options; separate multiple entries with #.',
        'Остальные пункты списка; разделяйте записи символом #.',
        'ตัวเลือกอื่น ๆ ในดรอปดาวน์ คั่นรายการด้วย #',
        'Übrige Dropdown-Einträge; mehrere Einträge mit # trennen.',
        'ドロップダウンの残りの選択肢。複数は # で区切ります。',
        '드롭다운 나머지 옵션. 여러 항목은 #로 구분합니다.',
        'Resto de opciones del desplegable; separa varias con #.',
        'Autres éléments du menu ; séparez plusieurs entrées par #.',
      ),
    },
    {
      key: 'post_message_count_by_uid',
      type: 'text',
      label: L('单帖回帖上限', '單帖回覆上限', 'Per-thread reply cap', 'Лимит ответов в теме', 'ขีดจำกัดการตอบต่อกระทู้', 'Antwortobergrenze pro Thread', 'スレッド内返信上限', '스레드당 답글 상한', 'Límite de respuestas por tema', 'Plafond de réponses par sujet'),
      placeholder: L('如 10', '如 10', 'e.g. 10', 'напр. 10', 'เช่น 10', 'z. B. 10', '例: 10', '예: 10', 'p. ej. 10', 'ex. 10'),
      help: L(
        '同一用户在单个主题内最多可回帖次数；帖子现有回帖数达到该值后开始逐帖校验，保存时不能为 0。',
        '同一使用者在單個主題內最多可回覆次數；帖子現有回覆數達到該值後開始逐帖校驗，儲存時不能為 0。',
        'Max replies one user may post in a single thread; validation kicks in once the thread reaches this count. Cannot be 0 when saving.',
        'Максимум ответов одного пользователя в теме; проверка включается, когда у темы столько ответов. При сохранении не может быть 0.',
        'จำนวนครั้งสูงสุดที่ผู้ใช้หนึ่งตอบได้ในกระทู้เดียว เริ่มตรวจเมื่อกระทู้มีจำนวนตอบถึงค่านี้ ห้ามเป็น 0 ตอนบันทึก',
        'Maximale Antworten eines Nutzers in einem Thread; die Prüfung greift, sobald der Thread diese Zahl erreicht. Darf beim Speichern nicht 0 sein.',
        '同一ユーザーが 1 スレッド内で返信できる最大回数。スレッドの返信数がこの値に達すると検証が始まります。保存時に 0 は不可。',
        '한 사용자가 하나의 스레드에서 답글할 수 있는 최대 횟수. 스레드 답글 수가 이 값에 도달하면 검사가 시작되며 저장 시 0은 불가합니다.',
        'Máximo de respuestas de un usuario en un tema; la validación empieza cuando el tema alcanza ese número. No puede ser 0 al guardar.',
        'Nombre maximal de réponses d’un utilisateur dans un sujet ; la validation commence quand le sujet atteint ce nombre. Ne peut pas être 0 à l’enregistrement.',
      ),
    },
    {
      key: 'post_message_error',
      type: 'text',
      label: L('超出限制提示语', '超出限制提示語', 'Limit-exceeded message', 'Сообщение о превышении лимита', 'ข้อความเมื่อเกินขีดจำกัด', 'Meldung bei Limitüberschreitung', '上限超過時のメッセージ', '상한 초과 안내 문구', 'Mensaje al superar el límite', 'Message de dépassement de limite'),
      placeholder: L('如：您在本帖的回帖数已达上限，休息一下吧～', '如：您在本帖的回覆數已達上限，休息一下吧～', 'e.g. You have reached the reply limit for this thread. Take a break!', 'напр. Вы достигли лимита ответов в этой теме. Отдохните!', 'เช่น: คุณตอบในกระทู้นี้ครบขีดจำกัดแล้ว พักสักหน่อยนะ~', 'z. B. Du hast das Antwortlimit dieses Threads erreicht. Mach eine Pause!', '例：このスレッドでの返信数が上限に達しました。少し休みましょう～', '예: 이 스레드의 답글 수가 상한에 도달했습니다. 잠시 쉬어 가세요~', 'p. ej. Has alcanzado el límite de respuestas en este tema. ¡Toma un descanso!', 'ex. Vous avez atteint la limite de réponses dans ce sujet. Faites une pause !'),
      help: L(
        '达到上限后再回帖时向用户展示的提示，保存时不能为空。',
        '達到上限後再回覆時向使用者展示的提示，儲存時不能為空。',
        'Message shown when a user past the cap tries to reply; cannot be empty when saving.',
        'Подсказка, показываемая пользователю при попытке ответить после достижения лимита; при сохранении не может быть пустой.',
        'ข้อความแสดงเมื่อผู้ใช้เกินขีดจำกัดแล้วพยายามตอบ ห้ามว่างตอนบันทึก',
        'Hinweis, der erscheint, wenn ein Nutzer über dem Limit antworten will; darf beim Speichern nicht leer sein.',
        '上限を超えたユーザーが返信しようとした際に表示するメッセージ。保存時は空にできません。',
        '상한을 초과한 사용자가 답글 시도할 때 표시되는 안내입니다. 저장 시 비워 둘 수 없습니다.',
        'Mensaje mostrado cuando un usuario que superó el límite intenta responder; no puede quedar vacío al guardar.',
        'Message affiché quand un utilisateur au-delà du plafond tente de répondre ; ne peut pas être vide à l’enregistrement.',
      ),
    },
  ],
};
export const idxQuickReplyModule: ExtensionModule = {
  manifest: QUICK_REPLY_MANIFEST,
  schema: QUICK_REPLY_SCHEMA,
  setup(_api: ExtensionApi): void {
    /* 拦截接在核心 write 回帖路由，下拉数据走 /api/quick-reply-message */
  },
};

/** 插入代码扩展：八个注入位原始 HTML，键名为存储键（勿改名） */
export const INSERT_CODE_EXT_ID = 'idx_insert_code';
const INSERT_CODE_MANIFEST: ExtensionManifest = manifestOf(INSERT_CODE_EXT_ID, L('插入代码', '插入程式碼', 'Insert Code', 'Вставка кода', 'แทรกโค้ด', 'Code einfügen', 'コード挿入', '코드 삽입', 'Insertar código', 'Insérer du code'));
export const INSERT_CODE_KEYS = [
  'footer_end_htm',
  'footer_footer_left_end_htm',
  'footer_footer_right_end_htm',
  'footer_start_htm',
  'index_main_start_htm',
  'index_site_brief_after_htm',
  'thread_user_after_htm',
  'thread_message_after_htm',
] as const;

/** 注入位字段由 INSERT_CODE_KEYS 派生（键名单一来源），label/help 为各位置说明 */
const INSERT_CODE_FIELD_META: Record<(typeof INSERT_CODE_KEYS)[number], { label: ReturnType<typeof L>; help: ReturnType<typeof L> }> = {
  footer_end_htm: {
    label: L('页脚末尾', '頁腳末尾', 'End of footer', 'Конец подвала', 'ท้ายฟุตเทอร์', 'Ende des Footers', 'フッター末尾', '푸터 끝', 'Final del pie', 'Fin du pied de page'),
    help: L('全站页脚最末尾（</body> 前），适合放全站统计/全局脚本。', '全站頁腳最末尾（</body> 前），適合放全站統計/全域腳本。', 'Very end of the site footer (before </body>); ideal for site-wide analytics/global scripts.', 'Самый конец подвала сайта (перед </body>); подходит для общесайтовой статистики/глобальных скриптов.', 'ท้ายสุดของฟุตเทอร์ทั้งไซต์ (ก่อน </body>) เหมาะกับสคริปต์สถิติ/สคริปต์ทั่วทั้งไซต์', 'Ganz am Ende des Site-Footers (vor </body>); ideal für sitewide Analytics/globale Skripte.', 'サイトフッターの最末尾（</body> の前）。サイト全体の解析やグローバルスクリプトに最適。', '사이트 푸터의 가장 끝(</body> 앞). 사이트 전체 통계/전역 스크립트에 적합합니다.', 'Final del pie del sitio (antes de </body>); ideal para analítica global/scripts globales.', 'Tout à la fin du pied de page du site (avant </body>) ; idéal pour les statistiques globales/scripts globaux.'),
  },
  footer_footer_left_end_htm: {
    label: L('页脚左列末尾', '頁腳左列末尾', 'End of footer left column', 'Конец левой колонки подвала', 'ท้ายคอลัมน์ซ้ายของฟุตเทอร์', 'Ende der linken Footer-Spalte', 'フッター左列の末尾', '푸터 왼쪽 열 끝', 'Final de la columna izquierda del pie', 'Fin de la colonne gauche du pied de page'),
    help: L('页脚左侧栏目（站点信息列）末尾。', '頁腳左側欄目（站點資訊列）末尾。', 'End of the footer left column (site info column).', 'Конец левой колонки подвала (колонка информации о сайте).', 'ท้ายคอลัมน์ซ้ายของฟุตเทอร์ (คอลัมน์ข้อมูลไซต์)', 'Ende der linken Footer-Spalte (Spalte mit Site-Informationen).', 'フッター左列（サイト情報列）の末尾。', '푸터 왼쪽 열(사이트 정보 열)의 끝.', 'Final de la columna izquierda del pie (columna de información del sitio).', 'Fin de la colonne gauche du pied de page (colonne d’informations du site).'),
  },
  footer_footer_right_end_htm: {
    label: L('页脚右列末尾', '頁腳右列末尾', 'End of footer right column', 'Конец правой колонки подвала', 'ท้ายคอลัมน์ขวาของฟุตเทอร์', 'Ende der rechten Footer-Spalte', 'フッター右列の末尾', '푸터 오른쪽 열 끝', 'Final de la columna derecha del pie', 'Fin de la colonne droite du pied de page'),
    help: L('页脚右侧栏目（友情链接/联系方式列）末尾。', '頁腳右側欄目（友情連結/聯絡方式列）末尾。', 'End of the footer right column (friendly links/contact column).', 'Конец правой колонки подвала (дружественные ссылки/контакты).', 'ท้ายคอลัมน์ขวาของฟุตเทอร์ (ลิงก์เพื่อน/ช่องทางติดต่อ)', 'Ende der rechten Footer-Spalte (Partnerlinks/Kontaktspalte).', 'フッター右列（リンク集/連絡先列）の末尾。', '푸터 오른쪽 열(친구 링크/연락처 열)의 끝.', 'Final de la columna derecha del pie (enlaces amistosos/contacto).', 'Fin de la colonne droite du pied de page (liens amis/contact).'),
  },
  footer_start_htm: {
    label: L('页脚顶部', '頁腳頂部', 'Top of footer', 'Начало подвала', 'ด้านบนของฟุตเทอร์', 'Anfang des Footers', 'フッター上部', '푸터 상단', 'Inicio del pie', 'Haut du pied de page'),
    help: L('页脚区块开始处。', '頁腳區塊開始處。', 'Start of the footer block.', 'Начало блока подвала.', 'จุดเริ่มต้นบล็อกฟุตเทอร์', 'Beginn des Footer-Blocks.', 'フッターブロックの開始位置。', '푸터 블록의 시작 부분.', 'Comienzo del bloque del pie.', 'Début du bloc de pied de page.'),
  },
  index_main_start_htm: {
    label: L('首页列表顶部', '首頁列表頂部', 'Top of home thread list', 'Начало списка тем на главной', 'ด้านบนของรายการหน้าแรก', 'Anfang der Threadliste auf der Startseite', 'ホーム一覧の上部', '홈 목록 상단', 'Inicio de la lista de la portada', 'Haut de la liste de l’accueil'),
    help: L('首页主题列表区开始处。', '首頁主題列表區開始處。', 'Start of the home page thread list area.', 'Начало области списка тем на главной.', 'จุดเริ่มต้นพื้นที่รายการกระทู้หน้าแรก', 'Beginn des Threadlisten-Bereichs auf der Startseite.', 'ホームのスレッド一覧エリアの開始位置。', '홈 스레드 목록 영역의 시작 부분.', 'Comienzo del área de lista de temas de la portada.', 'Début de la zone de liste des sujets de l’accueil.'),
  },
  index_site_brief_after_htm: {
    label: L('首页侧栏', '首頁側欄', 'Home sidebar', 'Боковая панель главной', 'แถบข้างหน้าแรก', 'Startseiten-Seitenleiste', 'ホームサイドバー', '홈 사이드바', 'Barra lateral de la portada', 'Barre latérale de l’accueil'),
    help: L('首页侧栏「站点简介」之后。', '首頁側欄「站點簡介」之後。', 'After the “Site intro” block in the home sidebar.', 'После блока «О сайте» на боковой панели главной.', 'หลังบล็อก "แนะนำไซต์" ในแถบข้างหน้าแรก', 'Nach dem Block „Site-Kurzinfo“ in der Startseiten-Seitenleiste.', 'ホームサイドバーの「サイト概要」の後。', '홈 사이드바의 "사이트 소개" 뒤.', 'Después del bloque «Descripción del sitio» en la barra lateral de la portada.', 'Après le bloc « Présentation du site » dans la barre latérale de l’accueil.'),
  },
  thread_user_after_htm: {
    label: L('帖子侧栏用户卡后', '帖子側欄使用者卡後', 'After thread sidebar user card', 'После карточки автора на боковой панели темы', 'หลังการ์ดผู้ใช้ในแถบข้างกระทู้', 'Nach der Nutzerkarte in der Thread-Seitenleiste', 'スレッドサイドバーのユーザーカードの後', '스레드 사이드바 사용자 카드 뒤', 'Tras la tarjeta de usuario de la barra lateral del tema', 'Après la carte utilisateur de la barre latérale du sujet'),
    help: L('帖子页侧栏楼主用户信息卡之后。', '帖子頁側欄樓主使用者資訊卡之後。', 'After the OP user info card in the thread page sidebar.', 'После карточки автора темы на боковой панели страницы темы.', 'หลังการ์ดข้อมูลผู้โพสต์ในแถบข้างหน้ากระทู้', 'Nach der Info-Karte des Thread-Erstellers in der Seitenleiste der Threadseite.', 'スレッドページのサイドバーにある投稿者情報カードの後。', '스레드 페이지 사이드바의 글쓴이 정보 카드 뒤.', 'Tras la tarjeta de información del autor en la barra lateral de la página del tema.', 'Après la carte d’informations de l’auteur dans la barre latérale de la page du sujet.'),
  },
  thread_message_after_htm: {
    label: L('帖子楼层内容后', '帖子樓層內容後', 'After thread post content', 'После содержимого поста в теме', 'หลังเนื้อหาแต่ละโพสต์ในกระทู้', 'Nach dem Inhalt jedes Thread-Beitrags', 'スレッド各階層の本文の後', '스레드 각 층 본문 뒤', 'Tras el contenido de cada publicación del tema', 'Après le contenu de chaque message du sujet'),
    help: L('帖子页每个楼层正文之后。', '帖子頁每個樓層正文之後。', 'After the body of each post on the thread page.', 'После тела каждого поста на странице темы.', 'หลังเนื้อหาของแต่ละโพสต์ในหน้ากระทู้', 'Nach dem Text jedes Beitrags auf der Threadseite.', 'スレッドページの各投稿本文の後。', '스레드 페이지의 각 게시물 본문 뒤.', 'Tras el cuerpo de cada publicación en la página del tema.', 'Après le corps de chaque message sur la page du sujet.'),
  },
};
const INSERT_CODE_SCHEMA: ExtSchema = {
  brief: L(
    '插入代码：在页脚、首页、帖子页等 8 个页面位置注入自定义 HTML，适合统计脚本、验证代码、自定义挂件。',
    '插入程式碼：在頁腳、首頁、帖子頁等 8 個頁面位置注入自訂 HTML，適合統計腳本、驗證碼、自訂掛件。',
    'Insert code: inject custom HTML into 8 page positions (footer, home, thread pages, etc.) — ideal for analytics scripts, verification codes and custom widgets.',
    'Вставка кода: добавляйте свой HTML в 8 позиций страниц (подвал, главная, темы и др.) — для скриптов статистики, кодов верификации и виджетов.',
    'แทรกโค้ด: ฉีด HTML ที่กำหนดเองลงใน 8 ตำแหน่งหน้าเว็บ (ฟุตเทอร์ หน้าแรก หน้ากระทู้ ฯลฯ) เหมาะกับสคริปต์สถิติ โค้ดยืนยัน และวิดเจ็ตทำเอง',
    'Code einfügen: eigenen HTML-Code an 8 Seitenpositionen injizieren (Footer, Startseite, Threadseiten usw.) — ideal für Analytics-Skripte, Verifizierungscodes und eigene Widgets.',
    'コード挿入：フッター、ホーム、スレッドページなど 8 か所にカスタム HTML を注入します。解析スクリプト、認証コード、独自ウィジェットに最適。',
    '코드 삽입: 푸터, 홈, 스레드 페이지 등 8곳에 사용자 정의 HTML을 삽입합니다. 통계 스크립트, 인증 코드, 커스텀 위젯에 적합합니다.',
    'Insertar código: inyecta HTML personalizado en 8 posiciones de página (pie, portada, temas, etc.); ideal para scripts de analítica, códigos de verificación y widgets propios.',
    'Insérer du code : injecte du HTML personnalisé dans 8 positions de page (pied de page, accueil, sujets, etc.) ; idéal pour les scripts de statistiques, codes de vérification et widgets personnalisés.',
  ),
  intro: L(
    '启用后，下面各位置填写的 HTML 会按对应位置显示在前台页面；留空的位置不显示。内容按原样输出，请自行确保 HTML 安全可信。',
    '啟用後，下面各位置填寫的 HTML 會按對應位置顯示在前台頁面；留空的位置不顯示。內容按原樣輸出，請自行確保 HTML 安全可信。',
    'Once enabled, the HTML entered for each position below renders at that position on frontend pages; empty positions render nothing. Content is output as-is — make sure it is safe and trusted.',
    'После включения HTML, введённый для каждой позиции ниже, отображается в соответствующем месте фронтенда; пустые позиции ничего не выводят. Контент выводится как есть — позаботьтесь о его безопасности.',
    'เมื่อเปิดใช้งาน HTML ที่กรอกในแต่ละตำแหน่งด้านล่างจะแสดงตามตำแหน่งนั้นในหน้าเว็บ ตำแหน่งที่เว้นว่างจะไม่แสดง เนื้อหาแสดงตามต้นฉบับ โปรดตรวจสอบเองว่า HTML ปลอดภัยและเชื่อถือได้',
    'Nach der Aktivierung wird der für jede Position unten eingegebene HTML-Code an der entsprechenden Stelle im Frontend gerendert; leere Positionen bleiben leer. Der Inhalt wird unverändert ausgegeben — stellen Sie selbst sicher, dass er sicher und vertrauenswürdig ist.',
    '有効にすると、以下の各位置に入力した HTML がフロントの該当位置に表示されます。空欄の位置は表示されません。内容はそのまま出力されるため、安全で信頼できる HTML かご自身でご確認ください。',
    '활성화하면 아래 각 위치에 입력한 HTML이 프런트의 해당 위치에 표시되며, 비워 둔 위치는 표시되지 않습니다. 내용은 그대로 출력되므로 HTML이 안전하고 신뢰할 수 있는지 직접 확인하세요.',
    'Una vez activado, el HTML introducido en cada posición se muestra en ese lugar de las páginas del frontend; las posiciones vacías no muestran nada. El contenido se muestra tal cual: asegúrate de que sea seguro y de confianza.',
    'Une fois activé, le HTML saisi pour chaque position ci-dessous s’affiche à cet endroit côté frontend ; les positions vides ne rendent rien. Le contenu est affiché tel quel — assurez-vous qu’il est sûr et fiable.',
  ),
  fields: INSERT_CODE_KEYS.map(
    (key): ExtField => ({
      key,
      type: 'textarea',
      rows: 3,
      label: INSERT_CODE_FIELD_META[key].label,
      help: INSERT_CODE_FIELD_META[key].help,
    }),
  ),
};
export const idxInsertCodeModule: ExtensionModule = {
  manifest: INSERT_CODE_MANIFEST,
  schema: INSERT_CODE_SCHEMA,
  setup(_api: ExtensionApi): void {
    /* 注入位经 GET /api/insert-codes 下发，前端按位置渲染 */
  },
};
