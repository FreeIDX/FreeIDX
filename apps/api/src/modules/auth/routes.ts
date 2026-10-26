/**
 * 鉴权接口（T2-4，§8.1-8.4）：
 *  POST   /api/auth/email-code     邮箱验证码（email_code 表按 email 存 + TTL，§D.8#11）
 *  POST   /api/auth/register       注册
 *  POST   /api/auth/login          登录
 *  DELETE /api/auth/logout         登出
 *  POST   /api/auth/admin-token    后台二次验证（前台会话 + 口令复核重签 admin_at）
 * 新增防线（§14.3 T2-4）：Turnstile 人机验证、同 email 60s + 日上限频控、IP×账号失败 5 次锁 15min。
 * 降级：无 EMAIL_API_KEY ⇒ user_create_email_on 等效 0（§11.3）；无 TURNSTILE_SECRET ⇒ 直通（铁律 8 账号未到货）。
 * 口令链路：入参均为前端预哈希 32hex；新用户 PBKDF2 入库（T2-1）；存量 md5 命中只标记 upgradeNeeded 不请求内重算（§8.4）。
 */
import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { ADMIN_TOKEN_TTL, BanScope, Code, GroupId, effectiveBanScope, type LoginReq, type RegisterReq } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { core, randomPresetAvatar, readJson, type ReadEnv } from '../shared';
import { loadSetting, loadViewer, reqIp } from '../../core/loaders';
import { banMessage } from '../../core/ban';
import { createSession, destroySession, destroyUserSessions, ipToLong } from '../../core/auth/session';
import { hashPassword, verifyClientPassword } from '../../core/auth';
import { issueAccessToken, ACCESS_TOKEN_TTL } from '../../core/auth/jwt';
import { issueAdminToken } from '../../core/auth/admin';
import { isEmail, isPassword, isUsername } from '../../core/auth/validate';
import { getEmailProvider } from '../../core/email';
import { canonicalBase, isHttpsRequest } from '../../core/site';
import { verifyTurnstile } from '../../core/turnstile';
import { USER_SESSION_COLS } from '../../core/db/columns';
import type { D1b, Stmt } from '../../core/db';
import { creditDeltaStmts, upgradeGroupByCredits } from '../../core/points';
import { getExtensions } from '../../core/extensions';
import { t0 } from '../../core/i18n';

/** 验证码「5 分钟内有效」口径（TTL 落库强制过期） */
const EMAIL_CODE_TTL = 300;
const SEND_MIN_INTERVAL = 60;
const SEND_DAILY_CAP = 10;
/** IP×账号失败计数 5 次锁 15min（设计新增） */

/** c.executionCtx 在无 ExecutionContext 绑定的环境（本地/测试）会抛错——安全取用（与 write/routes.ts 同款） */
function safeExecCtx(c: Context<ReadEnv>): { waitUntil?: (pr: Promise<unknown>) => void } | undefined {
  try {
    return c.executionCtx as { waitUntil?: (pr: Promise<unknown>) => void };
  } catch {
    return undefined;
  }
}
const FAIL_LIMIT = 5;
const FAIL_LOCK_TTL = 900;
/** 找回密码一次性 token（落 email_code 表；§D.8#11）：30min 有效 */
const RESET_SCENE = 'user_resetpw';
const RESET_TOKEN_TTL = 1800;

/** URL-safe 一次性 token（crypto 随机，非 6 位数字码，抗枚举/爆破） */
function randomTokenHex(bytes = 16): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of arr) s += b.toString(16).padStart(2, '0');
  return s;
}

interface UserSessionRow {
  uid: number;
  gid: number;
  password: string;
  salt: string;
  token_version: number;
  avatar: number;
  username: string;
  email: string;
  /** 小黑屋（0025）：USER_SESSION_COLS 已投影，登录前置判定禁登位 */
  ban_scope: number;
  ban_until: number;
  ban_reason: string;
}

const now = () => Math.floor(Date.now() / 1000);
const ipLongOf = (c: Context<ReadEnv>): number => ipToLong(reqIp(c));

/**
 * 注册默认积分（kv 三键 d_credit/d_gold/d_rmb）：
 * D1（SQLite）不支持改列默认，改存 kv 三键，注册时显式发放。
 * 读取失败/未配置 = 0（不赠送）。
 */
