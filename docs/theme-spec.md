# 主题开发规范（内置完整主题）

主题系统只支持**内置完整主题**：主题是参与构建的前端代码，不是后台上传的样式包。
没有 zip 上传、没有 CSS 注入、没有主题数据表——换主题改的是构建产物里加载哪套代码，
因此主题可以覆写布局插槽乃至整页，能力上限与主程序持平。

后台入口：**系统 → 主题管理**（`/admin/themes`）。启用状态存在 kv `theme`（仅一个 id）。

> 想直接照着做一个主题？看 [主题开发指南](theme-dev-guide.md)——从零建文件夹到后台启用的完整走查与可运行示例。
> 本文是契约与规则（做错会被构建拦住的那部分）。

---

## 1. 目录约定（硬性）

```
apps/web/src/themes/
├─ light/                     ← 基底主题（必需，不可删）
│  ├─ theme.json      必需：元信息（名称/简介/版本/排序/配置入口）
│  ├─ index.tsx       必需：默认导出 ThemeModule（装配布局与页面）
│  ├─ Layout.tsx      本主题私有：整站布局外壳
│  └─ pages/          本主题私有：17 个前台页面（每个页面一个文件）
└─ <id>/                      ← 其它主题：名字即主题 id
   ├─ theme.json      必需
   ├─ index.tsx       必需
   └─ theme.css       可选：随主题启用才注入的样式
```

- `themes/` **根目录下只允许主题文件夹**，不允许出现 `types.ts` / `registry.ts` / README 等文件。
  主题基础设施统一放在 `apps/web/src/lib/theme/`。
- **文件夹名就是主题 id**，不需要改动任何注册文件。
- 新增主题 = 新建主题文件夹；构建时由
  `import.meta.glob` 自动发现（见 [registry.ts](../apps/web/src/lib/theme/registry.ts)）。
- 主题文件夹内部结构自由（可自带 `Layout.tsx`、`pages/`、`components/` 等），
  校验脚本只约束根目录固定文件名。
- 构建前会跑 `node scripts/check-themes.mjs`（`apps/web` 的 `build`/`typecheck` 已接入），
  校验：根目录只有文件夹、必需文件齐全、`theme.json` 合法且 `id === 文件夹名`、id 唯一。

### theme.json

```json
{
  "id": "demo",
  "name": { "zh-cn": "演示主题", "en-us": "Demo" },
  "description": { "zh-cn": "……", "en-us": "……" },
  "version": "1.0.0",
  "author": "FreeIDX",
  "order": 10,
  "configPath": "/admin/extensions/light"
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | 是 | 必须等于文件夹名（校验脚本会拦） |
| `name` | 是 | `{ 语言码: 文案 }`，至少提供 `zh-cn` 与 `en-us` |
| `description` | 否 | 同上，后台列表展示 |
| `version` / `author` | 否 | 后台列表展示 |
| `order` | 否 | 列表排序，小的在前，缺省 100 |
| `configPath` | 否 | 主题自有配置页的后台路径；填了后台卡片就出「设置」入口 |

---

## 2. index.tsx：ThemeModule

```tsx
import { lazyPage } from '../../lib/theme/sdk';
import type { ThemeModule } from '../../lib/theme/types';
import { Layout as MyLayout } from './Layout';

const theme: ThemeModule = {
  // 接管整站外壳（不写则沿用基底主题 light 的布局）
  layout: MyLayout,
  // 覆写布局插槽（不写的插槽继续用基底实现）
  slots: { header: MyHeader, dock: MyDock, footer: MyFooter },
  // 整页替换前台路由页（不写的页面继续用基底实现）
  pages: {
    home: MyHome,
    // 大页面建议懒加载，保留路由级分包
    forum: lazyPage(() => import('./pages/Forum').then((m) => ({ default: m.Forum }))),
  },
};

