/** §20.4 安全项：CORS 白名单化——credentials:true 下不得反射任意 Origin（否则任意外站可携 Cookie 跨域读响应） */
import { describe, it, expect } from 'vitest';
import { app } from '../src/index';
import { fakeD1 } from './helpers/fake-d1';

const SITE = 'http://localhost:8787';
const env = () => ({ DB: fakeD1().db, CACHE: undefined, SITE_URL: SITE }) as never;
/** 多域名部署后「站点自身域」按请求 Host 判定，故请求一律带绝对 URL（与真实请求一致） */
const url = (p: string) => `${SITE}${p}`;

describe('CORS Origin 白名单（§20.4）', () => {
  it('白名单内 Origin（站点自身域）→ 反射放行', async () => {
    const res = await app.request(url('/api/health'), { headers: { origin: SITE } }, env());
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('本地 dev（vite 5173）→ 放行（dev proxy 同源开发用）', async () => {
    const res = await app.request(url('/api/health'), { headers: { origin: 'http://localhost:5173' } }, env());
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('白名单外恶意 Origin → 回落请求域（ACAO 不匹配 → 浏览器拒绝跨域读取）', async () => {
    const res = await app.request(url('/api/health'), { headers: { origin: 'https://evil.example.com' } }, env());
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('无 Origin（同源/curl）→ 回落请求域，不构成跨域暴露', async () => {
    const res = await app.request(url('/api/health'), {}, env());
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('OPTIONS 预检：恶意 Origin 同样不反射', async () => {
    const res = await app.request(
      url('/api/threads'),
      { method: 'OPTIONS', headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' } },
      env(),
    );
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
  });
});