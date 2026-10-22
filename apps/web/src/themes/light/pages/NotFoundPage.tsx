import { LinkButton } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { useT } from '../../../lib/i18n';

/** 404 页：zh-card 居中面板（大空态图标 + 标题 + 说明 + 主色「返回首页」按钮）。 */
export function NotFoundPage() {
  const t = useT();
  return (
    <div className="flex min-h-[max(670px,calc(100dvh_-_14rem))] items-center justify-center py-10">
      <section className="zh-card w-full max-w-md px-8 py-12 text-center">
        <Icon name="bug" className="mx-auto size-14 text-zh-grey" />
        <h2 className="mt-4 text-xl font-bold text-foreground">{t('resource_not_found')}</h2>
        <p className="mt-2 text-sm text-lt-grey">{t('err_content_not_found')}</p>
        <div className="mt-6">
          <LinkButton to="/" variant="primary">
            {t('back_to_home')}
          </LinkButton>
        </div>
      </section>
    </div>
  );
}