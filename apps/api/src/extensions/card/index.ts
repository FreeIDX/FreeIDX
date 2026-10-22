/**
 * card 卡密插件（T5-5，§15.5；官方通道之一，出厂 installed=1、enable=1，零外部依赖兜底）。
 * 与其它通道同为独立插件：manifest + PaymentProvider 实现。差异收敛点：
 *  - createCheckout → { mode:'redeem' }（收银台渲染兑换码输入框，无跳转/无二维码）
 *  - verifyWebhook → null（卡密无异步回调，收款即时于 redeem）
 *  - redeem（本插件独有的可选能力，见 payment-core 的 RedeemCapable）：DB 原子认领卡密防重复兑换。
 * 本模块自带通道代码；payment-core 只经 registry 结构化调用，不含通道逻辑。
 */
import type { PayOrder, PaymentProvider } from '@freeidx/shared';
import type { ExtensionManifest, ExtSchema } from '@freeidx/shared';
import type { D1b } from '../../core/db';
import type { ExtensionApi, ExtensionModule } from '../../core/extensions/registry';
import type { RedeemCapable, RedeemContext, RedeemResult } from '../../core/payment/registry';
import { registerProvider } from '../../core/payment/registry';
import { L } from '../../core/i18n';

const CARD_MANIFEST: ExtensionManifest = {
  id: 'card',
  name: L('卡密充值', '卡密儲值', 'Redemption Card', 'Пополнение кодом', 'เติมเงินด้วยรหัส', 'Einlösecode-Aufladung', '引き換えコード', '교환 코드 충전', 'Recarga con código', 'Recharge par code'),
  version: '1.0.0',
  installed: 1,
  enable: 1,
  dependencies: { 'payment-core': '>=1.0' },
  capabilities: { currencies: [], modes: ['redeem'], refund: false },
};

/** 后台配置表单 schema（插件自声明）：卡密零配置，无字段 */
const CARD_SCHEMA: ExtSchema = {
  brief: L(
    '卡密充值通道：后台批量生成 VIP 兑换卡密，用户在收银台输入兑换码即时开通，零外部依赖。',
    '卡密儲值通道：後台批次產生 VIP 兌換卡密，使用者在收銀台輸入兌換碼即時開通，零外部依賴。',
    'Redemption-card top-up: generate VIP codes in the admin panel; users redeem at the checkout for instant activation. Zero external dependencies.',
    'Пополнение кодами: массовая генерация VIP-кодов в админке; пользователь активирует их на кассе мгновенно. Без внешних зависимостей.',
    'ช่องทางเติมเงินด้วยรหัส: สร้างรหัสแลก VIP แบบกลุ่มในแผงผู้ดูแล ผู้ใช้กรอกรหัสที่หน้าชำระเงินเพื่อเปิดใช้ทันที ไม่พึ่งบริการภายนอก',
    'Code-Aufladung: VIP-Codes im Admin-Panel als Batch erzeugen; Nutzer lösen sie an der Kasse zur sofortigen Aktivierung ein. Ohne externe Abhängigkeiten.',
    '引き換えコード決済：管理画面で VIP 引き換えコードを一括生成し、ユーザーがレジでコードを入力すると即時開通します。外部依存なし。',
    '교환 코드 충전 채널: 관리자 페이지에서 VIP 교환 코드를 일괄 생성하고, 사용자가 결제 화면에서 코드를 입력하면 즉시 개통됩니다. 외부 의존성 없음.',
    'Canal de recarga con códigos: genera códigos VIP por lotes en el panel de administración; los usuarios los canjean en la caja para activarse al instante. Sin dependencias externas.',
    'Canal de recharge par codes : générez des codes VIP par lots dans le panneau d’administration ; les utilisateurs les échangent à la caisse pour une activation immédiate. Aucune dépendance externe.',
  ),
  intro: L(
    '本插件**无需任何配置**——启用后在「支付管理 → 卡密」页生成卡密即可；用户在收银台输入兑换码，验证通过即时开通 VIP。',
    '本外掛**無需任何設定**——啟用後在「支付管理 → 卡密」頁產生卡密即可；使用者在收銀台輸入兌換碼，驗證通過即時開通 VIP。',
    'This plugin requires **no configuration** — after enabling, generate codes on the “Payments → Cards” page; users enter a code at the checkout and VIP activates instantly upon verification.',
    'Плагин **не требует настройки** — после включения генерируйте коды на странице «Платежи → Карты»; пользователь вводит код на кассе, и VIP активируется мгновенно после проверки.',
    'ปลั๊กอินนี้**ไม่ต้องตั้งค่าใดๆ** — เปิดใช้งานแล้วสร้างรหัสที่หน้า “จัดการการชำระเงิน → บัตร” ได้เลย ผู้ใช้กรอกรหัสที่หน้าชำระเงิน เมื่อยืนยันผ่านจะเปิด VIP ทันที',
    'Dieses Plugin erfordert **keine Konfiguration** — nach der Aktivierung Codes auf der Seite „Zahlungen → Karten“ erzeugen; Nutzer geben an der Kasse einen Code ein, die VIP-Aktivierung erfolgt sofort nach Prüfung.',
    'このプラグインは**設定不要**です。有効化後「決済管理 → カード」ページでコードを生成してください。ユーザーがレジでコードを入力すると、検証後に即時 VIP が開通します。',
    '이 플러그인은 **설정이 필요 없습니다** — 활성화한 뒤 “결제 관리 → 카드” 페이지에서 코드를 생성하면 됩니다. 사용자가 결제 화면에 코드를 입력하면 검증 후 즉시 VIP가 개통됩니다.',
    'Este complemento **no requiere configuración**: tras activarlo, genera códigos en la página «Pagos → Tarjetas»; los usuarios introducen un código en la caja y el VIP se activa al instante tras la verificación.',
    'Ce plugin **ne nécessite aucune configuration** — après activation, générez les codes sur la page « Paiements → Cartes » ; les utilisateurs saisissent un code à la caisse et le VIP s’active immédiatement après vérification.',
  ),
  fields: [],
};

