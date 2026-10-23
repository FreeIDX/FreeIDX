/**
 * 内容语言筛选条（模式 1「软过滤」的前端入口）。
 *
 * 仅在后台「内容语言分区」开关打开时渲染；站点关闭时整个组件返回 null，
 * 首页/版块页行为与升级前完全一致（连外层卡片/分隔线都不会出现）。
 *
 * 选中语义见 store/contentLang.ts：'' 未选择（跟随站点默认）、'all' 显式全部、其余为具体语言。
 * 语言名使用原生名（中文/English/日本語…），不随界面语言翻译。
 */
import { CONTENT_LANGS, CONTENT_LANG_NATIVE_NAMES, type ContentLang } from '@freeidx/shared';
import { useT } from '../lib/i18n';
import { useContentLang, useContentLangFilter, useContentLangMode } from '../store/contentLang';
import { cx } from './ui';

const chip =
  'inline-flex shrink-0 cursor-pointer items-center rounded-full border px-2.5 py-[3px] text-xs leading-none transition-colors';
const chipOn = 'border-brand bg-brand text-white';
const chipOff = 'border-zh-line bg-lt-soft text-ink-soft hover:bg-zh-row-hover';

/** wrap：bar = 卡片内分隔行（首页）；card = 独立卡片（版块页）；none = 裸条（搜索页） */
export function ContentLangBar({ wrap = 'none' }: { wrap?: 'none' | 'bar' | 'card' }) {
  const t = useT();
  const mode = useContentLangMode();
  const effective = useContentLangFilter();
  const pref = useContentLang((s) => s.pref);
  const setPref = useContentLang((s) => s.setPref);
  if (mode <= 0) return null;

  /* 选中态按「实际生效值」渲染：mode=2 且未手动选择时，界面语言对应的 chip 高亮 */
  const active = (v: string) => (v ? effective === v : effective === '');
  const isManual = (v: string) => (v ? pref === v : pref === 'all');

  const inner = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <span className="text-xs text-lt-grey">{t('content_lang_label')}</span>
      <button type="button" className={cx(chip, active('') ? chipOn : chipOff)} onClick={() => setPref('all')}>
        {t('content_lang_all')}
      </button>
      {CONTENT_LANGS.map((l) => (
        <button
          key={l}
          type="button"
          className={cx(chip, active(l) ? chipOn : chipOff, !isManual(l) && active(l) ? 'ring-1 ring-brand/40' : '')}
          onClick={() => setPref(l)}
        >
          {CONTENT_LANG_NATIVE_NAMES[l as ContentLang]}
        </button>
      ))}
    </div>
  );

  if (wrap === 'card') return <div className="zh-card mb-[.4rem] px-3 py-3">{inner}</div>;
  if (wrap === 'bar') return <div className="border-b border-zh-line px-5 py-2">{inner}</div>;
  return inner;
}
