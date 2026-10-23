/**
 * 扩展详情 / 配置（/admin/extensions/:id，§4.10）。
 * 结构：卡体内一条媒体行（54×54 图标砖，取自 ./ext-icon 与列表卡同源、`<h4>` 名称+版本、brief 段）
 * → `<hr>` → 双列元信息栅格 → `<hr>` → 提示条 → 居中按钮行；卡**外**另有 [返回]（次要按钮，width:210px）。
 *
 * 配置区已**表单化**（尽量不让管理员写 JSON）：
 *  - 有 schema 的插件默认渲染结构化表单：开关/文本/键值行 + 每项 help 说明获取方法；
 *    顶部 intro 说明「开箱即用」的部分，零配置插件（card）直接声明无需配置。
 *    schema 由**插件自声明**（挂后端 ExtensionModule，随 GET /api/admin/extensions/:id 下发，
 *    target 已由服务端归一化：password→secret）；旧 api / 无 schema 插件自动降级裸 JSON 高级模式。
 *  - 密钥类字段永不回显：GET 只回 secretKeys 键名 → 徽章「已配置/未配置」；保存走 PUT secretPatch
 *    增量合并（只提交填写了的键），实现「留空即保持原值」。
 *  - 右上角「高级模式」切换回裸 JSON 文本域（secret 整体覆盖），面向未知插件/兜底排查。
 * 三处按现实现改判（§7 记账，勿当遗漏）：
 *  1) 配置编辑落在本页（schema 与 ext:{id}:config 键位一一对应），不再依赖插件自带配置表单。
 *  2) 价格/安装量/销量/认证等列来自官方插件市场接口，本地扩展无数据，整体不出。
 *  3) [返回] 是回列表的链接，不用 history.back()——直接输 URL 进入本页时不会退出后台。
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { getExtension, putExtension } from '../api';
import { useAdminLang, useAdminT, type AdminT } from '../t';
import { useAdminAction } from '../use-action';
import { apiErrorMessage } from '../../lib/errors';
import { extName } from './ExtensionPage';
import { ExtIcon } from './ext-icon';
import { AdSlotGrid } from './AdSlotGrid';
import { extText, type ExtField } from '@freeidx/shared';
import { PLUGIN_TABS } from '../tabs';
import { Alert, Button, Card, ErrorState, LinkButton, TabBar, cx, inputCls } from '../ui';

/** 文本域必须是 JSON 对象；空串视为空对象（提交 `{}` 即清空该项）——高级模式专用 */
function parseJsonObject(text: string, label: string, t: AdminT): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let v: unknown;
  try {
    v = JSON.parse(trimmed);
  } catch {
    throw new Error(t('ext_json_invalid', '{label}不是合法的 JSON', { label }));
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(t('ext_json_not_object', '{label}需为 JSON 对象', { label }));
  return v as Record<string, unknown>;
}

function getPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** 不可变地按路径写值（中途缺对象则补建），返回新根对象 */
function setPath(obj: Record<string, unknown>, path: string[], v: unknown): Record<string, unknown> {
  const [head = '', ...rest] = path;
  if (!head) return obj;
  if (!rest.length) return { ...obj, [head]: v };
  const child = (obj[head] && typeof obj[head] === 'object' && !Array.isArray(obj[head])
    ? obj[head]
    : {}) as Record<string, unknown>;
  return { ...obj, [head]: setPath(child, rest, v) };
}

/** 字段标签行：label + （密钥的已配置徽章） */
function FieldLabel({ field, configured }: { field: ExtField; configured?: boolean }) {
  const t = useAdminT();
  const lang = useAdminLang();
  return (
    <span className="mb-[.5rem] flex items-center gap-2 font-medium">
      {extText(field.label, lang) || field.key}
      {field.target === 'secret' && (
        <span
          className={cx(
            'rounded-full px-2 py-0.5 text-[.75rem] font-normal',
            configured ? 'bg-success/10 text-success' : 'bg-canvas text-muted',
          )}
        >
          {configured ? t('ext_configured', '已配置') : t('ext_not_configured', '未配置')}
        </span>
      )}
    </span>
  );
}

/** 帮助文案（说明方法） */
function FieldHelp({ text }: { text: string }) {
  return <p className="mt-[.4rem] mb-0 text-xs leading-relaxed text-muted-2">{text}</p>;
}