/** 卡密插件在扩展目录中的登记项：通道行为经 registerProvider 装配，此处仅提供后台可见的 manifest（启停/配置走 §15.4 通用通道） */
export const cardExtensionModule: ExtensionModule = {
  manifest: CARD_MANIFEST,
  schema: CARD_SCHEMA,
  setup(_api: ExtensionApi): void {
    /* 卡密无 bootstrap 贡献/事件订阅，收款即时于 redeem */
  },
};

/** 兑换码归一：去除所有空白 + 转大写（存库侧约定同一形式） */
export function normalizeCardCode(code: string): string {
  return String(code ?? '').replace(/\s+/g, '').toUpperCase();
}

async function redeem(order: PayOrder, code: string, ctx: RedeemContext): Promise<RedeemResult> {
  const norm = normalizeCardCode(code);
  if (!norm) return { ok: false, reason: 'card.codeRequired' };
  // 原子认领：仅未使用、未过期、且计划与订单一致的卡才置为已用；changes=1 才算抢到（防并发重复兑换）
  const r = await ctx.db
    .prepare(
      `UPDATE bbs_card SET status = 1, redeemed_uid = ?, redeemed_date = ?
       WHERE code = ? AND status = 0 AND plan_id = ? AND (expire_date = 0 OR expire_date > ?)`,
    )
    .bind(order.uid, ctx.ts, norm, order.planId, ctx.ts)
    .run();
  const claimed = Number(r.meta?.changes ?? 0);
  if (claimed !== 1) return { ok: false, reason: 'card.codeInvalid' };
  return { ok: true, providerRef: `card:${norm}` };
}

/** 结构上满足 RedeemCapable（= PaymentProvider + redeem）；createCheckout/verifyWebhook 为契约兜底实现 */
export const cardProvider: RedeemCapable & PaymentProvider = {
  id: 'card',
  capabilities: { currencies: [], modes: ['redeem'], refund: false },
  async createCheckout(): Promise<{ mode: 'redeem' }> {
    return { mode: 'redeem' };
  },
  // 卡密无异步 webhook：任何回调都视为无效（不落账）
  async verifyWebhook(): Promise<null> {
    return null;
  },
  redeem,
};

/** L1 编译期装配：登记 card Provider（幂等：Map.set）。启停仍由 kv 'extensions' 经 providerLifecycle 门控。 */
export function registerCard(): void {
  registerProvider(cardProvider, { installed: 1, enable: 1 });
}

