/**
 * checkin 每日签到插件：用户每日签到领奖励——经验/金币/人民币（tt_credits 三币种）+ VIP 会员天数，
 * 数值存 ext:checkin:config（后台「插件中心」可配，0=关闭该奖励），出厂 installed=1、enable=0。
 *  - 数据归插件独占（bbs_checkin 表 schema 归核心，见 migrations/0012_checkin.sql）；
 *    PK(uid, day) 幂等：重复签到 INSERT 冲突整批回滚，零副作用。
 *  - credits 走积分账本（铁律 §15.1：point_log 流水 reason='checkin'，幂等键 checkin:{uid}:{day}）；
 *    VIP 天数复用订单履约口径（core/order.ts fulfillOrder）：vip_expire_at = MAX(现值, now) + days*86400，不挂组。
 *  - bootstrap 只下发与访客无关部分（enabled + rewards）；viewer 相关状态（今日已签/累计天数）
 *    由 GET /api/checkin 提供（contributeBootstrap 无请求上下文，且游客 bootstrap 可被边缘缓存共享）。
 *  - API 路由在 modules/plugins/routes.ts（isEnabled 门控；契约③ registerRoute 只接管非 /api 路径）。
 */
import { RunLevel, type ExtSchema } from '@freeidx/shared';
import type { ExtensionApi, ExtensionModule } from '../core/extensions/registry';
import { loadSetting } from '../core/loaders';
import { loadExtConfig } from '../core/ext-store';
import { creditDeltaStmts, dayNo } from '../core/points';
import type { D1b, Stmt } from '../core/db';
import type { Cache } from '../core/cache';
import { L } from '../core/i18n';

const CHECKIN_EXT_ID = 'checkin';

