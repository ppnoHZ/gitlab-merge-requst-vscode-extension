import assert from 'assert';
import axios from 'axios';
import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile, appendFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  Audit, AuditApiError, AuditEvent, AuditOperation, AuditStore, AuditWriteError, defaultAuditDirectory
} from '../src/audit';
import { GitLabService } from '../src/gitlabService';
import { TokenManager } from '../src/tokenManager';
import * as vscode from 'vscode';

class FaultingStore extends AuditStore {
  failOn: AuditEvent['phase'] | undefined;
  async append(...args: Parameters<AuditStore['append']>): Promise<AuditEvent> {
    if (args[3] === this.failOn) {
      this.failOn = undefined;
      await rename(this.directory, `${this.directory}.saved`);
      await writeFile(this.directory, 'storage unavailable');
    }
    return super.append(...args);
  }
}

async function runTests(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'gitlab-audit-core-'));
  const originalStore = Audit.storage;
  try {
    assert.equal(defaultAuditDirectory('linux', '/home/example'),
      '/home/example/.local/state/gitlab-mr-tool/audit');
    assert.equal(defaultAuditDirectory('darwin', '/home/example'),
      '/home/example/Library/Application Support/GitLab MR Tool/audit');

    const directory = path.join(root, 'concurrent');
    const stores = [new AuditStore(directory, 'test', 1800), new AuditStore(directory, 'test', 1800)];
    await Promise.all(Array.from({ length: 80 }, (_, index) =>
      stores[index % 2].append(randomUUID(), 'branch.copy', 'normal', 'success', {
        branch: `feature/${index}`, project: index % 2, userId: 7, instance: 'https://user:secret@example.test/?token=secret#secret'
      })));
    const initial = await stores[0].query({}, 10, 15);
    assert.equal(initial.total, 80);
    assert.equal(initial.events.length, 15);
    assert.ok(initial.files > 2, 'size rotation must create multiple independently verifiable streams');
    assert.equal((await stores[0].query({ project: '1', actor: '7', risk: 'normal', search: 'feature/' })).total, 40);
    assert.equal((await stores[0].query({ from: '2999-01-01T00:00:00.000Z' })).total, 0);
    assert.ok(initial.events.every(event => event.context.instance === 'https://example.test/'));
    assert.ok(initial.events.every(event => event.actor.gitlabIdentity === 'verified'));
    if (process.platform !== 'win32') {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(directory, (await readdir(directory))[0]))).mode & 0o777, 0o600);
    }

    const pending = await AuditOperation.begin(stores[0], 'branch.delete', 'high', { branch: 'old' });
    await pending.record('prepared');
    const restarted = new AuditStore(directory, 'restarted');
    await restarted.recover();
    assert.equal((await restarted.query()).unresolved, 1);
    assert.equal((await restarted.query({ phase: 'unresolved' })).events.length, 2);
    assert.equal((await restarted.query({ operationId: pending.id })).total, 2);

    const unsafe = { branch: '=HYPERLINK("bad")', project: '+cmd', source: 'command' as const,
      token: 'NEVER_PERSIST', headers: { Authorization: 'NEVER_PERSIST' }, body: 'CODE_MUST_NOT_BE_LOGGED' };
    await restarted.append(randomUUID(), 'branch.copy', 'normal', 'success', unsafe);
    const csvPath = path.join(root, 'history.csv');
    const exported = await restarted.exportTo(csvPath, 'csv', { search: 'HYPERLINK' });
    assert.equal(exported, 1);
    const csv = await readFile(csvPath, 'utf8');
    assert.ok(csv.includes(`"'=HYPERLINK(""bad"")"`), 'CSV formulas must be neutralized');
    assert.ok(csv.includes(`"'+cmd"`));
    assert.ok(csv.includes('export_summary') && csv.includes('schemaVersion') && csv.includes('count'));
    await assert.rejects(restarted.exportTo(csvPath, 'csv'), /已存在|未知|EEXIST/);
    assert.equal(await readFile(csvPath, 'utf8'), csv, 'existing export must not be overwritten');
    await assert.rejects(restarted.exportTo(path.join(directory, 'output.csv'), 'csv'), /原始审计目录/);
    const jsonPath = path.join(root, 'history.jsonl');
    const jsonCount = await restarted.exportTo(jsonPath, 'jsonl', { action: 'branch.copy' });
    const lines = (await readFile(jsonPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines[0].type, 'export_manifest');
    assert.equal(lines[0].schemaVersion, 1);
    assert.equal(lines.at(-1).count, jsonCount);
    assert.equal(lines.length, jsonCount + 2);
    assert.ok(!JSON.stringify(lines).includes('NEVER_PERSIST'));
    assert.ok(!JSON.stringify(lines).includes('CODE_MUST_NOT_BE_LOGGED'));
    assert.ok((await restarted.query({ action: 'audit.export', phase: 'success' })).total >= 2);

    const corrupt = new AuditStore(path.join(root, 'corrupt'), 'test');
    await corrupt.append(randomUUID(), 'branch.copy', 'normal', 'success', { branch: 'original' });
    const corruptPath = path.join(corrupt.directory, (await readdir(corrupt.directory))[0]);
    const original = await readFile(corruptPath, 'utf8');
    await writeFile(corruptPath, original.replace('original', 'tampered'));
    await assert.rejects(corrupt.query(), /校验失败/);
    assert.equal(corrupt.healthy, false);
    await assert.rejects(corrupt.append(randomUUID(), 'mr.create', 'sensitive', 'prepared', {}), AuditWriteError);
    await assert.rejects(corrupt.recover(), /校验失败/);
    await writeFile(corruptPath, original);
    await corrupt.recover();
    assert.equal(corrupt.healthy, true);
    await appendFile(corruptPath, '{"partial":');
    await assert.rejects(corrupt.query());
    const noNewline = new AuditStore(path.join(root, 'no-newline'));
    await noNewline.append(randomUUID(), 'copy', 'normal', 'success', {});
    const noNewlinePath = path.join(noNewline.directory, (await readdir(noNewline.directory))[0]);
    await writeFile(noNewlinePath, (await readFile(noNewlinePath, 'utf8')).trimEnd());
    await assert.rejects(noNewline.query(), /不完整/);

    let remoteWrites = 0;
    let status = 200;
    let response: unknown;
    let networkError = false;
    let inspectPrepared: (() => Promise<void>) | undefined;
    axios.defaults.adapter = async config => {
      const mutation = config.method === 'post' || config.method === 'delete';
      if (mutation) {
        await inspectPrepared?.();
        remoteWrites++;
        if (networkError) { throw new Error('PRIVATE_TOKEN_NOT_FOR_AUDIT'); }
      }
      const data = mutation ? response : config.url?.endsWith('/main')
        ? { name: 'main', commit: { id: 'main-sha' } }
        : { name: 'feature/test', protected: false, default: false, commit: { id: 'branch-sha' } };
      return { config, data: typeof data === 'string' ? data : JSON.stringify(data),
        status: mutation ? status : 200, statusText: '', headers: {} };
    };
    const service = new GitLabService('https://gitlab.example.test', 'PRIVATE_TOKEN_NOT_FOR_AUDIT');
    const payload = { projectId: 1, sourceBranch: 'feature/test', targetBranch: 'main',
      title: 'TITLE_NOT_FOR_AUDIT', description: 'CODE_NOT_FOR_AUDIT' };
    const createResponse = { iid: 9, title: 'Test', web_url: 'https://gitlab.example.test/mr/9' };
    const effects = [
      () => service.deleteBranch(1, 'feature/test', 'branch-sha', 'main-sha'),
      () => service.approveReview(1, 9, 'a'.repeat(40), 7),
      () => service.createMergeRequest(payload)
    ];
    for (const [index, effect] of effects.entries()) {
      const failing = new FaultingStore(path.join(root, `prepare-failure-${index}`));
      failing.failOn = 'prepared';
      Audit.configure(failing);
      const before = remoteWrites;
      await assert.rejects(effect(), AuditWriteError);
      assert.equal(remoteWrites, before, 'failed durable prepare MUST prevent mutation dispatch');
      assert.equal(failing.healthy, false);
      const saved = new AuditStore(`${failing.directory}.saved`);
      assert.equal((await saved.query({ phase: 'prepared' })).total, 0);
    }
    const post = new FaultingStore(path.join(root, 'post-success'));
    post.failOn = 'success';
    Audit.configure(post);
    response = createResponse;
    const beforeSuccess = remoteWrites;
    await assert.rejects(service.createMergeRequest(payload), error =>
      error instanceof AuditWriteError && error.remoteSucceeded && /已成功/.test(error.message));
    assert.equal(remoteWrites, beforeSuccess + 1);
    await assert.rejects(service.createMergeRequest(payload), AuditWriteError);
    assert.equal(remoteWrites, beforeSuccess + 1, 'post-success audit fault must latch');
    await unlink(post.directory);
    await rename(`${post.directory}.saved`, post.directory);
    await post.recover();
    assert.equal((await post.query()).unresolved, 1, 'unfinished persisted intent remains unknown after restart');
    inspectPrepared = async () => {
      assert.ok((await post.query({ action: 'mr.create', phase: 'prepared' })).total > 0);
    };
    await service.createMergeRequest(payload);
    inspectPrepared = undefined;
    assert.equal((await post.query({ action: 'mr.create', phase: 'success' })).events[0].context.mr, 9);

    for (const code of [403, 409, 500, 408]) {
      status = code;
      response = { message: 'PRIVATE_RESPONSE_MUST_NOT_BE_RECORDED' };
      await assert.rejects(service.createMergeRequest(payload), code < 500 && code !== 408
        ? new RegExp(String(code)) : /结果未知/);
      const result = await post.query({ action: 'mr.create', phase: code < 500 && code !== 408 ? 'failed' : 'unknown' });
      assert.ok(result.events.some(event => event.httpStatus === code));
    }
    status = 200;
    networkError = true;
    await assert.rejects(service.createMergeRequest(payload), /结果未知/);
    networkError = false;
    response = '<html>PRIVATE_RESPONSE_MUST_NOT_BE_RECORDED</html>';
    await assert.rejects(service.createMergeRequest(payload), /结果未知/);
    response = { unconfirmed: true };
    await assert.rejects(service.createMergeRequest(payload), /结果未知/);
    const persisted = (await Promise.all((await readdir(post.directory)).map(name =>
      readFile(path.join(post.directory, name), 'utf8')))).join('');
    for (const secret of ['PRIVATE_TOKEN_NOT_FOR_AUDIT', 'PRIVATE_RESPONSE_MUST_NOT_BE_RECORDED',
      'TITLE_NOT_FOR_AUDIT', 'CODE_NOT_FOR_AUDIT']) {
      assert.ok(!persisted.includes(secret), `${secret} must not enter audit logs`);
    }
    assert.ok(persisted.includes('NETWORK_OR_RESPONSE_UNCONFIRMED'));
    const uncertain = new FaultingStore(path.join(root, 'uncertain-audit-failure'));
    uncertain.failOn = 'unknown';
    Audit.configure(uncertain);
    networkError = true;
    const beforeUncertain = remoteWrites;
    await assert.rejects(service.createMergeRequest(payload), error =>
      error instanceof AuditWriteError && error.effectMayHaveRun && !error.remoteSucceeded && /已发出/.test(error.message));
    assert.equal(remoteWrites, beforeUncertain + 1);
    assert.equal(uncertain.healthy, false);
    networkError = false;

    const commandStore = new AuditStore(path.join(root, 'command'));
    Audit.configure(commandStore);
    const duplicate = await AuditOperation.begin(commandStore, 'write.once', 'sensitive', {});
    let executed = 0;
    const duplicateResults = await Promise.allSettled([
      duplicate.execute(async () => { executed++; }),
      duplicate.execute(async () => { executed++; })
    ]);
    assert.equal(executed, 1, 'same operation must not dispatch concurrent duplicate effects');
    assert.equal(duplicateResults.filter(result => result.status === 'rejected').length, 1);
    await Audit.operation('branch.delete', 'high', {}, async () => false);
    assert.equal((await commandStore.query({ phase: 'cancelled' })).total, 1);
    await assert.rejects(Audit.operation('branch.delete', 'high', {}, async () => {
      throw new Error('private details');
    }));
    assert.equal((await commandStore.query({ phase: 'blocked' })).total, 1);
    await assert.rejects(Audit.operation('mr.create', 'sensitive', {}, () =>
      Audit.sensitive('mr.create', 'sensitive', {}, async () => { throw new AuditApiError('private', 500); })));
    const outcome = await commandStore.query({ action: 'mr.create' });
    assert.deepEqual(outcome.events.map(event => event.phase).sort(), ['confirmed', 'prepared', 'requested', 'unknown']);

    let credentialsWritten = 0;
    const context = {
      secrets: {
        store: async () => { credentialsWritten++; },
        delete: async () => { credentialsWritten++; },
        get: async () => undefined,
        keys: async () => [],
        onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event
      }
    };
    const tokens = new TokenManager(context);
    const tokenFault = new FaultingStore(path.join(root, 'token-failure'));
    tokenFault.failOn = 'prepared';
    Audit.configure(tokenFault);
    await assert.rejects(tokens.setToken('PRIVATE_TOKEN_NOT_FOR_AUDIT'), AuditWriteError);
    await assert.rejects(tokens.clearToken(), AuditWriteError);
    assert.equal(credentialsWritten, 0);
    console.log('[PASS] audit: OS paths, permissions, concurrent windows, rotation, hash validation, truncation, recovery, history filters, export metadata/formula safety/privacy, durable fail-closed API and token boundaries, uncertain outcomes and post-success fault latch');
  } finally {
    Audit.configure(originalStore);
    await rm(root, { recursive: true, force: true });
  }
}

runTests().catch(error => { console.error(error); process.exitCode = 1; });
