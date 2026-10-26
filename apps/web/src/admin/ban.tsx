/**
 * 小黑屋共用件（后台）：范围文案 + 时长预设 + 范围勾选器。
 * 语义与 @freeidx/shared 的 BanScope 一一对应（1 禁言 / 2 禁访 / 4 禁登，可组合）。
 */
import { BanScope, type AdminKey } from '@freeidx/shared';
import { Checkbox, Field } from './ui';
import { useAdminT } from './t';

/** 时长预设：秒（0 = 永久）；顺序即下拉顺序。文案一律走词典（禁止在此硬编码中文） */
export const BAN_DURATIONS: { value: number; key: AdminKey }[] = [
  { value: 3600, key: 'ban_duration_1h' },
  { value: 86400, key: 'ban_duration_1d' },
  { value: 604800, key: 'ban_duration_7d' },
  { value: 2592000, key: 'ban_duration_30d' },
  { value: 0, key: 'ban_duration_forever' },
];

/** 位掩码 → 可读文案（MUTE + READ + LOGIN，用顿号/逗号连接） */
export function scopeText(scope: number, t: (k: AdminKey, f?: string) => string): string {
  const out: string[] = [];
  if (scope & BanScope.MUTE) out.push(t('ban_scope_mute', '禁言'));
  if (scope & BanScope.READ) out.push(t('ban_scope_read', '禁访'));
  if (scope & BanScope.LOGIN) out.push(t('ban_scope_login', '禁止登录'));
  return out.join(' / ');
}

/** 范围勾选器：三档独立开关，组合即掩码（至少一档由调用方校验） */
export function BanScopePicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const t = useAdminT();
  const toggle = (bit: number, on: boolean) => onChange(on ? value | bit : value & ~bit);
  return (
    <Field label={t('ban_scope', '封禁范围')} hint={t('ban_scope_required', '请至少选择一种封禁范围')}>
      <div className="space-y-2 py-1">
        {[
          { bit: BanScope.MUTE, label: t('ban_scope_mute', '禁言（可登录、可浏览，不能发帖回帖）') },
          { bit: BanScope.READ, label: t('ban_scope_read', '禁访（不能浏览与发帖）') },
          { bit: BanScope.LOGIN, label: t('ban_scope_login', '禁止登录（并立即踢下线）') },
        ].map((o) => (
          <Checkbox key={o.bit} checked={(value & o.bit) !== 0} onChange={(on) => toggle(o.bit, on)} label={o.label} />
        ))}
      </div>
    </Field>
  );
}
