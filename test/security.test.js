import test from 'node:test';
import assert from 'node:assert';

// Set trusted proxies before importing the server module
process.env.TRUSTED_PROXIES = '127.0.0.1,::1';
process.env.AUTH_MODE = 'proxy';

const { isProxyAuthorized, isAuthorized } = await import('../server.js');

// Mock request objects
function makeReq(remoteAddress, headers = {}) {
  return {
    headers,
    socket: { remoteAddress }
  };
}

test('proxy authorization only accepted from trusted proxies', async (t) => {
  const reqTrusted = makeReq('127.0.0.1', { 'x-forwarded-user': 'alice' });
  assert.strictEqual(isProxyAuthorized(reqTrusted), true);

  const reqUntrusted = makeReq('1.2.3.4', { 'x-forwarded-user': 'alice' });
  assert.strictEqual(isProxyAuthorized(reqUntrusted), false);
});

test('isAuthorized respects proxy mode and headers', async (t) => {
  const reqTrusted = makeReq('127.0.0.1', { 'x-forwarded-user': 'bob' });
  assert.strictEqual(isAuthorized(reqTrusted), true);

  const reqNoHeader = makeReq('127.0.0.1', {});
  assert.strictEqual(isAuthorized(reqNoHeader), false);
});
