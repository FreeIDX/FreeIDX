/**
 * MCP 访问令牌管理（挂在扩展详情页 /admin/extensions/mcp 的第二个区块，与 AdSlotGrid 同一模式）。
 *
 * 三个必须遵守的交互约定：
 *  1. 明文只在创建响应里出现一次 —— 创建成功后固定在卡片顶部展示并提供复制按钮，
 *     刷新/离开页面即永久丢失（后端只存 SHA-256）；
 *  2. 档位是「令牌上限」，站点实际放行还要与插件配置取交集，故这里给出 read/write/admin 三选；
 *  3. 撤销是软删除：列表保留记录但标记已撤销，令牌立即失效（审计可继续追溯）。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MCP_SCOPES, type McpToolScope } from '@freeidx/shared';
import { createMcpToken, getMcpTokens, revokeMcpToken } from '../api';
import type { McpTokenCreated } from '../types';
import { useAdminT } from '../t';
import { useAdminAction, useBatchAction } from '../use-action';
import { Alert, Button, Card, Checkbox, ErrorState, Table, cx, inputCls } from '../ui';
import { Icon } from '../../components/icons';

const fmtDate = (sec: number): string => (sec > 0 ? new Date(sec * 1000).toLocaleString() : '—');

/** 复制到剪贴板：失败时静默（管理员可手动选中） */
function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function McpTokenGrid() {
  const t = useAdminT();
  const q = useQuery({ queryKey: ['admin', 'mcp-tokens'], queryFn: getMcpTokens });
  const batch = useBatchAction([['admin', 'mcp-tokens']]);

  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<McpToolScope[]>(['read']);
  const [expireDays, setExpireDays] = useState(0);
  const [created, setCreated] = useState<McpTokenCreated | null>(null);

  const create = useAdminAction(
    () => createMcpToken({ name: name.trim() || 'AI client', scopes: scopes.join(','), expireDays }),
    {
      invalidate: [['admin', 'mcp-tokens']],
      ok: () => t('mcp_token_created', '令牌已创建，请立即复制'),
      onData: (d) => {
        setCreated(d);
        setName('');
      },
    },
  );

  const toggleScope = (s: McpToolScope) => {
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  };

  const rows = q.data?.tokens ?? [];
  /** 档位说明：read/write/admin 本身是协议术语，保持英文；补充说明才是给人看的 */
  const scopeHint: Record<McpToolScope, string> = {
    read: t('mcp_scope_read_hint', '列出/阅读版块、主题、回复、搜索'),
    write: t('mcp_scope_write_hint', '发帖与回帖（版块审核照常生效）'),
    admin: t('mcp_scope_admin_hint', '置顶/关闭/删除等版务动作'),
  };

  return (
    <div className="space-y-3">
      {q.isError && <ErrorState error={q.error} />}

      {/* 明文一次性与接入说明：令牌丢失只能新建，这里的提示不能省 */}
      {created && (
        <Card title={t('mcp_new_token', '新令牌（仅显示这一次）')}>
          <Alert tone="warn">{t('mcp_copy_now', '关闭或刷新后无法再次查看，请立即复制并填入 AI 客户端配置。')}</Alert>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-[6px] bg-canvas px-3 py-2 font-mono text-[.8125rem]">
              {created.token}
            </code>
            <Button size="sm" onClick={() => copyText(created.token)}>
              <Icon name="copy" />
              {t('mcp_copy', '复制')}
            </Button>
          </div>
          <p className="mt-2 mb-0 text-xs leading-relaxed text-muted-2">
            {t('mcp_endpoint_hint', '接入地址：本站 /mcp · 请求头：Authorization: Bearer <令牌>')}
          </p>
        </Card>
      )}

      <Card
        title={t('mcp_tokens', '访问令牌')}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-2">
              {t('mcp_scope_note', '令牌档位是上限，站点配置的开放档位同样生效（两者取交集）。')}
            </span>
            <Button
              loading={create.pending}
              disabled={!scopes.length}
              onClick={() => create.mutate()}
              className="w-[10rem]"
            >
              {t('create', '创建')}
            </Button>
          </div>
        }
      >
        <div className="mb-4 grid gap-3 md:grid-cols-[1fr_auto_auto]">
          <label className="block">
            <span className="mb-[.4rem] block text-sm font-medium">{t('mcp_token_name', '名称')}</span>
            <input
              className={cx(inputCls, 'w-full')}
              value={name}
              maxLength={40}
              placeholder={t('mcp_token_name_ph', '如 Claude Desktop')}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div>
            <span className="mb-[.4rem] block text-sm font-medium">{t('mcp_scopes', '档位')}</span>
            <div className="flex items-center gap-3 pt-1">
              {MCP_SCOPES.map((s) => (
                <label key={s} className="flex cursor-pointer items-center gap-1.5 text-sm" title={scopeHint[s]}>
                  <Checkbox checked={scopes.includes(s)} onChange={() => toggleScope(s)} />
                  {s}
                </label>
              ))}
            </div>
          </div>
          <label className="block w-[9rem]">
            <span className="mb-[.4rem] block text-sm font-medium">{t('mcp_expire_days', '有效天数')}</span>
            <input
              type="number"
              min={0}
              max={3650}
              className={cx(inputCls, 'w-full')}
              value={expireDays}
              onChange={(e) => setExpireDays(Math.max(0, Number(e.target.value || 0)))}
            />
          </label>
        </div>

        {create.flash && <Alert tone={create.flash.tone}>{create.flash.text}</Alert>}
        {batch.flash && <Alert tone={batch.flash.tone}>{batch.flash.text}</Alert>}

        <Table
          head={[
            'ID',
            t('mcp_token_name', '名称'),
            t('mcp_token_prefix', '前缀'),
            t('mcp_scopes', '档位'),
            t('mcp_expire_at', '过期'),
            t('mcp_last_used', '最近使用'),
            '',
          ]}
          minWidth="min-w-[900px]"
        >
          {rows.map((r) => (
            <tr key={r.id} className={r.revoked ? 'opacity-50' : undefined}>
              <td className="w-[60px] tabular-nums">{r.id}</td>
              <td>
                {r.name || '—'}
                <span className="ml-2 text-xs text-muted-2">{r.username || `uid ${r.uid}`}</span>
              </td>
              <td className="font-mono text-xs">{r.tokenPrefix}…</td>
              <td className="text-xs">{r.scopes}</td>
              <td className="text-xs">{r.expireAt > 0 ? fmtDate(r.expireAt) : t('mcp_never', '永不过期')}</td>
              <td className="text-xs">{fmtDate(r.lastUsedAt)}</td>
              <td className="w-[90px]">
                {r.revoked ? (
                  <span className="text-xs text-muted">{t('mcp_revoked', '已撤销')}</span>
                ) : (
                  <Button variant="danger" size="sm" onClick={() => void batch.run([() => revokeMcpToken(r.id)], t('mcp_revoked', '已撤销'))}>
                    {t('mcp_revoke', '撤销')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
        {!rows.length && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('none', '无')}</p>}
        <p className="mt-2 mb-0 text-xs leading-relaxed text-muted-2">
          {t(
            'mcp_auth_note',
            '所有调用按令牌持有者的真实版块权限、审核状态与付费墙过滤；站点关闭或只读时 AI 客户端同样只读。',
          )}
        </p>
      </Card>
    </div>
  );
}