/** 后台配置表单 schema：四个数值字段（ExtFieldType 无数字控件，text + 服务端 Number 解析），键名与 ext:checkin:config 一一对应（勿改名） */
const CHECKIN_SCHEMA: ExtSchema = {
  brief: L(
    '每日签到：用户每日签到领奖励，支持经验/金币/人民币/VIP 会员天数，数值可配，0=关闭该奖励。',
    '每日簽到：使用者每日簽到領獎勵，支援經驗/金幣/人民幣/VIP 會員天數，數值可配，0=關閉該獎勵。',
    'Daily check-in: users sign in each day for rewards — experience/gold/RMB/VIP membership days; amounts configurable, 0 disables a reward.',
    'Ежедневный чек-ин: пользователи получают награды за ежедневный вход — опыт/золото/юани/дни VIP; значения настраиваются, 0 отключает награду.',
    'เช็คอินรายวัน: ผู้ใช้เช็คอินทุกวันเพื่อรับรางวัล — ประสบการณ์/เหรียญ/หยวน/วันสมาชิก VIP ตั้งค่าได้ 0=ไม่มีรางวัลนั้น',
    'Täglicher Check-in: Nutzer erhalten tägliche Anmeldeprämien — Erfahrung/Gold/RMB/VIP-Mitgliedschaftstage; Werte konfigurierbar, 0 deaktiviert die Prämie.',
    '毎日チェックイン：毎日のサインインで報酬を獲得——経験値/ゴールド/人民元/VIP 会員日数。数値は設定可能、0 で報酬オフ。',
    '매일 체크인: 사용자가 매일 서명하여 보상을 받습니다 — 경험치/골드/위안화/VIP 멤버십 일수, 값은 설정 가능, 0=해당 보상 비활성화.',
    'Registro diario: los usuarios inician sesión cada día para recibir recompensas — experiencia/oro/RMB/días de membresía VIP; valores configurables, 0 desactiva la recompensa.',
    'Check-in quotidien : les utilisateurs se connectent chaque jour pour recevoir des récompenses — expérience/or/RMB/jours d’adhésion VIP ; valeurs configurables, 0 désactive la récompense.',
  ),
  intro: L(
    '启用后首页右侧栏出现「每日签到」卡片。下方奖励数值全部可选，0 表示不发放；签到按天幂等，重复点击不会重复发放。VIP 天数从 max(当前到期时间, 现在) 起算，未过期会员自动叠加。',
    '啟用後首頁右側欄出現「每日簽到」卡片。下方獎勵數值全部可選，0 表示不發放；簽到按天冪等，重複點擊不會重複發放。VIP 天數從 max(目前到期時間, 現在) 起算，未過期會員自動疊加。',
    'Once enabled, a “Daily check-in” card appears in the homepage sidebar. All reward amounts below are optional; 0 means no payout. Check-in is idempotent per day — repeated clicks never double-grant. VIP days count from max(current expiry, now), so unexpired memberships stack automatically.',
    'После включения в правой колонке главной страницы появляется карточка «Ежедневный чек-ин». Все значения наград ниже необязательны; 0 — не выдавать. Чек-ин идемпотентен по дням: повторные клики не выдают награду дважды. Дни VIP считаются от max(текущий срок, сейчас) — действующая VIP-подписка суммируется автоматически.',
    'เมื่อเปิดใช้งาน การ์ด "เช็คอินรายวัน" จะปรากฏในแถบข้างหน้าแรก ค่ารางวัลด้านล่างเป็นตัวเลือกทั้งหมด 0 = ไม่มีการมอบ เช็คอินเป็น idempotent ตามวัน กดซ้ำไม่มอบซ้ำ วัน VIP นับจาก max(วันหมดอายุปัจจุบัน, ปัจจุบัน) สมาชิกที่ยังไม่หมดอายุจะถูกต่ออัตโนมัติ',
    'Nach der Aktivierung erscheint eine Karte „Täglicher Check-in“ in der Seitenleiste der Startseite. Alle Prämienwerte unten sind optional; 0 bedeutet keine Auszahlung. Check-in ist pro Tag idempotent — mehrfaches Klicken zahlt nicht doppelt. VIP-Tage zählen ab max(aktuellem Ablaufdatum, jetzt); nicht abgelaufene Mitgliedschaften werden automatisch addiert.',
    '有効にするとホーム右サイドバーに「毎日チェックイン」カードが表示されます。以下の報酬数値はすべて任意で、0 は不支給を意味します。チェックインは日単位で冪等のため、連打しても二重支給されません。VIP 日数は max(現在の有効期限, 現在) から起算し、期限切れでない会員は自動的に加算されます。',
    '활성화하면 홈 오른쪽 사이드바에 "매일 체크인" 카드가 나타납니다. 아래 보상 값은 모두 선택 사항이며 0은 미지급을 의미합니다. 체크인은 일 단위로 멱등하여 반복 클릭해도 중복 지급되지 않습니다. VIP 일수는 max(현재 만료일, 현재)부터 계산되어 만료되지 않은 멤버십은 자동으로 누적됩니다.',
    'Al activarlo, aparece una tarjeta «Registro diario» en la barra lateral de la portada. Todos los valores de recompensa son opcionales; 0 significa que no se otorga. El registro es idempotente por día: los clics repetidos no duplican el pago. Los días VIP se calculan desde max(caducidad actual, ahora); las membresías no caducadas se acumulan automáticamente.',
    'Une fois activé, une carte « Check-in quotidien » apparaît dans la barre latérale de l’accueil. Tous les montants ci-dessous sont optionnels ; 0 signifie aucun versement. Le check-in est idempotent par jour — les clics répétés ne doublent pas la récompense. Les jours VIP sont comptés depuis max(expiration actuelle, maintenant) ; les adhésions non expirées s’additionnent automatiquement.',
  ),
  fields: [
    {
      key: 'exp',
      type: 'text',
      label: L('经验奖励（积分）', '經驗獎勵（積分）', 'Experience reward (credits)', 'Награда опытом (кредиты)', 'รางวัลประสบการณ์ (เครดิต)', 'Erfahrungsprämie (Credits)', '経験値報酬（ポイント）', '경험치 보상(포인트)', 'Recompensa de experiencia (créditos)', 'Récompense d’expérience (crédits)'),
      placeholder: L('如 5，0=不发放', '如 5，0=不發放', 'e.g. 5; 0 = none', 'напр. 5; 0 = не выдавать', 'เช่น 5, 0=ไม่มอบ', 'z. B. 5; 0 = keine', '例: 5、0=不支給', '예: 5, 0=미지급', 'p. ej. 5; 0 = nada', 'ex. 5 ; 0 = aucun'),
      help: L(
        '每次签到发放的经验值（bbs_user.credits，走 point_log 流水），影响用户组自动升级。',
        '每次簽到發放的經驗值（bbs_user.credits，走 point_log 流水），影響使用者組自動升級。',
        'Experience granted per check-in (bbs_user.credits, recorded in point_log), affects automatic user-group upgrades.',
        'Опыт за каждый чек-ин (bbs_user.credits, проводится через point_log), влияет на автоматическое повышение группы.',
        'ค่าประสบการณ์ที่มอบต่อการเช็คอิน (bbs_user.credits บันทึกใน point_log) ส่งผลต่อการเลื่อนระดับกลุ่มผู้ใช้อัตโนมัติ',
        'Erfahrung pro Check-in (bbs_user.credits, über point_log gebucht), beeinflusst automatische Gruppenaufstiege.',
        'チェックインごとに付与される経験値（bbs_user.credits、point_log に記録）。ユーザーグループの自動昇格に影響します。',
        '체크인마다 지급되는 경험치(bbs_user.credits, point_log에 기록)로 사용자 그룹 자동 승급에 영향을 줍니다.',
        'Experiencia otorgada por registro (bbs_user.credits, registrada en point_log), afecta a las subidas automáticas de grupo.',
        'Expérience accordée par check-in (bbs_user.credits, enregistrée dans point_log), influence les promotions automatiques de groupe.',
      ),
    },
    {
      key: 'gold',
      type: 'text',
      label: L('金币奖励', '金幣獎勵', 'Gold reward', 'Награда золотом', 'รางวัลเหรียญ', 'Gold-Prämie', 'ゴールド報酬', '골드 보상', 'Recompensa de oro', 'Récompense en or'),
      placeholder: L('如 10，0=不发放', '如 10，0=不發放', 'e.g. 10; 0 = none', 'напр. 10; 0 = не выдавать', 'เช่น 10, 0=ไม่มอบ', 'z. B. 10; 0 = keine', '例: 10、0=不支給', '예: 10, 0=미지급', 'p. ej. 10; 0 = nada', 'ex. 10 ; 0 = aucun'),
      help: L(
        '每次签到发放的金币（bbs_user.golds），无流水账本。',
        '每次簽到發放的金幣（bbs_user.golds），無流水帳本。',
        'Gold granted per check-in (bbs_user.golds), no ledger.',
        'Золото за каждый чек-ин (bbs_user.golds), без журнала операций.',
        'เหรียญที่มอบต่อการเช็คอิน (bbs_user.golds) ไม่มีบันทึกธุรกรรม',
        'Gold pro Check-in (bbs_user.golds), ohne Kontobuchungen.',
        'チェックインごとに付与されるゴールド（bbs_user.golds）。台帳記録はありません。',
        '체크인마다 지급되는 골드(bbs_user.golds)로 거래 원장 기록이 없습니다.',
        'Oro otorgado por registro (bbs_user.golds), sin libro contable.',
        'Or accordé par check-in (bbs_user.golds), sans journal des opérations.',
      ),
    },
    {
      key: 'rmb',
      type: 'text',
      label: L('人民币奖励（分）', '人民幣獎勵（分）', 'RMB reward (cents)', 'Награда в юанях (центы)', 'รางวัลหยวน (หน่วยเซ็นต์)', 'RMB-Prämie (Cent)', '人民元報酬（分）', '위안화 보상(센트)', 'Recompensa en RMB (céntimos)', 'Récompense en RMB (centimes)'),
      placeholder: L('如 100，0=不发放', '如 100，0=不發放', 'e.g. 100; 0 = none', 'напр. 100; 0 = не выдавать', 'เช่น 100, 0=ไม่มอบ', 'z. B. 100; 0 = keine', '例: 100、0=不支給', '예: 100, 0=미지급', 'p. ej. 100; 0 = nada', 'ex. 100 ; 0 = aucun'),
      help: L(
        '每次签到发放的人民币，最小单位为分（bbs_user.rmbs），无流水账本。',
        '每次簽到發放的人民幣，最小單位為分（bbs_user.rmbs），無流水帳本。',
        'RMB granted per check-in, smallest unit is the cent (bbs_user.rmbs), no ledger.',
        'Юани за каждый чек-ин, минимальная единица — цент (bbs_user.rmbs), без журнала операций.',
        'เงินหยวนที่มอบต่อการเช็คอิน หน่วยเล็กสุดคือเซ็นต์ (bbs_user.rmbs) ไม่มีบันทึกธุรกรรม',
        'RMB pro Check-in, kleinste Einheit ist der Cent (bbs_user.rmbs), ohne Kontobuchungen.',
        'チェックインごとに付与される人民元。最小単位は分（bbs_user.rmbs）。台帳記録はありません。',
        '체크인마다 지급되는 위안화로 최소 단위는 센트(bbs_user.rmbs)이며 거래 원장 기록이 없습니다.',
        'RMB otorgado por registro, la unidad mínima es el céntimo (bbs_user.rmbs), sin libro contable.',
        'RMB accordé par check-in, l’unité minimale est le centime (bbs_user.rmbs), sans journal des opérations.',
      ),
    },
    {
      key: 'vipDays',
      type: 'text',
      label: L('会员天数奖励', '會員天數獎勵', 'VIP membership days reward', 'Награда днями VIP', 'รางวัลวันสมาชิก VIP', 'Prämie in VIP-Tagen', 'VIP 会員日数報酬', 'VIP 멤버십 일수 보상', 'Recompensa de días de membresía VIP', 'Récompense en jours d’adhésion VIP'),
      placeholder: L('如 1，0=不发放', '如 1，0=不發放', 'e.g. 1; 0 = none', 'напр. 1; 0 = не выдавать', 'เช่น 1, 0=ไม่มอบ', 'z. B. 1; 0 = keine', '例: 1、0=不支給', '예: 1, 0=미지급', 'p. ej. 1; 0 = nada', 'ex. 1 ; 0 = aucun'),
      help: L(
        '每次签到延长的 VIP 天数（bbs_user.vip_expire_at），享有会员权益（如附件免费下载）；不挂会员用户组。',
        '每次簽到延長的 VIP 天數（bbs_user.vip_expire_at），享有會員權益（如附件免費下載）；不掛會員使用者組。',
        'VIP days extended per check-in (bbs_user.vip_expire_at), with membership perks (e.g. free attachment downloads); no membership user group is assigned.',
        'Дни VIP, добавляемые за каждый чек-ин (bbs_user.vip_expire_at), с привилегиями членства (напр. бесплатная загрузка вложений); группа пользователя не назначается.',
        'วัน VIP ที่ต่อเพิ่มต่อการเช็คอิน (bbs_user.vip_expire_at) รับสิทธิประโยชน์สมาชิก (เช่น ดาวน์โหลดไฟล์แนบฟรี) แต่ไม่กำหนดกลุ่มผู้ใช้สมาชิก',
        'VIP-Tage, die pro Check-in verlängert werden (bbs_user.vip_expire_at), mit Mitgliedschaftsvorteilen (z. B. kostenlose Anhang-Downloads); keine Mitglieder-Benutzergruppe wird zugewiesen.',
        'チェックインごとに延長される VIP 日数（bbs_user.vip_expire_at）。会員特典（添付ファイルの無料ダウンロードなど）を利用できます。会員ユーザーグループには付与されません。',
        '체크인마다 연장되는 VIP 일수(bbs_user.vip_expire_at)로 멤버십 혜택(예: 첨부파일 무료 다운로드)을 누립니다. 멤버십 사용자 그룹은 부여되지 않습니다.',
        'Días VIP extendidos por registro (bbs_user.vip_expire_at), con ventajas de membresía (p. ej. descarga gratuita de adjuntos); no asigna un grupo de usuarios miembro.',
        'Jours VIP prolongés par check-in (bbs_user.vip_expire_at), avec les avantages membres (ex. téléchargement gratuit des pièces jointes) ; aucun groupe d’utilisateurs membre n’est attribué.',
      ),
    },
  ],
};

