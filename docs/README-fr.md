# FreeIDX

[English](../README.md) · [简体中文](README-cn.md) · [繁體中文](README-zh-tw.md) · [日本語](README-ja.md) · [한국어](README-ko.md) · **Français** · [Deutsch](README-de.md) · [Español](README-es.md) · [Русский](README-ru.md) · [ไทย](README-th.md)

**Un forum moderne, gratuit et open source, entièrement construit sur Cloudflare.**

`Cloudflare Workers` · `React 19` · `Tailwind CSS 4` · `Hono` · `TypeScript` · `D1` · `KV` · `R2` · `i18n` · `AGPL-3.0`

[Fonctionnalités](#-fonctionnalités) · [Architecture](#️-architecture) · [Démarrage rapide](#-démarrage-rapide) · [Domaine personnalisé](#-configuration-du-domaine-personnalisé) · [Structure du dépôt](#-structure-du-dépôt)

***

Un forum basé sur Cloudflare Workers + D1 + KV + R2, prenant en charge les publications, les commentaires, le téléversement de pièces jointes, l'adhésion, l'indexation SEO, le multilinguisme, et plus encore.

**💡 Fonctionne entièrement gratuitement** : le frontend et le backend sont déployés comme un unique projet Worker, les ressources statiques sont servies via Workers Assets, et D1/KV/R2 restent tous dans les limites de l'offre gratuite — zéro coût, zéro maintenance.

***

## 🏗️ Architecture

### Déploiement combiné sur un seul Worker

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

### Stack technique

| Couche              | Choix                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Frontend            | React 19 + React Router 7 + Tailwind CSS 4 + TanStack Query + Zustand + Vite                               |
| Backend             | Hono + TypeScript + Zod (Cloudflare Workers)                                                               |
| Base de données     | D1 (SQLite), KV pour le cache à faible fréquence d'écriture, Cache API pour la mise en cache en périphérie |
| Stockage            | R2 (pièces jointes/avatars, diffusés en streaming via le proxy Worker `/files/:key`)                       |
| Authentification    | JWT (httpOnly Cookie) + table de sessions D1, PBKDF2-SHA256                                                |
| CAPTCHA             | Cloudflare Turnstile                                                                                       |
| Tâches planifiées   | Cron Triggers (palier de 5 minutes + palier de réconciliation horaire + palier quotidien)                  |
| Gestion des paquets | pnpm workspace + Turborepo (monorepo : `apps/web` / `apps/api` / `packages/shared`)                        |

## ✨ Fonctionnalités

### 📝 Cœur du forum

- ✅ **Gestion des publications** - Publier, modifier, supprimer, épingler, fermer, déplacer entre les sections, mettre en avant ; pagination par curseur + défilement infini ; mises à jour optimistes TanStack Query (nombre de publications et de vues reflété instantanément)
- ✅ **Système de commentaires** - Réponses, citations, surlignage de mots-clés, marqueurs de lecture, réponses multi-niveaux
- ✅ **Téléversement de pièces jointes** - Images/fichiers téléversés directement vers R2, diffusés en streaming via le proxy Worker `/files/:key`, pour un trafic sortant sans frais tout en évitant les quotas d'opérations de Storage Class B ; éditeur de texte enrichi **TipTap** intégré, avec insertion de code et téléversement d'images par collage
- ✅ **Recherche** - Recherche par mots-clés au sein des sections, avec surlignage des fragments correspondants

### 👥 Utilisateurs et permissions

- ✅ **Authentification des utilisateurs** - Inscription, connexion, déconnexion, codes de vérification par e-mail, récupération de mot de passe ; authentification à double voie JWT (httpOnly Cookie) + table de sessions, protection CSRF sur tout le site
- ✅ **Système de permissions à trois niveaux** - Groupes d'utilisateurs × accès aux sections × moteur de règles de modération, avec des autorisations de lecture/écriture et de modération jusque sur chaque section
- ✅ **Promotion automatique des groupes d'utilisateurs** - Dès que le nombre de publications + de sujets entre dans un intervalle de crédits, le groupe change automatiquement, sans intervention manuelle
- ✅ **Centre utilisateur** - Téléversement d'avatar, modification du profil, changement de mot de passe, mes sujets/mes réponses, préférences de notification par e-mail
- ✅ **Actions de modération** - Épingler/fermer/supprimer/déplacer/supprimer un utilisateur, avec prise en charge du traitement par lots

### 💎 Adhésion et monétisation

- ✅ **Système d'adhésion** - Crédits + niveaux + VIP + pièces jointes payantes + paiements de commandes, le tout formant une boucle fermée complète
- ✅ **Canaux de paiement enfichables** - card / paypal / stripe / alipay, un plugin indépendant par canal ; payment-core ne contient que les contrats + le registre + la machine à états des commandes ; activez/désactivez chaque canal et renouvelez les clés depuis le panneau d'administration, sans aucun déploiement
- ✅ **Système publicitaire** - Emplacements publicitaires personnalisés + Google AdSense, configuration flexible sur plusieurs emplacements

### 🔌 Extensibilité et ingénierie

- ✅ **Mécanisme de plugins** - Points d'extension hook / overwrite + emplacements de composants frontend, remplaçables à chaud depuis le panneau d'administration, pour étendre les fonctionnalités sans toucher au code central
- ✅ **Panneau d'administration** - Paramètres du site, sections, sujets, utilisateurs, groupes d'utilisateurs, cache — tout au même endroit
- ✅ **Multilingue** - Chinois simplifié/traditionnel / anglais / japonais / coréen / français / allemand / espagnol / russe / thaï — 10 langues au total, génération par scripts + validation sur l'ensemble du pipeline en pré-commit, éliminant les textes codés en dur
- ✅ **Tâches planifiées** - Ordonnancement Cron Triggers à trois paliers (toutes les 5 minutes / réconciliation horaire / quotidien), automatisant le recyclage des sessions, la réinitialisation quotidienne des statistiques, le GC des pièces jointes et la réconciliation des commandes orphelines

### 🔍 Indexation SEO / GEO

- ✅ **Pré-rendu pour les crawlers** - HTML SEO pré-généré à l'écriture et stocké dans R2 + Cache API, servi uniquement aux user agents des crawlers ; le CPU de rendu au moment de la requête est structurellement réduit à zéro
- ✅ **Boîte à outils d'indexation complète** - sitemap, données structurées JSON-LD, llms.txt, politiques pour crawlers IA, robots ; URL pseudo-statiques `.htm` pour la rétrocompatibilité
- ✅ **Mise en cache en périphérie** - Barrière de lecture Cache API ; les endpoints populaires obtiennent `x-edge-cache: HIT` dès le deuxième accès, économisant considérablement le quota de lectures D1

### 🔐 Sécurité et adaptation à l'offre gratuite

- ✅ **Sécurité des mots de passe** - PBKDF2-SHA256 (WebCrypto), nombre d'itérations calibré pour la limite CPU de 10 ms des Workers, avec mise à niveau paresseuse pour la compatibilité avec les anciens hachages
- ✅ **CAPTCHA** - Cloudflare Turnstile intégré, présent sur la connexion/l'inscription/la publication/la réponse/la récupération de mot de passe
- ✅ **Service e-mail** - Pool de comptes SMTP / Email Provider pour une livraison fiable des e-mails de vérification et de la récupération de mot de passe
- ✅ **Adaptation approfondie à l'offre gratuite** - Cache multi-couches (mémoire LRU dans l'Isolate + KV + table de cache D1 + Cache API), requêtes fusionnées via `DB.batch()`, comptage asynchrone fusionné via `waitUntil` — pour tirer le maximum du quota de 100k requêtes/jour, 5M de lectures de lignes / 100k d'écritures de lignes

