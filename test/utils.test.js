import test from 'node:test';
import assert from 'node:assert';

// We use dynamic import so we can set the env var BEFORE server.js is loaded/evaluated
process.env.CONFIG_ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
const { normalizeServer, encryptPassword, decryptPassword } = await import('../server.js');

test('Utility Functions', async (t) => {
  await t.test('normalizeServer', async () => {
    assert.strictEqual(normalizeServer({ url: 'http://192.168.1.1' }).url, 'http://192.168.1.1');
    assert.strictEqual(normalizeServer({ url: 'http://192.168.1.1/admin/api.php' }).url, 'http://192.168.1.1');
    assert.strictEqual(normalizeServer({ baseUrl: 'https://pihole.local' }).url, 'https://pihole.local');
  });

  await t.test('encryption/decryption', async () => {
    const originalPassword = 'my-super-secret-password';
    const encrypted = encryptPassword(originalPassword);
    assert.notStrictEqual(encrypted, originalPassword);
    assert.ok(encrypted.startsWith('v1:'));

    const decrypted = decryptPassword(encrypted);
    assert.strictEqual(decrypted, originalPassword);
  });

  await t.test('encryption/decryption - empty password', async () => {
    assert.strictEqual(encryptPassword(''), '');
    assert.strictEqual(decryptPassword(''), '');
  });
});
