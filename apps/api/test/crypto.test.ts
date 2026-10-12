/**
 * AES-GCM 私钥封装（§17.1 / T5-4 复用）：往返、篡改/错钥安全失败、密钥长度校验。
 */
import { describe, it, expect } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/core/crypto';

const MASTER = btoa(String.fromCharCode(7).repeat(32));
const OTHER = btoa(String.fromCharCode(9).repeat(32));

describe('core/crypto（ext secret AES-GCM）', () => {
  it('加密-解密往返', async () => {
    const token = await encryptSecret('{"publisherId":"pub-1"}', MASTER);
    expect(token.startsWith('v1.')).toBe(true);
    expect(token).not.toContain('pub-1');
    expect(await decryptSecret(token, MASTER)).toBe('{"publisherId":"pub-1"}');
  });

  it('同一明文两次密文不同（随机 IV）', async () => {
    const a = await encryptSecret('x', MASTER);
    const b = await encryptSecret('x', MASTER);
    expect(a).not.toBe(b);
  });

  it('错误 master key → null（安全失败，不回退明文）', async () => {
    const token = await encryptSecret('secret', MASTER);
    expect(await decryptSecret(token, OTHER)).toBeNull();
  });

  it('篡改密文 → null', async () => {
    const token = await encryptSecret('secret', MASTER);
    expect(await decryptSecret(token.slice(0, -2) + 'AA', MASTER)).toBeNull();
  });

  it('非 v1 格式密文 → null', async () => {
    expect(await decryptSecret('garbage', MASTER)).toBeNull();
  });

  it('master key 非 32 字节 → 加密抛错', async () => {
    await expect(encryptSecret('x', btoa(String.fromCharCode(1).repeat(16)))).rejects.toThrow();
  });
});