/** kv 键值行：受控组件，对象是唯一数据源（改名=删旧键写新键），底部固定一行「添加」 */
function KvRows({
  field,
  value,
  onChange,
}: {
  field: ExtField;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const t = useAdminT();
  const lang = useAdminLang();
  const [addKey, setAddKey] = useState('');
  const [addVal, setAddVal] = useState('');
  const entries = Object.entries(value);
  const numeric = field.type === 'kv' && field.numeric;
  const coerce = (v: string): unknown => (numeric && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);

  const rename = (oldKey: string, newKey: string): void => {
    const next: Record<string, unknown> = {};
    for (const [k, v] of entries) if (k !== oldKey) next[k] = v;
    const val = String(value[oldKey] ?? '');
    if (newKey.trim()) next[newKey.trim()] = coerce(val);
    onChange(next);
  };
  const setValue = (key: string, v: string): void => onChange({ ...value, [key]: coerce(v) });
  const remove = (key: string): void => {
    const next = { ...value };
    delete next[key];
    onChange(next);
  };
  const add = (): void => {
    const k = addKey.trim();
    if (!k) return;
    onChange({ ...value, [k]: coerce(addVal) });
    setAddKey('');
    setAddVal('');
  };

  return (
    <div className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] gap-1.5">
          <input
            aria-label={extText(field.keyLabel, lang) || t('ext_key', '键')}
            value={k}
            spellCheck={false}
            onChange={(e) => rename(k, e.target.value)}
            className={cx(inputCls, 'font-mono text-[.8125rem]')}
          />
          <input
            aria-label={extText(field.valueLabel, lang) || t('ext_value', '值')}
            value={String(v ?? '')}
            spellCheck={false}
            onChange={(e) => setValue(k, e.target.value)}
            className={cx(inputCls, 'font-mono text-[.8125rem]')}
          />
          <Button type="button" variant="secondary" size="sm" onClick={() => remove(k)}>
            {t('delete', '删除')}
          </Button>
        </div>
      ))}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] gap-1.5">
        <input
          aria-label={t('ext_add_key', '新增{label}', { label: extText(field.keyLabel, lang) || t('ext_key', '键') })}
          value={addKey}
          spellCheck={false}
          placeholder={extText(field.placeholder, lang) || extText(field.keyLabel, lang)}
          onChange={(e) => setAddKey(e.target.value)}
          className={cx(inputCls, 'font-mono text-[.8125rem]')}
        />
        <input
          aria-label={t('ext_add_value', '新增{label}', { label: extText(field.valueLabel, lang) || t('ext_value', '值') })}
          value={addVal}
          spellCheck={false}
          placeholder={extText(field.valueLabel, lang)}
          onChange={(e) => setAddVal(e.target.value)}
          className={cx(inputCls, 'font-mono text-[.8125rem]')}
        />
        <Button type="button" variant="secondary" size="sm" disabled={!addKey.trim()} onClick={add}>
          {t('ext_add', '添加')}
        </Button>
      </div>
    </div>
  );
}

