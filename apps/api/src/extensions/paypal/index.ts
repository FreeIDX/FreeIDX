/**
 * PayPal 通道插件（§15.5，与 stripe 同构的外部通道）。纯 REST（无重 SDK）：
 *   - OAuth2 client credentials 取 Bearer token（每次操作现取现用，无本地状态）；
 *   - Orders v2 托管收银台：processing_instruction=ORDER_COMPLETE_ON_PAYMENT_APPROVAL，
 *     买家批准即自动入账，无需服务端二次 capture，天然适配 redirect 跳转流；
 *   - webhook 验签走官方 /v1/notifications/verify-webhook-signature（需配置 webhookId）；
 *   - 退款先查订单取 capture id，再 POST /v2/payments/captures/{id}/refund。
 * 出厂 installed=1、enable=0：后台填 clientId/clientSecret 即热启用；未启用通道收银台自动隐藏。
 * 通道差异全部收敛在本文件，payment-core 不含 PayPal 逻辑（与 stripe 同一契约）。
 */
import type { PayOrder, PaymentProvider, PaymentConfig, PaymentCapabilities, ProviderEvent } from '@freeidx/shared';
import type { ExtensionManifest, ExtSchema } from '@freeidx/shared';
import type { ExtensionApi, ExtensionModule } from '../../core/extensions/registry';
import { registerProvider } from '../../core/payment/registry';
import { L, t0 } from '../../core/i18n';

