/**
 * 每日签到卡片（checkin 插件）：首页右侧栏。插件启用（bootstrap ext.checkin，§12 契约⑦）时渲染，停用零残留。
 * 版式：卡头（标题 + 今日共 N 人签到 + 右侧胶囊签到/登录按钮）+ 本周七天格子（周一~周四一行 4 格、周五~周日一行 3 格，
 * 今天蓝框高亮、已签到打勾）。
 * viewer 相关状态（今日已签/累计天数/本周标记）经 GET /api/checkin 拉取（bootstrap 贡献侧无请求上下文）；
 * 签到 POST /api/checkin，成功后就地展示奖励明细并刷新 bootstrap（头部积分即时更新）。游客点击登录按钮开弹窗登录。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiGet, apiSend } from '../lib/api';
import { useAuth } from '../store/auth';
import { useAuthModal } from '../store/authModal';
import { SidePanel, cx } from './ui';
import { Icon } from './icons';
import { useT } from '../lib/i18n';

/** GET /api/checkin 响应（modules/plugins/routes.ts） */
interface CheckinStatus {
  enabled: boolean;
  rewards?: { exp: number; gold: number; rmb: number; vipDays: number };
  checked?: boolean;
  days?: number;
  /** 今天在本周格子中的下标（0=周一 … 6=周日，与 week 同序） */
  todayIndex?: number;
  /** 本周七天签到标记（周一起算，与 todayIndex 同序） */
  week?: boolean[];
  /** 今日签到人数（卡头文案） */
  todayCount?: number;
}
/** POST /api/checkin 响应 data */
interface CheckinResult {
  rewards: { exp: number; gold: number; rmb: number; vipDays: number };
  summary: string;
  checked: boolean;
  days: number;
}

/** bootstrap ext.checkin 载荷（apps/api/src/extensions/checkin.ts contributeBootstrap） */
interface CheckinExt {
  enabled: boolean;
  rewards?: { exp: number; gold: number; rmb: number; vipDays: number };
}

/** 周一起算的七天标签（下标与接口 week/todayIndex 对齐） */
const WEEKDAY_KEYS = [
  'checkin_week_mon',
  'checkin_week_tue',
  'checkin_week_wed',
  'checkin_week_thu',
  'checkin_week_fri',
  'checkin_week_sat',
  'checkin_week_sun',
] as const;

/** 周标签键（与接口 week/todayIndex 下标同序） */
type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** 周格分行：周一~周四一行（4 格等宽），周五~周日一行（3 格等宽 → 每格更宽） */
const WEEK_ROWS: readonly (readonly WeekdayKey[])[] = [
  [WEEKDAY_KEYS[0], WEEKDAY_KEYS[1], WEEKDAY_KEYS[2], WEEKDAY_KEYS[3]],
  [WEEKDAY_KEYS[4], WEEKDAY_KEYS[5], WEEKDAY_KEYS[6]],
];

export function CheckinCard() {
  const t = useT();
  const qc = useQueryClient();
  const ext = useAuth((s) => s.ext);
  const me = useAuth((s) => s.me);
  const refresh = useAuth((s) => s.refresh);
  const openAuth = useAuthModal((s) => s.openAuth);
  const cfg = ext?.checkin as CheckinExt | undefined;
  const [doing, setDoing] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const q = useQuery({
    queryKey: ['checkin'],
    queryFn: () => apiGet<CheckinStatus>('/api/checkin'),
    enabled: cfg?.enabled === true,
    staleTime: 30_000,
  });

  if (!cfg?.enabled || q.data?.enabled === false) return null;
  const checked = q.data?.checked === true;
  const days = q.data?.days ?? 0;
  const todayCount = q.data?.todayCount;
  /** 本周格子（接口 UTC 周口径；未登录/未加载时为空态，仅今天高亮） */
  const todayIndex = q.data?.todayIndex;
  const week = q.data?.week ?? [];

  const checkin = async () => {
    setDoing(true);
    setFlash(null);
    try {
      const r = await apiSend<CheckinResult>('POST', '/api/checkin');
      setFlash({ tone: 'ok', text: `${t('checkin_done')} ${r.summary}` });
      await qc.invalidateQueries({ queryKey: ['checkin'] });
      await refresh();
    } catch (e) {
      setFlash({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setDoing(false);
    }
  };

  return (
    <SidePanel pad="p-0" className="overflow-hidden">
      {/* 卡头：标题 + 今日共 N 人签到，右侧胶囊签到/登录按钮 */}
      <div className="flex items-center justify-between gap-3 bg-zh-accent-soft px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-foreground">{t('checkin_title')}</p>
          {todayCount != null && <p className="mt-0.5 text-xs text-lt-grey">{t('checkin_today_count', { count: todayCount })}</p>}
          {me && <p className="mt-0.5 text-xs text-lt-grey">{t('checkin_days', { days })}</p>}
        </div>
        {me ? (
          <button
            type="button"
            disabled={checked || doing}
            onClick={() => void checkin()}
            className={cx(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium transition-colors',
              checked ? 'bg-lt-soft text-lt-grey' : 'bg-brand text-white hover:bg-brand-hover',
            )}
          >
            <Icon name={doing ? 'refresh' : 'calendar_check'} className={cx('size-4', doing && 'animate-spin')} />
            {checked ? t('checkin_done') : t('checkin_btn')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => openAuth('login')}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
          >
            <Icon name="calendar_check" className="size-4" />
            {t('checkin_login')}
          </button>
        )}
      </div>
      {/* 本周七天格子：周一~周四一行 4 格，周五~周日一行 3 格（等宽 → 更宽）；今天蓝框高亮，已签到打勾 */}
      {todayIndex != null && (
        <div className="px-4 pb-3 pt-3">
          {WEEK_ROWS.map((row, r) => (
            <div key={r} className={cx('flex gap-2', r > 0 && 'mt-2')}>
              {row.map((key) => {
                const i = WEEKDAY_KEYS.indexOf(key);
                const signed = week[i] === true;
                const isToday = i === todayIndex;
                return (
                  <div
                    key={key}
                    className={cx(
                      'flex min-h-[68px] flex-1 flex-col items-center justify-center gap-1.5 rounded-[10px] border',
                      isToday ? 'border-brand bg-card' : 'border-transparent bg-lt-aid',
                    )}
                  >
                    <span className={cx('text-xs', isToday ? 'text-brand' : 'text-lt-grey')}>{t(key)}</span>
                    <Icon name={signed ? 'check' : 'close'} strokeWidth={2.5} className={cx('size-5', signed || isToday ? 'text-brand' : 'text-zh-pill')} />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {flash && <p className={cx('px-4 pb-3 text-xs', flash.tone === 'ok' ? 'text-success' : 'text-destructive')}>{flash.text}</p>}
    </SidePanel>
  );
}
