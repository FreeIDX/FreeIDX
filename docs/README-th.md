# FreeIDX

[English](../README.md) · [简体中文](README-cn.md) · [繁體中文](README-zh-tw.md) · [日本語](README-ja.md) · [한국어](README-ko.md) · [Français](README-fr.md) · [Deutsch](README-de.md) · [Español](README-es.md) · [Русский](README-ru.md) · **ไทย**

**ฟอรัมโอเพนซอร์สสมัยใหม่ที่สร้างขึ้นบน Cloudflare ทั้งหมดโดยใช้งานฟรี**

`Cloudflare Workers` · `React 19` · `Tailwind CSS 4` · `Hono` · `TypeScript` · `D1` · `KV` · `R2` · `i18n` · `AGPL-3.0`

[ฟีเจอร์](#-ฟีเจอร์) · [สถาปัตยกรรม](#️-สถาปัตยกรรม) · [เริ่มต้นอย่างรวดเร็ว](#-เริ่มต้นอย่างรวดเร็ว) · [Custom Domain](#-การกำหนดค่า-custom-domain) · [โครงสร้าง Repository](#-โครงสร้าง-repository)

***

ฟอรัมที่สร้างบนพื้นฐานของ Cloudflare Workers + D1 + KV + R2 รองรับทั้งการโพสต์ ความคิดเห็น การอัปโหลดไฟล์แนบ ระบบสมาชิก การจัดทำดัชนี SEO รองรับหลายภาษา และอื่น ๆ อีกมากมาย

**💡 ใช้งานได้ฟรีทั้งหมด**: ฝั่ง frontend และ backend ถูก deploy เป็นโปรเจกต์ Worker เดียว ไฟล์ static ให้บริการผ่าน Workers Assets ส่วน D1/KV/R2 ทั้งหมดอยู่ภายในขอบเขต free tier — ไม่มีค่าใช้จ่าย ไม่ต้องดูแลระบบ

***

## 🏗️ สถาปัตยกรรม

### การ deploy แบบรวมด้วย Worker เดียว

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

### เทคโนโลยีที่ใช้

| เลเยอร์             | ทางเลือก                                                                           |
| ------------------ | ---------------------------------------------------------------------------------- |
| Frontend           | React 19 + React Router 7 + Tailwind CSS 4 + TanStack Query + Zustand + Vite       |
| Backend            | Hono + TypeScript + Zod (Cloudflare Workers)                                       |
| ฐานข้อมูล           | D1 (SQLite), KV สำหรับแคชการเขียนความถี่ต่ำ, Cache API สำหรับแคชที่ edge            |
| พื้นที่จัดเก็บข้อมูล | R2 (ไฟล์แนบ/รูปประจำตัว สตรีมผ่าน Worker proxy `/files/:key`)                       |
| การยืนยันตัวตน      | JWT (httpOnly Cookie) + ตาราง session ใน D1, PBKDF2-SHA256                         |
| CAPTCHA            | Cloudflare Turnstile                                                               |
| งานตามกำหนดเวลา     | Cron Triggers (ทุก 5 นาที + ชั้นกระทบยอดรายชั่วโมง + ชั้นรายวัน)                     |
| การจัดการแพ็กเกจ    | pnpm workspace + Turborepo (monorepo: `apps/web` / `apps/api` / `packages/shared`) |

## ✨ ฟีเจอร์

### 📝 ฟังก์ชันหลักของฟอรัม

- ✅ **การจัดการโพสต์** - เผยแพร่ แก้ไข ลบ ปักหมุด ปิด ย้ายระหว่างหมวด ตั้งเป็นโพสต์แนะนำ; แบ่งหน้าแบบ cursor + infinite scrolling; อัปเดตแบบ optimistic ด้วย TanStack Query (จำนวนโพสต์และจำนวนเข้าชมอัปเดตทันที)
- ✅ **ระบบความคิดเห็น** - การตอบกลับ การอ้างอิงข้อความ ไฮไลต์คีย์เวิร์ด ทำเครื่องหมายว่าอ่านแล้ว และการตอบกลับหลายระดับ
- ✅ **การอัปโหลดไฟล์แนบ** - รูปภาพ/ไฟล์อัปโหลดตรงเข้า R2 แล้วสตรีมผ่าน Worker proxy `/files/:key` ไม่มีค่า egress พร้อมเลี่ยงโควตาการทำงานของ Storage Class B; มี **TipTap rich text editor** ในตัว รองรับการแทรกโค้ดและการวางรูปภาพจากคลิปบอร์ด
- ✅ **การค้นหา** - ค้นหาด้วยคีย์เวิร์ดภายในหมวด พร้อมไฮไลต์ส่วนที่ตรงกัน

### 👥 ผู้ใช้และสิทธิ์การเข้าถึง

- ✅ **การยืนยันตัวตนผู้ใช้** - สมัครสมาชิก เข้าสู่ระบบ ออกจากระบบ รหัสยืนยันทางอีเมล กู้คืนรหัสผ่าน; ยืนยันตัวตนแบบสองทางด้วย JWT (httpOnly Cookie) + ตาราง session พร้อมการป้องกัน CSRF ทั่วทั้งไซต์
- ✅ **ระบบสิทธิ์แบบสามชั้น** - กลุ่มผู้ใช้ × สิทธิ์การเข้าถึงหมวด × rule engine ของผู้ดูแล กำหนดสิทธิ์อ่าน/เขียนและอำนาจการกลั่นกรองได้ละเอียดถึงระดับหมวดย่อย
- ✅ **เลื่อนกลุ่มผู้ใช้อัตโนมัติ** - เมื่อจำนวนโพสต์ + จำนวนกระทู้เข้าอยู่ในช่วง credits ที่กำหนด ระบบจะเปลี่ยนกลุ่มให้อัตโนมัติ โดยไม่ต้องดำเนินการด้วยตนเอง
- ✅ **ศูนย์ผู้ใช้** - อัปโหลดรูปประจำตัว แก้ไขโปรไฟล์ เปลี่ยนรหัสผ่าน กระทู้/การตอบกลับของฉัน และการตั้งค่าการแจ้งเตือนทางอีเมล
- ✅ **การดำเนินการกลั่นกรอง** - ปักหมุด/ปิด/ลบ/ย้าย/ลบผู้ใช้ รองรับการทำงานเป็นชุด

### 💎 สมาชิกและการสร้างรายได้

- ✅ **ระบบสมาชิก** - credits + ระดับ + VIP + ไฟล์แนบแบบเสียเงิน + การชำระเงินตามคำสั่งซื้อ ครบวงจร
- ✅ **ช่องทางชำระเงินแบบปลั๊กอิน** - card / paypal / stripe / alipay แต่ละช่องทางเป็นปลั๊กอินอิสระ; payment-core มีเพียง contracts + registry + order state machine; เปิด/ปิดแต่ละช่องทางและหมุนเวียนคีย์ได้จากหน้าผู้ดูแลระบบโดยไม่ต้อง deploy ใหม่
- ✅ **ระบบโฆษณา** - ตำแหน่งโฆษณาแบบกำหนดเอง + Google AdSense ตั้งค่าได้ยืดหยุ่นหลายตำแหน่ง

### 🔌 ความสามารถในการต่อยอดและงานวิศวกรรม

- ✅ **กลไกปลั๊กอิน** - จุดต่อขยายแบบ hook / overwrite + component slot ฝั่ง frontend ถอดเปลี่ยนได้แบบ hot-swap จากหน้าผู้ดูแลระบบ ต่อยอดฟังก์ชันได้โดยไม่ต้องแก้โค้ดหลัก
- ✅ **หน้าผู้ดูแลระบบ** - ตั้งค่าไซต์ หมวด กระทู้ ผู้ใช้ กลุ่มผู้ใช้ แคช — จัดการได้ครบในที่เดียว
- ✅ **รองรับหลายภาษา** - จีนตัวย่อ/จีนตัวเต็ม / อังกฤษ / ญี่ปุ่น / เกาหลี / ฝรั่งเศส / เยอรมัน / สเปน / รัสเซีย / ไทย — รวม 10 ภาษา สร้างด้วยสคริปต์ + ตรวจสอบครบทั้ง pipeline ก่อน commit ขจัดปัญหาข้อความ hardcode
- ✅ **งานตามกำหนดเวลา** - Cron Triggers จัดตาราง 3 ชั้น (ทุก 5 นาที / กระทบยอดรายชั่วโมง / รายวัน) ทำงานอัตโนมัติทั้งการเก็บกู้ session, รีเซ็ตสถิติรายวัน, GC ไฟล์แนบ และการกระทบยอดคำสั่งซื้อค้าง

### 🔍 การจัดทำดัชนี SEO / GEO

- ✅ **Pre-render สำหรับ crawler** - สร้าง HTML สำหรับ SEO ล่วงหน้าตอนเขียนข้อมูลแล้วเก็บไว้ใน R2 + Cache API ให้บริการเฉพาะ user agent ของ crawler ทำให้ CPU ที่ใช้ render ตอนรับ request ลดลงเป็นศูนย์อย่างเป็นโครงสร้าง
- ✅ **ชุดเครื่องมือจัดทำดัชนีครบวงจร** - sitemap, JSON-LD structured data, llms.txt, นโยบาย AI crawler, robots; URL `.htm` แบบ pseudo-static เพื่อความเข้ากันได้กับระบบเดิม
- ✅ **การแคชที่ edge** - read barrier ด้วย Cache API; endpoint ยอดนิยมจะได้ `x-edge-cache: HIT` ตั้งแต่ครั้งที่สอง ประหยัดโควตาอ่าน D1 ได้อย่างมีนัยสำคัญ

### 🔐 ความปลอดภัยและการปรับให้เข้ากับ free tier

- ✅ **ความปลอดภัยของรหัสผ่าน** - PBKDF2-SHA256 (WebCrypto) ปรับจำนวนรอบ iteration ให้เหมาะกับขีดจำกัด CPU 10ms ของ Workers พร้อม lazy upgrade เพื่อรองรับ hash รุ่นเก่า
- ✅ **CAPTCHA** - เชื่อมต่อ Cloudflare Turnstile ติดตั้งบนขั้นตอนเข้าสู่ระบบ/สมัครสมาชิก/โพสต์/ตอบกลับ/กู้คืนรหัสผ่าน
- ✅ **บริการอีเมล** - pool บัญชี SMTP / Email Provider เพื่อส่งอีเมลยืนยันและกู้คืนรหัสผ่านได้อย่างน่าเชื่อถือ
- ✅ **ปรับแต่งเจาะลึกสำหรับ free tier** - การแคชหลายชั้น (LRU memory ใน Isolate + KV + ตารางแคชใน D1 + Cache API), รวมคิวรีด้วย `DB.batch()`, นับแบบรวม asynchronously ด้วย `waitUntil` — คุ้มค่าสูงสุดกับโควตา 100k requests/day, 5M row reads / 100k row writes

## 🚀 เริ่มต้นอย่างรวดเร็ว

## วิธีที่ 1: การ deploy อัตโนมัติด้วย GitHub Actions (แนะนำ)

โปรเจกต์มาพร้อม `.github/workflows/deploy.yml`; การ push ไปที่ branch `main` หรือการสั่งรันเอง จะ build และ deploy ขึ้น Cloudflare ให้โดยอัตโนมัติ โดย pipeline จะ**ค้นหา D1 / KV ตามชื่อให้อัตโนมัติและสร้างขึ้นใหม่หากยังไม่มี** — ไม่ต้องแก้ไขไฟล์ใดใน repository ด้วยตนเอง

#### ขั้นตอนที่ 1: ขอรับ Cloudflare API Token

1. เข้าสู่ระบบ [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. ไปที่ **My Profile > API Tokens** แล้วคลิก **Create Token**

   ![](images/img-01.png)
3. คลิก "View all templates" เลือกเทมเพลต **Developer Services** ในหน้าการ์ดเทมเพลต ส่วนอื่น ๆ ไม่ต้องแก้ไข แล้วคลิก **Review Token** เป็นอันเสร็จสิ้น
4. คัดลอก Token (แสดงเพียงครั้งเดียว) และ Account ID จากบัญชีของคุณ แล้วเก็บทั้งสองอย่างไว้ให้ดี

#### ขั้นตอนที่ 2: ตั้งค่า GitHub Secrets

Fork โปรเจกต์ไปยัง repository ของคุณเอง จากนั้นใน GitHub repository ของคุณ:

1. ไปที่ **Settings > Secrets and variables > Actions**
2. เพิ่ม secrets ต่อไปนี้ โดยใช้รูปภาพด้านล่างช่วยระบุตำแหน่งที่ตั้งค่า:

   ① **Settings** → ② **Secrets and variables → Actions** → ③ แท็บ **Secrets** → ④ **New repository secret**.

   ![](images/img-02.png)

| ชื่อ Secret             | Value                      | คำอธิบาย                              | จำเป็น   |
| ----------------------- | -------------------------- | ------------------------------------- | -------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token       | Token ที่สร้างในขั้นตอนที่ 1          | ใช่      |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID ของคุณ | แถบด้านขวาของหน้าแรกบัญชี            | ใช่      |

**ตัวแปร:**

| ชื่อตัวแปร          | ค่า                           | คำอธิบาย                                                                                                                                                                                                              | จำเป็น   |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `SITE_URL`          | URL ของไซต์                   | เช่น `https://forum.example.com` (หากยังไม่มีโดเมน **อย่าสร้างตัวแปรนี้ก่อน** รอผูกโดเมนแล้วจึงกลับมาตั้งค่า และอย่าพิมพ์คำว่า "empty")                                                                               | ไม่      |
| `TURNSTILE_SITEKEY` | Cloudflare Turnstile Site Key | [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile); หากไม่สร้าง widget ยืนยันตัวตนจะไม่แสดงบน frontend การเปลี่ยนค่านี้ต้อง deploy frontend ใหม่จึงจะมีผล                                   | ไม่      |

### ขั้นตอนที่ 3: การ deploy ครั้งแรก

ในหน้า **Actions** ของ GitHub repository ของคุณ:

1. เลือก workflow **Deploy to Cloudflare**
2. คลิก **Run workflow** เลือก branch `main` แล้วติ๊ก `run_seed` — สร้างหมวดเริ่มต้น + ผู้ดูแลระบบคนแรก (ตารางจะถูกสร้างจาก `apps/api/migrations/` โดยอัตโนมัติ ไม่ต้องติ๊ก)
3. เมื่อรันผ่านเป็นสีเขียวก็ใช้งานได้แล้ว ทั้งนี้ Worker `freeidx-api` จะถูกสร้างขึ้นเฉพาะในขั้นตอนนี้เท่านั้น **ในการ push ไป main ครั้งถัด ๆ ไป `run_seed` จะปิดอยู่โดยค่าเริ่มต้น** ส่วน migration จะถูกนำไปใช้โดยอัตโนมัติและไม่แตะต้องข้อมูลเดิม

#### ขั้นตอนที่ 4: ตั้งค่า Runtime Secrets

หลังจากการ deploy ครั้งแรกรันผ่านเป็นสีเขียว `freeidx-api` จะปรากฏในรายการ Workers คลิกเข้าไป → **Settings → Variables and secrets** เลือกประเภทเป็น **Secret** แล้วเพิ่มทีละรายการ (เมื่อบันทึกแล้วจะมองไม่เห็นค่า แต่จะไม่ถูก deploy ทับ; กรอกครั้งเดียวใช้ได้ระยะยาว):

| ชื่อ                 | วัตถุประสงค์                                                                | จำเป็น                                            |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| `JWT_SECRET`         | เซ็น login token / CSRF                                                    | ใช่                                               |
| `TURNSTILE_SECRET`   | ตรวจสอบ CAPTCHA ฝั่งเซิร์ฟเวอร์ (ต้องใช้คู่กับ `TURNSTILE_SITEKEY`)         | ไม่                                               |
| `SECRETS_MASTER_KEY` | คีย์หลัก AES-GCM สำหรับความลับการชำระเงินของปลั๊กอิน                        | ไม่                                               |

สร้างค่าแบบสุ่มในเครื่องแล้วคัดลอกไปวางทีละค่า:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### วิธีที่ 2: การพัฒนาแบบ local

```bash
pnpm install

# Build the frontend first, then start the backend (wrangler dev reads the same [assets] config)
pnpm --filter @freeidx/web build
pnpm --filter @freeidx/api dev
```

- รันด้วย miniflare บนเครื่อง ไม่ต้องใช้ resource ID จริง
- ใส่ secrets ไว้ใน `apps/api/.dev.vars`
- ฐานข้อมูล: `pnpm db:apply` เพื่อ apply migrations, `pnpm db:seed` เพื่อโหลดข้อมูลเริ่มต้น

## วิธีที่ 3: สร้างผ่านหน้าเว็บ Cloudflare Dashboard

Workers & Pages → Create → **Continue with GitHub** ก็สร้างได้เช่นกัน แต่ต้องกรอก D1/KV ID จริงและ `SITE_URL` ลงใน `apps/api/wrangler.toml` ผ่านหน้าเว็บ GitHub ด้วยตนเอง (ค่าใน repository เป็นเพียง placeholder หากไม่เปลี่ยนจะล้มเหลวแน่นอน) และชื่อโปรเจกต์ต้องเป็น `freeidx-api` เลือกอย่างใดอย่างหนึ่งระหว่างวิธีนี้กับ pipeline

## 🌐 การกำหนดค่า Custom Domain

1. หน้าแรกของ Cloudflare → **Add a domain** นำโดเมนมา host ที่นั่น แล้วเปลี่ยน NS record ทั้งสองรายการที่ผู้ให้บริการจดทะเบียนโดเมน
2. Workers → `freeidx-api` → **Settings → Domains & Routes → Add → Custom domain**
3. กลับไปที่ GitHub Variables แล้วตั้ง `SITE_URL` เป็นโดเมนนี้ จากนั้น push commit ใดก็ได้เพื่อให้มีผล

ไม่ต้องตั้งค่า Route — `/api/*`, `/files/*` และพาธของหน้าต่าง ๆ อยู่ใน Worker เดียวกันทั้งหมด การแคชที่ edge จะมีผลอัตโนมัติเมื่อผูก custom domain แล้ว และอย่าลืมปิด preview domain `*.workers.dev` เพื่อกันเครื่องมือค้นหาจัดทำดัชนีเป็นเนื้อหาซ้ำ

**บัญชีผู้ดูแลระบบเริ่มต้น** (เปลี่ยนทันทีหลังเข้าสู่ระบบครั้งแรก!):

- อีเมล: `admin@admin.com` / รหัสผ่าน: `1`

## 📦 โครงสร้าง Repository

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

## 📄 สัญญาอนุญาต

โปรเจกต์นี้เผยแพร่ภายใต้สัญญาอนุญาต [GNU Affero General Public License v3.0 (AGPL-3.0)](../LICENSE)

**ข้อควรทราบ:** ตามมาตรา 13 ของ AGPL-3.0 ผู้ใดก็ตามที่แก้ไขโค้ดของโปรเจกต์นี้และให้บริการผ่านเครือข่าย (SaaS) **ต้อง** เปิดเผยซอร์สโค้ดฉบับสมบูรณ์ที่แก้ไขแล้วแก่ผู้ใช้บริการนั้น

## 🙋 การสนับสนุน

- 💬 ยินดีรับ Issues และ Pull Requests
- 🌟 หากโปรเจกต์นี้เป็นประโยชน์ต่อคุณ กรุณากด Star ให้ด้วย!

