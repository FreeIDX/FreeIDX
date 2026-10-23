/**
 * 插件图标（插件中心列表卡片 + 插件详情页头图共用，**唯一来源**）。
 *
 * 设计约定（替代原「manifest.id 首字母」占位砖，也避免目录新增插件后回落到通用插头）：
 *  - 图形：按插件语义取真实 SVG 图形（图标集见 components/icons.tsx），不用字母/emoji；
 *  - 配色：每个插件一个稳定色相（后台色板令牌优先，品牌色（Stripe/PayPal）用官方色值），
 *    浅底 10% + 同色描边 15%，深浅主题下都能读出层次；
 *  - 尺寸：card = 列表卡 44px 砖（22px 图形），detail = 详情页 54px 砖（26px 图形），
 *    两处同源，改一处即两处一致。
 * 新增插件时在此登记 id → 图形/配色；未登记的 id 仍回落通用插头（不会白屏）。
 */
import { Icon, type IconName } from '../../components/icons';

interface ExtIconMeta {
  icon: IconName;
  /** 底色 + 前景色 + 描边色（同色相三件套，勿拆开使用） */
  tint: string;
}

const EXT_ICONS: Record<string, ExtIconMeta> = {
  // 收录/排名增长
  seo: { icon: 'trending_up', tint: 'bg-brand/10 text-brand ring-brand/15' },
  // AI 爬虫 / 生成式引擎
  geo: { icon: 'bot', tint: 'bg-info/10 text-info ring-info/15' },
  // 广告投放
  ads: { icon: 'megaphone', tint: 'bg-price/10 text-price ring-price/15' },
  // 每日签到（日历打勾）
  checkin: { icon: 'calendar_check', tint: 'bg-success/10 text-success ring-success/15' },
  // 卡密兑换券
  card: { icon: 'ticket', tint: 'bg-[#7c3aed]/10 text-[#7c3aed] ring-[#7c3aed]/15' },
  // Stripe 品牌紫
  stripe: { icon: 'credit_card', tint: 'bg-[#635bff]/10 text-[#635bff] ring-[#635bff]/15' },
  // PayPal 品牌蓝
  paypal: { icon: 'wallet', tint: 'bg-[#009cde]/10 text-[#009cde] ring-[#009cde]/15' },
  // 虚拟点击（浏览量）
  idx_view_boost: { icon: 'eye', tint: 'bg-[#e11d48]/10 text-[#e11d48] ring-[#e11d48]/15' },
  // 快速回复限制（对话气泡）
  idx_quick_reply: { icon: 'chat_bubbles', tint: 'bg-[#d97706]/10 text-[#d97706] ring-[#d97706]/15' },
  // 插入代码（代码尖括号）
  idx_insert_code: { icon: 'code', tint: 'bg-[#475569]/10 text-[#475569] ring-[#475569]/15' },
  // 简蓝主题（插件中心列表隐藏，详情页仍会用到）
  light: { icon: 'sun', tint: 'bg-[#f59e0b]/10 text-[#f59e0b] ring-[#f59e0b]/15' },
};

/** 未登记插件的回落：通用插头 + 中性灰 */
const EXT_ICON_FALLBACK: ExtIconMeta = { icon: 'plug', tint: 'bg-line-soft text-muted ring-line' };

/** 插件 id → 图标元数据 */
export function extIconMeta(id: string): ExtIconMeta {
  return EXT_ICONS[id] ?? EXT_ICON_FALLBACK;
}

const TILE: Record<'card' | 'detail', string> = {
  card: 'size-11 rounded-[10px]',
  detail: 'size-[54px] rounded-[12px]',
};

const GLYPH: Record<'card' | 'detail', string> = {
  card: 'size-[22px]',
  detail: 'size-[26px]',
};

/** 插件图标砖：列表卡与详情页共用，尺寸只决定砖/图形大小，配色与图形恒取自 extIconMeta */
export function ExtIcon({ id, size = 'card', className = '' }: { id: string; size?: 'card' | 'detail'; className?: string }) {
  const meta = extIconMeta(id);
  return (
    <span className={`inline-grid shrink-0 place-items-center ring-1 ${TILE[size]} ${meta.tint} ${className}`}>
      <Icon name={meta.icon} className={GLYPH[size]} />
    </span>
  );
}
