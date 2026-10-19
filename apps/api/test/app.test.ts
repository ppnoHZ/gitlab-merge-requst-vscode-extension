import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app';

test('HTTP API reports health and disconnected state, and rejects unknown routes', async () => {
  const app = createApp();
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), { status: 'ok', service: 'gitlab-workbench-api' });
    assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), { status: 'ok', gitlab: { connected: false, configured: false } });
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
    assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  }
});