const CAPS: PaymentCapabilities = {
  currencies: ['USD', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'AUD', 'CAD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'BRL', 'MXN', 'PHP', 'TWD', 'THB'],
  modes: ['redirect'],
  refund: true,
};

const PAYPAL_MANIFEST: ExtensionManifest = {
  id: 'paypal',
  name: L('PayPal 支付', 'PayPal 付款', 'PayPal', 'Оплата через PayPal', 'ชำระเงินผ่าน PayPal', 'PayPal-Zahlung', 'PayPal 決済', 'PayPal 결제', 'Pago con PayPal', 'Paiement PayPal'),
  version: '1.0.0',
  installed: 1,
  enable: 0,
  dependencies: { 'payment-core': '>=1.0' },
  capabilities: { currencies: [...CAPS.currencies], modes: [...CAPS.modes], refund: CAPS.refund },
};

/** 后台配置表单 schema（插件自声明）：clientSecret 为私密项，键名与 ext:paypal:config/secret 一一对应（勿改名） */
const PAYPAL_SCHEMA: ExtSchema = {
  brief: L(
    'PayPal 国际支付通道：跳转 PayPal 收银页完成付款，支付结果自动回调确认，支持多币种与退款。',
    'PayPal 國際支付通道：跳轉 PayPal 收銀頁完成付款，支付結果自動回呼確認，支援多幣種與退款。',
    'PayPal international payments: pay on PayPal’s hosted checkout page, results confirmed by automatic callbacks; supports multiple currencies and refunds.',
    'Международные платежи через PayPal: оплата на хостинговой странице чекаута PayPal, результат подтверждается автоматическим колбэком; поддерживает несколько валют и возвраты.',
    'ช่องทางชำระเงินสากลผ่าน PayPal: ชำระผ่านหน้าเช็คเอาต์ที่ PayPal ดูแล ผลการชำระยืนยันอัตโนมัติด้วย callback รองรับหลายสกุลเงินและการคืนเงิน',
    'Internationale Zahlungen über PayPal: Bezahlung auf der gehosteten Kassenseite von PayPal, Ergebnis wird per automatischem Callback bestätigt; unterstützt mehrere Währungen und Rückerstattungen.',
    'PayPal 国際決済チャネル：PayPal のホスト型チェックアウトページで支払いを完了し、結果は自動コールバックで確認。多通貨と返金に対応。',
    'PayPal 국제 결제 채널: PayPal 호스팅 결제 페이지에서 결제를 완료하며 결과는 자동 콜백으로 확인합니다. 다중 통화와 환불을 지원합니다.',
    'Canal internacional de pagos PayPal: paga en la página de pago alojada de PayPal, el resultado se confirma con callbacks automáticos; admite varias monedas y reembolsos.',
    'Canal de paiement international PayPal : paiement sur la page de paiement hébergée de PayPal, résultat confirmé par callback automatique ; prend en charge plusieurs devises et remboursements.',
  ),
  intro: L(
    '填好下方凭据并启用本插件后，收银台会自动出现 PayPal 跳转支付（未启用或未配置时对用户完全隐藏，不影响其他通道）。沙箱/生产由「生产环境」开关切换，切换后需同步换用对应环境的凭据。',
    '填好下方憑證並啟用本外掛後，收銀台會自動出現 PayPal 跳轉支付（未啟用或未設定時對使用者完全隱藏，不影響其他通道）。沙箱/生產由「生產環境」開關切換，切換後需同步換用對應環境的憑證。',
    'After filling in the credentials below and enabling this plugin, a PayPal redirect option appears automatically at checkout (fully hidden from users while disabled or unconfigured, other channels unaffected). Sandbox/live is switched by the “Live mode” toggle; after switching, switch to the matching environment’s credentials.',
    'После заполнения учётных данных ниже и включения плагина в чекауте автоматически появляется перенаправление на PayPal (пока выключено или не настроено — полностью скрыто от пользователей, другие каналы не затронуты). Песочница/прод переключается флагом «Прод-среда (Live)»; после переключения замените данные на соответствующие среде.',
    'เมื่อกรอกข้อมูลรับรองด้านล่างและเปิดใช้ปลั๊กอินแล้ว ตัวเลือกชำระผ่าน PayPal จะปรากฏในหน้าเช็คเอาต์อัตโนมัติ (ซ่อนจากผู้ใช้ทั้งหมดเมื่อยังไม่เปิดหรือยังไม่ตั้งค่า ไม่กระทบช่องทางอื่น) สลับ sandbox/production ด้วยสวิตช์ "โหมด Live (ผลิตจริง)" และเมื่อสลับแล้วต้องเปลี่ยนไปใช้ข้อมูลรับรองของสภาพแวดล้อมนั้นด้วย',
    'Nach dem Ausfüllen der Zugangsdaten unten und der Aktivierung des Plugins erscheint PayPal-Weiterleitung automatisch an der Kasse (während deaktiviert oder unkonfiguriert vollständig ausgeblendet; andere Kanäle unberührt). Sandbox/Live wird über den Schalter „Live-Modus (Produktion)“ umgeschaltet; danach auch die Zugangsdaten der jeweiligen Umgebung verwenden.',
    '下の資格情報を入力して本プラグインを有効化すると、チェックアウトに PayPal へのリダイレクト決済が自動表示されます（無効または未設定の間はユーザーに一切表示されず、他のチャネルにも影響しません）。サンドボックス/本番は「本番環境（Live）」スイッチで切り替え、切り替えたら対応環境の資格情報に交換してください。',
    '아래 자격 증명을 입력하고 이 플러그인을 활성화하면 결제창에 PayPal 리디렉션 결제가 자동으로 표시됩니다(비활성화 또는 미설정 시 사용자에게 완전히 숨겨지고 다른 채널에 영향이 없습니다). 샌드박스/라이브는 "라이브 모드(프로덕션)" 스위치로 전환하며, 전환 후 해당 환경의 자격 증명으로 교체해야 합니다.',
    'Tras rellenar las credenciales de abajo y activar este complemento, aparece automáticamente la opción de redirección a PayPal en la pasarela (totalmente oculta para los usuarios mientras esté desactivado o sin configurar; no afecta a otros canales). El entorno sandbox/producción se cambia con el interruptor «Modo Live (producción)»; tras cambiarlo, usa también las credenciales del entorno correspondiente.',
    'Après avoir renseigné les identifiants ci-dessous et activé ce plugin, une option de redirection vers PayPal apparaît automatiquement à la caisse (totalement masquée tant que désactivé ou non configuré ; n’affecte pas les autres canaux). Le basculement sandbox/production se fait via l’interrupteur « Mode Live (production) » ; après bascule, utilisez aussi les identifiants de l’environnement correspondant.',
  ),
  fields: [
    {
      key: 'clientId',
      type: 'text',
      label: 'Client ID',
      placeholder: L('PayPal 应用 Client ID，留空保持不变', 'PayPal 應用 Client ID，留空保持不變', 'PayPal app Client ID, leave blank to keep unchanged', 'Client ID приложения PayPal, оставьте пустым, чтобы не менять', 'Client ID ของแอป PayPal เว้นว่างเพื่อคงค่าเดิม', 'Client ID der PayPal-App, leer lassen, um unverändert zu bleiben', 'PayPal アプリの Client ID、空欄で変更なし', 'PayPal 앱 Client ID, 비워 두면 변경 없음', 'Client ID de la app de PayPal, dejar en blanco para mantener el valor', 'Client ID de l’application PayPal, laisser vide pour conserver'),
      help: L(
        'developer.paypal.com → Apps & Credentials → 创建/选择应用，复制 Client ID。与下方 Secret 一起构成收款凭据。',
        'developer.paypal.com → Apps & Credentials → 建立/選擇應用，複製 Client ID。與下方 Secret 一起構成收款憑證。',
        'developer.paypal.com → Apps & Credentials → create/select an app and copy the Client ID. Together with the Secret below it forms the payment credentials.',
        'developer.paypal.com → Apps & Credentials → создайте/выберите приложение и скопируйте Client ID. Вместе с Secret ниже образует платёжные данные.',
        'developer.paypal.com → Apps & Credentials → สร้าง/เลือกแอป แล้วคัดลอก Client ID ใช้ร่วมกับ Secret ด้านล่างเป็นข้อมูลรับรองการรับเงิน',
        'developer.paypal.com → Apps & Credentials → App erstellen/auswählen und die Client ID kopieren. Bildet zusammen mit dem Secret unten die Zahlungs-Zugangsdaten.',
        'developer.paypal.com → Apps & Credentials → アプリを作成/選択して Client ID をコピーします。下の Secret と合わせて入金用の資格情報になります。',
        'developer.paypal.com → Apps & Credentials → 앱을 생성/선택하고 Client ID를 복사합니다. 아래 Secret과 함께 결제 수령 자격 증명이 됩니다.',
        'developer.paypal.com → Apps & Credentials → crea/selecciona una app y copia el Client ID. Junto con el Secret de abajo forma las credenciales de cobro.',
        'developer.paypal.com → Apps & Credentials → créez/sélectionnez une application et copiez le Client ID. Avec le Secret ci-dessous, il forme les identifiants d’encaissement.',
      ),
    },
    {
      key: 'clientSecret',
      target: 'secret',
      type: 'password',
      label: 'Client Secret',
      placeholder: L('PayPal 应用 Secret，留空保持不变', 'PayPal 應用 Secret，留空保持不變', 'PayPal app Secret, leave blank to keep unchanged', 'Secret приложения PayPal, оставьте пустым, чтобы не менять', 'Secret ของแอป PayPal เว้นว่างเพื่อคงค่าเดิม', 'Secret der PayPal-App, leer lassen, um unverändert zu bleiben', 'PayPal アプリの Secret、空欄で変更なし', 'PayPal 앱 Secret, 비워 두면 변경 없음', 'Secret de la app de PayPal, dejar en blanco para mantener el valor', 'Secret de l’application PayPal, laisser vide pour conserver'),
      help: L(
        '与 Client ID 同页的 Secret key。这是收款必填项，只存加密的私密项且永不回显。',
        '與 Client ID 同頁的 Secret key。這是收款必填項，只存加密的私密項且永不回顯。',
        'The Secret key on the same page as the Client ID. Required for taking payments; stored only as an encrypted secret and never echoed back.',
        'Secret key на той же странице, что и Client ID. Обязателен для приёма платежей; хранится только в зашифрованном виде и никогда не возвращается.',
        'Secret key ที่อยู่หน้าเดียวกับ Client ID เป็นข้อมูลบังคับสำหรับการรับเงิน เก็บเป็นความลับแบบเข้ารหัสเท่านั้นและไม่แสดงกลับเสมอ',
        'Der Secret key auf derselben Seite wie die Client ID. Pflichtfeld für den Zahlungseingang; wird nur verschlüsselt gespeichert und nie zurückgesendet.',
        'Client ID と同じページにある Secret key。入金には必須で、暗号化された秘密項目としてのみ保存され、再表示されることはありません。',
        'Client ID와 같은 페이지의 Secret key입니다. 결제 수령에 필수이며 암호화된 시크릿으로만 저장되고 다시 표시되지 않습니다.',
        'La clave Secret en la misma página que el Client ID. Obligatoria para cobrar; se guarda solo como secreto cifrado y nunca se muestra de vuelta.',
        'La clé Secret sur la même page que le Client ID. Obligatoire pour encaisser ; stockée uniquement comme secret chiffré et jamais renvoyée.',
      ),
    },
    {
      key: 'webhookId',
      type: 'text',
      label: 'Webhook ID',
      placeholder: L('如 4XY12345AB678901C，留空保持不变', '如 4XY12345AB678901C，留空保持不變', 'e.g. 4XY12345AB678901C, leave blank to keep unchanged', 'напр. 4XY12345AB678901C, оставьте пустым, чтобы не менять', 'เช่น 4XY12345AB678901C เว้นว่างเพื่อคงค่าเดิม', 'z. B. 4XY12345AB678901C, leer lassen, um unverändert zu bleiben', '例: 4XY12345AB678901C、空欄で変更なし', '예: 4XY12345AB678901C, 비워 두면 변경 없음', 'p. ej. 4XY12345AB678901C, dejar en blanco para mantener el valor', 'ex. 4XY12345AB678901C, laisser vide pour conserver'),
      help: L(
        '同一应用页 → Webhooks 添加端点（指向站点的 PayPal 回调地址 /api/payments/webhook/paypal）后，复制 Webhook ID。不填则回调验签关闭（一律拒绝落账），订单状态只能靠主动查询。',
        '同一應用頁 → Webhooks 新增端點（指向站點的 PayPal 回呼位址 /api/payments/webhook/paypal）後，複製 Webhook ID。不填則回呼驗簽關閉（一律拒絕落帳），訂單狀態只能靠主動查詢。',
        'On the same app page → Webhooks, add an endpoint (pointing to your site’s PayPal callback URL /api/payments/webhook/paypal) and copy the Webhook ID. If left empty, callback signature verification is off (all webhooks rejected), and order status must be checked by polling.',
        'На той же странице приложения → Webhooks добавьте endpoint (указывающий на callback-адрес PayPal вашего сайта /api/payments/webhook/paypal) и скопируйте Webhook ID. Если пусто, проверка подписи колбэков отключена (все вебхуки отклоняются), статус заказа — только опросом.',
        'ในหน้าแอปเดียวกัน → Webhooks เพิ่ม endpoint (ชี้ไปที่ callback URL ของ PayPal สำหรับไซต์คุณ /api/payments/webhook/paypal) แล้วคัดลอก Webhook ID ถ้าเว้นว่าง การตรวจลายเซ็น callback จะปิด (ปฏิเสธทุก webhook) และสถานะคำสั่งต้องเช็คด้วยการ query เอง',
        'Auf derselben App-Seite → Webhooks: Endpoint hinzufügen (verweist auf die PayPal-Callback-URL Ihrer Website /api/payments/webhook/paypal) und die Webhook-ID kopieren. Leer: Signaturprüfung aus (alle Webhooks abgelehnt); Bestellstatus nur per Abfrage.',
        '同じアプリページ → Webhooks でエンドポイント（サイトの PayPal コールバック URL /api/payments/webhook/paypal）を追加し、Webhook ID をコピーします。未入力の場合はコールバック署名検証が無効（すべて拒否）となり、注文状態は能動的な照会でのみ確認できます。',
        '같은 앱 페이지 → Webhooks에서 엔드포인트(사이트의 PayPal 콜백 URL /api/payments/webhook/paypal)를 추가하고 Webhook ID를 복사합니다. 비워 두면 콜백 서명 검증이 꺼져(모두 거부) 주문 상태를 직접 조회해야 합니다.',
        'En la misma página de la app → Webhooks, añade un endpoint (apuntando a la URL de callback de PayPal de tu sitio /api/payments/webhook/paypal) y copia el Webhook ID. Si se deja vacío, la verificación de firma queda desactivada (se rechazan todos) y el estado del pedido solo se consulta activamente.',
        'Sur la même page d’application → Webhooks, ajoutez un endpoint (pointant vers l’URL de callback PayPal de votre site /api/payments/webhook/paypal) et copiez le Webhook ID. Laissé vide, la vérification de signature est désactivée (tout est refusé) et le statut des commandes doit être interrogé activement.',
      ),
    },
    {
      key: 'env',
      type: 'switch',
      label: L('生产环境（Live）', '生產環境（Live）', 'Live mode (production)', 'Прод-среда (Live)', 'โหมด Live (ผลิตจริง)', 'Live-Modus (Produktion)', '本番環境（Live）', '라이브 모드(프로덕션)', 'Modo Live (producción)', 'Mode Live (production)'),
      onValue: 'live',
      offValue: 'sandbox',
      defaultOn: false,
      help: L(
        '关闭时走沙箱环境（api-m.sandbox.paypal.com），用测试账号联调；正式收款前开启并换用 Live 凭据。',
        '關閉時走沙箱環境（api-m.sandbox.paypal.com），用測試帳號聯調；正式收款前開啟並換用 Live 憑證。',
        'When off, the sandbox environment (api-m.sandbox.paypal.com) is used with test accounts; before taking real payments, enable it and switch to Live credentials.',
        'Когда выключено, используется песочница (api-m.sandbox.paypal.com) с тестовыми аккаунтами; перед реальными платежами включите и подставьте Live-данные.',
        'เมื่อปิด ระบบจะใช้สภาพแวดล้อม sandbox (api-m.sandbox.paypal.com) กับบัญชีทดสอบ ก่อนรับชำระจริงให้เปิดสวิตช์นี้และเปลี่ยนไปใช้ข้อมูลรับรอง Live',
        'Ausgeschaltet: Sandbox-Umgebung (api-m.sandbox.paypal.com) mit Testkonten; vor echten Zahlungen aktivieren und Live-Zugangsdaten einsetzen.',
        'オフの場合はサンドボックス環境（api-m.sandbox.paypal.com）をテストアカウントで利用します。本番の入金前にオンにして Live の資格情報へ切り替えてください。',
        '끄면 샌드박스 환경(api-m.sandbox.paypal.com)을 테스트 계정으로 사용합니다. 실제 결제 수령 전에 켜고 Live 자격 증명으로 교체하세요.',
        'Desactivado usa el entorno sandbox (api-m.sandbox.paypal.com) con cuentas de prueba; antes de cobrar de verdad, actívalo y cambia a credenciales Live.',
        'Désactivé, l’environnement sandbox (api-m.sandbox.paypal.com) est utilisé avec des comptes de test ; avant les encaissements réels, activez-le et passez aux identifiants Live.',
      ),
    },
    {
      key: 'successUrl',
      type: 'text',
      label: L('支付成功跳转地址', '付款成功跳轉位址', 'Payment success redirect URL', 'URL перенаправления при успешной оплате', 'URL สำหรับกระโดดกลับเมื่อชำระสำเร็จ', 'Weiterleitungs-URL nach erfolgreicher Zahlung', '支払い成功時のリダイレクト URL', '결제 성공 리디렉션 URL', 'URL de redirección al pagar con éxito', 'URL de redirection après paiement réussi'),
      placeholder: L('留空使用站点默认', '留空使用站點預設', 'Leave blank for the site default', 'Оставьте пустым для значения сайта по умолчанию', 'เว้นว่างเพื่อใช้ค่าเริ่มต้นของไซต์', 'Leer lassen für die Standard-URL der Website', '空欄でサイト既定を使用', '비워 두면 사이트 기본값 사용', 'Dejar en blanco para el valor predeterminado del sitio', 'Laisser vide pour la valeur par défaut du site'),
      help: L(
        '用户在 PayPal 付款成功后浏览器跳回的完整 URL（https:// 开头）。留空时由站点按当前域名默认处理。',
        '使用者在 PayPal 付款成功後瀏覽器跳回的完整 URL（https:// 開頭）。留空時由站點按目前網域預設處理。',
        'Full URL the browser returns to after successful PayPal payment (must start with https://). If empty, the site handles it by the current domain by default.',
        'Полный URL, на который браузер возвращается после успешной оплаты через PayPal (начинается с https://). Если пусто, сайт обрабатывает это по умолчанию для текущего домена.',
        'URL แบบเต็มที่เบราว์เซอร์จะกลับมาหลังชำระผ่าน PayPal สำเร็จ (ขึ้นต้นด้วย https://) ถ้าเว้นว่างไซต์จะจัดการตามโดเมนปัจจุบันเป็นค่าเริ่มต้น',
        'Vollständige URL, zu der der Browser nach erfolgreicher PayPal-Zahlung zurückkehrt (beginnt mit https://). Leer: Die Website behandelt dies standardmäßig über die aktuelle Domain.',
        'PayPal での支払い成功後にブラウザーが戻る完全な URL（https:// で始まる）。空欄の場合はサイトが現在のドメインで既定処理します。',
        'PayPal 결제 성공 후 브라우저가 돌아올 전체 URL(https://로 시작). 비워 두면 사이트가 현재 도메인 기본값으로 처리합니다.',
        'URL completa a la que vuelve el navegador tras pagar con éxito en PayPal (debe empezar por https://). Si se deja vacío, el sitio lo gestiona por defecto según el dominio actual.',
        'URL complète vers laquelle le navigateur revient après un paiement PayPal réussi (doit commencer par https://). Vide : le site le gère par défaut selon le domaine actuel.',
      ),
    },
    {
      key: 'cancelUrl',
      type: 'text',
      label: L('取消支付跳转地址', '取消付款跳轉位址', 'Payment cancel redirect URL', 'URL перенаправления при отмене оплаты', 'URL สำหรับกระโดดกลับเมื่อยกเลิกการชำระ', 'Weiterleitungs-URL bei Zahlungsabbruch', '支払いキャンセル時のリダイレクト URL', '결제 취소 리디렉션 URL', 'URL de redirección al cancelar el pago', 'URL de redirection en cas d’annulation du paiement'),
      placeholder: L('留空使用站点默认', '留空使用站點預設', 'Leave blank for the site default', 'Оставьте пустым для значения сайта по умолчанию', 'เว้นว่างเพื่อใช้ค่าเริ่มต้นของไซต์', 'Leer lassen für die Standard-URL der Website', '空欄でサイト既定を使用', '비워 두면 사이트 기본값 사용', 'Dejar en blanco para el valor predeterminado del sitio', 'Laisser vide pour la valeur par défaut du site'),
      help: L(
        '用户在 PayPal 收银页点取消后跳回的完整 URL（https:// 开头）。留空时由站点按当前域名默认处理。',
        '使用者在 PayPal 收銀頁點取消後跳回的完整 URL（https:// 開頭）。留空時由站點按目前網域預設處理。',
        'Full URL the browser returns to after the user cancels on the PayPal checkout page (must start with https://). If empty, the site handles it by the current domain by default.',
        'Полный URL, на который браузер возвращается после отмены на странице чекаута PayPal (начинается с https://). Если пусто, сайт обрабатывает это по умолчанию для текущего домена.',
        'URL แบบเต็มที่เบราว์เซอร์จะกลับมาหลังผู้ใช้กดยกเลิกที่หน้าเช็คเอาต์ของ PayPal (ขึ้นต้นด้วย https://) ถ้าเว้นว่างไซต์จะจัดการตามโดเมนปัจจุบันเป็นค่าเริ่มต้น',
        'Vollständige URL, zu der der Browser nach Abbruch auf der PayPal-Kassenseite zurückkehrt (beginnt mit https://). Leer: Die Website behandelt dies standardmäßig über die aktuelle Domain.',
        'ユーザーが PayPal のチェックアウトページでキャンセルした後にブラウザーが戻る完全な URL（https:// で始まる）。空欄の場合はサイトが現在のドメインで既定処理します。',
        '사용자가 PayPal 결제 페이지에서 취소한 후 브라우저가 돌아올 전체 URL(https://로 시작). 비워 두면 사이트가 현재 도메인 기본값으로 처리합니다.',
        'URL completa a la que vuelve el navegador cuando el usuario cancela en la página de pago de PayPal (debe empezar por https://). Si se deja vacío, el sitio lo gestiona por defecto según el dominio actual.',
        'URL complète vers laquelle le navigateur revient après annulation sur la page de paiement PayPal (doit commencer par https://). Vide : le site le gère par défaut selon le domaine actuel.',
      ),
    },
  ],
};

interface PaypalCfg extends PaymentConfig {
  clientId?: string;
  clientSecret?: string;
  /** 'sandbox'（默认）| 'live' */
  env?: string;
  webhookId?: string;
  apiUrl?: string; // 默认按 env 选 api-m(.sandbox)?.paypal.com（测试可注入本地 mock 基址）
  successUrl?: string;
  cancelUrl?: string;
}

const LIVE_API = 'https://api-m.paypal.com';
const SANDBOX_API = 'https://api-m.sandbox.paypal.com';
/** 零小数位币种（PayPal 按币种表决定 minor unit，本通道支持列表里仅这两个） */
const ZERO_DECIMAL = new Set(['JPY', 'KRW']);

/** 出网基址校验：仅允许 http/https（该请求携带 Bearer token，须锁死协议，与 stripe 同口径） */
function safeBase(cfg: PaypalCfg): string {
  const raw = cfg.apiUrl ?? (cfg.env === 'live' ? LIVE_API : SANDBOX_API);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(t0('pay.paypalApiUrlInvalid'));
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(t0('pay.paypalApiUrlProtocol'));
  return raw.replace(/\/+$/, '');
}

function toAmount(cents: number, currency: string): string {
  const exp = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
  return (cents / 10 ** exp).toFixed(exp);
}
function toCents(value: string, currency: string): number {
  const exp = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
  return Math.round(Number(value) * 10 ** exp);
}

/** OAuth2 client credentials：凭据缺失/鉴权失败返回 null（调用侧判 null 处理） */
async function token(base: string, cfg: PaypalCfg): Promise<string | null> {
  if (!cfg.clientId || !cfg.clientSecret) return null;
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) return null;
  return ((await res.json()) as { access_token?: string }).access_token ?? null;
}

