/**
 * stripe 通道插件（T5-6，§15.5；官方外部通道之一）。
 * 纯 REST（无重 SDK）：Checkout Sessions 托管收银台 + webhook HMAC-SHA256 验签（WebCrypto 原生）。
 * 出厂 installed=1、enable=0：后台填 secretKey + webhookSecret 即热启用；未启用通道收银台自动隐藏（providerLifecycle 门控）。
 * 通道差异全部收敛在 createCheckout/verifyWebhook（+ refund/queryOrder），payment-core 不含本文件任何逻辑。
 */
import type { PayOrder, PaymentProvider, PaymentConfig, PaymentCapabilities, ProviderEvent } from '@freeidx/shared';
import type { ExtensionManifest, ExtSchema } from '@freeidx/shared';
import type { ExtensionApi, ExtensionModule } from '../../core/extensions/registry';
import { registerProvider } from '../../core/payment/registry';
import { L, t0 } from '../../core/i18n';

const CAPS: PaymentCapabilities = { currencies: ['USD', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD'], modes: ['redirect'], refund: true };

const STRIPE_MANIFEST: ExtensionManifest = {
  id: 'stripe',
  name: L('Stripe 卡支付', 'Stripe 卡付款', 'Stripe', 'Оплата через Stripe', 'ชำระเงินผ่าน Stripe', 'Stripe-Zahlung', 'Stripe カード決済', 'Stripe 카드 결제', 'Pago con Stripe', 'Paiement Stripe'),
  version: '1.0.0',
  installed: 1,
  enable: 0,
  dependencies: { 'payment-core': '>=1.0' },
  capabilities: { currencies: [...CAPS.currencies], modes: [...CAPS.modes], refund: CAPS.refund },
};

/** 后台配置表单 schema（插件自声明）：secretKey/webhookSecret 为私密项，键名与 ext:stripe:config/secret 一一对应（勿改名） */
const STRIPE_SCHEMA: ExtSchema = {
  brief: L(
    'Stripe 国际支付通道：跳转 Stripe 托管收银台完成付款，支付结果自动回调确认，支持多币种与退款。',
    'Stripe 國際支付通道：跳轉 Stripe 託管收銀台完成付款，支付結果自動回呼確認，支援多幣種與退款。',
    'Stripe international payments: pay via Stripe’s hosted checkout, results confirmed by automatic callbacks; supports multiple currencies and refunds.',
    'Международные платежи через Stripe: оплата на хостинговом чекауте Stripe, результат подтверждается автоматическим колбэком; поддерживает несколько валют и возвраты.',
    'ช่องทางชำระเงินสากลผ่าน Stripe: ชำระผ่านหน้าเช็คเอาต์ที่ Stripe ดูแล ผลการชำระยืนยันอัตโนมัติด้วย callback รองรับหลายสกุลเงินและการคืนเงิน',
    'Internationale Zahlungen über Stripe: Bezahlung über Stripes gehostete Kasse, Ergebnis wird per automatischem Callback bestätigt; unterstützt mehrere Währungen und Rückerstattungen.',
    'Stripe 国際決済チャネル：Stripe のホスト型チェックアウトで支払いを完了し、結果は自動コールバックで確認。多通貨と返金に対応。',
    'Stripe 국제 결제 채널: Stripe 호스팅 결제창에서 결제를 완료하며 결과는 자동 콜백으로 확인합니다. 다중 통화와 환불을 지원합니다.',
    'Canal internacional de pagos Stripe: paga en la pasarela alojada de Stripe, el resultado se confirma con callbacks automáticos; admite varias monedas y reembolsos.',
    'Canal de paiement international Stripe : paiement via la caisse hébergée de Stripe, résultat confirmé par callback automatique ; prend en charge plusieurs devises et remboursements.',
  ),
  intro: L(
    '填好下方密钥并启用本插件后，收银台会自动出现 Stripe 跳转支付（未启用或未配置时对用户完全隐藏，不影响其他通道）。',
    '填好下方密鑰並啟用本外掛後，收銀台會自動出現 Stripe 跳轉支付（未啟用或未設定時對使用者完全隱藏，不影響其他通道）。',
    'After filling in the keys below and enabling this plugin, a Stripe redirect option appears automatically at checkout (fully hidden from users while disabled or unconfigured, other channels unaffected).',
    'После заполнения ключей ниже и включения плагина в чекауте автоматически появляется перенаправление на Stripe (пока выключено или не настроено — полностью скрыто от пользователей, другие каналы не затронуты).',
    'เมื่อกรอกคีย์ด้านล่างและเปิดใช้ปลั๊กอินแล้ว ตัวเลือกชำระผ่าน Stripe จะปรากฏในหน้าเช็คเอาต์อัตโนมัติ (ซ่อนจากผู้ใช้ทั้งหมดเมื่อยังไม่เปิดหรือยังไม่ตั้งค่า ไม่กระทบช่องทางอื่น)',
    'Nach dem Ausfüllen der Schlüssel unten und der Aktivierung des Plugins erscheint Stripe-Weiterleitung automatisch an der Kasse (während deaktiviert oder unkonfiguriert vollständig ausgeblendet; andere Kanäle unberührt).',
    '下のキーを入力して本プラグインを有効化すると、チェックアウトに Stripe へのリダイレクト決済が自動表示されます（無効または未設定の間はユーザーに一切表示されず、他のチャネルにも影響しません）。',
    '아래 키를 입력하고 이 플러그인을 활성화하면 결제창에 Stripe 리디렉션 결제가 자동으로 표시됩니다(비활성화 또는 미설정 시 사용자에게 완전히 숨겨지고 다른 채널에 영향이 없습니다).',
    'Tras rellenar las claves de abajo y activar este complemento, aparece automáticamente la opción de redirección a Stripe en la pasarela (totalmente oculta para los usuarios mientras esté desactivado o sin configurar; no afecta a otros canales).',
    'Après avoir renseigné les clés ci-dessous et activé ce plugin, une option de redirection vers Stripe apparaît automatiquement à la caisse (totalement masquée tant que désactivé ou non configuré ; n’affecte pas les autres canaux).',
  ),
  fields: [
    {
      key: 'secretKey',
      target: 'secret',
      type: 'password',
      label: 'Stripe Secret Key',
      placeholder: L('sk_live_… 或 sk_test_…，留空保持不变', 'sk_live_… 或 sk_test_…，留空保持不變', 'sk_live_… or sk_test_…, leave blank to keep unchanged', 'sk_live_… или sk_test_…, оставьте пустым, чтобы не менять', 'sk_live_… หรือ sk_test_… เว้นว่างเพื่อคงค่าเดิม', 'sk_live_… oder sk_test_…, leer lassen, um unverändert zu bleiben', 'sk_live_… または sk_test_…、空欄で変更なし', 'sk_live_… 또는 sk_test_…, 비워 두면 변경 없음', 'sk_live_… o sk_test_…, dejar en blanco para mantener el valor', 'sk_live_… ou sk_test_…, laisser vide pour conserver'),
      help: L(
        'Stripe 后台 → Developers → API keys → Secret key。测试模式用 sk_test_ 开头，正式收款用 sk_live_ 开头。这是收款必填项。',
        'Stripe 後台 → Developers → API keys → Secret key。測試模式用 sk_test_ 開頭，正式收款用 sk_live_ 開頭。這是收款必填項。',
        'Stripe dashboard → Developers → API keys → Secret key. Use the sk_test_ prefix for test mode and sk_live_ for live payments. Required for taking payments.',
        'Панель Stripe → Developers → API keys → Secret key. В тестовом режиме — префикс sk_test_, для реальных платежей — sk_live_. Обязательное поле для приёма платежей.',
        'แดชบอร์ด Stripe → Developers → API keys → Secret key โหมดทดสอบใช้คำนำหน้า sk_test_ ส่วนรับชำระจริงใช้ sk_live_ เป็นข้อมูลบังคับสำหรับการรับเงิน',
        'Stripe-Dashboard → Developers → API keys → Secret key. Im Testmodus mit sk_test_, für echte Zahlungen mit sk_live_. Pflichtfeld für den Zahlungseingang.',
        'Stripe ダッシュボード → Developers → API keys → Secret key。テストモードは sk_test_、本番の売上計上には sk_live_ で始まるキーを使用します。入金には必須です。',
        'Stripe 대시보드 → Developers → API keys → Secret key. 테스트 모드는 sk_test_로, 실제 결제 수령은 sk_live_로 시작합니다. 결제 수령에 필수 항목입니다.',
        'Panel de Stripe → Developers → API keys → Secret key. En modo de prueba usa el prefijo sk_test_ y para cobros reales sk_live_. Campo obligatorio para cobrar.',
        'Tableau de bord Stripe → Developers → API keys → Secret key. En mode test, préfixe sk_test_ ; pour les encaissements réels, sk_live_. Champ obligatoire pour encaisser.',
      ),
    },
    {
      key: 'webhookSecret',
      target: 'secret',
      type: 'password',
      label: L('Webhook 签名密钥', 'Webhook 簽名密鑰', 'Webhook signing secret', 'Секрет подписи webhook', 'รหัสลับลงชื่อ Webhook', 'Webhook-Signaturgeheimnis', 'Webhook 署名シークレット', '웹훅 서명 시크릿', 'Secreto de firma del webhook', 'Secret de signature du webhook'),
      placeholder: L('whsec_…，留空保持不变', 'whsec_…，留空保持不變', 'whsec_…, leave blank to keep unchanged', 'whsec_…, оставьте пустым, чтобы не менять', 'whsec_… เว้นว่างเพื่อคงค่าเดิม', 'whsec_…, leer lassen, um unverändert zu bleiben', 'whsec_…、空欄で変更なし', 'whsec_…, 비워 두면 변경 없음', 'whsec_…, dejar en blanco para mantener el valor', 'whsec_…, laisser vide pour conserver'),
      help: L(
        'Stripe 后台 → Developers → Webhooks 添加端点（指向站点的 Stripe 回调地址）后，点击签名密钥（Signing secret）复制 whsec_ 开头的值。不填则回调验签关闭，订单状态只能靠主动查询。',
        'Stripe 後台 → Developers → Webhooks 新增端點（指向站點的 Stripe 回呼位址）後，點擊簽名密鑰（Signing secret）複製 whsec_ 開頭的值。不填則回呼驗簽關閉，訂單狀態只能靠主動查詢。',
        'In the Stripe dashboard → Developers → Webhooks, add an endpoint (pointing to your site’s Stripe callback URL), then copy the whsec_ value under Signing secret. If left empty, callback signature verification is off and order status must be checked by polling.',
        'В панели Stripe → Developers → Webhooks добавьте endpoint (указывающий на callback-адрес Stripe вашего сайта), затем скопируйте значение whsec_ из «Signing secret». Если оставить пустым, проверка подписи колбэков отключится и статус заказа придётся опрашивать вручную.',
        'ในแดชบอร์ด Stripe → Developers → Webhooks เพิ่ม endpoint (ชี้ไปที่ callback URL ของ Stripe สำหรับไซต์คุณ) แล้วคัดลอกค่า whsec_ จาก Signing secret ถ้าเว้นว่าง การตรวจลายเซ็น callback จะปิด และสถานะคำสั่งต้องเช็คด้วยการ query เอง',
        'Stripe-Dashboard → Developers → Webhooks: Endpoint hinzufügen (verweist auf die Stripe-Callback-URL Ihrer Website), dann den whsec_-Wert unter „Signing secret“ kopieren. Bleibt das Feld leer, ist die Callback-Signaturprüfung aus; Bestellstatus nur per Abfrage.',
        'Stripe ダッシュボード → Developers → Webhooks でエンドポイント（サイトの Stripe コールバック URL）を追加し、Signing secret の whsec_ で始まる値をコピーします。未入力の場合はコールバック署名検証が無効となり、注文状態は能動的な照会でのみ確認できます。',
        'Stripe 대시보드 → Developers → Webhooks에서 엔드포인트(사이트의 Stripe 콜백 URL)를 추가한 뒤 Signing secret의 whsec_ 값을 복사합니다. 비워 두면 콜백 서명 검증이 꺼져 주문 상태를 직접 조회해야 합니다.',
        'En el panel de Stripe → Developers → Webhooks, añade un endpoint (apuntando a la URL de callback de Stripe de tu sitio) y copia el valor whsec_ de «Signing secret». Si se deja vacío, la verificación de firma del callback queda desactivada y el estado del pedido solo se consulta activamente.',
        'Dans le tableau de bord Stripe → Developers → Webhooks, ajoutez un endpoint (pointant vers l’URL de callback Stripe de votre site), puis copiez la valeur whsec_ sous « Signing secret ». Laissé vide, la vérification de signature des callbacks est désactivée et le statut des commandes doit être interrogé activement.',
      ),
    },
    {
      key: 'successUrl',
      type: 'text',
      label: L('支付成功跳转地址', '付款成功跳轉位址', 'Payment success redirect URL', 'URL перенаправления при успешной оплате', 'URL สำหรับกระโดดกลับเมื่อชำระสำเร็จ', 'Weiterleitungs-URL nach erfolgreicher Zahlung', '支払い成功時のリダイレクト URL', '결제 성공 리디렉션 URL', 'URL de redirección al pagar con éxito', 'URL de redirection après paiement réussi'),
      placeholder: L('留空使用站点默认', '留空使用站點預設', 'Leave blank for the site default', 'Оставьте пустым для значения сайта по умолчанию', 'เว้นว่างเพื่อใช้ค่าเริ่มต้นของไซต์', 'Leer lassen für die Standard-URL der Website', '空欄でサイト既定を使用', '비워 두면 사이트 기본값 사용', 'Dejar en blanco para el valor predeterminado del sitio', 'Laisser vide pour la valeur par défaut du site'),
      help: L(
        '用户在 Stripe 付款成功后浏览器跳回的完整 URL（https:// 开头）。留空时由站点按当前域名默认处理。',
        '使用者在 Stripe 付款成功後瀏覽器跳回的完整 URL（https:// 開頭）。留空時由站點按目前網域預設處理。',
        'Full URL the browser returns to after successful Stripe payment (must start with https://). If empty, the site handles it by the current domain by default.',
        'Полный URL, на который браузер возвращается после успешной оплаты через Stripe (начинается с https://). Если пусто, сайт обрабатывает это по умолчанию для текущего домена.',
        'URL แบบเต็มที่เบราว์เซอร์จะกลับมาหลังชำระผ่าน Stripe สำเร็จ (ขึ้นต้นด้วย https://) ถ้าเว้นว่างไซต์จะจัดการตามโดเมนปัจจุบันเป็นค่าเริ่มต้น',
        'Vollständige URL, zu der der Browser nach erfolgreicher Stripe-Zahlung zurückkehrt (beginnt mit https://). Leer: Die Website behandelt dies standardmäßig über die aktuelle Domain.',
        'Stripe での支払い成功後にブラウザーが戻る完全な URL（https:// で始まる）。空欄の場合はサイトが現在のドメインで既定処理します。',
        'Stripe 결제 성공 후 브라우저가 돌아올 전체 URL(https://로 시작). 비워 두면 사이트가 현재 도메인 기본값으로 처리합니다.',
        'URL completa a la que vuelve el navegador tras pagar con éxito en Stripe (debe empezar por https://). Si se deja vacío, el sitio lo gestiona por defecto según el dominio actual.',
        'URL complète vers laquelle le navigateur revient après un paiement Stripe réussi (doit commencer par https://). Vide : le site le gère par défaut selon le domaine actuel.',
      ),
    },
    {
      key: 'cancelUrl',
      type: 'text',
      label: L('取消支付跳转地址', '取消付款跳轉位址', 'Payment cancel redirect URL', 'URL перенаправления при отмене оплаты', 'URL สำหรับกระโดดกลับเมื่อยกเลิกการชำระ', 'Weiterleitungs-URL bei Zahlungsabbruch', '支払いキャンセル時のリダイレクト URL', '결제 취소 리디렉션 URL', 'URL de redirección al cancelar el pago', 'URL de redirection en cas d’annulation du paiement'),
      placeholder: L('留空使用站点默认', '留空使用站點預設', 'Leave blank for the site default', 'Оставьте пустым для значения сайта по умолчанию', 'เว้นว่างเพื่อใช้ค่าเริ่มต้นของไซต์', 'Leer lassen für die Standard-URL der Website', '空欄でサイト既定を使用', '비워 두면 사이트 기본값 사용', 'Dejar en blanco para el valor predeterminado del sitio', 'Laisser vide pour la valeur par défaut du site'),
      help: L(
        '用户在 Stripe 收银台点取消后跳回的完整 URL（https:// 开头）。留空时由站点按当前域名默认处理。',
        '使用者在 Stripe 收銀台點取消後跳回的完整 URL（https:// 開頭）。留空時由站點按目前網域預設處理。',
        'Full URL the browser returns to after the user cancels at the Stripe checkout (must start with https://). If empty, the site handles it by the current domain by default.',
        'Полный URL, на который браузер возвращается после отмены на чекауте Stripe (начинается с https://). Если пусто, сайт обрабатывает это по умолчанию для текущего домена.',
        'URL แบบเต็มที่เบราว์เซอร์จะกลับมาหลังผู้ใช้กดยกเลิกที่หน้าเช็คเอาต์ของ Stripe (ขึ้นต้นด้วย https://) ถ้าเว้นว่างไซต์จะจัดการตามโดเมนปัจจุบันเป็นค่าเริ่มต้น',
        'Vollständige URL, zu der der Browser nach Abbruch an der Stripe-Kasse zurückkehrt (beginnt mit https://). Leer: Die Website behandelt dies standardmäßig über die aktuelle Domain.',
        'ユーザーが Stripe のチェックアウトでキャンセルした後にブラウザーが戻る完全な URL（https:// で始まる）。空欄の場合はサイトが現在のドメインで既定処理します。',
        '사용자가 Stripe 결제창에서 취소한 후 브라우저가 돌아올 전체 URL(https://로 시작). 비워 두면 사이트가 현재 도메인 기본값으로 처리합니다.',
        'URL completa a la que vuelve el navegador cuando el usuario cancela en la pasarela de Stripe (debe empezar por https://). Si se deja vacío, el sitio lo gestiona por defecto según el dominio actual.',
        'URL complète vers laquelle le navigateur revient après annulation à la caisse Stripe (doit commencer par https://). Vide : le site le gère par défaut selon le domaine actuel.',
      ),
    },
  ],
};

interface StripeCfg extends PaymentConfig {
  secretKey?: string; // sk_live / sk_test
  webhookSecret?: string; // whsec_...
  apiUrl?: string; // 默认 https://api.stripe.com（测试可注入本地 mock 基址）
  successUrl?: string;
  cancelUrl?: string;
}

const API = 'https://api.stripe.com';
// webhook 重放容忍窗口（Stripe 官方默认 5 分钟）：|now - t| 超此值即拒绝，防被截获的签名体重放。
const WEBHOOK_TOLERANCE_SEC = 300;

/** 出网基址校验：仅允许 http/https（该请求携带 secretKey Bearer，须锁死协议、拒绝 file/gopher/注入改写目标）。 */
function safeBase(cfg: StripeCfg): string {
  const raw = cfg.apiUrl ?? API;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(t0('pay.stripeApiUrlInvalid'));
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(t0('pay.stripeApiUrlProtocol'));
  return raw.replace(/\/+$/, '');
}

/** createCheckout 判别联合的结构性扩展：携带 provider_ref（session id）供核心回填做 webhook 反查 */
interface StripeCheckoutResult {
  mode: 'redirect';
  url: string;
  providerRef: string;
}

function hmacHex(secret: string, payload: string): Promise<string> {
  return (async () => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  })();
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function createCheckout(order: PayOrder, cfg: StripeCfg): Promise<StripeCheckoutResult> {
  const base = safeBase(cfg);
  if (!cfg.secretKey) throw new Error('pay.refundNoCreds');
  const line = form({
    'mode': 'payment',
    'client_reference_id': order.orderNo,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': order.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(order.amountCents),
    'line_items[0][price_data][product_data][name]': order.orderNo,
    'success_url': cfg.successUrl ?? `${base}/done`,
    'cancel_url': cfg.cancelUrl ?? `${base}/cancel`,
    'metadata[order_no]': order.orderNo,
  });
  const res = await fetch(`${base}/v1/checkout/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: line,
  });
  const j = (await res.json()) as { id?: string; url?: string };
  if (!j.id || !j.url) throw new Error(t0('pay.stripeCheckoutFailed'));
  return { mode: 'redirect', url: j.url, providerRef: j.id };
}

/** Stripe 签名头：`t=<ts>,v1=<hex>[,v1=...]`；signed = `${t}.${rawBody}` 的 HMAC-SHA256(secret) */
async function verifyWebhook(req: Request, cfg: StripeCfg): Promise<ProviderEvent | null> {
  const header = req.headers.get('stripe-signature') ?? '';
  const secret = cfg.webhookSecret;
  if (!header || !secret) return null;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()] as const;
    }),
  );
  const ts = parts['t'];
  const sigs = header.split(',').map((kv) => kv.trim()).filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  if (!ts || sigs.length === 0) return null;
  // 重放防护：签名时间戳须在当前容忍窗口内（否则被截获的合法签名体可无限重放）。
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > WEBHOOK_TOLERANCE_SEC) return null;
  const body = await req.text();
  const expected = await hmacHex(secret, `${ts}.${body}`);
  if (!sigs.some((s) => safeEqualHex(s, expected))) return null; // 验签失败 → 拒绝落账

  let evt: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    evt = JSON.parse(body);
  } catch {
    return null;
  }
  const obj = evt.data?.object ?? {};
  const providerRef = String(obj['id'] ?? obj['reference'] ?? '');
  if (!providerRef) return null;
  // 站内订单号：下单时写入 session 的 metadata.order_no（Stripe 会复制到 PaymentIntent/Charge），
  // 以及 session 的 client_reference_id。退款/失败类事件的 providerRef 是 ch_/re_/pi_ 而非下单存的
  // cs_，无法反查订单，必须靠此标识兜底（core/payment/orchestrator 二级反查），否则钱退了单不动。
  const meta = obj['metadata'] as Record<string, unknown> | undefined;
  const orderNo = String(meta?.['order_no'] ?? obj['client_reference_id'] ?? '').trim();
  const base = { providerRef, ...(orderNo ? { orderNo } : {}) };
  const type = String(evt.type ?? '');
  // Checkout Session 事件金额在 amount_total；PaymentIntent 事件金额在 amount（无 amount_total）。
  // 二者字段名不同，必须按对象类型分别取，否则 payment_intent.succeeded 取到 undefined → 金额一致性校验被跳过。
  if (type === 'checkout.session.completed') {
    // 异步支付方式（SEPA/银行转账等）completed 事件到达时 payment_status 仍为 unpaid，
    // 必须等 async_payment_succeeded 才算到账；此时若按 paid 履约，会出现「未付款先发会员」。
    const ps = String(obj['payment_status'] ?? '');
    // 未到账：返回 ignored（HTTP 200 ack），等 async_payment_succeeded 再落账；
    // 不能返回 null（=验签失败 400），否则 Stripe 会重试同一事件。
    if (ps !== 'paid' && ps !== 'no_payment_required') return { ...base, status: 'ignored', raw: obj };
    return { ...base, status: 'paid', amountCents: Number(obj['amount_total'] ?? 0) || undefined, raw: obj };
  }
  if (type === 'checkout.session.async_payment_succeeded') {
    return { ...base, status: 'paid', amountCents: Number(obj['amount_total'] ?? 0) || undefined, raw: obj };
  }
  if (type === 'payment_intent.succeeded') {
    return { ...base, status: 'paid', amountCents: Number(obj['amount'] ?? 0) || undefined, raw: obj };
  }
  if (type === 'charge.refunded') {
    // amount_refunded 是累计退款额：只有累计达到订单全额，核心才回收会员/积分（部分退款仅记录）
    return { ...base, status: 'refunded', amountCents: Number(obj['amount_refunded'] ?? 0) || undefined, raw: obj };
  }
  if (type === 'refund.created') {
    return { ...base, status: 'refunded', amountCents: Number(obj['amount'] ?? 0) || undefined, raw: obj };
  }
  if (
    type === 'checkout.session.expired' ||
    type === 'checkout.session.async_payment_failed' ||
    type === 'payment_intent.payment_failed'
  ) {
    return { ...base, status: 'failed', raw: obj };
  }
  // 争议关闭 ≠ 支付失败：dispute 发生在支付之后（订单多已 paid/fulfilled），failed→closeOrder 会触发
  // 非法迁移或误关已履约单；败诉由 Stripe 另发 charge.refunded 走 refunded 分支，胜诉无需动作。
  // 未知/无关事件类型（含 charge.dispute.closed）：忽略（返回 null），绝不回落 failed。
  return null;
}

async function queryOrder(ref: string, cfg: StripeCfg): Promise<'pending' | 'paid' | 'failed'> {
  const base = safeBase(cfg);
  if (!cfg.secretKey || !ref) return 'pending';
  const res = await fetch(`${base}/v1/checkout/sessions/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${cfg.secretKey}` },
  });
  // 查询失败（限流 429/网络/5xx/资源暂不可见）绝不判死：返回 pending 留待下一轮对账或 webhook 定论。
  // failed→closeOrder 会把可支付订单推进终态 closed（closed 无出边），此后真实 paid webhook
  // 落在 closed 单上被 applyProviderEvent 忽略 → 用户已付却永不履约。
  if (!res.ok) return 'pending';
  const j = (await res.json()) as { payment_status?: string };
  // Checkout 会话 payment_status 仅 paid/unpaid/no_payment_required；未确认已付一律 pending。
  if (j.payment_status === 'paid') return 'paid';
  return 'pending';
}

async function refund(order: PayOrder, cfg: StripeCfg): Promise<{ ok: boolean; reason?: string }> {
  const base = safeBase(cfg);
  if (!cfg.secretKey) return { ok: false, reason: 'pay.refundNoCreds' };
  // 退款目标必须是 Stripe 侧真实对象（payment_intent pi_ / charge ch_），内部订单号 FI… 必被拒。
  // provider_ref（Checkout 会话 id cs_）由 payment-core 的 OrderRow 随 order 一并带入。
  const ref = (order as PayOrder & { providerRef?: string }).providerRef?.trim() ?? '';
  if (!ref) return { ok: false, reason: 'pay.refundNoRef' };
  let paymentIntent = '';
  if (/^(pi_|ch_)/.test(ref)) {
    paymentIntent = ref;
  } else {
    const s = await fetch(`${base}/v1/checkout/sessions/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${cfg.secretKey}` },
    });
    if (!s.ok) return { ok: false, reason: 'pay.refundQueryFailed' };
    const sj = (await s.json()) as { payment_intent?: string };
    paymentIntent = sj.payment_intent ?? '';
  }
  if (!paymentIntent) return { ok: false, reason: 'pay.refundNoTarget' };
  const res = await fetch(`${base}/v1/refunds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ 'payment_intent': paymentIntent }),
  });
  return res.ok ? { ok: true } : { ok: false, reason: 'pay.refundRejected' };
}

export const stripeProvider: PaymentProvider = {
  id: 'stripe',
  capabilities: CAPS,
  createCheckout: createCheckout as PaymentProvider['createCheckout'],
  verifyWebhook: verifyWebhook as PaymentProvider['verifyWebhook'],
  queryOrder: queryOrder as PaymentProvider['queryOrder'],
  refund: refund as PaymentProvider['refund'],
};

export function registerStripe(): void {
  // 出厂安装但停用：需后台填入密钥后 enable=1 才进收银台/接受回调
  registerProvider(stripeProvider, { installed: 1, enable: 0 });
}

/** 通道在扩展目录的登记项：manifest 供后台启停/配置表单（§15.4 走 /api/admin/extensions/{id}）；运行时行为经 registerProvider */
export const stripeExtensionModule: ExtensionModule = {
  manifest: STRIPE_MANIFEST,
  schema: STRIPE_SCHEMA,
  setup(_api: ExtensionApi): void {
    /* 无 bootstrap 贡献/事件订阅：外部通道仅按请求装配 checkout/webhook */
  },
};