/** 卡密码生成：C + 时间去重前缀 + 随机段（crypto 优先），大写去歧义字符集（去除 I/O/0/1） */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCardCode(): string {
  let body = '';
  try {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a);
    for (const b of a) body += ALPHABET[b % ALPHABET.length];
  } catch {
    for (let i = 0; i < 12; i++) body += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `C${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

interface CardGenInput {
  planId: number;
  count: number;
  batchNo: string;
  expireDate: number;
}
interface CardOut {
  id: number;
  code: string;
  plan_id: number;
  batch_no: string;
  status: number;
  redeemed_uid: number;
  redeemed_date: number;
  expire_date: number;
  create_date: number;
}

/** 后台批量生成卡密（§15.4 POST /api/admin/cards）：一次生成 count 张，落库返回码文明文（生成时仅此一次回显给管理员） */
export async function generateCards(db: D1b, input: CardGenInput, ts: number): Promise<CardOut[]> {
  const n = Math.max(1, Math.min(200, Math.trunc(input.count) || 1));
  const created: CardOut[] = [];
  // 多值 INSERT 分段提交：每段 20 张 = 100 绑定参数（D1 单语句上限）。逐条 INSERT 会在 count≳45 时
  // 撞 HARD_D1_QUERIES=50 预算（BudgetError 部分提交无回滚，管理员重试产生重复批次），N 条查询须收敛为 ceil(N/20) 条。
  const SEG = 20;
  for (let off = 0; off < n; off += SEG) {
    const m = Math.min(SEG, n - off);
    const values = Array.from({ length: m }, () => '(?,?,?,0,?,?)').join(',');
    const params: (string | number)[] = [];
    for (let i = 0; i < m; i++) {
      const code = genCardCode();
      params.push(code, input.planId, input.batchNo, ts, input.expireDate);
      created.push({
        id: 0,
        code,
        plan_id: input.planId,
        batch_no: input.batchNo,
        status: 0,
        redeemed_uid: 0,
        redeemed_date: 0,
        expire_date: input.expireDate,
        create_date: ts,
      });
    }
    const r = await db
      .prepare<{ id: number }>(
        `INSERT INTO bbs_card (code,plan_id,batch_no,status,create_date,expire_date) VALUES ${values} RETURNING id`,
      )
      .bind(...params)
      .all();
    const ids = (r.results ?? []).map((x) => Number(x.id));
    for (let i = 0; i < m; i++) {
      const row = created[off + i];
      if (row) row.id = ids[i] ?? 0;
    }
  }
  return created;
}

/**
 * 后台批量作废卡密（§15.4 POST /api/admin/cards/void）：仅未使用（status=0）的卡可作废，置 status=2。
 * 兑换侧原子认领 SQL 限定 status=0，作废卡天然不可兑换；已使用卡不可作废以保账目可查。
 * 返回实际作废张数（传入 id 中已使用/不存在的会被 WHERE 条件跳过）。
 */
export async function voidCards(db: D1b, ids: number[], _ts: number): Promise<number> {
  if (!ids.length) return 0;
  const marks = ids.map(() => '?').join(',');
  const r = await db.prepare(`UPDATE bbs_card SET status = 2 WHERE status = 0 AND id IN (${marks})`).bind(...ids).run();
  return Number(r.meta?.changes ?? 0);
}

/**
 * 后台批量删除卡密（§15.4 POST /api/admin/cards/delete）：仅未使用（0）/已作废（2）的卡可删，
 * 已使用（1）的卡保留兑换账目、服务端拒绝删除。返回实际删除张数。
 */
export async function deleteCards(db: D1b, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const marks = ids.map(() => '?').join(',');
  const r = await db.prepare(`DELETE FROM bbs_card WHERE status IN (0,2) AND id IN (${marks})`).bind(...ids).run();
  return Number(r.meta?.changes ?? 0);
}

/** 后台卡密列表（§15.4 GET /api/admin/cards）：可选批次/状态过滤，有界分页守预算 */
export async function listCards(db: D1b, opts: { batchNo?: string; status?: 0 | 1 | 2; limit: number; offset: number }): Promise<CardOut[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.batchNo) {
    where.push('batch_no = ?');
    params.push(opts.batchNo);
  }
  if (opts.status !== undefined) {
    where.push('status = ?');
    params.push(opts.status);
  }
  const sql = `SELECT id,code,plan_id,batch_no,status,redeemed_uid,redeemed_date,expire_date,create_date FROM bbs_card${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ? OFFSET ?`;
  const r = await db.prepare<CardOut>(sql).bind(...params, opts.limit, opts.offset).all();
  return r.results;
}
