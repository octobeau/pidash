import test from 'node:test';
import assert from 'node:assert';

process.env.DATABASE_PATH = ':memory:';
process.env.CONFIG_ENCRYPTION_KEY = Buffer.from('d'.repeat(32)).toString('base64');

const { fetchV5, fetchV6, getJson, collectServer } = await import('../server.js');

// Helper to create a mock Response
function mockResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('fetchV5 normalizes summary fields', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.search.includes('summaryRaw'))   return mockResponse({ dns_queries_today: 500, ads_blocked_today: 50, ads_percentage_today: 10, domains_being_blocked: 2000, queries_forwarded: 400, queries_cached: 50, unique_clients: 8, status: 'enabled' });
    if (u.search.includes('getQueryTypes')) return mockResponse({ querytypes: { A: 300, AAAA: 100 } });
    if (u.search.includes('topItems'))     return mockResponse({ top_queries: [{ domain: 'example.com', count: 10 }], top_ads: [] });
    if (u.search.includes('topClients'))   return mockResponse({ top_sources: [{ ip: '192.168.1.1', count: 5 }] });
    if (u.search.includes('overTimeData')) return mockResponse({ over_time_data: {} });
    if (u.search.includes('getForwardDestinations')) return mockResponse({ forward_destinations: {} });
    return mockResponse({});
  };
  t.after(() => { globalThis.fetch = original; });

  const result = await fetchV5({ id: '1', url: 'http://pihole.test', password: '', version: '5', color: '#39d98a' });
  assert.strictEqual(result.version, '5');
  assert.strictEqual(result.summary.queries, 500);
  assert.strictEqual(result.summary.blocked, 50);
  assert.strictEqual(result.summary.blockRate, 10);
  assert.ok(Array.isArray(result.topDomains));
});

test('collectServer returns offline result on fetch failure', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  t.after(() => { globalThis.fetch = original; });

  const result = await collectServer({ id: '99', name: 'Dead PH', url: 'http://dead.test', password: '', version: '5', color: '#f97373' });
  assert.strictEqual(result.online, false);
  assert.ok(result.error);
  assert.strictEqual(result.summary.queries, 0);
});

test('aggregate uses max for domains, not sum', async (t) => {
  // Two servers each reporting 50000 domains (same blocklist)
  const original = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = async (url) => {
    callCount++;
    const u = new URL(url);
    if (u.search.includes('summaryRaw')) return mockResponse({
      dns_queries_today: 1000, ads_blocked_today: 100, ads_percentage_today: 10,
      domains_being_blocked: 50000, queries_forwarded: 800, queries_cached: 100, unique_clients: 5
    });
    return mockResponse({});
  };
  t.after(() => { globalThis.fetch = original; });

  const { collectSnapshot } = await import('../src/pihole.js');
  const servers = [
    { id: '1', name: 'A', url: 'http://a.test', password: '', version: '5', color: '#39d98a' },
    { id: '2', name: 'B', url: 'http://b.test', password: '', version: '5', color: '#4c9ffe' }
  ];
  const snap = await collectSnapshot(servers, { force: true });
  assert.strictEqual(snap.totals.domains, 50000, 'domains should be max(50000, 50000) = 50000 not 100000');
  assert.strictEqual(snap.totals.queries, 2000, 'queries should be summed');
});

test('getJson surfaces Pi-hole error message', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => mockResponse({ error: { key: 'unauthorized', message: 'Bad credentials' } }, 401);
  t.after(() => { globalThis.fetch = original; });

  await assert.rejects(
    () => getJson('http://pihole.test/api/auth'),
    /Bad credentials/
  );
});

test('collectSnapshot rate-limit returns cached result within 5s', async (t) => {
  const { collectSnapshot } = await import('../src/pihole.js');
  let fetchCount = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCount++;
    const u = new URL(url);
    if (u.search.includes('summaryRaw')) return mockResponse({ dns_queries_today: fetchCount * 10 });
    return mockResponse({});
  };
  t.after(() => { globalThis.fetch = original; });

  const servers = [{ id: '10', name: 'RateTest', url: 'http://rt.test', password: '', version: '5', color: '#39d98a' }];
  await collectSnapshot(servers, { force: true });
  const second = await collectSnapshot(servers);
  assert.strictEqual(second.cached, true, 'second call within 5s should be cached');
});
