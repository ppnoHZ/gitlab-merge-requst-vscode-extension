import assert from 'assert';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AuditStore } from '../src/audit';
import { AuditView } from '../src/auditView';
import { openedDocuments, targetPick, titleInput } from './vscodeMock';

async function runTests(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'gitlab-audit-view-'));
  const store = new AuditStore(path.join(root, 'logs'), 'test');
  const view = new AuditView(store);
  try {
    const operationId = randomUUID();
    for (let index = 0; index < 61; index++) {
      await store.append(index < 2 ? operationId : randomUUID(), index < 2 ? 'mr.create' : 'branch.copy',
        index < 2 ? 'sensitive' : 'normal', index === 0 ? 'requested' : 'success',
        { project: index < 2 ? 'team/project' : 'other/project', branch: `feature/${index}` });
    }
    let items = await view.getChildren();
    assert.equal(items.filter(item => item.event).length, 50);
    assert.ok(items.some(item => item.label === '日志位置（扩展运行主机）'));
    assert.ok(items.some(item => item.command?.command === 'gitlabMr.nextAuditPage'));
    await view.changePage(1);
    items = await view.getChildren();
    assert.equal(items.filter(item => item.event).length, 11);
    assert.ok(items.some(item => item.command?.command === 'gitlabMr.previousAuditPage'));
    assert.ok(!items.some(item => item.command?.command === 'gitlabMr.nextAuditPage'));

    targetPick.value = 'project';
    titleInput.value = 'team/';
    await view.filterHistory();
    items = await view.getChildren();
    assert.equal(items.filter(item => item.event).length, 2, 'filter must reset to first page');
    await view.showOperation(items.find(item => item.event)!);
    const details = JSON.parse(openedDocuments.at(-1)!.content);
    assert.equal(details.operationId, operationId);
    assert.equal(details.events.length, 2);
    assert.equal(details.events[0].phase, 'requested');
    assert.ok(!items.some(item => item.command?.command === 'gitlabMr.nextAuditPage'));
    targetPick.value = 'risk';
    titleInput.value = 'high';
    await view.filterHistory();
    assert.equal((await view.getChildren()).filter(item => item.event).length, 0);
    targetPick.value = 'phase';
    titleInput.value = '__proto__';
    await assert.rejects(view.filterHistory(), /无效操作状态/);
    targetPick.value = 'from';
    titleInput.value = 'not a date';
    await assert.rejects(view.filterHistory(), /ISO 8601/);
    titleInput.value = '2026-10-19T00:00:00';
    await assert.rejects(view.filterHistory(), /ISO 8601/);
    targetPick.value = 'reset';
    await view.filterHistory();
    assert.equal((await view.getChildren()).filter(item => item.event).length, 50);

    const blocker = path.join(root, 'unavailable');
    await writeFile(blocker, 'not a directory');
    const brokenView = new AuditView(new AuditStore(blocker));
    const errors = await brokenView.getChildren();
    assert.ok(errors.some(item => String(item.label).includes('历史读取失败')));
    assert.ok(errors.some(item => String(item.label).includes('敏感操作已暂停')));
    assert.equal(errors.filter(item => item.event).length, 0);
    brokenView.dispose();
    console.log('[PASS] audit view: health/path, 50-event pagination, stacked filters/reset, input validation, operation timeline and explicit history failures');
  } finally {
    view.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

runTests().catch(error => { console.error(error); process.exitCode = 1; });
