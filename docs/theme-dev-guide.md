# 主题开发指南

从零做一个内置主题的完整走查：建文件夹 → 写三个接管点 → 本地调试 → 后台启用。
规则与契约见 [主题开发规范](theme-spec.md)，本文是**怎么做**。

---

## 0. 先理解：主题是什么

换主题 = 换构建产物里加载哪套前端代码。主题不是后台上传的样式包，它参与 TypeScript 编译与
Tailwind 扫描，因此**能覆写布局、能整页替换，上限与主程序持平**。

主题只有三个接管点，全部可选：

| 接管点 | 作用 | 不写会怎样 |
| --- | --- | --- |
| `layout` | 整站外壳，接收 `children`（路由内容） | 沿用基底主题 `light` 的外壳 |
| `slots` | 替换外壳内部区域：`header` / `dock` / `footer` | 该区域沿用基底实现 |
| `pages` | 整页替换前台路由页（17 个键） | 该路由沿用基底页面 |

**基底继承**是理解一切的关键：`light` 是基底主题，自带整站布局与全部 17 个页面。
你的主题只写差异，其余自动继承——所以哪怕只有一个 `pages.home`，全站依然可用。

```
你的主题  ──合并──▶  基底主题 light
 layout?     取你的优先，否则用 light 的
 slots?      { ...light.slots, ...你的 }
 pages?      { ...light.pages, ...你的 }
```

合并只复制组件引用，`React.lazy` 未被渲染就不会 `import()`，所以基底页面 chunk 不会提前下载。

---

## 1. 最小可行主题（3 步）

以 `demo` 为例（文件夹名就是主题 id）：

**第 1 步** 新建 `apps/web/src/themes/demo/theme.json`：

```json
{
  "id": "demo",
  "name": { "zh-cn": "演示主题", "en-us": "Demo" },
  "version": "0.1.0",
  "author": "you",
  "order": 10
}
```

**第 2 步** 新建 `apps/web/src/themes/demo/index.tsx`：

```tsx
import type { ThemeModule } from '../../lib/theme/types';

const theme: ThemeModule = {
  // 什么都不覆写 → 等同简蓝
};

export default theme;
```

**第 3 步** 跑校验，然后在后台启用：

```bash
pnpm --filter @freeidx/web themes:check   # 目录与 theme.json 合法性
pnpm --filter @freeidx/web dev            # 起前端
# 后台 → 系统 → 主题管理 → 找到「演示主题」→ 启用 → 刷新前台
```

到这一步没有任何视觉变化——这是对的，说明继承链路通了。接下来逐项加东西。

> 注意：`id` 必须等于文件夹名，且匹配 `^[a-z0-9][a-z0-9_-]{0,31}$`（小写字母/数字开头，
> 可含 `-` `_`，最长 32）。`name` 至少要有 `zh-cn` 与 `en-us`。写错了 `themes:check` 会直接报出来。

---

## 2. 三个接管点怎么写

### 2.1 `slots`：只换某个区域（最常用）

写 `slots.header` 就替换了顶栏。**为什么插槽能生效？** 因为基底主题的 `Layout.tsx` 内部是这么装配的：

```tsx
<ThemeSlot name="header">{/* 简蓝顶栏 JSX */}</ThemeSlot>
<main id="body">{children}</main>
<ThemeSlot name="footer">{/* 简蓝页脚 JSX */}</ThemeSlot>
<ThemeSlot name="dock">{/* 简蓝底栏 JSX */}</ThemeSlot>
```

`ThemeSlot` 发现你的主题提供了 `slots.header` 就渲染你的，否则渲染它自己的 children。
这条机制让你**不必重写整个外壳**就能换顶栏，也不必与基底共享布局状态。

### 2.2 `pages`：整页替换某个路由

页面组件**不接收 props**，自己经 SDK 取数据。大页面用 `lazyPage()` 包一层保留路由级分包：

```tsx
import { lazyPage } from '../../lib/theme/sdk';

pages: {
  home: AuroraHome,                                        // 直接给组件
  forum: lazyPage(() => import('./pages/Forum').then((m) => ({ default: m.Forum }))),
}
```

