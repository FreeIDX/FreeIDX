# FreeIDX

[English](../README.md) · [简体中文](README-cn.md) · **繁體中文** · [日本語](README-ja.md) · [한국어](README-ko.md) · [Français](README-fr.md) · [Deutsch](README-de.md) · [Español](README-es.md) · [Русский](README-ru.md) · [ไทย](README-th.md)

**基於 Cloudflare 全端打造的免費、開源現代論壇。**

`Cloudflare Workers` · `React 19` · `Tailwind CSS 4` · `Hono` · `TypeScript` · `D1` · `KV` · `R2` · `多語言` · `AGPL-3.0`

[功能亮點](#-功能亮點) · [架構設計](#️-架構設計) · [快速開始](#-快速開始) · [自訂網域](#-自訂網域設定) · [儲存庫結構](#-儲存庫結構)

***

一個基於 Cloudflare Workers + D1 + KV + R2 的論壇，支援文章、留言、附件上傳、會員體系、SEO 收錄、多語言等。

**💡 全站免費執行**：前後端合併為一個 Worker 專案部署，靜態資源走 Workers Assets，D1/KV/R2 全部使用免費層，零成本、零維運。

***

## 🏗️ 架構設計

### 單 Worker 合併部署方案

```
使用者存取：forum.example.com
         ↓
   Cloudflare Worker「freeidx-api」（Edge 網路）
         ↓
  ┌─ Worker 判斷路由
  │
  ├─ /assets/* ?
  │  └─ YES → Workers Assets 直接回傳靜態檔案（不消耗 Worker 請求）
  │
  ├─ /api/* / /files/* ?
  │  ├─ YES → Hono Worker 處理業務邏輯
  │  │         ├ JWT + Session 雙軌鑑權
  │  │         ├ 權限引擎（使用者群組 × 看板 × 板主）
  │  │         └ 回傳 JSON / 串流代理 R2 檔案
  │
  └─ 其他   → 爬蟲預渲染 HTML / SPA index.html，React Router 接管
```

### 技術堆疊

| 層    | 選型                                                                               |
| ---- | -------------------------------------------------------------------------------- |
| 前端   | React 19 + React Router 7 + Tailwind CSS 4 + TanStack Query + Zustand + Vite     |
| 後端   | Hono + TypeScript + Zod（Cloudflare Workers）                                      |
| 資料庫  | D1（SQLite），KV 做低頻寫快取，Cache API 做邊緣快取                                             |
| 儲存   | R2（附件/頭像，Worker 串流代理 `/files/:key`）                                              |
| 鑑權   | JWT（httpOnly Cookie）+ D1 session 表，PBKDF2-SHA256                                 |
| 人機驗證 | Cloudflare Turnstile                                                             |
| 排程任務 | Cron Triggers（每 5 分鐘檔 + 每小時對帳檔 + 每日凌晨檔）                                          |
| 套件管理 | pnpm workspace + Turborepo（monorepo：`apps/web` / `apps/api` / `packages/shared`） |

## ✨ 功能亮點

### 📝 論壇核心

- ✅ **文章管理** - 發布、編輯、刪除、置頂、關閉、移動看板、精華，游標分頁 + 無限捲動， TanStack Query 樂觀更新（發文數、瀏覽量即時回饋）
- ✅ **留言系統** - 回覆、引用、關鍵字高亮、已讀標記、多層回覆
- ✅ **附件上傳** - 圖片/檔案直傳 R2，Worker 串流代理 `/files/:key`，享受零對外流量費並規避儲存 B 類操作額度；內建 **TipTap 富文字編輯器**，支援程式碼插入、圖片貼上上傳
- ✅ **搜尋** - 看板內關鍵字檢索，高亮命中片段

### 👥 使用者與權限

- ✅ **使用者驗證** - 註冊、登入、登出、郵件驗證碼、找回密碼，JWT（httpOnly Cookie）+ Session 表雙軌鑑權，CSRF 全站防護
- ✅ **三層權限體系** - 使用者群組 × 看板 access × 板主規則引擎，精細到單一看板的讀寫與板務授權
- ✅ **使用者群組自動升級** - 發文數 + 主題數落入 credits 區間自動換組，無需人工干預
- ✅ **個人中心** - 頭像上傳、資料修改、密碼修改、我的主題/回覆、郵件通知偏好
- ✅ **板務操作** - 置頂/關閉/刪除/移動/刪除使用者，支援批次處理

### 💎 會員與商業化

- ✅ **會員體系** - 積分 + 等級 + VIP + 付費附件 + 訂單付款完整閉環
- ✅ **支付通道外掛化** - card / paypal / stripe / alipay 每通道一個獨立外掛，payment-core 只含契約 + 註冊表 + 訂單狀態機，後台逐個啟停、換金鑰零部署
- ✅ **廣告系統** - 自訂廣告版位 + Google AdSense，多版位彈性配置

### 🔌 擴充與工程化

- ✅ **外掛機制** - hook / overwrite 擴充點 + 前端元件插槽，後台熱插拔，不改核心程式碼即可增強功能
- ✅ **管理後台** - 網站設定、看板、主題、使用者、使用者群組、快取一站式管理
- ✅ **多語言** - 中文簡繁 / 英 / 日 / 韓 / 法 / 德 / 西 / 俄 / 泰 共 10 種語言，腳本化產生 + pre-commit 全鏈路驗證，杜絕硬編碼文案
- ✅ **排程任務** - Cron Triggers 三檔調度（每 5 分鐘 / 每小時對帳 / 每日凌晨），session 回收、日統計歸零、附件 GC、掉單對帳全自動

### 🔍 SEO / GEO 收錄

- ✅ **爬蟲預渲染** - 寫入期預先產生 SEO HTML 存 R2 + Cache API，僅爬蟲 UA 讀取，請求期渲染 CPU 結構性歸零
- ✅ **收錄全套方案** - sitemap、JSON-LD 結構化資料、llms.txt、AI 爬蟲策略、robots，`.htm` 偽靜態 URL 保持相容
- ✅ **邊緣快取** - Cache API 讀取屏障，熱門介面第二跳 `x-edge-cache: HIT`，大幅節省 D1 讀取額度

### 🔐 安全與免費層適配

- ✅ **密碼安全** - PBKDF2-SHA256（WebCrypto），迭代次數針對 Workers 10ms CPU 上限調校，相容舊雜湊懶升級
- ✅ **人機驗證** - 整合 Cloudflare Turnstile，登入/註冊/發文/回覆/找回密碼全掛載
- ✅ **郵件服務** - SMTP / Email Provider 帳號池，驗證郵件、找回密碼穩定送達
- ✅ **免費層深度適配** - 多層快取（Isolate 記憶體 LRU + KV + D1 cache 表 + Cache API）、`DB.batch()` 合併查詢、`waitUntil` 非同步合併計數，把 10 萬請求/天、500 萬行讀/10 萬行寫的額度用到極致

## 🚀 快速開始

## 方法 1：GitHub Actions 自動部署（推薦）

專案已內建 `.github/workflows/deploy.yml`，推送到 `main` 分支或手動觸發時自動建置並部署到 Cloudflare。D1 / KV 由管線**按名稱自動查找、缺了自動建立**，無需手動編輯任何儲存庫檔案。

#### 第一步：取得 Cloudflare API Token

1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 進入 **My Profile > API Tokens**，點選 **Create Token**

   ![](images/img-01.png)
3. 點選「檢視所有範本」，在範本卡片頁選擇 **Developer Services** 範本，其餘不用設定，點 **審核權杖** 就完成了。
4. 複製 Token（只會顯示一次）和 Account ID，一併複製保存起來。

#### 第二步：設定 GitHub Secrets

專案 fork 到你自己的儲存庫中，在你的 GitHub 儲存庫中：

1. 進入 **Settings > Secrets and variables > Actions**
2. 新增以下密鑰，對照下圖找入口：

   ① **Settings** → ② **Secrets and variables → Actions** → ③ **Secrets** 標籤頁 → ④ **New repository secret**。

   ![](images/img-02.png)

| Secret 名稱               | 值                        | 描述           | 是否必需 |
| ----------------------- | ------------------------ | ------------ | ---- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token     | 第一步建立的 Token | 必需   |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Cloudflare Account ID | 帳號首頁右側欄      | 必需   |

**Variables：**

| Variable 名稱         | 值                             | 描述                                                                                                      | 是否必需 |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- | ---- |
| `SITE_URL`          | 網站 URL                        | 例如：`https://forum.example.com`（還沒網域就**先不要建立這個變數**，綁網域後回來補；不要填「留空」二字）                                    | 非必需  |
| `TURNSTILE_SITEKEY` | Cloudflare Turnstile Site Key | [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile)；不建立則前端不渲染驗證元件。改值必須重新部署前端才生效 | 非必需  |

### 第三步：首次部署

在 GitHub 儲存庫的 **Actions** 頁面：

1. 選擇 **Deploy to Cloudflare** workflow
2. 點選 **Run workflow**，選擇 `main` 分支，並勾選：
   - `apply_migrations` —— 建立資料表（`apps/api/migrations/`）
   - `run_seed` —— 初始看板 + 首位管理員
3. 跑綠即上線，Worker `freeidx-api` 也是在這一步才被建立出來。**以後推 main 時這兩個勾選預設是關的**，不會動到資料庫。

#### 第四步：設定執行階段金鑰

首次部署跑綠後，Workers 清單裡才會出現 `freeidx-api`。點進去 → **Settings → Variables and secrets**，類型選 **Secret**，逐個新增（儲存後不可見，但不會被部署覆蓋，填一次長期有效）：

| 名稱                   | 用途                                      | 是否必需         |
| -------------------- | --------------------------------------- | ------------ |
| `JWT_SECRET`         | 登入權杖 / CSRF 簽章                          | 必需           |
| `TURNSTILE_SECRET`   | 人機驗證伺服器端驗證（需與 `TURNSTILE_SITEKEY` 成對設定） | 非必需          |
| `SECRETS_MASTER_KEY` | 外掛支付金鑰的 AES-GCM 主金鑰                     | 非必需          |

隨機值在本機產生一條貼一條：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 方法 2：本機開發

```bash
pnpm install

# 先建置前端，再啟動後端（wrangler dev 讀取同一份 [assets] 設定）
pnpm --filter @freeidx/web build
pnpm --filter @freeidx/api dev
```

- 本機跑 miniflare，不需要真實資源 ID
- 金鑰放 `apps/api/.dev.vars`
- 資料庫：`pnpm db:apply` 套用遷移，`pnpm db:seed` 灌入初始資料

## 方法 3：Cloudflare 後台視覺化建置

Workers & Pages → Create → **Continue with GitHub** 也能部署，但需要在 GitHub 網頁手動把 D1/KV 的真實 ID 和 `SITE_URL` 填入 `apps/api/wrangler.toml`（儲存庫裡是佔位值，不改必失敗），且專案名稱必須是 `freeidx-api`。與管線二選一。

## 🌐 自訂網域設定

1. Cloudflare 首頁 → **Add a domain**，把網域託管進來，到註冊商修改兩條 NS
2. Workers → `freeidx-api` → **Settings → Domains & Routes → Add → Custom domain**
3. 回到 GitHub Variables 把 `SITE_URL` 填成這個網域，隨便推一次提交讓它生效

不需要設定 Route，`/api/*`、`/files/*` 和頁面路徑都在同一個 Worker 裡。綁好自訂網域後邊緣快取自動生效，順手關掉 `*.workers.dev` 預覽網域，避免被搜尋引擎當成重複內容收錄。

**預設管理員帳號**（首次登入後請立即修改！）：

- 電子郵件: `admin@admin.com` / 密碼: `1`

## 📦 儲存庫結構

```
FreeIDX/
├── apps/
│   ├── web/               # 前端 React 19 SPA → Worker Static Assets
│   └── api/               # 後端 Hono Worker（含 migrations/）
├── packages/
│   └── shared/            # 前後端共享型別、錯誤碼、i18n 資源
├── scripts/               # i18n 產生與驗證腳本
├── docs/                  # 設計文件（開發架構 / 前後端頁面設計 / 部署手冊）
└── .github/workflows/     # CI / 部署管線
```

## 📄 授權條款

本專案基於 [GNU Affero 通用公共授權條款 v3.0（AGPL-3.0）](../LICENSE) 開源。

**重要提示：** 依據 AGPL-3.0 第 13 條，任何人修改本專案程式碼並對外透過網路提供服務（SaaS）時，**必須**向該服務的使用者公開修改後的完整原始碼。

## 🙋 支援

- 💬 歡迎提交 Issue 和 Pull Request
- 🌟 如果有幫助，請 Star 本專案！

