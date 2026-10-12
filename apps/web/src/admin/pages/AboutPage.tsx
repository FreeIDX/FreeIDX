/**
 * 关于页：
 * 尺寸口径按根字号 14px 换算（故 rem 不是 Tailwind 默认 16px 口径）：
 *  块间距：上下 3rem、段落间 1.5rem、左右 1rem；
 *  大头像 6rem 圆；主标题 3.5rem/300/lh1.2；导语 1.25rem/300；
 *  卡头是裸 `<h5>`（1.25rem/500/lh1.2/mb .5rem），与卡内小标题（1.1rem/400）高度不同，勿混用。
 * 本页有意改写的内容：
 *  - logo 用自绘的 FreeIDX 品牌字标（assets/admin/adm-wordmark.svg：
 *    斜体 Free + ID + X 字标，X 下带青色飞翼，字标自带产品名，故不再渲染文字标题行）；
 *  - 版头布局为字标居中（注意 preflight 把 img 变 block，text-center 不居中，须用 flex）。
 *  - 版本行只报 FreeIDX 1.0.0；
 *  - 「Official Site / Open Source / Dev Team」三行为「官网：www.freeidx.com / 开源地址：github.com/FreeIDX/FreeIDX / 作者：kevin」。
 */
import { cardBodyCls, cardCls, cardHeaderCls, cx } from '../ui';
import { useAdminT } from '../t';
import admWordmark from '../../assets/admin/adm-wordmark.svg';

const VERSION = '1.0.0';

const TEAM: { labelKey: 'official_site_label' | 'open_source_label' | 'author_label'; text?: string; links?: { name: string; href: string }[] }[] = [
  { labelKey: 'official_site_label', links: [{ name: 'www.freeidx.com', href: 'http://www.freeidx.com' }] },
  { labelKey: 'open_source_label', links: [{ name: 'github.com/FreeIDX/FreeIDX', href: 'https://github.com/FreeIDX/FreeIDX' }] },
  { labelKey: 'author_label', text: 'kevin' },
];

function Credit({ name, href }: { name: string; href: string }) {
  /* 现代扁平风：链接用品牌蓝，hover 变浅蓝 */
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-brand no-underline hover:text-brand-hover hover:underline">
      {name}
    </a>
  );
}

export function AboutPage() {
  const t = useAdminT();
  return (
    <div>
      <div className="my-[3rem] text-center">
        <div className="flex items-center justify-center">
          <img src={admWordmark} alt="FreeIDX" className="h-[4.5rem] w-auto" />
        </div>
        <p className="mt-[1.25rem] mb-[1rem] text-[1.25rem] font-light">
          {t('admin_about_version', '版本')}：{VERSION}
        </p>
      </div>

      <section className={cx(cardCls, 'flex flex-col')}>
        {/* .card-header 为 display:flex + align-items:center，h5 作为 flex item 保留 .5rem 下边距 */}
        <div className={cardHeaderCls}>
          <h5 className="mb-[.5rem] text-[1.25rem] font-medium leading-[1.2]">{t('dev_team_info', '开发团队信息')}</h5>
        </div>
        <div className={cardBodyCls}>
          {TEAM.map((row) => (
            <div key={row.labelKey}>
              {t(row.labelKey)}
              {row.text}
              {row.links?.map((l) => (
                <span key={l.name}>
                  <Credit {...l} />{' '}
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