可用键（17 个）：
`home` `forum` `thread` `user` `login` `register` `resetpw` `me` `compose` `search`
`discovery` `rank` `mod` `paylist` `vip` `order` `notfound`。

### 2.3 `layout`：自带整站外壳

只有想做完全不同的骨架（比如侧边栏式）才需要。签名必须接收可选的 `children`：

```tsx
import type { ReactNode } from 'react';

export function MyLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="fi-theme-demo min-h-dvh">
      <MyTopBar />
      <main className="mx-auto max-w-[1140px] px-4">{children}</main>
      <MyFooter />
    </div>
  );
}
```

接管 `layout` 后，`slots` 想生效必须**由你自己在外壳里调用 `ThemeSlot`**——插槽只是外壳内部的
约定位置，基底外壳被替换掉了，它就不再提供这些位置。

**固定顶栏的坑**：基底外壳给内容区留了 `pt-[100px] lg:pt-[83px]` 的内边距。如果你的页面想顶到页头下缘，
照下面这样抵掉（示例见 §3 的 `DemoHome`）：

```tsx
<div className="-mt-[100px] pt-[100px] lg:-mt-[83px] lg:pt-[83px]">
```

---

## 3. 完整示例：`demo` 主题

演示三件事：换顶栏、换页脚、整页替换首页。其它 16 个页面继续沿用基底。

### `themes/demo/theme.json`

```json
{
  "id": "demo",
  "name": {
    "zh-cn": "演示主题",
    "zh-tw": "演示主題",
    "en-us": "Demo"
  },
  "description": {
    "zh-cn": "示例完整主题：覆写顶栏/页脚插槽并整页替换首页。",
    "en-us": "Sample full theme: overrides the header/footer slots and replaces the home page."
  },
  "version": "1.0.0",
  "author": "FreeIDX",
  "order": 10
}
```

### `themes/demo/index.tsx`