## 🚀 Démarrage rapide

## Méthode 1 : déploiement automatisé via GitHub Actions (recommandé)

Le projet est livré avec `.github/workflows/deploy.yml` ; tout push vers la branche `main` ou un déclenchement manuel lance automatiquement le build et le déploiement vers Cloudflare. D1 / KV sont **retrouvés automatiquement par nom et créés s'ils sont absents** par le pipeline — aucun fichier du dépôt ne doit être modifié manuellement.

#### Étape 1 : obtenir un token d'API Cloudflare

1. Connectez-vous au [tableau de bord Cloudflare](https://dash.cloudflare.com/)
2. Allez dans **My Profile > API Tokens**, cliquez sur **Create Token**

   ![](images/img-01.png)
3. Cliquez sur « View all templates », sélectionnez le modèle **Developer Services** sur la page des cartes de modèles, ne touchez à rien d'autre, puis cliquez sur **Review Token** pour terminer.
4. Copiez le token (affiché une seule fois) ainsi que l'Account ID de votre compte, et conservez les deux.

#### Étape 2 : configurer les GitHub Secrets

Forkez le projet dans votre propre dépôt. Dans votre dépôt GitHub :

1. Allez dans **Settings > Secrets and variables > Actions**
2. Ajoutez les secrets suivants, en vous aidant de l'image ci-dessous pour repérer l'entrée :

   ① **Settings** → ② **Secrets and variables → Actions** → ③ onglet **Secrets** → ④ **New repository secret**.

   ![](images/img-02.png)

| Nom du secret           | Valeur                      | Description                                          | Obligatoire |
| ----------------------- | --------------------------- | ---------------------------------------------------- | ----------- |
| `CLOUDFLARE_API_TOKEN`  | Token d'API Cloudflare      | Le token créé à l'étape 1                            | Oui         |
| `CLOUDFLARE_ACCOUNT_ID` | Votre Account ID Cloudflare | Barre latérale droite de la page d'accueil du compte | Oui         |

**Variables :**

| Nom de la variable  | Valeur                        | Description                                                                                                                                                                                                                                             | Obligatoire |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `SITE_URL`          | URL du site                   | p. ex. `https://forum.example.com` (si vous n'avez pas encore de domaine, **ne créez pas cette variable pour l'instant** ; revenez après avoir lié le domaine ; ne saisissez pas le mot « empty »)                                                      | Non         |
| `TURNSTILE_SITEKEY` | Site Key Cloudflare Turnstile | [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) ; le widget de vérification ne s'affichera pas sur le frontend s'il n'a pas été créé. Toute modification de la valeur exige un redéploiement du frontend pour prendre effet | Non         |

### Étape 3 : premier déploiement

Sur la page **Actions** de votre dépôt GitHub :

1. Sélectionnez le workflow **Deploy to Cloudflare**
2. Cliquez sur **Run workflow**, sélectionnez la branche `main`, puis cochez :
   - `apply_migrations` — créer les tables (`apps/api/migrations/`)
   - `run_seed` — sections initiales + premier administrateur
3. Une fois le workflow au vert, vous êtes en ligne ; le Worker `freeidx-api` n'est d'ailleurs créé qu'à cette étape. **Lors des pushs suivants vers main, ces deux cases sont décochées par défaut** et ne toucheront pas la base de données.

#### Étape 4 : configurer les secrets d'exécution

Une fois le premier déploiement au vert, `freeidx-api` apparaît dans la liste des Workers. Cliquez dessus → **Settings → Variables and secrets**, choisissez le type **Secret**, puis ajoutez-les un par un (invisibles une fois enregistrés, mais ils ne seront pas écrasés par les déploiements ; à remplir une seule fois, valable dans la durée) :

| Nom                  | Usage                                                                                | Obligatoire                                             |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `JWT_SECRET`         | Signature des tokens de connexion / CSRF                                             | Oui                                                     |
| `TURNSTILE_SECRET`   | Vérification CAPTCHA côté serveur (à associer obligatoirement à `TURNSTILE_SITEKEY`) | Non                                                     |
| `SECRETS_MASTER_KEY` | Clé maîtresse AES-GCM pour les secrets de paiement des plugins                       | Non                                                     |

Générez une valeur aléatoire en local et collez-en une à la fois :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Méthode 2 : développement en local

```bash
pnpm install

# Build the frontend first, then start the backend (wrangler dev reads the same [assets] config)
pnpm --filter @freeidx/web build
pnpm --filter @freeidx/api dev
```

- Exécute miniflare en local ; aucun ID de ressource réel nécessaire
- Placez les secrets dans `apps/api/.dev.vars`
- Base de données : `pnpm db:apply` pour appliquer les migrations, `pnpm db:seed` pour charger les données initiales

## Méthode 3 : création visuelle via le tableau de bord Cloudflare

Workers & Pages → Create → **Continue with GitHub** fonctionne aussi, mais cela oblige à remplir manuellement les vrais ID D1/KV ainsi que `SITE_URL` dans `apps/api/wrangler.toml` via l'interface web GitHub (le dépôt contient des valeurs d'exemple ; l'échec est garanti sans modification), et le nom du projet doit être `freeidx-api`. Choisissez entre cette méthode et le pipeline.

## 🌐 Configuration du domaine personnalisé

1. Page d'accueil Cloudflare → **Add a domain**, hébergez-y le domaine, puis modifiez les deux enregistrements NS chez votre registrar
2. Workers → `freeidx-api` → **Settings → Domains & Routes → Add → Custom domain**
3. Retournez dans les Variables GitHub et définissez `SITE_URL` sur ce domaine ; poussez n'importe quel commit pour que cela prenne effet

Aucune configuration de Route nécessaire — `/api/*`, `/files/*` et les chemins de pages vivent tous dans le même Worker. La mise en cache en périphérie prend effet automatiquement dès que le domaine personnalisé est lié ; pensez aussi à désactiver le domaine de prévisualisation `*.workers.dev` pour éviter que les moteurs de recherche ne l'indexent comme contenu dupliqué.

**Compte administrateur par défaut** (changez-le immédiatement après la première connexion !) :

- E-mail : `admin@admin.com` / Mot de passe : `1`

## 📦 Structure du dépôt

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

## 📄 Licence

Ce projet est publié sous la [GNU Affero General Public License v3.0 (AGPL-3.0)](../LICENSE).

**Important :** conformément à l'article 13 de l'AGPL-3.0, toute personne qui modifie le code de ce projet et le propose en tant que service en ligne (SaaS) **doit** mettre à la disposition des utilisateurs du service le code source complet modifié.

## 🙋 Support

- 💬 Les Issues et Pull Requests sont les bienvenues
- 🌟 Si ce projet vous aide, n'hésitez pas à lui laisser une Star !

