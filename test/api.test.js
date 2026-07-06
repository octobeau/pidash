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

    let ready = false;
    for (let i = 0; i < 15; i++) {
      try {
        const res = await fetch(`http://localhost:${PORT}/healthz`);
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch (e) {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!ready) {
      throw new Error('Server failed to start for integration tests');
    }

    await t.test('GET /healthz returns ok', async () => {
      const res = await fetch(`http://localhost:${PORT}/healthz`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ok, true);
    });

    await t.test('GET /api/config returns configuration', async () => {
      const response = await fetch(`http://localhost:${PORT}/api/config`);
      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.ok(data.servers !== undefined);
    });

    await t.test('static 404 responses include security headers', async () => {
      const response = await fetch(`http://localhost:${PORT}/does-not-exist`);
      assert.strictEqual(response.status, 404);
      assert.ok(response.headers.get('content-security-policy'));
      assert.strictEqual(response.headers.get('x-frame-options'), 'DENY');
    });

    await t.test('CSRF failures include security headers', async () => {
      const response = await fetch(`http://localhost:${PORT}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://127.0.0.1' })
      });
      assert.strictEqual(response.status, 403);
      assert.ok(response.headers.get('content-security-policy'));
      assert.strictEqual(response.headers.get('cache-control'), 'no-store');
    });

    await t.test('PUT /api/servers can clear a stored password', async () => {
      const createResponse = await fetch(`http://localhost:${PORT}/api/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` },
        body: JSON.stringify({
          name: 'Clear Password Test',
          url: 'https://192.168.1.118',
          password: 'old-v5-token',
          version: '6',
          color: '#39d98a',
          enabled: true
        })
      });
      assert.strictEqual(createResponse.status, 201);
      const created = await createResponse.json();
      assert.strictEqual(created.hasPassword, true);

      const updateResponse = await fetch(`http://localhost:${PORT}/api/servers/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` },
        body: JSON.stringify({
          name: 'Clear Password Test',
          url: 'https://192.168.1.118',
          version: '6',
          color: '#39d98a',
          enabled: true,
          clearPassword: true
        })
      });
      assert.strictEqual(updateResponse.status, 200);
      const updated = await updateResponse.json();
      assert.strictEqual(updated.hasPassword, false);
    });

  } finally {
    if (serverProcess) {
      serverProcess.kill();
    }
    if (existsSync(testDatabasePath)) {
      rmSync(testDatabasePath, { force: true });
    }
  }
});