```tsx
/** 演示主题：只从 lib/theme/sdk 取能力，不 import 框架内部实现。 */
import { useAuth, useT, Link, Icon, cx } from '../../lib/theme/sdk';
import type { ThemeModule } from '../../lib/theme/types';

/** 顶栏：深色玻璃拟态条 + 渐变下缘 */
function DemoHeader() {
  const setting = useAuth((s) => s.setting);
  const t = useT();
  const name = setting?.sitename || 'FreeIDX';
  return (
    <header className="fi-theme-demo-bar fixed inset-x-0 top-0 z-[999] border-b border-white/10 bg-slate-900/85">
      <div className="mx-auto flex h-[68px] w-full max-w-[1140px] items-center gap-3 px-4 3xl:max-w-[1536px]">
        <Link to="/" className="flex shrink-0 items-center gap-2 no-underline">
          {setting?.logo_url ? (
            <img src={String(setting.logo_url)} alt={name} className="h-[34px] w-auto" />
          ) : (
            <span className="bg-gradient-to-r from-sky-300 to-violet-300 bg-clip-text text-xl font-bold tracking-tight text-transparent">
              {name}
            </span>
          )}
        </Link>
        <nav className="ml-4 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-[15px]">
          <Link to="/" className="rounded-full px-3 py-1.5 text-slate-200 no-underline transition-colors hover:bg-white/10 hover:text-white">
            {t('home')}
          </Link>
          <Link to="/rank" className="rounded-full px-3 py-1.5 text-slate-200 no-underline transition-colors hover:bg-white/10 hover:text-white">
            {t('rank')}
          </Link>
        </nav>
        <Link to="/search" className="flex size-9 items-center justify-center rounded-full text-slate-200 no-underline hover:bg-white/10" aria-label={t('search')}>
          <Icon name="search" className="size-[18px]" />
        </Link>
      </div>
      <div className="h-[2px] w-full bg-gradient-to-r from-sky-400/70 via-violet-400/60 to-transparent" />
    </header>
  );
}

/** 页脚：简洁深色条 */
function DemoFooter() {
  const setting = useAuth((s) => s.setting);
  return (
    <footer className="border-t border-white/10 bg-slate-900 py-5 text-[13px] text-slate-400">
      <div className="mx-auto flex w-full max-w-[1140px] flex-wrap justify-between gap-2 px-4 3xl:max-w-[1536px]">
        <span>Powered by FreeIDX · Demo</span>
        <span>{setting?.sitename}</span>
      </div>
    </footer>
  );
}

/** 首页：Hero + 版块宫格（整页替换） */
function DemoHome() {
  const setting = useAuth((s) => s.setting);
  const forumlist = useAuth((s) => s.forumlist);
  const t = useT();
  const topForums = forumlist.filter((f) => !f.parentFid);
  return (
    // 抵掉外壳给固定顶栏预留的上内边距（移动 100px / 桌面 83px），让 Hero 顶到页头下缘
    <div className="fi-theme-demo -mt-[100px] pt-[100px] lg:-mt-[83px] lg:pt-[83px]">
      <section className="fi-theme-demo-hero relative overflow-hidden">
        <div className="relative z-10 mx-auto w-full max-w-[1140px] px-4 py-16 text-white 3xl:max-w-[1536px]">
          <h1 className="m-0 text-[32px] leading-tight font-bold">{setting?.sitename || 'FreeIDX'}</h1>
          {setting?.brief && <p className="mt-3 max-w-[52ch] text-[15px] leading-relaxed text-slate-300">{setting.brief}</p>}
          <div className="mt-6 flex flex-wrap gap-2">
            {topForums.slice(0, 3).map((f) => (
              <Link
                key={f.fid}
                to={`/forum/${f.fid}`}
                className="rounded-full border border-white/25 bg-white/10 px-4 py-2 text-sm text-white no-underline transition-colors hover:bg-white/20"
              >
                {f.name}
              </Link>
            ))}
          </div>
        </div>
      </section>
      <section className="mx-auto w-full max-w-[1140px] px-4 py-8 3xl:max-w-[1536px]">
        <h2 className="m-0 mb-4 text-lg font-bold">{t('forum_nav')}</h2>
        <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {topForums.map((f) => (
            <li key={f.fid}>
              <Link
                to={`/forum/${f.fid}`}
                className={cx(
                  'flex h-full flex-col gap-1 rounded-xl bg-card p-4 no-underline shadow-[0_1px_6px_rgba(15,23,42,0.06)]',
                  'transition-transform hover:-translate-y-0.5',
                )}
              >
                <span className="font-medium text-foreground">{f.name}</span>
                {f.brief && <span className="line-clamp-2 text-[13px] leading-snug text-muted">{f.brief}</span>}
                <span className="mt-auto text-[12px] text-zh-grey">
                  {f.threads} {t('threads')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const theme: ThemeModule = {
  slots: { header: DemoHeader, footer: DemoFooter },
  pages: { home: DemoHome },
};

export default theme;
```

### `themes/demo/theme.css`

可选文件，**只在该主题启用时才被 import**。为避免污染其它主题与后台，选择器一律以自己的前缀限定：

```css
/* 演示主题局部样式：随主题启用才注入（registry 按需加载 theme.css） */
.fi-theme-demo-hero {
  background-image: linear-gradient(120deg, #0f172a 0%, #1e293b 45%, #0b3b56 100%);
}
.fi-theme-demo-hero::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    radial-gradient(closest-side, rgba(56, 189, 248, 0.35), transparent) 12% 30% / 42% 78% no-repeat,
    radial-gradient(closest-side, rgba(167, 139, 250, 0.32), transparent) 82% 70% / 48% 82% no-repeat;
  pointer-events: none;
}
.fi-theme-demo-bar {
  backdrop-filter: saturate(140%) blur(12px);
}
```

---

## 4. 数据与样式从哪来

### SDK（`apps/web/src/lib/theme/sdk.ts`）

```tsx
import { useAuth, useT, useLight, Link, Icon, Avatar, cx, lazyPage } from '../../lib/theme/sdk';
```

| 导出 | 用途 |
| --- | --- |
| `useAuth` | 站点快照：`setting`（站点设置）、`forumlist`（版块树）、`grouplist`（用户组）、`me`（当前用户）、`loaded` |
| `useT` / `useLang` / `useLangPref` / `useGroupName` | 多语言文案、当前语言、语言偏好、用户组名 |
| `useLight` / `useThemeMode` / `useApplyTheme` / `userBgImage` | 简蓝配置面（轮播/友链/底栏/暗色/主页背景） |
| `Link` / `NavLink` / `useLocation` / `useNavigate` / `useParams` | 路由 |
| `Icon` / `Avatar` / `cx` | 通用 UI 基元 |
| `lazyPage` | 把 `import()` 变成可按需加载的页面组件 |

