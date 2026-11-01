import test from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(__dirname, '../server.js');
const PORT = 8081;
const testDatabasePath = path.join(__dirname, 'test.sqlite');

test('API Integration Tests', async (t) => {
  let serverProcess = null;

  try {
    serverProcess = spawn('node', [serverScript], {
      env: {
        ...process.env,
        PORT: String(PORT),
        AUTH_MODE: 'none',
        PIHOLE_CONFIG: path.join(__dirname, 'test-config.json'),
        DATABASE_PATH: testDatabasePath,
        CONFIG_ENCRYPTION_KEY: Buffer.from('b'.repeat(32)).toString('base64')
      },
      stdio: 'inherit'
    });

    // Wait for server to be ready
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://localhost:${PORT}/healthz`);
        if (res.status === 200) { ready = true; break; }
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!ready) throw new Error('Server failed to start for integration tests');

    // Helpers
    const base = `http://localhost:${PORT}`;
    let csrfToken = null;

    await t.test('GET /healthz returns ok', async () => {
      const res = await fetch(`${base}/healthz`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ok, true);
    });

    await t.test('GET /api/csrf-token returns a token', async () => {
      const res = await fetch(`${base}/api/csrf-token`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.token, 'token should be present');
      assert.strictEqual(typeof data.token, 'string');
      assert.ok(data.token.length >= 32);
      csrfToken = data.token;
    });

    await t.test('GET /api/config returns configuration', async () => {
      const res = await fetch(`${base}/api/config`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.servers !== undefined);
      assert.ok(typeof data.authMode === 'string');
    });

    await t.test('static 404 responses include security headers', async () => {
      const res = await fetch(`${base}/does-not-exist`);
      assert.strictEqual(res.status, 404);
      assert.ok(res.headers.get('content-security-policy'));
      assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
      assert.ok(res.headers.get('permissions-policy'), 'Permissions-Policy header should be present');
    });

    await t.test('CSRF failures include security headers', async () => {
      const res = await fetch(`${base}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1' })
      });
      assert.strictEqual(res.status, 403);
      assert.ok(res.headers.get('content-security-policy'));
      assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    });

    await t.test('CSRF token header bypasses origin check', async () => {
      assert.ok(csrfToken, 'need csrf token from earlier test');
      const res = await fetch(`${base}/api/servers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({ name: 'CSRF Test', url: 'http://192.168.1.50', version: 'auto', color: '#39d98a', enabled: true })
      });
      assert.strictEqual(res.status, 201);
      const created = await res.json();

      // Clean up
      await fetch(`${base}/api/servers/${created.id}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken }
      });
    });

    await t.test('PUT /api/servers can clear a stored password', async () => {
      const createRes = await fetch(`${base}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ name: 'Clear PW Test', url: 'https://192.168.1.118', password: 'old-token', version: '6', color: '#39d98a', enabled: true })
      });
      assert.strictEqual(createRes.status, 201);
      const created = await createRes.json();
      assert.strictEqual(created.hasPassword, true);

      const updateRes = await fetch(`${base}/api/servers/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ name: 'Clear PW Test', url: 'https://192.168.1.118', version: '6', color: '#39d98a', enabled: true, clearPassword: true })
      });
      assert.strictEqual(updateRes.status, 200);
      const updated = await updateRes.json();
      assert.strictEqual(updated.hasPassword, false);
    });

    await t.test('DELETE /api/servers/:id returns 404 for unknown id', async () => {
      const res = await fetch(`${base}/api/servers/999999`, {
        method: 'DELETE',
        headers: { Origin: base }
      });
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.ok(data.error);
    });

    await t.test('GET /api/history returns history structure', async () => {
      const res = await fetch(`${base}/api/history?range=24h`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.history));
    });

    await t.test('GET /api/alerts returns alerts structure', async () => {
      const res = await fetch(`${base}/api/alerts`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.alerts));
      assert.strictEqual(typeof data.unread, 'number');
    });

    await t.test('POST /api/alerts/read marks alerts read', async () => {
      const res = await fetch(`${base}/api/alerts/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({})
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ok, true);
    });

    await t.test('POST /api/servers/:id/test returns connection result', async () => {
      // Get an existing server id from config
      const configRes = await fetch(`${base}/api/config`);
      const { servers } = await configRes.json();
      if (!servers.length) { t.skip('no servers configured'); return; }

      const sid = servers[0].id;
      const res = await fetch(`${base}/api/servers/${sid}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({})
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(typeof data.online === 'boolean');
      assert.ok(typeof data.latencyMs === 'number');
    });

    await t.test('POST /api/servers/999/blocking returns 404', async () => {
      const res = await fetch(`${base}/api/servers/999/blocking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ enabled: true })
      });
      assert.strictEqual(res.status, 404);
    });

    await t.test('GET /api/servers/999/queries returns 404', async () => {
      const res = await fetch(`${base}/api/servers/999/queries`);
      assert.strictEqual(res.status, 404);
    });

    await t.test('versioned static assets get immutable cache header', async () => {
      const res = await fetch(`${base}/styles.css?v=7`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('cache-control')?.includes('immutable'), 'versioned CSS should be immutable');
    });

  } finally {
    if (serverProcess) serverProcess.kill();
    if (existsSync(testDatabasePath)) rmSync(testDatabasePath, { force: true });
  }
});
