import test from 'node:test';
import assert from 'node:assert';

// In-memory DB so tests don't touch the real database
process.env.DATABASE_PATH = ':memory:';
process.env.CONFIG_ENCRYPTION_KEY = Buffer.from('c'.repeat(32)).toString('base64');
process.env.AUTH_MODE = 'none';

const {
  normalizeServer, loadServers, listServerConfigs,
  createServerConfig, updateServerConfig, deleteServerConfig
} = await import('../server.js');

// -- Import db internals directly for history/alerts testing
const { recordMetrics, getHistory, generateAlerts, getAlerts, markAlertsRead, unreadAlertCount } = await import('../src/db.js');

test('normalizeServer strips admin/api paths', () => {
  assert.strictEqual(normalizeServer({ url: 'http://192.168.1.1/admin/api.php' }).url, 'http://192.168.1.1');
  assert.strictEqual(normalizeServer({ url: 'http://192.168.1.1/admin/' }).url, 'http://192.168.1.1');
  assert.strictEqual(normalizeServer({ url: 'http://192.168.1.1/api/' }).url, 'http://192.168.1.1');
  assert.strictEqual(normalizeServer({ url: 'http://192.168.1.1/' }).url, 'http://192.168.1.1');
});

test('normalizeServer accepts baseUrl and host aliases', () => {
  assert.strictEqual(normalizeServer({ baseUrl: 'https://pihole.local' }).url, 'https://pihole.local');
});

test('createServerConfig / listServerConfigs / deleteServerConfig round-trip', () => {
  const created = createServerConfig({ name: 'Test PH', url: 'http://10.0.0.1', version: 'auto', color: '#39d98a', enabled: true });
  assert.ok(created.id);
  assert.strictEqual(created.name, 'Test PH');
  assert.strictEqual(created.hasPassword, false);

  const list = listServerConfigs();
  assert.ok(list.some((s) => s.id === created.id));

  deleteServerConfig(created.id);
  const list2 = listServerConfigs();
  assert.ok(!list2.some((s) => s.id === created.id));
});

test('deleteServerConfig throws on missing id', () => {
  assert.throws(() => deleteServerConfig(999999), /Server not found/);
});

test('updateServerConfig clears password', () => {
  const created = createServerConfig({ name: 'PH-pw', url: 'http://10.0.0.2', password: 'secret' });
  assert.strictEqual(created.hasPassword, true);

  const updated = updateServerConfig(created.id, {
    name: 'PH-pw', url: 'http://10.0.0.2', version: 'auto', color: '#39d98a', enabled: true, clearPassword: true
  });
  assert.strictEqual(updated.hasPassword, false);

  deleteServerConfig(created.id);
});

test('recordMetrics and getHistory return per-server series', () => {
  // Create a server to get a real ID
  const srv = createServerConfig({ name: 'Metrics Server', url: 'http://10.0.0.3', version: 'auto', color: '#39d98a', enabled: true });

  const snapshot = {
    generatedAt: new Date().toISOString(),
    servers: [{
      id: srv.id,
      name: 'Metrics Server',
      online: true,
      summary: { queries: 1000, blocked: 200, blockRate: 20, forwarded: 700, cached: 100, clients: 5, status: 'enabled' }
    }]
  };
  recordMetrics(snapshot);

  const history = getHistory('24h');
  const entry = history.find((h) => String(h.id) === String(srv.id));
  assert.ok(entry, 'server appears in history');
  assert.ok(entry.points.length > 0, 'has at least one data point');
  assert.strictEqual(entry.points[0].queries, 1000);

  deleteServerConfig(srv.id);
});

test('generateAlerts fires on offline/online transitions', () => {
  const srv = createServerConfig({ name: 'Alert Server', url: 'http://10.0.0.4', version: 'auto', color: '#39d98a', enabled: true });
  const sid = String(srv.id);
  const make = (online) => ({
    generatedAt: new Date().toISOString(),
    servers: [{ id: sid, name: 'Alert Server', online, summary: { queries: 0, blocked: 0, blockRate: 0, forwarded: 0, cached: 0, clients: 0, status: online ? 'enabled' : 'disabled' } }]
  });

  const before = getAlerts().length;
  generateAlerts(make(true));   // initial state: online (no alert — no prior state)
  generateAlerts(make(false));  // goes offline — alert
  const after = getAlerts();
  assert.strictEqual(after.length - before, 1);
  assert.strictEqual(after[0].type, 'offline');
  assert.ok(unreadAlertCount() >= 1);

  markAlertsRead();
  assert.strictEqual(unreadAlertCount(), 0);

  deleteServerConfig(srv.id);
});
