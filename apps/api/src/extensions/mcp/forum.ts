/**
 * MCP 版块配置工具（契约 ⑨，scope=admin）：`forum_get` / `forum_update`。
 *
 * 与内容写工具（thread_create / reply_create）刻意分开：
 *  - 改的是**站点配置**（版块简介/公告/SEO 标题/关键词及其多语言映射），不是内容，
 *    因此不套用版块发帖权限，而是要求四重条件同时成立：
 *      ① 站点点开关 `forumWriteOn` 打开（出厂关闭，关掉时工具根本不进 tools/list）
 *      ② 站点 `enabledScopes` 含 admin
 *      ③ 令牌自身 scopes 含 admin
 *      ④ 令牌持有者 gid=1（admin 档位由管理员发放，但持有者未必是管理员本人）
 *  - 只写**显式传入**的键（merge 语义）：漏传 = 保持原值，传空串 / 空对象 = 清空该文案
 *    （展示回退主字段），与管理后台 `PUT /api/admin/forums/:fid` 完全同一口径。
 *  - 归一化复用 shared 的 `normNameI18n` / `stringifyNameI18n`：非法语言代码会被丢弃，
 *    不会把 `{"xx":"…"}` 这类脏数据写进库。
 *
 * 写后必须清 `forumlist`：整张版块表（含这些文案）都缓存在该键下，
 * 不清会让前台与 SEO 产物在一个 TTL 内继续读旧值。
 */
import { normNameI18n, stringifyNameI18n } from '@freeidx/shared';
import { L } from '../../core/i18n';
import type { McpCallCtx, McpToolDef, McpToolResult } from '../../core/extensions/registry';
import type { D1b } from '../../core/db';
import { ToolError } from './tools';

/**
 * 可多语言的文案字段：MCP 参数名（camelCase）→ 主列 / 多语言列 / 单值长度上限。
 * `nonEmpty` 只作用于主字段（版块名不能清空，与后台 `PUT /api/admin/forums/:fid` 同口径）。
 */
const TEXT_FIELDS = [
  { arg: 'name', col: 'name', i18nCol: 'name_i18n', max: 200, nonEmpty: true },
  { arg: 'brief', col: 'brief', i18nCol: 'brief_i18n', max: 5000, nonEmpty: false },
  { arg: 'announcement', col: 'announcement', i18nCol: 'announcement_i18n', max: 5000, nonEmpty: false },
  { arg: 'seoTitle', col: 'seo_title', i18nCol: 'seo_title_i18n', max: 300, nonEmpty: false },
  { arg: 'seoKeywords', col: 'seo_keywords', i18nCol: 'seo_keywords_i18n', max: 1000, nonEmpty: false },
] as const;

/** 版块文案配置行（显式投影，禁 SELECT *） */
interface ForumConfigRow {
  fid: number;
  name: string;
  name_i18n: string;
  brief: string;
  brief_i18n: string;
  announcement: string;
  announcement_i18n: string;
  seo_title: string;
  seo_title_i18n: string;
  seo_keywords: string;
  seo_keywords_i18n: string;
}

const CONFIG_COLS =
  'fid,name,name_i18n,brief,brief_i18n,announcement,announcement_i18n,seo_title,seo_title_i18n,seo_keywords,seo_keywords_i18n';

/** 行 → 模型可读结构（多语言映射解析成对象，前端/后台同一结构） */
function configOf(r: ForumConfigRow): Record<string, unknown> {
  return {
    fid: Number(r.fid),
    name: String(r.name ?? ''),
    nameI18n: normNameI18n(r.name_i18n),
    brief: String(r.brief ?? ''),
    briefI18n: normNameI18n(r.brief_i18n),
    announcement: String(r.announcement ?? ''),
    announcementI18n: normNameI18n(r.announcement_i18n),
    seoTitle: String(r.seo_title ?? ''),
    seoTitleI18n: normNameI18n(r.seo_title_i18n),
    seoKeywords: String(r.seo_keywords ?? ''),
    seoKeywordsI18n: normNameI18n(r.seo_keywords_i18n),
    url: `/forum/${Number(r.fid)}`,
  };
}

async function loadConfig(db: D1b, fid: number): Promise<ForumConfigRow> {
  const row = await db
    .prepare<ForumConfigRow>(`SELECT ${CONFIG_COLS} FROM bbs_forum WHERE fid = ?`)
    .bind(fid)
    .first<ForumConfigRow>();
  if (!row) throw new ToolError(`Forum ${fid} not found`);
  return row;
}

/** 站点配置只允许管理员本人改：档位由管理员发放，但拿令牌的人未必是管理员 */
function assertAdmin(ctx: McpCallCtx): void {
  if (ctx.principal.gid !== 1) {
    throw new ToolError('Only an administrator token owner may read or change forum settings');
  }
}

