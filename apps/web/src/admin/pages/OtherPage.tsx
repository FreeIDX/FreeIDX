/**
 * 其他 / 清理缓存（模式 C 的对半栅格变体）。
 * 服务端只清四个热键：forumlist / grouplist / setting / runtime
 * （user:{uid} 与 ext:*:config 由各自的写路径精确失效，不在一键范围内）；
 * L2 KV 与 L-1 Cache API 边缘副本不受这里控制——前者靠 TTL/主动 del，后者只能等 TTL 过期。
 */
import { clearCache } from '../api';
import { useAdminT } from '../t';
import { useAdminAction } from '../use-action';
import { Icon } from '../../components/icons';
import { OTHER_TABS } from '../tabs';
import { Alert, Button, Card, Field, PageTitle, TabBar } from '../ui';

const KEYS = [
  { k: 'forumlist', descKey: 'admin_other_cache_key_forumlist', descFallback: 'Forum tree + per-group permission matrix (any forum write also auto-invalidates)' },
  { k: 'grouplist', descKey: 'admin_other_cache_key_grouplist', descFallback: 'User group 12 permission items (editing a group invalidates)' },
  { k: 'setting', descKey: 'admin_other_cache_key_setting', descFallback: 'Site settings (saving in admin invalidates; this is a fallback)' },

  { k: 'runtime', descKey: 'admin_other_cache_key_runtime', descFallback: 'Site-wide thread/post/user count snapshot' },
] as const;

export function OtherPage() {
  const t = useAdminT();
  const done = useAdminAction(clearCache, {
    ok: t('admin_other_cache_done', '已清空核心缓存，前台下次请求即重建'),
    invalidate: [['admin', 'runtime']],
  });

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_other_cache', '其他设置')}</PageTitle>
      <TabBar active="cache" items={OTHER_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {done.flash && <Alert tone={done.flash.tone}>{done.flash.text}</Alert>}

      <Card>
        <Field label={t('admin_clear_cache', '清理缓存')}>
          <p className="pt-1 text-sm text-muted">
            {t('admin_other_cache_help', '手动失效 L1（Workstore/内存）里由 D1 装配出来的热数据。改了权限、版块顺序或计数却仍看到旧值时用一次即可，日常无需点击。')}
          </p>
          <ul className="mt-3 space-y-1 text-xs text-muted-2">
            {KEYS.map((x) => (
              <li key={x.k}>
                <code className="rounded bg-white px-1 py-0.5 text-brand">{x.k}</code> — {t(x.descKey, x.descFallback)}
              </li>
            ))}
          </ul>
          <div className="mt-4 lg:w-1/2">
            <Button block loading={done.pending} onClick={() => done.mutate()}>
              <Icon name="refresh" />
              {t('admin_clear_cache', '立即清理')}
            </Button>
          </div>
        </Field>
      </Card>
    </div>
  );
}
