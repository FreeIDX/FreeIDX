export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  /** 合并部署：前端 SPA 产物（wrangler.toml [assets] binding） */
  ASSETS: Fetcher;
  SITE_URL: string;
  JWT_SECRET?: string;
  /** 后台轨独立签名密钥（T3-3）；缺省回退 JWT_SECRET */
  ADMIN_JWT_SECRET?: string;
  TURNSTILE_SECRET?: string;
  /** 扩展/邮箱私密字段 AES-GCM 主密钥（ext:email:secret 等；缺省时私密项不可写） */
  SECRETS_MASTER_KEY?: string;
}
