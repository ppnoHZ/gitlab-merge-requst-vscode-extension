import assert from 'assert';
import axios from 'axios';
import { configuration } from './vscodeMock';
import { Logger } from '../src/logger';
import { debugLog } from '../src/diagnosticLogging';
import { GitLabService } from '../src/gitlabService';
import { GitService } from '../src/gitService';
import { readFileSync } from 'fs';

async function run() {
  const info = Logger.info; const warn = Logger.warn; const error = Logger.error;
  const lines: string[] = [];
  Logger.info = (message, ...args) => { lines.push(message + JSON.stringify(args)); };
  Logger.warn = (message, ...args) => { lines.push(message + JSON.stringify(args)); };
  Logger.error = (message, value) => { lines.push(message + String(value ?? '')); };
  let status = 200;
  const adapter = axios.defaults.adapter;
  axios.defaults.adapter = async config => ({
    config, status, statusText: 'test', headers: {},
    data: JSON.stringify(status === 200 ? { id: 7, username: 'me', name: 'Me' } : { message: 'request refused', private_response_field: 'PRIVATE_RESPONSE_PAYLOAD' })
  });
  try {
    configuration.delete('verboseLogging');
    const service = new GitLabService('https://gitlab.test', 'PRIVATE_TEST_TOKEN');
    for (let i = 0; i < 10; i++) await service.getCurrentUser();
    debugLog('renderer diagnostic', { branch: 'release/v1' });
    await new GitService(process.cwd()).isGitRepo(); // Routine Git reads/failures are also quiet.
    status = 404;
    await assert.rejects(service.getBranchCreationRef(1, 'branch', 'missing'), /404/);
    status = 403;
    await assert.rejects(service.getCurrentUser(), /403/);
    assert.deepEqual(lines, []); // Errors still propagate, but only the operation owner reports them.
    configuration.set('verboseLogging', true);
    status = 200;
    await service.getCurrentUser();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /200 GET \/user/);
    status = 403;
    await assert.rejects(service.getCurrentUser(), /403/);
    assert.equal(lines.length, 2);
    assert(lines.every(line => !line.includes('PRIVATE_RESPONSE_PAYLOAD') && !line.includes('PRIVATE_TEST_TOKEN')));
    debugLog('renderer diagnostic');
    assert.equal(lines.length, 3);
    configuration.set('verboseLogging', false);
    debugLog('disabled immediately');
    assert.equal(lines.length, 3);
    Logger.warn('actionable warning'); Logger.error('operation failed');
    assert(lines.at(-2)?.includes('actionable warning')); assert(lines.at(-1)?.includes('operation failed'));
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    assert.equal(manifest.contributes.configuration.properties['gitlabMr.verboseLogging'].default, false);
  } finally {
    configuration.delete('verboseLogging');
    Logger.info = info; Logger.warn = warn; Logger.error = error; axios.defaults.adapter = adapter;
  }
  console.log('[PASS] logging: default requests/Git/probes are quiet, failures propagate, diagnostics are opt-in without payloads, warnings/errors remain available');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