/** 单值长度护栏：MCP 请求体 256KB，拦掉「把整篇文章塞进 SEO 标题」这类误用 */
function textOf(v: unknown, max: number, name: string): string {
  const s = String(v ?? '');
  if ([...s].length > max) throw new ToolError(`${name} is too long (max ${max} characters)`);
  return s;
}

/** 多语言映射：归一化（丢弃非法语言/空值）后再落库，空映射存空串 = 未配置 */
function i18nOf(v: unknown, max: number, name: string): string {
  const map = normNameI18n(v);
  for (const [loc, text] of Object.entries(map)) {
    if ([...text].length > max) throw new ToolError(`${name}.${loc} is too long (max ${max} characters)`);
  }
  return stringifyNameI18n(map);
}

function fidOf(args: Record<string, unknown>): number {
  const fid = Number(args.fid ?? 0);
  if (!Number.isInteger(fid) || fid <= 0) throw new ToolError('fid must be a positive integer (see forum_list)');
  return fid;
}

/* ------------------------------ 工具实现 ------------------------------ */

async function forumGet(args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  assertAdmin(ctx);
  const row = await loadConfig(ctx.db, fidOf(args));
  return { text: JSON.stringify(configOf(row), null, 2) };
}

async function forumUpdate(args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  assertAdmin(ctx);
  const fid = fidOf(args);

  const sets: string[] = [];
  const vals: (string | number)[] = [];
  /** 列名来自上方常量表（非模型输入），无注入面 */
  for (const f of TEXT_FIELDS) {
    if (f.arg in args) {
      const v = textOf(args[f.arg], f.max, f.arg);
      if (f.nonEmpty && !v.trim()) throw new ToolError(`${f.arg} must not be empty`);
      sets.push(`${f.col}=?`);
      vals.push(f.nonEmpty ? v.trim() : v);
    }
    const i18nArg = `${f.arg}I18n`;
    if (i18nArg in args) {
      sets.push(`${f.i18nCol}=?`);
      vals.push(i18nOf(args[i18nArg], f.max, i18nArg));
    }
  }
  if (!sets.length) {
    throw new ToolError(
      'Nothing to update: pass at least one of name, brief, announcement, seoTitle, seoKeywords (or their *I18n maps)',
    );
  }

  const done = await ctx.db
    .prepare<{ fid: number }>(`UPDATE bbs_forum SET ${sets.join(',')} WHERE fid = ? RETURNING fid`)
    .bind(...vals, fid)
    .first<{ fid: number }>();
  if (!done) throw new ToolError(`Forum ${fid} not found`);

  // 版块表整表缓存在 forumlist（前台导航/版块页/SEO 都读它），必须主动失效
  await ctx.cache.del('forumlist');

  const row = await loadConfig(ctx.db, fid);
  return { text: JSON.stringify({ ...configOf(row), updated: true }, null, 2) };
}

/* ------------------------------ 工具声明 ------------------------------ */

/** 工具名集合：请求期按站点点开关整体摘除（models 不会误选到不存在的能力） */
export const MCP_FORUM_TOOL_NAMES: readonly string[] = ['forum_get', 'forum_update'];

