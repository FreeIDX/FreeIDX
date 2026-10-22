/**
 * 主题管理（/admin/themes，系统分组，位于「基础设置」与「插件中心」之间）。
 *
 * 口径：
 *  - 主题是**参与构建的内置前端代码**（apps/web/src/themes/<id>/），不做第三方 zip 上传/CSS 注入；
 *    清单由前端 `lib/theme/registry` 在构建期自动发现，因此新增主题无需改后台任何代码。
 *  - 后端只记住「启用哪个 id」（kv `theme`，PUT /api/admin/theme），切换后前台**整页刷新**即生效
 *    （首屏引导读窗口注入值，缺失回落 GET /api/theme/active）。
 *  - 简蓝主题的配置项仍托管在插件中心（其 theme.json 声明 configPath=/admin/extensions/light），
 *    本页只提供「设置」跳转，不复制那套表单。
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { extText } from '@freeidx/shared';
import { getAdminTheme, putAdminTheme } from '../api';
import { useAdminLang, useAdminT } from '../t';
import { apiErrorMessage } from '../../lib/errors';
import { listThemes } from '../../lib/theme/registry';
import { Badge, Button, Card, ErrorState, LinkButton, PageTitle, Toast, cx, useToast } from '../ui';

export function ThemePage() {
  const t = useAdminT();
  const lang = useAdminLang();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'theme'], queryFn: getAdminTheme });
  /** 清单来自构建期静态发现（无网络请求）：同名文件夹多语言元信息在 theme.json 内 */
  const themes = useMemo(() => listThemes(), []);
  const toast = useToast();
  const active = q.data?.active ?? '';

  const m = useMutation({
    mutationFn: (id: string) => putAdminTheme(id),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'theme'] });
      const meta = themes.find((x) => x.id === id);
      toast.show(
        t('admin_theme_switched', '已启用「{name}」，刷新前台页面后生效', { name: meta ? extText(meta.name, lang) : id }),
      );
    },
    onError: (e) => toast.show(apiErrorMessage(e), 'warn'),
  });

  return (
    <>
      <PageTitle>{t('admin_menu_theme')}</PageTitle>
      <ErrorState error={q.error} />
      {toast.toast && <Toast text={toast.toast.text} tone={toast.toast.tone} onDone={toast.close} />}

      <Card
        title={t('admin_menu_theme')}
        tools={
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted">
              {t('admin_theme_current')}：{active || '-'}
            </span>
            {q.data && active !== q.data.default && (
              <Button
                variant="default"
                size="sm"
                onClick={() => m.mutate(q.data!.default, { onSuccess: () => toast.show(t('admin_theme_reset_done')) })}
                loading={m.isPending && m.variables === q.data.default}
              >
                {t('admin_theme_reset')}
              </Button>
            )}
          </div>
        }
      >
        {themes.length === 0 ? (
          <p className="m-0 text-sm text-muted">{t('admin_theme_empty', '未发现任何内置主题')}</p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0 lg:grid-cols-2">
            {themes.map((th) => {
              const inUse = th.id === active;
              const name = extText(th.name, lang);
              const desc = extText(th.description, lang);
              return (
                <li
                  key={th.id}
                  className={cx(
                    'flex flex-col gap-2 rounded-[8px] border p-4',
                    inUse ? 'border-brand bg-brand/5' : 'border-line-soft bg-canvas',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-medium">{name}</span>
                    <Badge tone="secondary">{th.id}</Badge>
                    {inUse && <Badge tone="success">{t('admin_theme_in_use', '使用中')}</Badge>}
                  </div>
                  {desc && <p className="m-0 text-sm leading-relaxed text-muted">{desc}</p>}
                  {(th.version || th.author) && (
                    <p className="m-0 text-xs text-muted-2">
                      {th.version && `v${th.version}`}
                      {th.version && th.author ? ' · ' : ''}
                      {th.author}
                    </p>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                    {inUse ? (
                      <Button variant="default" size="sm" disabled>
                        {t('admin_theme_in_use', '使用中')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => m.mutate(th.id)}
                        loading={m.isPending && m.variables === th.id}
                      >
                        {t('admin_theme_enable', '启用')}
                      </Button>
                    )}
                    {th.configPath && (
                      <LinkButton to={th.configPath} variant="secondary" size="sm">
                        {t('admin_theme_settings')}
                      </LinkButton>
                    )}
                  </div>
                  {th.configPath && <p className="m-0 text-xs text-muted-2">{t('admin_theme_config', '该主题的配置项在插件中心维护')}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title={t('admin_theme_dev_title', '主题开发规范')}>
        <ol className="m-0 mb-3 list-decimal space-y-1 pl-5 text-sm leading-relaxed">
          <li>{t('admin_theme_dev_step1', '新建文件夹 apps/web/src/themes/<id>/，文件夹名即主题 id')}</li>
          <li>{t('admin_theme_dev_step2', '放入 theme.json（名称/简介/版本）与 index.tsx（默认导出 ThemeModule）')}</li>
          <li>{t('admin_theme_dev_step3', '可选 theme.css 与 preview.png；无需改动任何注册文件')}</li>
        </ol>
        <p className="m-0 text-xs text-muted-2">{t('admin_theme_dev_doc', '完整规范见 docs/theme-spec.md')}</p>
      </Card>
    </>
  );
}