interface CheckinRewards {
  exp: number;
  gold: number;
  rmb: number;
  vipDays: number;
}

/** 配置 → 非负整数奖励（非法/缺省按 0=关闭） */
function parseCheckinRewards(config: Record<string, unknown>): CheckinRewards {
  const int = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return { exp: int(config.exp), gold: int(config.gold), rmb: int(config.rmb), vipDays: int(config.vipDays) };
}

/** 读奖励配置（ext:checkin:config，三层缓存读穿） */
export function loadCheckinRewards(cache: Cache, db: D1b): Promise<CheckinRewards> {
  return loadExtConfig(cache, db, CHECKIN_EXT_ID).then(parseCheckinRewards);
}

/** 本周签到概览（UTC 周，索引 0=周一 … 6=周日）：todayIndex 供前台高亮今天，week 为七天签到标记 */
interface CheckinWeek {
  todayIndex: number;
  week: boolean[];
}

/** 日序号 → 星期下标（0=周一；1970-01-01 为周四，故偏移 +3） */
function weekIndex(day: number): number {
  return (day + 3) % 7;
}

/** 游客/未登录的空白周态（今天仍照常高亮） */
export function emptyWeek(day = dayNo(Math.floor(Date.now() / 1000))): CheckinWeek {
  return { todayIndex: weekIndex(day), week: Array.from({ length: 7 }, () => false) };
}