async function loadRegisterCredits(db: D1b): Promise<{ credits: number; golds: number; rmbs: number }> {
  const rows = await db
    .prepare<{ k: string; v: string }>('SELECT k,v FROM bbs_kv WHERE k IN (?,?,?)')
    .bind('d_credit', 'd_gold', 'd_rmb')
    .all();
  const get = (k: string): number => {
    const n = Math.trunc(Number(rows.results.find((r) => String(r.k) === k)?.v ?? 0));
    return Number.isFinite(n) ? n : 0;
  };
  return { credits: get('d_credit'), golds: get('d_gold'), rmbs: get('d_rmb') };
}

/** 双轨签发（§8.1）：session 行 + Cookie sid，配置了 JWT_SECRET 再发 Cookie at；gid=1 追加后台 Cookie admin_at（T3-3） */
async function grant(c: Context<ReadEnv>, uid: number, tokenVersion: number, gid: number): Promise<void> {
  const db = c.get('db');
  const sid = await createSession(db, uid, {
    ip: ipLongOf(c),
    useragent: c.req.header('user-agent') ?? '',
    url: new URL(c.req.url).pathname,
  });
  const secure = isHttpsRequest(c);
  setCookie(c, 'sid', sid, { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: ACCESS_TOKEN_TTL });
  if (c.env.JWT_SECRET) {
    const at = await issueAccessToken(c.env.JWT_SECRET, uid, tokenVersion);
    setCookie(c, 'at', at, { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: ACCESS_TOKEN_TTL });
  }
  const adminSecret = c.env.ADMIN_JWT_SECRET ?? c.env.JWT_SECRET;
  // 同浏览器换号（管理员未登出 → 普通用户登录/注册）时必须清掉上一个账号的后台令牌，
  // 否则 adminGuard 仍会按旧 token 里的 uid 回查到管理员，导致后台权限跨账号残留。
  if (gid === GroupId.ADMIN && adminSecret) {
    const adminAt = await issueAdminToken(adminSecret, uid, tokenVersion);
    setCookie(c, 'admin_at', adminAt, { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: ADMIN_TOKEN_TTL });
  } else {
    setCookie(c, 'admin_at', '', { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: 0 });
  }
}

