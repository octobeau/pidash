import test from 'node:test';
import assert from 'node:assert';

// We use dynamic import so we can set the env var BEFORE server.js is loaded/evaluated
process.env.CONFIG_ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
const { normalizeServer, encryptPassword, decryptPassword, fetchV6, getJson } = await import('../server.js');

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

test('Pi-hole v6 auth with no password set does not require a SID', async (t) => {
  const originalFetch = globalThis.fetch;
  const seenHeaders = [];

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/auth') {
      return jsonResponse({
        session: {
          valid: true,
          totp: false,
          sid: null,
          validity: -1,
          message: 'no password set'
        }
      });
    }

    seenHeaders.push(options.headers || {});
    if (parsed.pathname === '/api/stats/summary') {
      return jsonResponse({
        queries: { total: 42, blocked: 7, percent_blocked: 16.6 },
        gravity: { domains_being_blocked: 1000 }
      });
    }

    return jsonResponse({});
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await fetchV6({
    id: 1,
    url: 'http://pihole.test',
    password: 'stale-v5-token'
  });

  assert.strictEqual(result.version, '6');
  assert.strictEqual(result.summary.queries, 42);
  assert.ok(seenHeaders.length > 0);
  assert.ok(seenHeaders.every((headers) => !headers['X-FTL-SID']));
});

test('getJson includes Pi-hole JSON error messages', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({
    error: {
      key: 'unauthorized',
      message: 'Unauthorized'
    }
  }, { status: 401, statusText: 'Unauthorized' });

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => getJson('http://pihole.test/api/auth'),
    /401 Unauthorized from \/api\/auth: Unauthorized/
  );
});

test('Pi-hole v6 auth without SID reports useful session details', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/auth') {
      return jsonResponse({
        session: {
          valid: false,
          totp: true,
          sid: null,
          message: 'additional authentication required'
        }
      });
    }

    return jsonResponse({});
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => fetchV6({
      id: 2,
      url: 'http://pihole.test',
      password: 'web-password-with-2fa'
    }),
    /2FA appears to be enabled.*Pi-hole marked the session invalid.*additional authentication required/
  );
});

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    statusText: init.statusText || 'OK',
    headers: {
      'content-type': 'application/json'
    }
  });
}