/** 本周（周一~周日）签到标记：与 dayNo/签到日键同一 UTC 口径 */
async function checkinWeek(db: D1b, uid: number): Promise<CheckinWeek> {
  const day = dayNo(Math.floor(Date.now() / 1000));
  const todayIndex = weekIndex(day);
  const monday = day - todayIndex;
  const rows = await db
    .prepare<{ day: number }>('SELECT day FROM bbs_checkin WHERE uid = ? AND day >= ? AND day < ?')
    .bind(uid, monday, monday + 7)
    .all();
  const week = Array.from({ length: 7 }, () => false);
  for (const r of rows.results) week[Number(r.day) - monday] = true;
  return { todayIndex, week };
}

/** 签到状态（viewer 相关）：今日是否已签 + 累计签到天数 + 本周七天标记 */
export async function checkinStatus(db: D1b, uid: number): Promise<{ checked: boolean; days: number } & CheckinWeek> {
  const day = dayNo(Math.floor(Date.now() / 1000));
  const [today, total, week] = await Promise.all([
    db.prepare<{ uid: number }>('SELECT uid FROM bbs_checkin WHERE uid = ? AND day = ?').bind(uid, day).first<{ uid: number }>(),
    db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_checkin WHERE uid = ?').bind(uid).first<{ c: number }>(),
    checkinWeek(db, uid),
  ]);
  return { checked: !!today, days: Number(total?.c ?? 0), ...week };
}

