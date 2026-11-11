/**
 * 内置图标选择弹窗（后台「导航栏设置」等需要给条目配图标的场景共用）。
 *
 *  - 图标来源唯一：components/icons.tsx 的 ICON_NAMES，与前台渲染是同一套 SVG，选中什么前台就显示什么；
 *  - 只能从白名单里挑，不提供手填 —— 手填的名字前台可能认不出来（isIconName 会静默忽略），
 *    不如在后台这一步就堵住；
 *  - 首格固定「无图标」= 存空串（省缺字段），用于把已有图标去掉；
 *  - 点击即选中并回写父组件行，父组件负责关闭弹窗。
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon, ICON_NAMES, type IconName } from '../components/icons';
import { useAdminT } from './t';
import { Button, Input, Modal, cx } from './ui';

export function IconPickerModal({
  open,
  value,
  title,
  hint,
  onPick,
  onClose,
}: {
  open: boolean;
  /** 当前图标名；空串 = 未配置 */
  value: string;
  /** 弹窗标题（缺省 = 导航项图标） */
  title?: string;
  /** 说明文案（缺省 = 图标显示位置说明） */
  hint?: string;
  onPick: (name: IconName | '') => void;
  onClose: () => void;
}) {
  const t = useAdminT();
  /** 搜索词：按图标名（英文语义名）过滤，打开时重置 */
  const [kw, setKw] = useState('');
  useEffect(() => {
    if (open) setKw('');
  }, [open]);

  const list = useMemo(() => {
    const q = kw.trim().toLowerCase();
    return q ? ICON_NAMES.filter((n) => n.includes(q)) : ICON_NAMES;
  }, [kw]);

  return (
    <Modal
      open={open}
      wide
      title={title ?? t('nav_item_icon_title', '导航项图标')}
      onClose={onClose}
      footer={
        <Button variant="default" onClick={onClose}>
          {t('cancel', '取消')}
        </Button>
      }
    >
      <p className="mb-2 text-sm text-muted-2">
        {hint ?? t('nav_icon_hint', '图标显示在名称左侧；选择「无图标」则只显示名称。')}
      </p>
      <div className="mb-3">
        <Input
          value={kw}
          placeholder={t('nav_icon_search', '搜索图标')}
          aria-label={t('nav_icon_search', '搜索图标')}
          onChange={(e) => setKw(e.target.value)}
        />
      </div>
      <div className="grid max-h-[52vh] grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-1.5 overflow-y-auto">
        {/* 无图标：清空已选图标 */}
        <button
          type="button"
          onClick={() => onPick('')}
          title={t('nav_item_icon_none', '无图标')}
          aria-pressed={!value}
          className={cx(
            'flex flex-col items-center gap-1 rounded-[6px] border px-1.5 py-2 text-[11px] leading-none transition-colors',
            !value
              ? 'border-brand bg-brand/5 text-brand'
              : 'border-line-soft text-muted hover:border-brand/40 hover:text-ink',
          )}
        >
          <Icon name="close" className="size-[18px]" />
          <span className="w-full truncate text-center">{t('nav_item_icon_none', '无图标')}</span>
        </button>
        {list.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onPick(n)}
            title={n}
            aria-pressed={value === n}
            className={cx(
              'flex flex-col items-center gap-1 rounded-[6px] border px-1.5 py-2 text-[11px] leading-none transition-colors',
              value === n
                ? 'border-brand bg-brand/5 text-brand'
                : 'border-line-soft text-muted hover:border-brand/40 hover:text-ink',
            )}
          >
            <Icon name={n} className="size-[18px]" />
            <span className="w-full truncate text-center">{n.replace(/_/g, ' ')}</span>
          </button>
        ))}
      </div>
      {list.length === 0 && (
        <p className="mt-2 text-sm text-muted-2">{t('no_data', '暂无数据')}</p>
      )}
    </Modal>
  );
}
