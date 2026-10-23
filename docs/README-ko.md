# FreeIDX

[English](../README.md) · [简体中文](README-cn.md) · [繁體中文](README-zh-tw.md) · [日本語](README-ja.md) · **한국어** · [Français](README-fr.md) · [Deutsch](README-de.md) · [Español](README-es.md) · [Русский](README-ru.md) · [ไทย](README-th.md)

**Cloudflare만으로 구축된 무료 오픈소스 모던 포럼입니다.**

`Cloudflare Workers` · `React 19` · `Tailwind CSS 4` · `Hono` · `TypeScript` · `D1` · `KV` · `R2` · `i18n` · `AGPL-3.0`

[주요 기능](#-주요-기능) · [아키텍처](#️-아키텍처) · [빠른 시작](#-빠른-시작) · [커스텀 도메인](#-커스텀-도메인-설정) · [저장소 구조](#-저장소-구조)

***

Cloudflare Workers + D1 + KV + R2 기반의 포럼으로, 게시글, 댓글, 첨부파일 업로드, 멤버십, SEO 색인, 다국어 등을 지원합니다.

**💡 완전 무료 운영**: 프런트엔드와 백엔드를 하나의 Worker 프로젝트로 배포하고, 정적 자산은 Workers Assets으로 서빙하며, D1/KV/R2는 모두 무료 티어 안에서 사용합니다 — 비용 제로, 운영 부담 제로.

***

## 🏗️ 아키텍처

### 단일 Worker 통합 배포

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

### 기술 스택

| 레이어    | 구성                                                                                 |
| ------ | ---------------------------------------------------------------------------------- |
| 프런트엔드  | React 19 + React Router 7 + Tailwind CSS 4 + TanStack Query + Zustand + Vite       |
| 백엔드    | Hono + TypeScript + Zod (Cloudflare Workers)                                       |
| 데이터베이스 | D1 (SQLite), 저빈도 쓰기 캐시용 KV, 엣지 캐시용 Cache API                                       |
| 스토리지   | R2 (첨부파일/아바타, Worker 프록시 `/files/:key`로 스트리밍)                                      |
| 인증     | JWT (httpOnly Cookie) + D1 세션 테이블, PBKDF2-SHA256                                   |
| 캡차     | Cloudflare Turnstile                                                               |
| 예약 작업  | Cron Triggers (5분 주기 + 매시간 정산 주기 + 일별 주기)                                          |
| 패키지 관리 | pnpm workspace + Turborepo (monorepo: `apps/web` / `apps/api` / `packages/shared`) |

## ✨ 주요 기능

### 📝 포럼 핵심

- ✅ **게시글 관리** - 발행, 수정, 삭제, 고정, 닫기, 섹션 이동, 추천 지정; 커서 기반 페이지네이션 + 무한 스크롤; TanStack Query 낙관적 업데이트 (게시글 수와 조회수가 즉시 반영)
- ✅ **댓글 시스템** - 답글, 인용, 키워드 하이라이트, 읽음 표시, 다단계 답글
- ✅ **첨부파일 업로드** - 이미지/파일을 R2에 직접 업로드하고 Worker 프록시 `/files/:key`로 스트리밍하여, Storage Class B 작업 할당량을 피하면서 제로 이그레스 요금의 혜택을 누림; 코드 삽입과 이미지 붙여넣기 업로드를 지원하는 **TipTap 리치 텍스트 에디터** 내장
- ✅ **검색** - 섹션 내 키워드 검색, 일치 단편 하이라이트 표시

### 👥 사용자 및 권한

- ✅ **사용자 인증** - 회원가입, 로그인, 로그아웃, 이메일 인증 코드, 비밀번호 찾기; JWT (httpOnly Cookie) + 세션 테이블 이중 트랙 인증, 사이트 전체 CSRF 보호
- ✅ **3계층 권한 시스템** - 사용자 그룹 × 섹션 접근 × 모더레이터 규칙 엔진, 읽기/쓰기 및 관리 권한을 개별 섹션 단위까지 부여
- ✅ **사용자 그룹 자동 승급** - 게시글 수 + 토픽 수가 크레딧 구간에 해당하면 그룹이 자동으로 변경되며, 수동 개입 불필요
- ✅ **사용자 센터** - 아바타 업로드, 프로필 편집, 비밀번호 변경, 내 토픽/답글, 이메일 알림 환경설정
- ✅ **관리 작업** - 고정/닫기/삭제/이동/사용자 삭제, 일괄 처리 지원

### 💎 멤버십 및 수익화

- ✅ **멤버십 시스템** - 크레딧 + 레벨 + VIP + 유료 첨부파일 + 주문 결제로 이어지는 완결된 사이클
- ✅ **플러그형 결제 채널** - card / paypal / stripe / alipay, 채널별 독립 플러그인; payment-core에는 컨트랙트 + 레지스트리 + 주문 상태 머신만 포함; 관리자 패널에서 채널 활성화/비활성화 및 키 교체 가능, 배포 불필요
- ✅ **광고 시스템** - 커스텀 광고 슬롯 + Google AdSense, 여러 노출 위치에 유연하게 구성

### 🔌 확장성 및 엔지니어링

- ✅ **플러그인 메커니즘** - hook / overwrite 확장 포인트 + 프런트엔드 컴포넌트 슬롯, 관리자 패널에서 핫스왑 가능, 핵심 코드를 건드리지 않고 기능 확장
- ✅ **관리자 패널** - 사이트 설정, 섹션, 토픽, 사용자, 사용자 그룹, 캐시까지 모두 한곳에서
- ✅ **다국어** - 간체/번체 중국어 / 영어 / 일본어 / 한국어 / 프랑스어 / 독일어 / 스페인어 / 러시아어 / 태국어 — 총 10개 언어, 스크립트 자동 생성 + 전 파이프라인 pre-commit 검증으로 하드코딩된 문구 제거
- ✅ **예약 작업** - Cron Triggers 3계층 스케줄링 (매 5분 / 매시간 정산 / 매일), 세션 회수, 일별 통계 리셋, 첨부파일 GC, 고아 주문 정산을 자동화

### 🔍 SEO / GEO 색인

- ✅ **크롤러 사전 렌더링** - SEO HTML을 쓰기 시점에 미리 생성해 R2 + Cache API에 저장하고, 크롤러 User-Agent에만 제공; 요청 시점 렌더링 CPU를 구조적으로 0으로 만듦
- ✅ **완비된 색인 도구 모음** - sitemap, JSON-LD 구조화 데이터, llms.txt, AI 크롤러 정책, robots; 하위 호환을 위한 의사 정적 `.htm` URL
- ✅ **엣지 캐싱** - Cache API 읽기 배리어; 인기 엔드포인트는 두 번째 요청부터 `x-edge-cache: HIT`, D1 읽기 할당량 크게 절약

### 🔐 보안 및 무료 티어 최적화

- ✅ **비밀번호 보안** - PBKDF2-SHA256 (WebCrypto), Workers 10ms CPU 제한에 맞춘 반복 횟수, 기존 해시 호환을 위한 레이지 업그레이드
- ✅ **캡차** - Cloudflare Turnstile 통합, 로그인/회원가입/글쓰기/답글 작성/비밀번호 찾기에 적용
- ✅ **이메일 서비스** - SMTP / 이메일 제공업체 계정 풀로 인증 메일과 비밀번호 찾기 메일을 안정적으로 발송
- ✅ **무료 티어 심층 대응** - 다층 캐싱 (Isolate 내 LRU 메모리 + KV + D1 캐시 테이블 + Cache API), `DB.batch()` 병합 쿼리, `waitUntil` 비동기 병합 카운팅 — 일 10만 요청, 500만 행 읽기 / 10만 행 쓰기 할당량을 최대한 활용

## 🚀 빠른 시작

## 방법 1: GitHub Actions 자동 배포 (권장)

프로젝트에는 `.github/workflows/deploy.yml`이 포함되어 있으며, `main` 브랜치에 푸시하거나 수동으로 실행하면 자동으로 빌드되어 Cloudflare에 배포됩니다. D1 / KV는 파이프라인이 **이름으로 자동 조회하고 없으면 생성**합니다 — 저장소 파일을 직접 수정할 필요가 없습니다.

#### 1단계: Cloudflare API Token 발급

1. [Cloudflare Dashboard](https://dash.cloudflare.com/)에 로그인합니다
2. **My Profile > API Tokens**로 이동한 뒤 **Create Token**을 클릭합니다

   ![](images/img-01.png)
3. "View all templates"를 클릭하고, 템플릿 카드 페이지에서 **Developer Services** 템플릿을 선택한 뒤 나머지 항목은 모두 그대로 두고 **Review Token**을 클릭하면 완료됩니다.
4. Token은 한 번만 표시되므로 복사해 두고, 계정의 Account ID와 함께 저장합니다.

#### 2단계: GitHub Secrets 설정

프로젝트를 자신의 저장소로 Fork합니다. GitHub 저장소에서:

1. **Settings > Secrets and variables > Actions**로 이동합니다
2. 아래 이미지를 참고해 해당 항목을 찾아 다음 시크릿을 추가합니다:

   ① **Settings** → ② **Secrets and variables → Actions** → ③ **Secrets** 탭 → ④ **New repository secret**.

   ![](images/img-02.png)

| 시크릿 이름                  | 값                         | 설명               | 필수 |
| ----------------------- | ------------------------- | ---------------- | -- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token      | 1단계에서 만든 Token   | 예  |
| `CLOUDFLARE_ACCOUNT_ID` | 본인의 Cloudflare Account ID | 계정 홈페이지 오른쪽 사이드바 | 예  |

**변수:**

| 변수 이름               | 값                             | 설명                                                                                                                                          | 필수  |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `SITE_URL`          | 사이트 URL                       | 예: `https://forum.example.com` (아직 도메인이 없다면 **당분간 이 변수를 만들지 마세요**; 도메인 연결 후 다시 돌아와 설정하세요. "empty"라는 단어를 입력하지 마세요)                           | 아니요 |
| `TURNSTILE_SITEKEY` | Cloudflare Turnstile Site Key | [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile); 생성하지 않으면 프런트엔드에서 검증 위젯이 렌더링되지 않습니다. 값을 변경하면 프런트엔드를 재배포해야 적용됩니다 | 아니요 |

### 3단계: 첫 배포

GitHub 저장소의 **Actions** 페이지에서:

1. **Deploy to Cloudflare** 워크플로우를 선택합니다
2. **Run workflow**를 클릭하고 `main` 브랜치를 선택한 뒤 `run_seed`를 체크합니다 — 초기 섹션 + 최초 관리자 (테이블은 `apps/api/migrations/`에서 자동 생성되며 체크가 필요 없습니다).
3. 초록불이 뜨면 배포 완료입니다; Worker `freeidx-api`도 이 단계에서 비로소 생성됩니다. **이후 `main`에 푸시할 때는 `run_seed`가 기본적으로 꺼져 있으며**, 마이그레이션은 자동 적용되어 기존 데이터를 건드리지 않습니다.

#### 4단계: 런타임 Secrets 설정

첫 배포가 초록불로 완료되면 Workers 목록에 `freeidx-api`가 표시됩니다. 클릭해 들어간 뒤 **Settings → Variables and secrets**에서 유형을 **Secret**으로 선택해 하나씩 추가합니다 (저장 후에는 값이 보이지 않지만 배포로 덮어써지지 않으며, 한 번만 입력하면 계속 유효합니다):

| 이름                   | 용도                                           | 필수                 |
| -------------------- | -------------------------------------------- | ------------------ |
| `JWT_SECRET`         | 로그인 토큰 / CSRF 서명                             | 예                  |
| `TURNSTILE_SECRET`   | 서버 측 캡차 검증 (`TURNSTILE_SITEKEY`와 반드시 짝으로 설정) | 아니요                |
| `SECRETS_MASTER_KEY` | 플러그인 결제 시크릿용 AES-GCM 마스터 키                   | 아니요                |

로컬에서 무작위 값을 생성해 하나씩 붙여넣습니다:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 방법 2: 로컬 개발

```bash
pnpm install

# Build the frontend first, then start the backend (wrangler dev reads the same [assets] config)
pnpm --filter @freeidx/web build
pnpm --filter @freeidx/api dev
```

- 로컬에서 miniflare로 실행; 실제 리소스 ID 불필요
- 시크릿은 `apps/api/.dev.vars`에 넣습니다
- 데이터베이스: `pnpm db:apply`로 마이그레이션 적용, `pnpm db:seed`로 초기 데이터 적재

## 방법 3: Cloudflare Dashboard에서 직접 구축

Workers & Pages → Create → **Continue with GitHub**으로도 배포할 수 있지만, GitHub 웹 UI에서 실제 D1/KV ID와 `SITE_URL`을 `apps/api/wrangler.toml`에 직접 채워 넣어야 하고 (저장소에는 플레이스홀더 값이 들어 있으므로 수정하지 않으면 반드시 실패), 프로젝트 이름은 반드시 `freeidx-api`여야 합니다. 이 방법 또는 파이프라인 중 하나를 선택하세요.

## 🌐 커스텀 도메인 설정

1. Cloudflare 홈페이지 → **Add a domain**에서 도메인을 Cloudflare에 위탁하고, 도메인 등록 기관에서 두 개의 NS 레코드를 변경합니다
2. Workers → `freeidx-api` → **Settings → Domains & Routes → Add → Custom domain**
3. GitHub Variables로 돌아가 `SITE_URL`을 이 도메인으로 설정한 뒤, 아무 커밋이든 푸시하면 적용됩니다

Route 설정은 필요 없습니다 — `/api/*`, `/files/*`, 페이지 경로가 모두 하나의 Worker 안에 있습니다. 커스텀 도메인을 연결하면 엣지 캐싱이 자동으로 활성화됩니다; 또한 검색 엔진이 `*.workers.dev` 프리뷰 도메인을 중복 콘텐츠로 색인하지 않도록 비활성화해 두는 것도 잊지 마세요.

**기본 관리자 계정** (첫 로그인 직후 반드시 변경하세요!):

- 이메일: `admin@admin.com` / 비밀번호: `1`

## 📦 저장소 구조

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

## 📄 라이선스

이 프로젝트는 [GNU Affero General Public License v3.0 (AGPL-3.0)](../LICENSE)에 따라 배포됩니다.

**중요:** AGPL-3.0 제13조에 따라, 이 프로젝트의 코드를 수정하여 네트워크 서비스(SaaS)로 제공하는 경우 해당 서비스 이용자에게 **수정된 전체 소스 코드를 공개해야 합니다**.

## 🙋 지원

- 💬 Issue와 Pull Request를 환영합니다
- 🌟 도움이 되셨다면 프로젝트에 Star를 눌러주세요!

