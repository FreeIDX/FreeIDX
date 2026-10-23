# FreeIDX

**English · [简体中文](docs/README-cn.md) · [繁體中文](docs/README-zh-tw.md) · [日本語](docs/README-ja.md) · [한국어](docs/README-ko.md) · [Français](docs/README-fr.md) · [Deutsch](docs/README-de.md) · [Español](docs/README-es.md) · [Русский](docs/README-ru.md) · [ไทย](docs/README-th.md)**

> ⚠️ **Legal Disclaimer**: This Project may only be used for lawful and compliant purposes such as study, research, and technical exchange. Before downloading, deploying, or using this Project, you must read the [Legal Disclaimer (LEGAL_DISCLAIMER.md)](docs/LEGAL_DISCLAIMER.md) in its entirety. Any user who violates the disclaimer shall bear all legal consequences arising therefrom.

**A free, open-source modern forum built entirely on Cloudflare.**

`Cloudflare Workers` · `React 19` · `Tailwind CSS 4` · `Hono` · `TypeScript` · `D1` · `KV` · `R2` · `i18n` · `AGPL-3.0`

[Features](#-features) · [Architecture](#️-architecture) · [Quick Start](#-quick-start) · [Custom Domain](#-custom-domain) · [Repository Structure](#-repository-structure)

***

A forum based on Cloudflare Workers + D1 + KV + R2, supporting posts, comments, attachment uploads, membership, SEO indexing, multi-language, and more.

**💡 Runs entirely free**: frontend and backend are deployed as a single Worker project, static assets are served via Workers Assets, and D1/KV/R2 all stay within the free tier — zero cost, zero ops.

***

## 🏗️ Architecture

### Single-Worker Combined Deployment

```
User visits: forum.example.com
         ↓
   Cloudflare Worker「freeidx-api」(Edge network)
         ↓
  ┌─ Worker route matching
  │
  ├─ /assets/* ?
  │  └─ YES → Workers Assets serves static files directly (no Worker request consumed)
  │
  ├─ /api/* / /files/* ?
  │  ├─ YES → Hono Worker handles business logic
  │  │         ├ JWT + Session dual-track authentication
  │  │         ├ Permission engine (user groups × sections × moderators)
  │  │         └ Returns JSON / streams R2 files via proxy
  │
  └─ Others → Crawler pre-rendered HTML / SPA index.html, handled by React Router
```

### Tech Stack

| Layer              | Choice                                                                             |
| ------------------ | ---------------------------------------------------------------------------------- |
| Frontend           | React 19 + React Router 7 + Tailwind CSS 4 + TanStack Query + Zustand + Vite       |
| Backend            | Hono + TypeScript + Zod (Cloudflare Workers)                                       |
| Database           | D1 (SQLite), KV for low-frequency write caching, Cache API for edge caching        |
| Storage            | R2 (attachments/avatars, streamed via Worker proxy `/files/:key`)                  |
| Auth               | JWT (httpOnly Cookie) + D1 session table, PBKDF2-SHA256                            |
| CAPTCHA            | Cloudflare Turnstile                                                               |
| Scheduled tasks    | Cron Triggers (5-minute tier + hourly reconciliation tier + daily tier)            |
| Package management | pnpm workspace + Turborepo (monorepo: `apps/web` / `apps/api` / `packages/shared`) |

## ✨ Features

### 📝 Forum Core

- ✅ **Post management** - Publish, edit, delete, pin, close, move between sections, feature; cursor-based pagination + infinite scrolling; TanStack Query optimistic updates (post count and view count reflected instantly)
- ✅ **Comment system** - Replies, quotes, keyword highlighting, read markers, multi-level replies
- ✅ **Attachment uploads** - Images/files uploaded directly to R2, streamed via Worker proxy `/files/:key`, enjoying zero egress fees while avoiding Storage Class B operation quotas; built-in **TipTap rich text editor** with code insertion and image paste-upload
- ✅ **Search** - Keyword search within sections, with highlighted matched fragments

### 👥 Users & Permissions

- ✅ **User authentication** - Registration, login, logout, email verification codes, password recovery; JWT (httpOnly Cookie) + session table dual-track authentication, site-wide CSRF protection
- ✅ **Three-tier permission system** - User groups × section access × moderator rule engine, with read/write and moderation authorization down to individual sections
- ✅ **Automatic user group upgrades** - Post count + topic count falling into a credits range triggers an automatic group change, no manual intervention needed
- ✅ **User center** - Avatar upload, profile editing, password change, my topics/replies, email notification preferences
- ✅ **Moderation actions** - Pin/close/delete/move/delete user, with batch processing support

### 💎 Membership & Monetization

- ✅ **Membership system** - Credits + levels + VIP + paid attachments + order payments, a complete closed loop
- ✅ **Pluggable payment channels** - card / paypal / stripe / alipay, one independent plugin per channel; payment-core contains only contracts + registry + order state machine; enable/disable each channel and rotate keys from the admin panel with zero deployment
- ✅ **Ad system** - Custom ad slots + Google AdSense, flexible configuration across multiple placements

### 🔌 Extensibility & Engineering

- ✅ **Plugin mechanism** - hook / overwrite extension points + frontend component slots, hot-swappable from the admin panel, extending functionality without touching core code
- ✅ **Admin panel** - Site settings, sections, topics, users, user groups, cache — all in one place
- ✅ **Multi-language** - Simplified/Traditional Chinese / English / Japanese / Korean / French / German / Spanish / Russian / Thai — 10 languages in total, script-generated + full-pipeline pre-commit validation, eliminating hardcoded copy
- ✅ **Scheduled tasks** - Cron Triggers three-tier scheduling (every 5 minutes / hourly reconciliation / daily), automating session recycling, daily stats reset, attachment GC, and orphaned order reconciliation

### 🔍 SEO / GEO Indexing

- ✅ **Crawler pre-rendering** - SEO HTML pre-generated at write time and stored in R2 + Cache API, served only to crawler user agents; request-time rendering CPU is structurally reduced to zero
- ✅ **Full indexing toolkit** - sitemap, JSON-LD structured data, llms.txt, AI crawler policies, robots; pseudo-static `.htm` URLs for backward compatibility
- ✅ **Edge caching** - Cache API read barrier; popular endpoints get `x-edge-cache: HIT` on the second hit, significantly saving D1 read quota

### 🔐 Security & Free-Tier Adaptation

- ✅ **Password security** - PBKDF2-SHA256 (WebCrypto), iteration count tuned for the Workers 10ms CPU limit, with lazy upgrade for legacy hash compatibility
- ✅ **CAPTCHA** - Cloudflare Turnstile integrated, mounted on login/registration/posting/replying/password recovery
- ✅ **Email service** - SMTP / Email Provider account pool for reliable delivery of verification emails and password recovery
- ✅ **Deep free-tier adaptation** - Multi-layer caching (in-Isolate LRU memory + KV + D1 cache table + Cache API), `DB.batch()` merged queries, `waitUntil` asynchronous merged counting — squeezing the most out of the 100k requests/day, 5M row reads / 100k row writes quota

## 🚀 Quick Start

## Method 1: GitHub Actions Automated Deployment (Recommended)

The project ships with `.github/workflows/deploy.yml`; pushing to the `main` branch or triggering manually will automatically build and deploy to Cloudflare. D1 / KV are **automatically looked up by name and created if missing** by the pipeline — no repository files need to be edited manually.

#### Step 1: Get a Cloudflare API Token

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Go to **My Profile > API Tokens**, click **Create Token**

   ![](docs/images/img-01.png)
3. Click "View all templates", select the **Developer Services** template on the template card page, leave everything else untouched, and click **Review Token** to finish.
4. Copy the Token (shown only once) and the Account ID from your account, and save both.

#### Step 2: Configure GitHub Secrets

Fork the project to your own repository. In your GitHub repository:

1. Go to **Settings > Secrets and variables > Actions**
2. Add the following secrets, using the image below to locate the entry:

   ① **Settings** → ② **Secrets and variables → Actions** → ③ **Secrets** tab → ④ **New repository secret**.

   ![](docs/images/img-02.png)

| Secret Name             | Value                      | Description                           | Required |
| ----------------------- | -------------------------- | ------------------------------------- | -------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token       | The Token created in Step 1           | Yes      |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID | Right sidebar of the account homepage | Yes      |

**Variables:**

| Variable Name       | Value                         | Description                                                                                                                                                                                                           | Required |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `SITE_URL`          | Site URL                      | e.g. `https://forum.example.com` (if you don't have a domain yet, **do not create this variable for now**; come back after binding the domain; do not enter the word "empty")                                         | No       |
| `TURNSTILE_SITEKEY` | Cloudflare Turnstile Site Key | [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile); the verification widget won't render on the frontend if not created. Changing the value requires redeploying the frontend to take effect | No       |

### Step 3: First Deployment

On the **Actions** page of your GitHub repository:

1. Select the **Deploy to Cloudflare** workflow
2. Click **Run workflow**, select the `main` branch, and check:
   - `apply_migrations` — create tables (`apps/api/migrations/`)
   - `run_seed` — initial sections + first admin
3. Once it runs green, you're live; the Worker `freeidx-api` is also only created at this step. **On subsequent pushes to main, these two checkboxes are off by default** and won't touch the database.

#### Step 4: Configure Runtime Secrets

After the first deployment runs green, `freeidx-api` will appear in the Workers list. Click into it → **Settings → Variables and secrets**, choose type **Secret**, and add them one by one (invisible once saved, but won't be overwritten by deployments; fill in once, valid long-term):

| Name                 | Purpose                                                                    | Required                                          |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| `JWT_SECRET`         | Login token / CSRF signing                                                 | Yes                                               |
| `TURNSTILE_SECRET`   | Server-side CAPTCHA verification (must be paired with `TURNSTILE_SITEKEY`) | No                                                |
| `SECRETS_MASTER_KEY` | AES-GCM master key for plugin payment secrets                              | No                                                |

Generate a random value locally and paste one at a time:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

#### Step 5: Stay Up to Date

Your fork ships with `.github/workflows/sync-upstream.yml`. Once Actions are enabled, it runs daily and requires **no extra secrets** beyond the two Cloudflare ones:

- Fast-forwards your `main` (and tags) to the upstream `FreeIDX/FreeIDX` `main` — upstream is fetched anonymously since it's public;
- Pushes the update and triggers the deploy workflow automatically, so your site follows upstream releases within a day;
- Turns **red** in the Actions tab if your `main` has diverged from upstream (e.g. you committed to it directly) — resolve the conflict once, or keep private customizations on a separate branch and leave `main` untouched.

Need an update right now? Go to **Actions → Sync Upstream → Run workflow**, or click **Sync fork** on your repository's code page. Either path deploys automatically.

> Note: GitHub disables scheduled workflows after 60 days without repository activity. If your fork stays quiet for a long stretch, run **Sync Upstream** manually once to re-arm the schedule. Private/customized forks should disable or delete this workflow and sync manually.

### Method 2: Local Development

```bash
pnpm install

# Build the frontend first, then start the backend (wrangler dev reads the same [assets] config)
pnpm --filter @freeidx/web build
pnpm --filter @freeidx/api dev
```

- Runs miniflare locally; no real resource IDs needed
- Put secrets in `apps/api/.dev.vars`
- Database: `pnpm db:apply` to apply migrations, `pnpm db:seed` to load initial data

## Method 3: Cloudflare Dashboard Visual Build

Workers & Pages → Create → **Continue with GitHub** also works, but requires manually filling the real D1/KV IDs and `SITE_URL` into `apps/api/wrangler.toml` on the GitHub web UI (the repository contains placeholder values; failure is guaranteed if unchanged), and the project name must be `freeidx-api`. Choose either this or the pipeline.

## 🌐 Custom Domain Configuration

1. Cloudflare homepage → **Add a domain**, host the domain there, and change the two NS records at your registrar
2. Workers → `freeidx-api` → **Settings → Domains & Routes → Add → Custom domain**
3. Go back to GitHub Variables and set `SITE_URL` to this domain; push any commit to make it take effect

No Route configuration needed — `/api/*`, `/files/*`, and page paths are all in the same Worker. Edge caching takes effect automatically once the custom domain is bound; also remember to disable the `*.workers.dev` preview domain to avoid search engines indexing it as duplicate content.

**Default admin account** (change it immediately after first login!):

- Email: `admin@admin.com` / Password: `1`

## 📦 Repository Structure

```
FreeIDX/
├── apps/
│   ├── web/               # Frontend React 19 SPA → Worker Static Assets
│   └── api/               # Backend Hono Worker (includes migrations/)
├── packages/
│   └── shared/            # Frontend/backend shared types, error codes, i18n resources
├── scripts/               # i18n generation and validation scripts
├── docs/                  # Design docs (dev architecture / frontend-backend page design / deployment manual)
└── .github/workflows/     # CI / deployment pipeline
```

## 📄 License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).

**Important:** If you modify this project and offer it as a network service (SaaS), you **must** make the complete modified source code available to users of that service, in accordance with Section 13 of the AGPL-3.0 license.

## 🙋 Support

- 💬 Issues and Pull Requests are welcome
- 🌟 If this helps you, please Star this project!

