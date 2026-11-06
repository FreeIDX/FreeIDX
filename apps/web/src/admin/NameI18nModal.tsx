/**
 * 名称多语言编辑弹窗（版块名 / 导航项名共用）。
 *
 *  - 默认名称 = 主名称（版块 `bbs_forum.name` / 导航项 `label`），前台未配置当前语言时回退它；
 *  - 每种界面语言（AVAILABLE_LOCALES）一个输入框，留空 = 该语言未翻译；
 *  - 弹窗内编辑的是**草稿**，点「确定」才回写父组件的行/表单，取消即丢弃。
 */
import { useEffect, useState } from 'react';
import { AVAILABLE_LOCALES, NATIVE_LANG_NAMES } from '@freeidx/shared';
import { useAdminT } from './t';
import { Button, Field, Input, Modal, Textarea } from './ui';

export function NameI18nModal({
  open,
  name,
  value,
  title,
  hint,
  defaultLabel,
  multiline,
  onSave,
  onClose,
}: {
  open: boolean;
  /** 默认名称（主名称）：未配置当前语言的回退值 */
  name: string;
  /** 已保存的多语言名称（locale → 名称）；父组件须保证打开期间引用稳定 */
  value: Record<string, string> | undefined;
  /** 弹窗标题（缺省 = 版块名多语言） */
  title?: string;
  /** 说明文案（缺省 = 版块名多语言提示，同样适用于导航项） */
  hint?: string;
  /** 「默认名称」字段的标签 */
  defaultLabel?: string;
  /** 长文本（站点介绍/站点描述等）用多行输入 */
  multiline?: boolean;
  onSave: (next: Record<string, string>, defaultName: string) => void;
  onClose: () => void;
}) {
  const t = useAdminT();
  const [defaultName, setDefaultName] = useState(name);
  const [map, setMap] = useState<Record<string, string>>(value ?? {});

  /* 每次打开（或切换到另一行）重置草稿；关闭后不保留未确认的输入 */
  useEffect(() => {
    if (!open) return;
    setDefaultName(name);
    setMap(value ?? {});
  }, [open, name, value]);

  const save = () => {
    const next: Record<string, string> = {};
    for (const loc of AVAILABLE_LOCALES) {
      const v = (map[loc] ?? '').trim();
      if (v) next[loc] = v;
    }
    /* 主名称不允许清空（服务端/前台过滤均要求非空），留空即保持原值 */
    onSave(next, defaultName.trim() || name);
  };

  return (
    <Modal
      open={open}
      wide
      title={title ?? t('forum_name_i18n_title', '版块名称多语言')}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            {t('cancel', '取消')}
          </Button>
          <Button onClick={save}>{t('confirm', '确定')}</Button>
        </>
      }
    >
      <Field
        label={defaultLabel ?? t('forum_name_i18n_default', '默认名称')}
        htmlFor="name-i18n-default"
        hint={
          hint ??
          t('forum_name_i18n_hint', '按站点当前语言自动显示对应名称；未填写的语言回退到默认名称。')
        }
      >
        {multiline ? (
          <Textarea
            id="name-i18n-default"
            className="h-[88px] min-h-0"
            value={defaultName}
            onChange={(e) => setDefaultName(e.target.value)}
          />
        ) : (
          <Input
            id="name-i18n-default"
            value={defaultName}
            onChange={(e) => setDefaultName(e.target.value)}
          />
        )}
      </Field>
      <div className="grid max-h-[52vh] grid-cols-1 gap-x-4 gap-y-3 overflow-y-auto sm:grid-cols-2">
        {AVAILABLE_LOCALES.map((loc) => (
          <div key={loc}>
            <label htmlFor={`name-i18n-${loc}`} className="mb-1 block text-sm text-muted">
              {NATIVE_LANG_NAMES[loc] ?? loc}
            </label>
            {multiline ? (
              <Textarea
                id={`name-i18n-${loc}`}
                className="h-[72px] min-h-0"
                value={map[loc] ?? ''}
                placeholder={defaultName}
                onChange={(e) => setMap((m) => ({ ...m, [loc]: e.target.value }))}
              />
            ) : (
              <Input
                id={`name-i18n-${loc}`}
                value={map[loc] ?? ''}
                placeholder={defaultName}
                onChange={(e) => setMap((m) => ({ ...m, [loc]: e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
