/**
 * 扩展管理（/admin/extensions，§4.10）。
 * 列表采用**无表头**的可横向滚动表格版式，行按 width 分五段：
 *  80 图标（54×54 链到详情）/ 300 名称+版本+目录+作者 / 100 价格 / brief / 250 右对齐按钮组，
 *  按钮显隐由 installed/enable/downloaded/have_upgrade 决定。
 * 本项目扩展是**代码内置**（ADMIN_CATALOG），没有下载/安装/升级/卸载端点，manifest 也没有
 * icon_url/brief/author 字段，所以价格列与 下载/购买/安装/升级/卸载 五个按钮整体不做（§7 记账），
 * 只保留 设置 + 启用/禁用（设置=主色按钮、禁用/启用=次要按钮）；
 * 图标位按插件语义取真实 SVG 图形（EXT_ICONS）。本地插件列表渲染为**小卡片网格**（2~3 列自适应），
 * 卡内：图标砖 + 名称/版本/目录 + 简介（来自插件自声明 schema 随列表 API 下发）+ 安装与启用状态徽章。
 * 名称是多语言 map（manifest.name），按后台语言（setting.adminLang）取词。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { extText } from '@freeidx/shared';
import { getExtensions, putExtension } from '../api';
import type { ExtensionRow } from '../types';
import { useAdminLang, useAdminT } from '../t';
import type { Flash } from '../use-action';
import { PLUGIN_TABS } from '../tabs';
import { Icon, type IconName } from '../../components/icons';
import { Alert, Button, ErrorState, TabBar } from '../ui';

/** manifest.name 取词：当前语言 → zh-cn → 任一可用 → 目录名 */
export function extName(name: Record<string, string>, lang: string, id: string): string {
  return name[lang] ?? name['zh-cn'] ?? Object.values(name)[0] ?? id;
}

/** 插件 id → 卡片图标与配色（真实语义图标，取代原「目录名首字母」占位砖） */
const EXT_ICONS: Record<string, { icon: IconName; tint: string }> = {
  seo: { icon: 'trending_up', tint: 'bg-brand/10 text-brand' }, // 收录/排名增长
  geo: { icon: 'bot', tint: 'bg-info/10 text-info' }, // AI 爬虫 / 生成式引擎
  ads: { icon: 'megaphone', tint: 'bg-price/10 text-price' }, // 广告投放
  card: { icon: 'ticket', tint: 'bg-success/10 text-success' }, // 卡密兑换券
  stripe: { icon: 'credit_card', tint: 'bg-[#635bff]/10 text-[#635bff]' }, // Stripe 品牌紫
  paypal: { icon: 'wallet', tint: 'bg-[#009cde]/10 text-[#009cde]' }, // PayPal 品牌蓝
};

const EXT_ICON_FALLBACK: { icon: IconName; tint: string } = { icon: 'plug', tint: 'bg-line-soft text-muted' };

const extIcon = (id: string) => EXT_ICONS[id] ?? EXT_ICON_FALLBACK;

export function ExtensionPage() {
  const t = useAdminT();
  const lang = useAdminLang();

  const q = useQuery({ queryKey: ['admin', 'extensions'], queryFn: getExtensions });
  const [flash, setFlash] = useState<Flash | null>(null);
  const [pendingId, setPendingId] = useState('');
  const rows: ExtensionRow[] = q.data?.extensions ?? [];

  const flip = async (r: ExtensionRow) => {
    setPendingId(r.id);
    setFlash(null);
    try {
      await putExtension(r.id, { enable: r.enable === 1 ? 0 : 1 });
      await q.refetch();
      setFlash({ tone: 'ok', text: `${extName(r.name, lang, r.id)} ${r.enable === 1 ? t('disabled', '已禁用') : t('enabled', '已启用')}` });
    } catch (e) {
      setFlash({ tone: 'warn', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setPendingId('');
    }
  };

  return (
    <div className="space-y-3">
      <TabBar active="local" items={PLUGIN_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {q.isError && <ErrorState error={q.error} />}
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 rounded-[8px] bg-surface p-4 shadow-adm-card">
            <div className="flex items-start gap-3">
              <Link
                to={`/admin/extensions/${r.id}`}
                className={`grid size-11 shrink-0 place-items-center rounded ${extIcon(r.id).tint} no-underline hover:brightness-95`}
              >
                <Icon name={extIcon(r.id).icon} className="size-6" />
              </Link>
              <div className="min-w-0 flex-1">
                <Link to={`/admin/extensions/${r.id}`} className="font-bold text-brand hover:underline">
                  {extName(r.name, lang, r.id)} <span className="text-[85%] font-normal">v{r.version}</span>
                </Link>
                <p className="mb-0 line-clamp-2 text-[85%] leading-snug text-muted">{extText(r.brief, lang) || r.id}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 pl-14">
              <div className="flex flex-wrap gap-1">
                {/* 本地扩展随 Worker 部署、无安装动作，不展示「未安装/已安装」；只看启用态 */}
                {r.enable === 1 ? (
                  <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">{t('enable', '启用')}</span>
                ) : (
                  <span className="rounded-full bg-canvas px-2 py-0.5 text-xs text-muted">{t('disable', '禁用')}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Link
                  to={`/admin/extensions/${r.id}`}
                  className="inline-flex items-center rounded-[.25rem] bg-brand px-2 py-1 text-[.875rem] text-white no-underline hover:bg-brand-hover"
                >
                  {t('setting', '设置')}
                </Link>
                <Button variant="secondary" size="sm" loading={pendingId === r.id} onClick={() => void flip(r)}>
                  {r.enable === 1 ? t('disable', '禁用') : t('enable', '启用')}
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {rows.length === 0 && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('none', '无')}</p>}
    </div>
  );
}
