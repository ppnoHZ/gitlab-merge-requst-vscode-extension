import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToString } from 'react-dom/server';
import { App } from '../src/App';
import { api, externalLink, RequestError } from '../src/api';
import { filterWebReleases, normalizeFilters, type ReleaseOverviewEntry } from '@gitlab-workbench/core';

test('Web transport keeps credentials same-origin and surfaces expired authorization', async () => {
  const original = globalThis.fetch;
  let options: RequestInit | undefined;
  globalThis.fetch = async (_path, init) => { options = init; return new Response(JSON.stringify({ error: '请重新登录' }), { status: 401 }); };
  try {
    await assert.rejects(api('/api/projects'), error => error instanceof RequestError && error.status === 401 && error.message === '请重新登录');
    assert.equal(options?.credentials, 'same-origin');
    globalThis.fetch = async () => new Response('<html>wrong proxy</html>', { status: 502 });
    await assert.rejects(api('/api/projects'), /无效响应/);
    globalThis.fetch = async () => new Response(JSON.stringify({ items: [], hasMore: false }));
    assert.deepEqual(await api('/api/projects'), { items: [], hasMore: false });
  } finally { globalThis.fetch = original; }
});

test('Web renders disconnected state without invented projects and rejects unsafe MR URLs', () => {
  const html = renderToString(<App />);
  assert(html.includes('尚未配置 GitLab 连接'));
  assert(!html.includes('api/auth/login'));
  assert.equal(externalLink('javascript:alert(1)'), undefined);
  assert.equal(externalLink('https://user:password@gitlab.example.test/mr/1'), undefined);
  assert.equal(externalLink('https://gitlab.example.test/mr/1'), 'https://gitlab.example.test/mr/1');
});

test('Web filters preserve complete release data and match unknown states conservatively', () => {
  const entries: ReleaseOverviewEntry[] = [
    { branch: 'release/v1', version: 'v1', features: [{ branch: 'feature/v1/a', state: 'not-created' }, { branch: 'feature/v1/b', state: 'merged' }], mergedIntoMain: false },
    { branch: 'release/v2', version: 'v2', features: [], error: 'MR unavailable', mainError: 'Git unavailable' }
  ];
  const filtered = filterWebReleases(entries, normalizeFilters({ main: ['unmerged'], risks: ['missing', 'closed'] }));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].features.length, 2);
  assert.equal(filterWebReleases(entries, normalizeFilters({ main: ['unknown'], risks: ['failed'] }))[0].branch, 'release/v2');
  assert.equal(entries.length, 2);
});