export default theme;
```

- `layout` 接收 `children`（路由内容），负责渲染顶栏/页脚等外壳；缺省时继承基底主题
  `light` 的布局。
- `slots` 可用键：`header`（含移动端二级导航与抽屉）、`dock`（移动端底部导航）、`footer`。
- `pages` 可用键见 [types.ts](../apps/web/src/lib/theme/types.ts) 的 `ThemePageName`
  （`home` / `forum` / `thread` / `user` / `login` / `register` / `resetpw` / `me` / `compose`
  / `search` / `discovery` / `rank` / `mod` / `paylist` / `vip` / `order` / `notfound`）。
- 页面组件不接收 props，自行经 SDK 取数据；`lazyPage()` 把 `import()` 包成页面组件，
  未被渲染的 chunk 不会下载。
- **基底继承**：`light` 是基底主题，自带布局与全部 17 个页面；其它主题只写差异，
  未覆写的布局/插槽/页面自动继承基底（装配见 [active.ts](../apps/web/src/lib/theme/active.ts)）。
  因此自定义主题即使只写一个 `pages.home`，其余路由依然可用。

### theme.css

可选。存在时**仅在该主题启用时**被 import（`registry.loadTheme` 按需加载），
因此不会被未启用主题污染。为避免影响后台与其它主题，选择器一律以自己的前缀限定：

```css
.fi-theme-demo-hero { /* … */ }
```

---

## 3. SDK：主题能用的 API

主题推荐从 `apps/web/src/lib/theme/sdk.ts` 取能力：

```tsx
import { useAuth, useT, useLight, Link, Icon, cx, lazyPage } from '../../lib/theme/sdk';
```

| 导出 | 用途 |
| --- | --- |
| `useAuth` | 站点设置 / 版块树 / 当前用户（bootstrap 只读快照） |
| `useT`、`useLang`、`useGroupName` | 多语言文案与用户组名 |
| `useLight`、`useThemeMode`、`useApplyTheme`、`userBgImage` | 简蓝配置面（轮播/友链/底栏/暗色/主页背景…） |
| `Link`、`NavLink`、`useLocation`、`useNavigate`、`useParams` | 路由 |
| `Icon`、`Avatar`、`cx` | 通用 UI 基元 |
| `lazyPage` | 把 `import()` 变成可按需加载的页面组件 |

约定：主题**不得**改动 SDK 之外的全局状态——否则主程序升级会破坏主题。
内置主题（如 `themes/light`）作为基底实现，允许直接 import `components/`、`lib/`、`store/`
等框架内部模块；新增的第三方风格主题请优先走 SDK。`components/` 下的通用积木
（`ui`、`icons`、`Avatar`、`ThreadList`、`PostCard`、`Composer` 等）由框架维护，主题只可复用。

---

## 4. 启用与生效

1. 后台「主题管理」点「启用」→ `PUT /api/admin/theme { id }` → 写 kv `theme`。
2. 前端首屏引导（[active.ts](../apps/web/src/lib/theme/active.ts)）读
   `window.__FI_THEME__`（Worker 在 SPA 壳中注入），缺失时回退 `GET /api/theme/active`，
   再加载对应主题的 `theme.css` 与模块，并与基底主题 `light` 合并；
   **加载失败一律回落 `light`**，不影响可用性。
3. 切换是**整页刷新**级别：后台点启用后刷新前台页面即可看到；`/api/theme/active`
   边缘缓存 30s，直链冷启动最多 30s 后跟上。

## 5. 简蓝主题（light）：基底主题

- 简蓝的实现全部在 `themes/light/`：`Layout.tsx`（整站外壳）+ `pages/`（17 个前台页面），
  `index.tsx` 把它们装配成 `layout` 与 `pages`。框架侧不再内置前台页面。
- 它同时是**基底主题**：其它主题未声明的 `layout`、未覆写的 `slots` / `pages`
  一律继承它（见 [active.ts](../apps/web/src/lib/theme/active.ts)）。
- 它的几十项外观配置仍由扩展侧承载（`ext:light:config`），表单在
  **插件中心 → 简蓝主题**（`/admin/extensions/light`）。
- 为避免重复呈现，简蓝在插件中心列表中隐藏（manifest `hiddenInCatalog: true`），
  详情与保存接口保留；主题管理卡片的「设置」按 `theme.json` 的 `configPath` 跳过去。
