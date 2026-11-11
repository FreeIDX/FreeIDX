/**
 * 站点 Logo（顶栏 / 页脚 / 登录注册找回页共用）：
 *  - 后台「基础设置」上传过 logo（bootstrap.setting.logo_url，落 R2 /files/site/logo.*）→ 直接渲染上传图；
 *  - 未上传（含上传后被「恢复默认」清空）→ 渲染打包内置的品牌字标 assets/brand-wordmark.svg，
 *    随构建带 hash 文件名，不依赖后台、不占 R2，也不受站点名称改名影响；
 *    暗色下用 filter 提亮成白色剪影，避免深蓝字压在深色顶栏上糊成一片。
 */
import defaultLogo from '../assets/brand-wordmark.svg';
import { cx } from '../lib/cx';

export function SiteLogo({
  setting,
  className,
}: {
  setting?: { logo_url?: string | null; sitename?: string | null } | null;
  className?: string;
}) {
  const uploaded = String(setting?.logo_url ?? '').trim();
  return (
    <img
      src={uploaded || defaultLogo}
      alt={setting?.sitename || 'FreeIDX'}
      className={cx(className, !uploaded && 'dark:brightness-0 dark:invert')}
    />
  );
}
