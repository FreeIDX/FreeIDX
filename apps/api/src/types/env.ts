export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  /** 合并部署：前端 SPA 产物（wrangler.toml [assets] binding） */
  ASSETS: Fetcher;
  /**
   * 主域名兜底（可选）：仅在后台「站点网址」留空时用于对外绝对地址（邮件/SEO/支付回跳）。
   * 多域名部署下不要依赖它——运行时行为（Cookie Secure/CORS）按请求域走，主域名以后台配置优先。
   */
  SITE_URL?: string;
  JWT_SECRET?: string;
  /** 后台轨独立签名密钥（T3-3）；缺省回退 JWT_SECRET */
  ADMIN_JWT_SECRET?: string;
  TURNSTILE_SECRET?: string;
  /** 扩展/邮箱私密字段 AES-GCM 主密钥（ext:email:secret 等；缺省时私密项不可写） */
  SECRETS_MASTER_KEY?: string;
}
