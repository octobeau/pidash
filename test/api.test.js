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
        DATABASE_PATH: testDatabasePath
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

  } finally {
    if (serverProcess) {
      serverProcess.kill();
    }
    if (existsSync(testDatabasePath)) {
      rmSync(testDatabasePath, { force: true });
    }
  }
});