约定：**不得**改动 SDK 之外的全局状态，否则主程序升级会破坏主题。
`themes/light` 作为基底实现可以直接 import `components/`、`lib/`、`store/`；其它主题请优先走 SDK。

### 样式

Tailwind 4 的扫描基准是 Vite root（`apps/web`），`themes/` 下的文件自动纳入，
写工具类不需要额外配置。设计令牌（`bg-card` / `text-foreground` / `text-brand` / `zh-card` 等）
定义在 [globals.css](../apps/web/src/styles/globals.css)，直接用即可。
暗色由 `<html class="dark">` 驱动（`.dark .theme-zh` 整体换令牌），别自己写颜色分支。

---

## 5. 本地开发与调试

```bash
pnpm --filter @freeidx/web themes:check    # 只跑目录/元信息校验（最快）
pnpm --filter @freeidx/web dev             # 起前端（后台启用后刷新前台）
pnpm --filter @freeidx/web typecheck       # tsc + 主题校验
pnpm --filter @freeidx/web build           # 校验 + 类型 + 构建
pnpm i18n:check                            # 文案门禁（含硬编码中文检查）
```

生效链路（[active.ts](../apps/web/src/lib/theme/active.ts)）：

1. Worker 在 SPA 壳里注入 `window.__FI_THEME__`（启用主题 id）；
2. 缺失时回退 `GET /api/theme/active`；
3. 加载该主题的 `theme.css` 与模块，再与基底主题 `light` 合并；
4. **任何一步失败都回落 `light`**，不影响可用性。

改完代码直接热更新即可；**换主题是整页刷新级别**，后台点启用后刷新前台页面。
`/api/theme/active` 有 30s 边缘缓存，直链冷启动最多 30s 后跟上。

调试小抄：

- 当前生效主题：控制台 `window.__FI_THEME__`，或看 `<html>` 上是否挂了你自己的前缀类。
- 想强制回简蓝：后台切回「简蓝主题」。
- 页面白屏且控制台报 chunk 失败：多半是 `index.tsx` / `pages/*` 抛错，回落逻辑会兜住，
  但业务错误需要看 `[theme] load "xxx" failed` 的 warn。

---

## 6. 常见坑

1. **`themes/` 根目录不能放文件。** `types.ts` / `registry.ts` / `slots.tsx` / `README.md` 等
   基础设施和文档都在 `lib/theme/` 与 `docs/`；校验脚本会拦。
2. **`theme.json` 的 `id` 必须等于文件夹名**，否则校验失败、构建中止。
3. **`name` 必须有 `zh-cn` 与 `en-us`**，其它语言缺省回落到这两条。
4. **接管 `layout` 后插槽要自己调用 `ThemeSlot`**，否则 `slots` 不会生效（见 §2.3）。
5. **固定顶栏要自己补偿高度**，基底外壳预留的是移动 100px / 桌面 83px。
6. **别在主题里写死中文。** `pnpm i18n:check` 会扫描 `apps/web/src`（含 `themes/`），
   硬编码中文会被拦；用 `useT()` 取文案，缺少的键走 i18n override 流程新增。
7. **大页面记得 `lazyPage()`**。直接静态 import 会把整页打进当前 chunk，
   丢掉路由级分包，首页体积会明显变大。
8. **主题里的 `theme.css` 一律带前缀**（如 `.fi-theme-demo-*`），否则可能污染后台与其它主题。
9. **不要把 `themes/` 加进 `.gitignore`**：它是源码，不是构建产物。

---

## 7. 上线前检查

- `pnpm --filter @freeidx/web build` 通过（含 `check-themes`）。
- `pnpm i18n:check` 通过（无硬编码中文、无缺失键）。
- 后台主题管理能看到你的主题，启用后前台刷新即为新外观。
- 逐个走一遍关键路由（首页 / 版块 / 帖子 / 个人页 / 404），确认未覆写的页面正常继承基底。
- 切回「简蓝主题」确认可正常回退。