export function authRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.post('/api/auth/email-code', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const b = await readJson<{ scene?: string; email?: string; turnstileToken?: string }>(c);
    if (!(await verifyTurnstile(c.env, b.turnstileToken, reqIp(c)))) {
      throw new AppError(Code.CAPTCHA_FAILED, t('auth.captchaFailed'));
    }
    const setting = await loadSetting(cache, db);
    const provider = await getEmailProvider(c.env, db, cache);
    const email = (b.email ?? '').trim().toLowerCase();
    if (!email) throw new AppError(Code.FORM_INVALID_EMAIL, t('auth.emailRequired'));
    const ferr = isEmail(email, t);
    if (ferr) throw new AppError(Code.FORM_INVALID_EMAIL, ferr);

    // 仅注册场景（6 位数字码）。找回密码走独立的一次性 token 链接（/password-reset/request），
    // 不再复用本接口：两者若共用一个 scene，(a) 6 位码会被 /password-reset/confirm 当作 token 接受，
    // (b) 频控互相挤占，(c) 本接口对未注册邮箱明说不存在，等于给找回密码的防枚举开了个侧门。
    const scene = 'user_create';
    if (b.scene !== scene) throw new AppError(Code.VALIDATION_ERROR, t('auth.sceneInvalid'));
    if (!setting.userCreateOn) throw new AppError(Code.NOT_LOGIN, t('auth.registerDisabled'));
    if (!setting.userCreateEmailOn) throw new AppError(Code.NOT_LOGIN, t('auth.emailVerifyDisabled'));
    if (!provider) throw new AppError(Code.NOT_LOGIN, t('auth.mailUnconfigured'));
    const dup = await db.prepare('SELECT uid FROM bbs_user WHERE email = ?').bind(email).first<{ uid: number }>();
    if (dup) throw new AppError(Code.FORM_EMAIL_EXISTS, t('auth.emailExists'));

    // 频控：同 email+scene 60s 一次、每日上限（email_code 表口径，跨 isolate 一致）
    const ts = now();
    const last = await db
      .prepare<{ create_date: number }>(
        'SELECT create_date FROM bbs_email_code WHERE email = ? AND scene = ? ORDER BY id DESC LIMIT 1',
      )
      .bind(email, scene)
      .first<{ create_date: number }>();
    if (last && ts - Number(last.create_date) < SEND_MIN_INTERVAL) {
      throw new AppError(Code.RATE_LIMITED, t('auth.sendTooFrequent'));
    }
    const dayStart = Math.floor(ts / 86400) * 86400;
    const cnt = await db
      .prepare<{ c: number }>(
        'SELECT COUNT(*) AS c FROM bbs_email_code WHERE email = ? AND scene = ? AND create_date >= ?',
      )
      .bind(email, scene, dayStart)
      .first<{ c: number }>();
    if (Number(cnt?.c ?? 0) >= SEND_DAILY_CAP) throw new AppError(Code.RATE_LIMITED, t('auth.sendDailyCap'));

    const code = String(100000 + Math.floor(Math.random() * 900000));
    await db
      .prepare('INSERT INTO bbs_email_code (email, code, scene, create_date, expiry, used) VALUES (?, ?, ?, ?, ?, 0)')
      .bind(email, code, scene, ts, ts + EMAIL_CODE_TTL)
      .run();
    const subject = t('auth.codeMailSubject', { site: setting.sitename });
    // 发信不阻塞请求（§D.6 Workers 映射「同步 SMTP→Email Provider + waitUntil，绝不请求内阻塞发信」）：
    // 验证码行已入库、有效性不依赖投递结果；不加队列重试——码 TTL 300s 短于 cron 5min 批处理周期，重试无意义（§11.2 通道仍预留）。
    const work = provider!.send(email, subject, t('auth.codeMailBody', { site: setting.sitename, code })).catch((e) => {
      console.error(`[email] ${t0('email.deliverError', { err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })}`);
      return false;
    });
    const ex = safeExecCtx(c);
    // 必须有 waitUntil 才算旁路成功：只有 ctx 没有 waitUntil 时挂上去的 promise 无人托管，
    // isolate 一回收就丢信（此时退化为请求内等待）
    if (ex?.waitUntil) ex.waitUntil(work);
    else await work;
    return ok(c, t('auth.sendDone'));
  });

  app.post('/api/auth/register', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const b = await readJson<RegisterReq>(c);
    if (!(await verifyTurnstile(c.env, b.turnstileToken, reqIp(c)))) {
      throw new AppError(Code.CAPTCHA_FAILED, t('auth.captchaFailed'));
    }
    const setting = await loadSetting(cache, db);
    // user_create_on 开关 + §11.3 降级：无 provider 等效 email 验证关闭
    if (!setting.userCreateOn) throw new AppError(Code.NOT_LOGIN, t('auth.registerDisabled'));
    const provider = await getEmailProvider(c.env, db, cache);
    const emailOn = setting.userCreateEmailOn && provider !== null;

    const email = (b.email ?? '').trim().toLowerCase();
    const username = (b.username ?? '').trim();
    if (!email) throw new AppError(Code.FORM_INVALID_EMAIL, t('auth.emailRequired'));
    if (!username) throw new AppError(Code.FORM_INVALID_USERNAME, t('auth.usernameRequired'));
    if (!b.password) throw new AppError(Code.FORM_PASSWORD_MISMATCH, t('auth.passwordRequired'));
    // 格式校验先于验证码校验：反序时「邮箱写成 a@b」只会得到"请先获取验证码"，
    // 用户被引去发码（发码接口同样校验格式才报错），多绕一圈。
    const ferr = isEmail(email, t);
    if (ferr) throw new AppError(Code.FORM_INVALID_EMAIL, ferr);
    const uerr = isUsername(username, t);
    if (uerr) throw new AppError(Code.FORM_INVALID_USERNAME, uerr);
    const prer = isPassword(b.password, t);
    if (prer) throw new AppError(Code.FORM_PASSWORD_MISMATCH, prer);

    let rowId = 0;
    if (emailOn) {
      const ts = now();
      const row = await db
        .prepare<{ id: number; code: string }>(
          'SELECT id, code FROM bbs_email_code WHERE email = ? AND scene = ? AND used = 0 AND expiry > ? ORDER BY id DESC LIMIT 1',
        )
        .bind(email, 'user_create', ts)
        .first<{ id: number; code: string }>();
      if (!row) throw new AppError(Code.FORM_EMAIL_CODE_ERROR, t('auth.codeNeedFirst'));
      if (!b.emailCode || String(b.emailCode) !== row.code) throw new AppError(Code.FORM_EMAIL_CODE_ERROR, t('auth.codeInvalid'));
      rowId = Number(row.id);
    }

    const dupEmail = await db.prepare('SELECT uid FROM bbs_user WHERE email = ?').bind(email).first<{ uid: number }>();
    if (dupEmail) throw new AppError(Code.FORM_EMAIL_EXISTS, t('auth.emailExists'));
    const dupName = await db.prepare('SELECT uid FROM bbs_user WHERE username = ?').bind(username).first<{ uid: number }>();
    if (dupName) throw new AppError(Code.FORM_USERNAME_EXISTS, t('auth.usernameExists'));

    const ts = now();
    const ip = ipLongOf(c);
    const stored = await hashPassword(b.password);
    const inserted = await db
      .prepare<{ uid: number }>(
        'INSERT INTO bbs_user (gid, email, username, password, salt, create_ip, create_date, logins, login_date, login_ip, avatar, avatar_auto) VALUES (101, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?) RETURNING uid',
      )
      .bind(email, username, stored, '', ip, ts, ts, ip, randomPresetAvatar())
      .first<{ uid: number }>();
    const uid = Number(inserted?.uid ?? 0);
    if (!uid) throw new AppError(Code.SYSTEM_ERROR, t('auth.registerFailed'));
    // 注册审核（user_check=1 时新用户 ok=0 待审核）
    if (setting.userCheck) await db.prepare('UPDATE bbs_user SET ok = 0 WHERE uid = ?').bind(uid).run();
    if (rowId) await db.prepare('UPDATE bbs_email_code SET used = 1 WHERE id = ?').bind(rowId).run();

    // 注册默认积分：credits 变动同批补流水（铁律 §15.1），golds/rmbs 无账本直落列
    const dflt = await loadRegisterCredits(db);
    const grantStmts: Stmt[] = [];
    const defaults: [number, number, string][] = [
      [1, dflt.credits, ''],
      [2, dflt.golds, ':gold'],
      [3, dflt.rmbs, ':rmb'],
    ];
    for (const [creditType, change, suffix] of defaults) {
      if (change === 0) continue;
      grantStmts.push(
        ...creditDeltaStmts({ db }, { uid, creditType, change, reason: 'register', bizKey: `register:${uid}${suffix}`, ts: ts }),
      );
    }
    if (grantStmts.length) await db.batch(grantStmts);

    await grant(c, uid, 0, 101);
    return ok(c, t('auth.registerDone'), { data: { uid, username, gid: 101 } });
  });

  app.post('/api/auth/login', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const b = await readJson<LoginReq>(c);
    if (!(await verifyTurnstile(c.env, b.turnstileToken, reqIp(c)))) {
      throw new AppError(Code.CAPTCHA_FAILED, t('auth.captchaFailed'));
    }
    const account = (b.account ?? '').trim();
    const password = b.password ?? '';
    if (!account) throw new AppError(Code.FORM_INVALID_EMAIL, t('auth.accountRequired'));

    // IP×账号失败锁（键含小写账号；计数存 L2 bbs_cache，TTL 15min）
    // 用原始 IP 而非 ipToLong：IPv6 会被压成 0，所有 IPv6 访客共用一把锁，可被定向锁他人账号
    const failKey = `login_fail:${reqIp(c)}:${account.toLowerCase()}`;
    const fails = (await cache.get<number>(failKey)) ?? 0;
    if (fails >= FAIL_LIMIT) throw new AppError(Code.RATE_LIMITED, t('auth.tooManyFails'));
    const bumpFail = async () => {
      await cache.set(failKey, fails + 1, FAIL_LOCK_TTL);
    };

    // 账号分发：is_email → by_email（不存在=邮箱不存在）否则 by_username
    // 邮箱一律按小写查：注册/后台建号/找回密码入库前都已归一为小写，
    // 若拿原样入参去查，用户手打 `A@B.com` 会查不到自己的账号（"邮箱不存在"）却能用 `a@b.com` 登录。
    const byEmail = /^[\w\-.]+@[\w\-.]+(\.\w+)+$/i.test(account);
    const user = await db
      .prepare<UserSessionRow>(`SELECT ${USER_SESSION_COLS} FROM bbs_user WHERE ${byEmail ? 'email' : 'username'} = ?`)
      .bind(byEmail ? account.toLowerCase() : account)
      .first<UserSessionRow>();
    if (!user) {
      await bumpFail();
      throw new AppError(Code.FORM_INVALID_EMAIL, byEmail ? t('auth.emailNotFound') : t('auth.usernameNotFound'));
    }
    const prer = isPassword(password, t);
    if (prer) throw new AppError(Code.FORM_PASSWORD_MISMATCH, prer);
    const v = await verifyClientPassword(password, user.password, user.salt);
    if (!v.ok) {
      await bumpFail();
      throw new AppError(Code.FORM_PASSWORD_MISMATCH, t('auth.passwordWrong'));
    }
    await cache.del(failKey);

    /**
     * 小黑屋（0025）：禁登位在签发会话之前拒绝。
     * 判在口令校验之后：不向未持有正确口令的人泄露「该账号已被封」这一信息。
     * 禁言/禁访不拦登录——用户仍需能登录查看封禁原因、修改资料或申请解封。
     */
    const banScope = effectiveBanScope(user.ban_scope, user.ban_until, now());
    if (banScope & BanScope.LOGIN) {
      throw new AppError(
        Code.BANNED,
        banMessage(banScope, Number(user.ban_until ?? 0), String(user.ban_reason ?? ''), t),
        { banScope, banUntil: Number(user.ban_until ?? 0) },
      );
    }

    const ts = now();
    await db
      .prepare('UPDATE bbs_user SET login_ip = ?, login_date = ?, logins = logins + 1 WHERE uid = ?')
      .bind(ipLongOf(c), ts, user.uid)
      .run();
    // 登录后按经验重算用户组。
    // 管理组 gid<100 短路，免一次余额查询
    let gid = Number(user.gid);
    if (gid >= GroupId.LEVEL1) {
      const up = await upgradeGroupByCredits({ db, cache }, Number(user.uid));
      if (up) {
        gid = up.newGid;
        const rt = await getExtensions(cache, db, undefined, { preloadConfigs: false });
        await rt.bus.emit('user:group-changed', { uid: Number(user.uid), oldGid: up.oldGid, newGid: up.newGid });
      }
    }
    await grant(c, Number(user.uid), Number(user.token_version ?? 0), gid);
    // v.upgradeNeeded：存量 md5 命中 → 改密/迁移任务时升级，登录请求内不重算（§8.4）
    return ok(c, t('auth.loginDone'), {
      data: {
        uid: Number(user.uid),
        gid,
        username: String(user.username),
        avatar: Number(user.avatar),
        upgradeNeeded: v.upgradeNeeded,
      },
    });
  });

  // 后台二次验证重签 admin_at：
  // 前台已登录用户复核口令 → 重发后台令牌。路径挂 /api/auth/* 而非 /api/admin/*：
  // adminGuard 覆盖 /api/admin/*，而本接口恰恰只在「没有可用后台令牌」时才被调用，放后台前缀会被守卫先 403 掉。
  // CSRF：/api/auth/* 在 csrf.ts:42 整体豁免（游客可达的登录/注册接口），本接口沿用该豁免——
  // 防线是「前台会话 Cookie + 口令」双要素：跨站表单提交不了用户口令，且 sid 为 SameSite=Lax 不随跨站 POST 携带，
  // 单靠会话无法被冒用，故不需要 X-CSRF-Token。
  app.post('/api/auth/admin-token', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    // 前台登录守卫：与其余需登录接口同一取法（loadViewer 走 sid/JWT 双轨）
    const v = await loadViewer(cache, db, c);
    if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));

    const b = await readJson<{ password?: string }>(c);
    const password = b.password ?? '';
    // 格式校验先于查库：非法入参不浪费 D1，也不触发哈希
    const prer = isPassword(password, t);
    if (prer) throw new AppError(Code.FORM_PASSWORD_MISMATCH, prer);

    const user = await db
      .prepare<UserSessionRow>(`SELECT ${USER_SESSION_COLS} FROM bbs_user WHERE uid = ?`)
      .bind(v.uid)
      .first<UserSessionRow>();
    if (!user) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
    // gid 以 bbs_user 实时行为准（loadViewer 的 user:{uid} 缓存 30s 内可能已降组），且与 adminGuard 同口径；
    // 判在验密之前：非管理员不必付 PBKDF2 两万次的 CPU（§8.4 CPU 墙）
    if (Number(user.gid) !== GroupId.ADMIN) throw new AppError(Code.NO_PERMISSION, t('guard.denied'), {}, 403);

    // 口令比对复用 POST /api/auth/login 的同一口径：入参为前端预哈希 32hex，stored 自动选 PBKDF2/md5 双轨
    const ver = await verifyClientPassword(password, user.password, user.salt);
    if (!ver.ok) throw new AppError(Code.FORM_PASSWORD_MISMATCH, t('auth.passwordWrong'));

    const adminSecret = c.env.ADMIN_JWT_SECRET ?? c.env.JWT_SECRET;
    if (!adminSecret) throw new AppError(Code.NO_PERMISSION, t('guard.secretMissing'), {}, 403);
    const uid = Number(user.uid);
    const adminAt = await issueAdminToken(adminSecret, uid, Number(user.token_version ?? 0));
    // Cookie 属性与 grant() 的 admin_at 段保持一致，避免前后台轨的 secure/maxAge 语义分叉
    const secure = isHttpsRequest(c);
    setCookie(c, 'admin_at', adminAt, { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: ADMIN_TOKEN_TTL });
    // v.upgradeNeeded 不透出：本接口只重发后台令牌，改密升级链路由 /api/auth/login 负责（§8.4）
    return ok(c, t('auth.loginDone'), { data: { uid } });
  });

  // 找回密码第一步（T4-1）：email 存在则发放一次性 token 并邮件发送重置链接；不存在同样返回成功（防账号枚举）。
  app.post('/api/auth/password-reset/request', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const b = await readJson<{ email?: string; turnstileToken?: string }>(c);
    if (!(await verifyTurnstile(c.env, b.turnstileToken, reqIp(c)))) {
      throw new AppError(Code.CAPTCHA_FAILED, t('auth.captchaFailed'));
    }
    const setting = await loadSetting(cache, db);
    const provider = await getEmailProvider(c.env, db, cache);
    if (!setting.userResetpwOn) throw new AppError(Code.NOT_LOGIN, t('auth.resetDisabled'));
    if (!provider) throw new AppError(Code.NOT_LOGIN, t('auth.mailUnconfigured'));
    const email = (b.email ?? '').trim().toLowerCase();
    const ferr = isEmail(email, t);
    if (ferr) throw new AppError(Code.FORM_INVALID_EMAIL, ferr);

    // 防枚举：无论邮箱是否注册均回同构成功；仅对已注册邮箱走频控+发信
    const u = await db.prepare('SELECT uid FROM bbs_user WHERE email = ?').bind(email).first<{ uid: number }>();
    if (!u) return ok(c, t('auth.resetMailSent'));

    const ts = now();
    // 频控命中同样回成功（不报 -7）：未注册邮箱永远成功、已注册却在 60s 内报错，
    // 等于把「该邮箱是否注册」用错误码送出去，与上面的防枚举口径自相矛盾；
    // 同时日上限与发码接口对齐，避免找回密码成为不限量的发信入口（单邮箱每天最多 10 封）。
    const last = await db
      .prepare<{ create_date: number }>(
        'SELECT create_date FROM bbs_email_code WHERE email = ? AND scene = ? ORDER BY id DESC LIMIT 1',
      )
      .bind(email, RESET_SCENE)
      .first<{ create_date: number }>();
    if (last && ts - Number(last.create_date) < SEND_MIN_INTERVAL) return ok(c, t('auth.resetMailSent'));
    const dayStart = Math.floor(ts / 86400) * 86400;
    const cnt = await db
      .prepare<{ c: number }>(
        'SELECT COUNT(*) AS c FROM bbs_email_code WHERE email = ? AND scene = ? AND create_date >= ?',
      )
      .bind(email, RESET_SCENE, dayStart)
      .first<{ c: number }>();
    if (Number(cnt?.c ?? 0) >= SEND_DAILY_CAP) return ok(c, t('auth.resetMailSent'));
    const token = randomTokenHex();
    // 单活一次性：旧未用 token 作废
    await db
      .prepare('UPDATE bbs_email_code SET used = 1 WHERE email = ? AND scene = ? AND used = 0')
      .bind(email, RESET_SCENE)
      .run();
    await db
      .prepare('INSERT INTO bbs_email_code (email, code, scene, create_date, expiry, used) VALUES (?, ?, ?, ?, ?, 0)')
      .bind(email, token, RESET_SCENE, ts, ts + RESET_TOKEN_TTL)
      .run();
    // 邮件里的重置链接必须指向主域名（后台「站点网址」优先），不能跟随当前请求域——
    // 否则从备用域发起的找回密码会把链接写成备用域，而登录态是 host-only，用户点开后又是游客。
    const base = canonicalBase(c, setting);
    const link = `${base}/reset-password?email=${encodeURIComponent(email)}&token=${token}`;
    // 发信同样走 waitUntil 不阻塞（§D.6 映射）；token 行已入库，投递失败不影响链接有效性
    const work = provider
      .send(
        email,
        t('auth.resetMailSubject', { site: setting.sitename }),
        t('auth.resetMailBody', { link }),
      )
      .catch(() => false);
    const ex = safeExecCtx(c);
    if (ex?.waitUntil) ex.waitUntil(work);
    else await work;
    return ok(c, t('auth.resetMailSent'));
  });

  // 找回密码第二步：校验一次性 token → 前端预哈希口令入库（PBKDF2）→ token_version+1 吊销既有会话（§8.4）
  app.post('/api/auth/password-reset/confirm', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const b = await readJson<{ email?: string; token?: string; password?: string }>(c);
    const email = (b.email ?? '').trim().toLowerCase();
    const token = (b.token ?? '').trim();
    if (!email || !token) throw new AppError(Code.FORM_INVALID_EMAIL, t('auth.emailOrTokenMissing'));
    const prer = isPassword(b.password ?? '', t);
    if (prer) throw new AppError(Code.FORM_PASSWORD_MISMATCH, prer);

    const ts = now();
    const row = await db
      .prepare<{ id: number }>(
        'SELECT id FROM bbs_email_code WHERE email = ? AND scene = ? AND code = ? AND used = 0 AND expiry > ? ORDER BY id DESC LIMIT 1',
      )
      .bind(email, RESET_SCENE, token, ts)
      .first<{ id: number }>();
    if (!row) throw new AppError(Code.FORM_EMAIL_CODE_ERROR, t('auth.resetLinkInvalid'));
    const u = await db.prepare('SELECT uid FROM bbs_user WHERE email = ?').bind(email).first<{ uid: number }>();
    if (!u) throw new AppError(Code.FORM_EMAIL_CODE_ERROR, t('auth.resetLinkInvalid'));
    const uid = Number(u.uid);

    const stored = await hashPassword(b.password!);
    await db
      .prepare('UPDATE bbs_user SET password = ?, salt = ?, token_version = token_version + 1 WHERE uid = ?')
      .bind(stored, '', uid)
      .run();
    await db.prepare('UPDATE bbs_email_code SET used = 1 WHERE id = ?').bind(Number(row.id)).run();
    // 改密 = 全端登出：token_version++ 使 JWT 轨（at/admin_at）失效；会话轨 sid 读取不校验 tv，须显式删除该用户所有 bbs_session 行。
    await destroyUserSessions(db, uid);
    await cache.del(`user:${uid}`);
    return ok(c, t('auth.resetDone'));
  });

  app.delete('/api/auth/logout', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const sid = c.req.header('cookie')?.match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
    const viewer = await loadViewer(cache, db, c);
    if (viewer.uid > 0) {
      // 登出 = 全端吊销：JWT 是无状态 100 天令牌，服务端唯一撤销手段是 token_version；
      // 若只删当前 sid，被盗的 at cookie 在登出后依然完全有效（且可经 loadViewer 重建
      // session）——「登出止损」形同虚设。故与改密吊销共用同一套三件套：
      // tv+1（废 JWT/admin_at）+ 删该用户全部 session 行 + user:{uid} 缓存失效。
      await db
        .prepare('UPDATE bbs_user SET token_version = token_version + 1 WHERE uid = ?')
        .bind(viewer.uid)
        .run();
      await destroyUserSessions(db, viewer.uid);
      await cache.del(`user:${viewer.uid}`);
    } else if (sid) {
      // 登录态不可辨（如库瞬时故障读不到用户）时至少撤销当前 session 行
      await destroySession(db, sid);
    }
    const secure = isHttpsRequest(c);
    setCookie(c, 'sid', '', { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: 0 });
    setCookie(c, 'at', '', { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: 0 });
    // 后台轨 Cookie 一并清除：登出即退出后台，防 admin_at 残留复用
    setCookie(c, 'admin_at', '', { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: 0 });
    return ok(c, t('auth.logoutDone'));
  });

  return app;
}