export function ExtensionEditPage() {
  const t = useAdminT();
  const lang = useAdminLang();
  const id = useParams().id ?? '';
  const q = useQuery({ queryKey: ['admin', 'extensions', id], queryFn: () => getExtension(id) });
  const d = q.data;
  const schema = d?.schema; // 插件自声明 schema（API 下发）；未加载或无 schema 时降级高级模式

  const [draft, setDraft] = useState<Record<string, unknown> | null>(null); // 结构化模式的 config 副本
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({}); // 密钥输入（永不回显，初始全空）
  const [configText, setConfigText] = useState<string | null>(null); // 高级模式
  const [secretText, setSecretText] = useState(''); // 高级模式
  const [advancedOverride, setAdvancedOverride] = useState<boolean | null>(null);
  const advanced = advancedOverride ?? !schema; // 无 schema 的未知插件只有高级模式
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (d && draft === null) setDraft(JSON.parse(JSON.stringify(d.config ?? {})) as Record<string, unknown>);
    if (d && configText === null) setConfigText(JSON.stringify(d.config ?? {}, null, 2));
  }, [d, draft, configText]);

  /** 模式互切时同步两边状态，避免编辑内容丢失 */
  const toggleMode = (): void => {
    if (!advanced) {
      if (draft) setConfigText(JSON.stringify(draft, null, 2));
      setAdvancedOverride(true);
      return;
    }
    if (schema) {
      try {
        setDraft(configText === null ? JSON.parse(JSON.stringify(d?.config ?? {})) : parseJsonObject(configText, t('admin_ext_config', '配置'), t));
        setAdvancedOverride(false);
      } catch (e) {
        setFlash({ tone: 'warn', text: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    setAdvancedOverride(false);
  };

  /** 结构化保存：config 整体写；密钥只提交填写了的键（secretPatch 增量合并 → 留空即保持原值） */
  const saveStructured = async (): Promise<unknown> => {
    if (!schema || !draft) return undefined;
    for (const f of schema.fields) {
      if (f.type !== 'kv' || !f.keyPattern) continue;
      const obj = getPath(draft, f.path ?? [f.key]) as Record<string, unknown> | undefined;
      for (const k of Object.keys(obj ?? {})) {
        if (!k.trim()) throw new Error(t('ext_empty_key', '「{label}」存在空键名，请补全或删除该行', { label: extText(f.label, lang) }));
        if (!new RegExp(f.keyPattern).test(k)) throw new Error(t('ext_key_pattern_err', '「{label}」的键「{key}」不符合格式要求（{pattern}）', { label: extText(f.label, lang), key: k, pattern: f.keyPattern }));
      }
    }
    const body: { config?: Record<string, unknown>; secretPatch?: Record<string, unknown> } = {};
    if (schema.fields.length) body.config = draft;
    const patch: Record<string, unknown> = {};
    for (const f of schema.fields) {
      if (f.target !== 'secret') continue; // password / text / textarea 密钥统一走增量合并
      const v = secretDraft[f.key]?.trim();
      if (v) patch[f.key] = v;
    }
    if (Object.keys(patch).length) body.secretPatch = patch;
    const r = await putExtension(id, body);
    if (Object.keys(patch).length) setSecretDraft({}); // 提交成功才清空密码框
    return r;
  };

  const { flash, setFlash, mutate, pending } = useAdminAction(
    () => (schema && !advanced ? saveStructured() : putExtension(id, {
        config: parseJsonObject(configText ?? '{}', t('admin_ext_config', '配置'), t),
        ...(secretText.trim() ? { secret: parseJsonObject(secretText, t('admin_ext_secret', '私密项'), t) } : {}),
      })),
    { ok: t('ext_save_success', '保存成功'), invalidate: [['admin', 'extensions']] },
  );

  const flip = async () => {
    if (!d) return;
    const next = d.enable === 1 ? 0 : 1;
    setToggling(true);
    try {
      await putExtension(id, { enable: next });
      await q.refetch();
      setFlash({ tone: 'ok', text: next === 1 ? t('enabled', '已启用') : t('disabled', '已禁用') });
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setToggling(false);
    }
  };

  const setIn = (path: string[], v: unknown): void => {
    if (draft) setDraft(setPath(draft, path, v));
  };

  return (
    <div className="space-y-3">
      <TabBar active="local" items={PLUGIN_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {q.isError && <ErrorState error={q.error} />}

      {d && (
        <>
          <Card>
            <div className="flex items-start">
              {/* 与插件中心列表卡同源（./ext-icon）：同一插件列表/详情图色一致 */}
              <ExtIcon id={d.manifest.id} size="detail" className="mr-[1rem]" />
              <div className="min-w-0 flex-1">
                <h4 className="mb-[.5rem] text-[1.5rem] font-medium leading-[1.2]">
                  {extName(d.manifest.name, lang, d.manifest.id)} v{d.manifest.version}
                </h4>
                <p className="mb-0 text-sm leading-relaxed text-muted">{extText(d.schema?.brief, lang)}</p>
              </div>
            </div>
            <hr className="my-[1rem] border-t border-line" />

            <div className="grid grid-cols-1 gap-x-[30px] md:grid-cols-2">
              <div>
                <span className="text-muted">{t('plugin_dir', '插件目录名')}</span>：{d.manifest.id}
              </div>
              <div>
                <span className="text-muted">{t('plugin_version', '版本')}</span>：v{d.manifest.version}
              </div>
              <div>
                <span className="text-muted">{t('enable', '启用')}</span>：
                {d.enable === 1 ? (
                  <span className="text-success">{t('enabled', '已启用')}</span>
                ) : (
                  <span className="text-muted">{t('disabled', '已禁用')}</span>
                )}
              </div>
              <div>
                <span className="text-muted">{t('admin_ext_secret', '私密项')}</span>：
                {d.hasSecret ? t('ext_secret_configured', '已配置（内容不回显）') : t('ext_not_configured', '未配置')}
              </div>
            </div>
            <hr className="my-[1rem] border-t border-line" />

            {schema && (
              <div className="mb-[1rem] rounded-[6px] bg-brand/5 px-3 py-2 text-sm leading-relaxed text-ink-soft">
                {extText(schema.intro, lang)}
              </div>
            )}

            <form
              onSubmit={(e: FormEvent) => (e.preventDefault(), mutate())}
            >
              {schema && !advanced && (
                <div className="space-y-4">
                  {schema.fields.map((f) => {
                    const configured = d.secretKeys?.includes(f.key) ?? false;
                    // 自动生成字段（如 IndexNow Key）：值由服务端自动生成并持久化（公开值，可展示），无需人工填写
                    if (f.autoGenerate) {
                      const val = String(getPath(draft ?? {}, f.path ?? [f.key]) ?? '');
                      return (
                        <div key={f.key} className="mb-[1rem]">
                          <span className="mb-[.5rem] flex items-center gap-2 font-medium">
                            {extText(f.label, lang) || f.key}
                            <span
                              className={cx(
                                'rounded-full px-2 py-0.5 text-[.75rem] font-normal',
                                val ? 'bg-success/10 text-success' : 'bg-canvas text-muted',
                              )}
                            >
                              {val ? t('ext_auto_generated', '已自动生成') : t('ext_auto_generate_pending', '首次推送时自动生成')}
                            </span>
                          </span>
                          <input
                            type="text"
                            readOnly
                            spellCheck={false}
                            value={val}
                            placeholder={t('ext_auto_placeholder', '无需填写——系统自动生成并持久化')}
                            className={cx(inputCls, 'font-mono text-[.8125rem] opacity-70')}
                          />
                          {f.help && <FieldHelp text={extText(f.help, lang)} />}
                        </div>
                      );
                    }
                    if (f.type === 'switch') {
                      const raw = getPath(draft ?? {}, f.path ?? [f.key]);
                      const checked = raw === undefined ? !!f.defaultOn : raw === f.onValue;
                      return (
                        <div key={f.key} className="mb-[1rem]">
                          <label className="flex cursor-pointer items-center gap-2">
                            <input
                              type="checkbox"
                              className="size-4 accent-brand"
                              checked={checked}
                              onChange={(e) => setIn(f.path ?? [f.key], e.target.checked ? f.onValue : f.offValue)}
                            />
                            <span className="font-medium">{extText(f.label, lang) || f.key}</span>
                          </label>
                          {f.help && <FieldHelp text={extText(f.help, lang)} />}
                        </div>
                      );
                    }
                    if (f.type === 'password') {
                      return (
                        <div key={f.key} className="mb-[1rem]">
                          <FieldLabel field={f} configured={configured} />
                          <input
                            type="password"
                            autoComplete="new-password"
                            spellCheck={false}
                            value={secretDraft[f.key] ?? ''}
                            placeholder={configured ? t('ext_secret_configured_placeholder', '已配置——留空表示保持不变') : extText(f.placeholder, lang)}
                            onChange={(e) => setSecretDraft((s) => ({ ...s, [f.key]: e.target.value }))}
                            className={cx(inputCls, 'font-mono text-[.8125rem]')}
                          />
                          {f.help && <FieldHelp text={extText(f.help, lang)} />}
                        </div>
                      );
                    }
                    if (f.type === 'kv') {
                      const obj = (getPath(draft ?? {}, f.path ?? [f.key]) ?? {}) as Record<string, unknown>;
                      return (
                        <div key={f.key} className="mb-[1rem]">
                          <FieldLabel field={f} />
                          <KvRows field={f} value={obj} onChange={(next) => setIn(f.path ?? [f.key], next)} />
                          {f.help && <FieldHelp text={extText(f.help, lang)} />}
                        </div>
                      );
                    }
                    // text / textarea（target=secret 的文本类密钥同样走 secretDraft：不回显、留空保持原值）
                    const secretText = f.target === 'secret';
                    const rawVal = secretText ? secretDraft[f.key] ?? '' : getPath(draft ?? {}, f.path ?? [f.key]);
                    const val = rawVal === undefined || rawVal === null ? '' : String(rawVal);
                    return (
                      <div key={f.key} className="mb-[1rem]">
                        <FieldLabel field={f} configured={configured} />
                        {f.type === 'textarea' ? (
                          <textarea
                            rows={f.rows ?? 4}
                            spellCheck={false}
                            value={val}
                            placeholder={secretText && configured ? t('ext_secret_configured_placeholder', '已配置——留空表示保持不变') : extText(f.placeholder, lang)}
                            onChange={(e) =>
                              secretText
                                ? setSecretDraft((s) => ({ ...s, [f.key]: e.target.value }))
                                : setIn(f.path ?? [f.key], e.target.value)
                            }
                            className={cx(inputCls, 'font-mono text-[.8125rem]')}
                          />
                        ) : (
                          <input
                            type="text"
                            spellCheck={false}
                            value={val}
                            placeholder={secretText && configured ? t('ext_secret_configured_placeholder', '已配置——留空表示保持不变') : extText(f.placeholder, lang)}
                            onChange={(e) =>
                              secretText
                                ? setSecretDraft((s) => ({ ...s, [f.key]: e.target.value }))
                                : setIn(f.path ?? [f.key], e.target.value)
                            }
                            className={cx(inputCls, 'font-mono text-[.8125rem]')}
                          />
                        )}
                        {f.help && <FieldHelp text={extText(f.help, lang)} />}
                      </div>
                    );
                  })}
                </div>
              )}

              {advanced && (
                <>
                  <div className="mb-[1rem]">
                    <label htmlFor="ext-config" className="mb-[.5rem] inline-block font-medium">
                      {t('ext_config_json_label', '配置（JSON）：')}
                    </label>
                    <textarea
                      id="ext-config"
                      rows={10}
                      spellCheck={false}
                      disabled={configText === null}
                      value={configText ?? ''}
                      onChange={(e) => setConfigText(e.target.value)}
                      className={cx(inputCls, 'font-mono text-[.8125rem]')}
                    />
                    <p className="mt-[.5rem] mb-0 text-xs text-muted-2">
                      {t('ext_config_hint_pre', '对应 kv ')}<code>{`ext:${d.manifest.id}:config`}</code>{t('ext_config_hint_post', '，明文存储、只放非敏感项；扩展运行期读取，保存后即时生效。')}
                    </p>
                  </div>
                  <div className="mb-[1rem]">
                    <label htmlFor="ext-secret" className="mb-[.5rem] inline-block font-medium">
                      {t('ext_secret_json_label', '私密项（JSON，选填）：')}
                    </label>
                    <textarea
                      id="ext-secret"
                      rows={4}
                      spellCheck={false}
                      placeholder={t('ext_secret_placeholder', '留空则不改动；填写即整体覆盖，AES-GCM 加密存储且永不回显')}
                      value={secretText}
                      onChange={(e) => setSecretText(e.target.value)}
                      className={cx(inputCls, 'font-mono text-[.8125rem]')}
                    />
                  </div>
                </>
              )}

              {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}

              <p className="mb-0 flex flex-wrap items-center justify-center gap-2">
                {(schema?.fields.length ?? 0) > 0 && (
                  <Button type="submit" loading={pending}>
                    {t('save', '保存')}
                  </Button>
                )}
                <Button variant="secondary" loading={toggling} onClick={() => void flip()}>
                  {d.enable === 1 ? t('disable', '禁用') : t('enable', '启用')}
                </Button>
                {schema && (
                  <Button type="button" variant="default" onClick={toggleMode}>
                    {advanced ? t('ext_return_simple', '返回简单模式') : t('ext_advanced_json', '高级模式（直接编辑 JSON）')}
                  </Button>
                )}
              </p>
            </form>
          </Card>

          {/* 广告位管理并入「广告系统」插件页：配置表单在上，槽位表在下（原顶层「广告位」tab 已移除） */}
          {id === 'ads' && <AdSlotGrid />}

          <p className="mt-[1rem] text-center">
            <LinkButton to="/admin/extensions" variant="secondary" className="w-[210px]">
              {t('back', '返回')}
            </LinkButton>
          </p>
        </>
      )}
    </div>
  );
}
