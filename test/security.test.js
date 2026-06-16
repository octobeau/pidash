import test from 'node:test';
import assert from 'node:assert';

// Set trusted proxies before importing the server module
process.env.TRUSTED_PROXIES = '127.0.0.1,::1,10.0.0.1,172.18.0.0/16,192.168.*';
process.env.AUTH_MODE = 'proxy';

const { isProxyAuthorized, isAuthorized, matchesTrustedProxyRule, normalizeServer, parseTrustedProxyRules } = await import('../server.js');

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

test('trusted proxy exact IPs do not match nearby prefixes', async () => {
  assert.strictEqual(isProxyAuthorized(makeReq('10.0.0.1', { 'x-forwarded-user': 'alice' })), true);
  assert.strictEqual(isProxyAuthorized(makeReq('10.0.0.10', { 'x-forwarded-user': 'alice' })), false);
  assert.strictEqual(isProxyAuthorized(makeReq('127.0.0.10', { 'x-forwarded-user': 'alice' })), false);
  assert.strictEqual(isProxyAuthorized(makeReq('::10', { 'x-forwarded-user': 'alice' })), false);
});

test('trusted proxy CIDR and explicit wildcard rules are supported', async () => {
  assert.strictEqual(isProxyAuthorized(makeReq('172.18.1.20', { 'x-forwarded-user': 'alice' })), true);
  assert.strictEqual(isProxyAuthorized(makeReq('172.19.1.20', { 'x-forwarded-user': 'alice' })), false);
  assert.strictEqual(isProxyAuthorized(makeReq('192.168.1.100', { 'x-forwarded-user': 'alice' })), true);

  const rules = parseTrustedProxyRules('10.10.0.0/16,192.168.*');
  assert.strictEqual(matchesTrustedProxyRule('10.10.5.5', rules[0]), true);
  assert.strictEqual(matchesTrustedProxyRule('10.11.5.5', rules[0]), false);
  assert.strictEqual(matchesTrustedProxyRule('192.168.50.2', rules[1]), true);
});

test('isAuthorized respects proxy mode and headers', async (t) => {
  const reqTrusted = makeReq('127.0.0.1', { 'x-forwarded-user': 'bob' });
  assert.strictEqual(isAuthorized(reqTrusted), true);

  const reqNoHeader = makeReq('127.0.0.1', {});
  assert.strictEqual(isAuthorized(reqNoHeader), false);
});

test('server URLs must use http or https', async () => {
  assert.strictEqual(normalizeServer({ url: 'http://192.168.1.2/admin/api.php' }).url, 'http://192.168.1.2');
  assert.strictEqual(normalizeServer({ url: 'https://pihole.local' }).url, 'https://pihole.local');
  assert.throws(() => normalizeServer({ url: 'file:///etc/passwd' }), /http or https/);
  assert.throws(() => normalizeServer({ url: 'ftp://example.test/resource' }), /http or https/);
});