/** 今日签到者列表：卡头「今日共 N 人签到」+ 签到者头像/昵称/时间/金币，≤10 条按时间倒序 */
interface CheckinTodayUser {
  uid: number;
  username: string;
  avatar: number;
  /** 本次签到发放的金币数（bbs_checkin.gold，0=该奖励未开启，前端不显示徽章） */
  gold: number;
  createDate: number;
}

export async function checkinToday(db: D1b, limit = 10): Promise<{ todayCount: number; todayUsers: CheckinTodayUser[] }> {
  const day = dayNo(Math.floor(Date.now() / 1000));
  const [cnt, rows] = await Promise.all([
    db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_checkin WHERE day = ?').bind(day).first<{ c: number }>(),
    db
      .prepare<{ uid: number; username: string; avatar: number; gold: number; create_date: number }>(
        'SELECT c.uid,u.username,u.avatar,c.gold,c.create_date FROM bbs_checkin c JOIN bbs_user u ON u.uid = c.uid WHERE c.day = ? ORDER BY c.create_date DESC LIMIT ?',
      )
      .bind(day, limit)
      .all(),
  ]);
  return {
    todayCount: Number(cnt?.c ?? 0),
    todayUsers: rows.results.map((r) => ({
      uid: r.uid,
      username: r.username,
      avatar: r.avatar,
      gold: Number(r.gold ?? 0),
      createDate: Number(r.create_date ?? 0),
    })),
  };
}