/** createCheckout 判别联合的结构性扩展：携带 provider_ref（PayPal order id）供核心回填做 webhook 反查 */
interface PaypalCheckoutResult {
  mode: 'redirect';
  url: string;
  providerRef: string;
}

async function createCheckout(order: PayOrder, cfg: PaypalCfg): Promise<PaypalCheckoutResult> {
  const base = safeBase(cfg);
  const access = await token(base, cfg);
  if (!access) throw new Error(t0('pay.paypalNoCreds'));
  const body = {
    intent: 'CAPTURE',
    /** 买家批准即自动完成入账：redirect 流无服务端 return 处理器，避免 APPROVED 悬挂 */
    processing_instruction: 'ORDER_COMPLETE_ON_PAYMENT_APPROVAL',
    purchase_units: [
      {
        reference_id: order.orderNo,
        custom_id: order.orderNo,
        amount: { currency_code: order.currency.toUpperCase(), value: toAmount(order.amountCents, order.currency) },
      },
    ],
    application_context: {
      user_action: 'PAY_NOW',
      return_url: cfg.successUrl ?? `${base}/done`,
      cancel_url: cfg.cancelUrl ?? `${base}/cancel`,
    },
  };
  const res = await fetch(`${base}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(t0('pay.paypalCheckoutFailed'));
  const j = (await res.json()) as { id?: string; links?: { rel?: string; href?: string }[] };
  const approve = j.links?.find((l) => l.rel === 'approve')?.href ?? '';
  if (!j.id || !approve) throw new Error(t0('pay.paypalNoApprove'));
  return { mode: 'redirect', url: approve, providerRef: j.id };
}

/** 从 capture 级事件 resource 反查 PayPal 订单 id：优先 supplementary_data.related_ids.order，回落 links 的 order/up href */
function orderRefOf(resource: Record<string, unknown>): string {
  const sup = resource['supplementary_data'] as { related_ids?: { order?: string } } | undefined;
  if (sup?.related_ids?.order) return String(sup.related_ids.order);
  const links = resource['links'] as { rel?: string; href?: string }[] | undefined;
  const href = links?.find((l) => l.rel === 'order' || l.rel === 'up')?.href ?? '';
  const m = /\/v2\/checkout\/orders\/([A-Z0-9]+)/.exec(href);
  return m?.[1] ?? '';
}

function amountOf(resource: Record<string, unknown>): number | undefined {
  const a = resource['amount'] as { value?: string; currency_code?: string } | undefined;
  if (!a?.value) return undefined;
  const cents = toCents(a.value, a.currency_code ?? 'USD');
  return Number.isFinite(cents) ? cents : undefined;
}

/**
 * 从 capture 级事件 resource 解析站内订单号：下单时写入 purchase_units[0].custom_id
 * （PayPal 会复制到 capture），CHECKOUT.ORDER 事件则由 purchase_units[0].reference_id 携带。
 * 供 core/payment/orchestrator 做二级反查（退款/失败事件的 providerRef 语义与下单不同）。
 */
function orderNoOf(resource: Record<string, unknown>): string {
  const direct = resource['custom_id'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const pu = (resource['purchase_units'] as { custom_id?: string; reference_id?: string }[] | undefined)?.[0];
  const ref = pu?.custom_id ?? pu?.reference_id ?? resource['reference_id'];
  return typeof ref === 'string' ? ref.trim() : '';
}

/**
 * 验签走官方 verify-webhook-signature 接口（HMAC 材料在 PayPal 侧，本地无从自算）：
 * webhookId/clientId/clientSecret 任一缺失 → null（拒绝落账，同 stripe「未配置即拒绝」口径）。
 * 事件映射：CHECKOUT.ORDER.COMPLETED 与 PAYMENT.CAPTURE.COMPLETED → paid；
 * PAYMENT.CAPTURE.DENIED/DECLINED → failed；PAYMENT.CAPTURE.REFUNDED/REVERSED → refunded。
 * APPROVED（悬挂中间态）与未知事件 → null 忽略，绝不回落 failed。
 */
async function verifyWebhook(req: Request, cfg: PaypalCfg): Promise<ProviderEvent | null> {
  if (!cfg.webhookId || !cfg.clientId || !cfg.clientSecret) return null;
  const body = await req.text();
  let evt: { event_type?: string; resource?: Record<string, unknown> };
  try {
    evt = JSON.parse(body) as { event_type?: string; resource?: Record<string, unknown> };
  } catch {
    return null;
  }
  const base = safeBase(cfg);
  const access = await token(base, cfg);
  if (!access) return null;
  // webhook_event 必须与 PayPal 侧签名所覆盖的报文逐字节一致：外层辅助字段用 JSON.stringify 转义，
  // webhook_event 直接内嵌原始 body（上面已 JSON.parse 成功，必为合法 JSON，无注入风险），
  // 避免把解析对象重新序列化后字段顺序/数字表示漂移导致验签误拒。
  const vpayload =
    `{"auth_algo":${JSON.stringify(req.headers.get('paypal-auth-algo') ?? '')}` +
    `,"cert_url":${JSON.stringify(req.headers.get('paypal-cert-url') ?? '')}` +
    `,"transmission_id":${JSON.stringify(req.headers.get('paypal-transmission-id') ?? '')}` +
    `,"transmission_sig":${JSON.stringify(req.headers.get('paypal-transmission-sig') ?? '')}` +
    `,"transmission_time":${JSON.stringify(req.headers.get('paypal-transmission-time') ?? '')}` +
    `,"webhook_id":${JSON.stringify(cfg.webhookId)}` +
    `,"webhook_event":${body}}`;
  const vres = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: vpayload,
  });
  if (!vres.ok) return null;
  const vj = (await vres.json()) as { verification_status?: string };
  if (vj.verification_status !== 'SUCCESS') return null;

  const resource = evt.resource ?? {};
  const type = String(evt.event_type ?? '');
  const orderNo = orderNoOf(resource);
  const orderNoField = orderNo ? { orderNo } : {};
  if (type === 'CHECKOUT.ORDER.COMPLETED') {
    // resource = checkout order：capture 金额在 purchase_units[0].payments.captures[0].amount
    const pu = (resource['purchase_units'] as { payments?: { captures?: { amount?: { value?: string; currency_code?: string } }[] } }[] | undefined)?.[0];
    const cap = pu?.payments?.captures?.[0];
    const cents = cap?.amount?.value ? toCents(cap.amount.value, cap.amount.currency_code ?? 'USD') : undefined;
    return { providerRef: String(resource['id'] ?? ''), ...orderNoField, status: 'paid', amountCents: cents || undefined, raw: resource };
  }
  if (type === 'PAYMENT.CAPTURE.COMPLETED') {
    const ref = orderRefOf(resource);
    if (!ref) return null;
    return { providerRef: ref, ...orderNoField, status: 'paid', amountCents: amountOf(resource), raw: resource };
  }
  if (type === 'PAYMENT.CAPTURE.DENIED' || type === 'PAYMENT.CAPTURE.DECLINED') {
    const ref = orderRefOf(resource);
    if (!ref) return null;
    return { providerRef: ref, ...orderNoField, status: 'failed', raw: resource };
  }
  if (type === 'PAYMENT.CAPTURE.REFUNDED' || type === 'PAYMENT.CAPTURE.REVERSED') {
    const ref = orderRefOf(resource);
    if (!ref) return null;
    return { providerRef: ref, ...orderNoField, status: 'refunded', raw: resource };
  }
  return null;
}

/** 掉单对账：查询失败绝不判死（429/5xx/网络）→ pending 留待下一轮；仅 COMPLETED/VOIDED 终态可判 */
async function queryOrder(ref: string, cfg: PaypalCfg): Promise<'pending' | 'paid' | 'failed'> {
  if (!cfg.clientId || !cfg.clientSecret || !ref) return 'pending';
  const base = safeBase(cfg);
  const access = await token(base, cfg);
  if (!access) return 'pending';
  const res = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  if (!res.ok) return 'pending';
  const j = (await res.json()) as { status?: string };
  if (j.status === 'COMPLETED') return 'paid';
  if (j.status === 'VOIDED') return 'failed';
  return 'pending';
}

async function refund(order: PayOrder, cfg: PaypalCfg): Promise<{ ok: boolean; reason?: string }> {
  if (!cfg.clientId || !cfg.clientSecret) return { ok: false, reason: 'pay.refundNoCreds' };
  // 退款目标必须是 PayPal 侧真实 capture id；provider_ref（PayPal order id）由核心 OrderRow 随单带入，
  // 先查订单取 captures[0].id，再发起退款（内部订单号 FI… 必被拒）。
  const ref = (order as PayOrder & { providerRef?: string }).providerRef?.trim() ?? '';
  if (!ref) return { ok: false, reason: 'pay.refundNoRef' };
  const base = safeBase(cfg);
  const access = await token(base, cfg);
  if (!access) return { ok: false, reason: 'pay.refundAuthFailed' };
  const o = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${access}` },
  });
  if (!o.ok) return { ok: false, reason: 'pay.refundQueryFailed' };
  const oj = (await o.json()) as { purchase_units?: { payments?: { captures?: { id?: string }[] } }[] };
  const capId = oj.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? '';
  if (!capId) return { ok: false, reason: 'pay.refundNoTarget' };
  const r = await fetch(`${base}/v2/payments/captures/${encodeURIComponent(capId)}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  return r.ok ? { ok: true } : { ok: false, reason: 'pay.refundRejected' };
}

const paypalProvider: PaymentProvider = {
  id: 'paypal',
  capabilities: CAPS,
  createCheckout: createCheckout as PaymentProvider['createCheckout'],
  verifyWebhook: verifyWebhook as PaymentProvider['verifyWebhook'],
  queryOrder: queryOrder as PaymentProvider['queryOrder'],
  refund: refund as PaymentProvider['refund'],
};

export function registerPaypal(): void {
  // 出厂安装但停用：需后台填入凭据后 enable=1 才进收银台/接受回调
  registerProvider(paypalProvider, { installed: 1, enable: 0 });
}

/** 通道在扩展目录的登记项：manifest 供后台启停/配置表单（§15.4 走 /api/admin/extensions/{id}）；运行时行为经 registerProvider */
export const paypalExtensionModule: ExtensionModule = {
  manifest: PAYPAL_MANIFEST,
  schema: PAYPAL_SCHEMA,
  setup(_api: ExtensionApi): void {
    /* 无 bootstrap 贡献/事件订阅：外部通道仅按请求装配 checkout/webhook */
  },
};
