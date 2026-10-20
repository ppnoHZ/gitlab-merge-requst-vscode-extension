import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readGitLabConfig } from '../src/config';

test('configuration reserves unset fields and rejects unsafe/incomplete redirects', () => {
  assert.equal(readGitLabConfig({}), undefined);
  assert.throws(() => readGitLabConfig({ GITLAB_URL: 'https://gitlab.example.com' }), /incomplete/);
  const values = { GITLAB_URL: 'https://gitlab.example.com', GITLAB_CLIENT_ID: 'id', GITLAB_CLIENT_SECRET: 'secret', GITLAB_REDIRECT_URI: 'http://127.0.0.1:5173/api/auth/callback', WEB_ORIGIN: 'http://127.0.0.1:5173' };
  assert.equal(readGitLabConfig(values)?.secureCookies, false);
  assert.throws(() => readGitLabConfig({ ...values, GITLAB_URL: 'http://gitlab.example.com' }), /HTTPS/);
  assert.throws(() => readGitLabConfig({ ...values, GITLAB_REDIRECT_URI: 'https://evil.example.com/api/auth/callback' }), /callback/);
});