/**
 * 执行签到（单批 DB.batch() 事务）：INSERT 签到记录 + 三币种入账 + VIP 延期，全部同批原子生效。
 * bbs_checkin PK / bbs_point_log biz_key 任一唯一冲突 → 'already'（今日已签，整批回滚幂等跳过）。
 */
export async function doCheckin(
  core: { db: D1b; cache: Cache },
  uid: number,
): Promise<{ granted: CheckinRewards } | 'already'> {
  const ts = Math.floor(Date.now() / 1000);
  const day = dayNo(ts);
  const rewards = await loadCheckinRewards(core.cache, core.db);
  const stmts: Stmt[] = [
    core.db
      .prepare('INSERT INTO bbs_checkin (uid, day, exp, gold, rmb, vip_days, create_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uid, day, rewards.exp, rewards.gold, rewards.rmb, rewards.vipDays, ts),
  ];
  // credits 必须留 point_log 流水（铁律 §15.1）；golds/rmbs 仅余额直加
  stmts.push(
    ...creditDeltaStmts(core, { uid, creditType: 1, change: rewards.exp, reason: 'checkin', bizKey: `checkin:${uid}:${day}`, ts }),
  );
  if (rewards.gold > 0) {
    stmts.push(...creditDeltaStmts(core, { uid, creditType: 2, change: rewards.gold, reason: 'checkin', bizKey: `checkin:${uid}:${day}:gold`, ts }));
  }
  if (rewards.rmb > 0) {
    stmts.push(...creditDeltaStmts(core, { uid, creditType: 3, change: rewards.rmb, reason: 'checkin', bizKey: `checkin:${uid}:${day}:rmb`, ts }));
  }
  if (rewards.vipDays > 0) {
    // 与订单履约同口径：未过期用户叠加、过期/无会员用户从当下起算
    stmts.push(
      core.db.prepare('UPDATE bbs_user SET vip_expire_at = MAX(vip_expire_at, ?) + ? WHERE uid = ?').bind(ts, rewards.vipDays * 86400, uid) as unknown as Stmt,
    );
  }
  try {
    await core.db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed: (bbs_checkin|bbs_point_log)/i.test(msg)) return 'already';
    throw e;
  }
  if (rewards.vipDays > 0) await core.cache.del(`user:${uid}`);
  return { granted: rewards };
}

export const checkinPlugin: ExtensionModule = {
  manifest: {
    id: CHECKIN_EXT_ID,
    name: L('每日签到', '每日簽到', 'Daily Check-in', 'Ежедневный чек-ин', 'เช็คอินรายวัน', 'Täglicher Check-in', '毎日チェックイン', '매일 체크인', 'Registro diario', 'Check-in quotidien'),
    version: '1.0.0',
    installed: 1,
    enable: 0, // 出厂停用：后台「插件中心」启用并配置奖励后生效（与 ads 一致）
    capabilities: { rewards: ['exp', 'gold', 'rmb', 'vipDays'] },
  },
  schema: CHECKIN_SCHEMA,
  setup(api: ExtensionApi) {
    // 契约 ⑦：启用标记 + 奖励配置随核心 bootstrap 一次下发（与访客无关，可安全随游客边缘缓存共享）
    api.contributeBootstrap(async (ext) => {
      const ctx = api.ctx;
      if (!ctx) return;
      const { db, cache } = ctx as { db: D1b; cache: Cache };
      // runlevel 关站短路（§17.4 同 ads）：签到入口随站点关闭自动收起
      const setting = await loadSetting(cache, db);
      if (setting.runlevel <= RunLevel.CLOSED_SITE) return;
      ext['checkin'] = { enabled: true, rewards: await loadCheckinRewards(cache, db) };
    });
  },
};