export const MCP_FORUM_TOOLS: McpToolDef[] = [
  {
    name: 'forum_get',
    scope: 'admin',
    description: L(
      '读取版块的文案配置：名称、简介、公告、SEO 标题、SEO 关键词，以及它们各自的多语言映射。仅管理员令牌可用，且需在后台打开「允许修改版块文案」开关。',
      '讀取版塊的文案設定：名稱、簡介、公告、SEO 標題、SEO 關鍵詞，以及它們各自的多語言對映。僅管理員權杖可用，且需在後台開啟「允許修改版塊文案」開關。',
      'Read a forum text config: name, brief, announcement, SEO title, SEO keywords and their multilingual maps. Administrator token only, and the "allow forum text editing" switch must be on.',
      'Читать текстовую конфигурацию раздела: название, описание, объявление, SEO-заголовок, SEO-ключевые слова и их переводы. Только токен администратора и включённый переключатель в админке.',
      'อ่านคอนฟิกข้อความของบอร์ด: ชื่อ คำอธิบาย ประกาศ SEO title SEO keywords และแมปหลายภาษา ใช้ได้เฉพาะโทเคนผู้ดูแล และต้องเปิดสวิตช์ในหลังบ้าน',
      'Liest die Textkonfiguration eines Forums: Name, Kurzbeschreibung, Ankündigung, SEO-Titel, SEO-Keywords und deren Übersetzungen. Nur Admin-Token und aktivierter Schalter im Backend.',
      'フォーラムの文案設定（名前・概要・告知・SEO タイトル・SEO キーワードと各多言語マップ）を読みます。管理者トークンかつ管理画面のスイッチがオンの場合のみ利用できます。',
      '게시판 문구 설정(이름, 설명, 공지, SEO 제목, SEO 키워드 및 각 다국어 매핑)을 읽습니다. 관리자 토큰과 관리 화면 스위치가 켜져 있어야 합니다.',
      'Lee la configuración de textos de un foro: nombre, descripción, anuncio, título SEO, palabras clave SEO y sus mapas multilingües. Solo con token de administrador y el interruptor activado.',
      'Lit la configuration textuelle d’un forum : nom, description, annonce, titre SEO, mots-clés SEO et leurs traductions. Réservé à un jeton administrateur, avec l’interrupteur activé.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        fid: { type: 'integer', minimum: 1, description: 'Forum id (see forum_list).' },
      },
      required: ['fid'],
      additionalProperties: false,
    },
    handler: forumGet,
  },
  {
    name: 'forum_update',
    scope: 'admin',
    description: L(
      '修改版块的名称/简介/公告/SEO 标题/SEO 关键词及其多语言映射。只更新显式传入的字段；传空字符串或空对象即清空（主名称不允许清空）。仅管理员令牌可用，且需在后台打开「允许修改版块文案」开关。',
      '修改版塊的名稱/簡介/公告/SEO 標題/SEO 關鍵詞及其多語言對映。只更新明確傳入的欄位；傳空字串或空物件即清空（主名稱不允許清空）。僅管理員權杖可用，且需在後台開啟「允許修改版塊文案」開關。',
      'Update a forum name / brief / announcement / SEO title / SEO keywords and their multilingual maps. Only the fields you pass are written; an empty string or empty object clears that text (the primary name cannot be cleared). Administrator token only, and the "allow forum text editing" switch must be on.',
      'Обновить название / описание / объявление / SEO-заголовок / SEO-ключевые слова и их переводы. Записываются только переданные поля; пустая строка или пустой объект очищают значение (основное название очистить нельзя). Только токен администратора и включённый переключатель.',
      'แก้ไขชื่อ/คำอธิบาย/ประกาศ/SEO title/SEO keywords และแมปหลายภาษา เขียนเฉพาะฟิลด์ที่ส่งมา ส่งสตริงว่างหรือออบเจ็กต์ว่างเพื่อล้างค่า (ชื่อหลักล้างไม่ได้) ใช้ได้เฉพาะโทเคนผู้ดูแลและต้องเปิดสวิตช์',
      'Aktualisiert Name / Kurzbeschreibung / Ankündigung / SEO-Titel / SEO-Keywords und deren Übersetzungen. Nur übergebene Felder werden geschrieben; leerer String oder leeres Objekt leert den Text (der Hauptname kann nicht geleert werden). Nur Admin-Token und aktivierter Schalter.',
      'フォーラムの名前・概要・告知・SEO タイトル・SEO キーワードと多言語マップを更新します。渡した項目だけを書き込み、空文字や空オブジェクトで消去します（主名前は消去できません）。管理者トークンかつスイッチがオンの場合のみ。',
      '게시판 이름/설명/공지/SEO 제목/SEO 키워드와 다국어 매핑을 수정합니다. 전달한 필드만 기록하며, 빈 문자열이나 빈 객체를 보내면 지워집니다(기본 이름은 지울 수 없음). 관리자 토큰과 스위치가 필요합니다.',
      'Actualiza nombre / descripción / anuncio / título SEO / palabras clave SEO y sus mapas multilingües. Solo se escriben los campos enviados; una cadena u objeto vacío borra ese texto (el nombre principal no se puede borrar). Solo con token de administrador y el interruptor activado.',
      'Met à jour le nom / la description / l’annonce / le titre SEO / les mots-clés SEO et leurs traductions. Seuls les champs transmis sont écrits ; une chaîne ou un objet vide efface le texte (le nom principal ne peut pas être vidé). Réservé à un jeton administrateur, avec l’interrupteur activé.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        fid: { type: 'integer', minimum: 1, description: 'Forum id (see forum_list).' },
        name: { type: 'string', maxLength: 200, description: 'Primary forum name (must be non-empty when passed).' },
        nameI18n: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'locale → forum name. Keys outside the site language list are dropped; {} clears all translations.',
        },
        brief: { type: 'string', maxLength: 5000, description: 'Forum brief (main language). Empty string clears it.' },
        briefI18n: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'locale → brief. Keys outside the site language list are dropped; {} clears all translations.',
        },
        announcement: { type: 'string', maxLength: 5000, description: 'Forum announcement. Empty string clears it.' },
        announcementI18n: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'locale → announcement. {} clears all translations.',
        },
        seoTitle: { type: 'string', maxLength: 300, description: 'SEO title. Empty string falls back to the forum name.' },
        seoTitleI18n: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'locale → SEO title. {} clears all translations.',
        },
        seoKeywords: { type: 'string', maxLength: 1000, description: 'SEO keywords (comma separated).' },
        seoKeywordsI18n: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'locale → SEO keywords. {} clears all translations.',
        },
      },
      required: ['fid'],
      additionalProperties: false,
    },
    handler: forumUpdate,
  },
];
