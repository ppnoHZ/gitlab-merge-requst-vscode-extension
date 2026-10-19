import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import { FileHandle, lstat, mkdir, open, readdir, realpath, unlink } from 'fs/promises';
import { homedir, hostname, userInfo } from 'os';
import * as path from 'path';
import { createInterface } from 'readline';

export type AuditPhase = 'requested' | 'confirmed' | 'prepared' | 'success' | 'failed' | 'unknown' | 'cancelled' | 'blocked';
export type AuditRisk = 'normal' | 'sensitive' | 'high';
export interface AuditContext {
  instance?: string;
  project?: string | number;
  branch?: string;
  sourceBranch?: string;
  targetBranch?: string;
  mr?: number;
  sha?: string;
  mainSha?: string;
  baseSha?: string;
  file?: string;
  userId?: number;
  username?: string;
  reviewers?: number[];
  removeSourceBranch?: boolean;
  squash?: boolean;
  setting?: string;
  source?: 'command' | 'api' | 'configuration' | 'system';
  format?: string;
  count?: number;
}
export interface AuditEvent {
  schemaVersion: 1;
  eventId: string;
  operationId: string;
  timestamp: string;
  session: string;
  stream: string;
  sequence: number;
  sessionSequence: number;
  action: string;
  risk: AuditRisk;
  phase: AuditPhase;
  actor: { osUser: string; host: string; extensionVersion: string; gitlabIdentity: 'verified' | 'unknown' };
  context: AuditContext;
  durationMs: number;
  errorCode?: string;
  httpStatus?: number;
  previousHash: string;
  hash: string;
}
export interface AuditFilter {
  from?: string;
  to?: string;
  project?: string;
  actor?: string;
  action?: string;
  risk?: AuditRisk;
  phase?: AuditPhase | 'unresolved';
  search?: string;
  operationId?: string;
}
export interface AuditQuery {
  events: AuditEvent[];
  total: number;
  unresolved: number;
  bytes: number;
  files: number;
}

export function defaultAuditDirectory(platform = process.platform, home = homedir()): string {
  if (platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'GitLab MR Tool', 'audit');
  }
  return platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'GitLab MR Tool', 'audit')
    : path.join(home, '.local', 'state', 'gitlab-mr-tool', 'audit');
}

export class AuditWriteError extends Error {
  constructor(readonly remoteSucceeded = false, readonly effectMayHaveRun = false) {
    super(remoteSucceeded
      ? '远端/目标操作已成功，但审计结果写入失败。请核对结果，不要重复执行；后续敏感操作已暂停，请修复审计存储。'
      : effectMayHaveRun
      ? '操作已发出，但审计结果写入失败。请到 GitLab/目标位置核对结果，不要重复执行；后续敏感操作已暂停。'
      : '审计存储不可用，已禁止执行敏感操作。请检查操作审计中的存储状态并修复后重试。');
  }
}

export class AuditOutcomeUnknownError extends Error {
  constructor(error: unknown) {
    super(`操作结果未知，可能已生效，请在 GitLab/目标位置核对，不要直接重复执行。${error instanceof Error ? error.message : ''}`);
  }
}

export class AuditBusyError extends Error {
  constructor() { super('其他窗口正在写入审计日志，请稍后刷新或重新校验。'); }
}

export class AuditApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function auditError(error: unknown): { errorCode: string; httpStatus?: number; phase: 'failed' | 'unknown' } {
  if (error instanceof AuditApiError) {
    return {
      errorCode: error.status ? `HTTP_${error.status}` : 'NETWORK_OR_RESPONSE_UNCONFIRMED',
      httpStatus: error.status,
      phase: error.status && error.status >= 400 && error.status < 500 && error.status !== 408 ? 'failed' : 'unknown'
    };
  }
  return { errorCode: 'RESULT_UNCONFIRMED', phase: 'unknown' };
}

const contextKeys: Array<keyof AuditContext> = [
  'instance', 'project', 'branch', 'sourceBranch', 'targetBranch', 'mr', 'sha', 'mainSha', 'baseSha',
  'file', 'userId', 'username', 'reviewers', 'removeSourceBranch', 'squash', 'setting', 'source', 'format', 'count'
];

function safeContext(input: AuditContext): AuditContext {
  const entries = contextKeys.filter(key => input[key] !== undefined).map(key => {
    let value = input[key];
    if (key === 'instance' && typeof value === 'string') {
      const url = new URL(value);
      value = `${url.protocol}//${url.host}${url.pathname}`;
    }
    if (typeof value === 'string') {
      value = value.slice(0, 2048);
    }
    return [key, value];
  });
  return Object.fromEntries(entries);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function matches(event: AuditEvent, filter: AuditFilter, unresolved: Set<string>): boolean {
  return (!filter.from || event.timestamp >= filter.from) && (!filter.to || event.timestamp <= filter.to) &&
    (!filter.operationId || event.operationId === filter.operationId) &&
    (!filter.project || String(event.context.project ?? '').toLowerCase().includes(filter.project.toLowerCase())) &&
    (!filter.actor || `${event.actor.osUser} ${event.context.userId ?? ''} ${event.context.username ?? ''}`
      .toLowerCase().includes(filter.actor.toLowerCase())) &&
    (!filter.action || event.action === filter.action) && (!filter.risk || event.risk === filter.risk) &&
    (!filter.phase || (filter.phase === 'unresolved' ? unresolved.has(event.operationId) : event.phase === filter.phase)) &&
    (!filter.search || JSON.stringify(event.context).toLowerCase().includes(filter.search.toLowerCase()));
}

export class AuditStore {
  readonly session = randomUUID();
  private queue: Promise<void> = Promise.resolve();
  private stream = '';
  private file = '';
  private sequence = 0;
  private sessionSequence = 0;
  private previousHash = '';
  private size = 0;
  private day = '';
  private fault = false;
  private actor: AuditEvent['actor'];
  private listeners = new Set<() => void>();

  constructor(
    readonly directory = defaultAuditDirectory(),
    version = 'unknown',
    private readonly maxFileBytes = 10 * 1024 * 1024
  ) {
    this.actor = { osUser: userInfo().username, host: hostname(), extensionVersion: version, gitlabIdentity: 'unknown' };
  }

  get healthy(): boolean { return !this.fault; }

  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureDirectory(): Promise<void> {
    const created = await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('审计路径必须是独立的实际目录，不能是符号链接。');
    }
    if (created) {
      let parent = path.dirname(path.resolve(this.directory));
      const stop = path.dirname(path.resolve(created));
      for (;;) {
        await this.syncDirectory(parent);
        if (parent === stop) { break; }
        parent = path.dirname(parent);
      }
    }
  }

  private async syncDirectory(directory = this.directory): Promise<void> {
    if (process.platform !== 'win32') {
      const handle = await open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
  }

  async append(
    operationId: string, action: string, risk: AuditRisk, phase: AuditPhase,
    context: AuditContext, durationMs = 0, error?: { errorCode: string; httpStatus?: number }
  ): Promise<AuditEvent> {
    return this.enqueue(async () => {
      if (this.fault) {
        throw new AuditWriteError();
      }
      let handle: FileHandle | undefined;
      try {
        await this.ensureDirectory();
        const today = new Date().toISOString().slice(0, 10);
        const newFile = !this.file || this.day !== today || this.size >= this.maxFileBytes;
        if (newFile) {
          this.stream = `${today}-${this.session}-${randomUUID()}`;
          this.file = path.join(this.directory, `${this.stream}.jsonl`);
          this.sequence = 0;
          this.previousHash = '';
          this.size = 0;
          this.day = today;
          handle = await open(this.file, 'wx', 0o600);
        } else {
          const stat = await lstat(this.file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== this.size) {
            throw new Error('审计文件被删除、替换或修改。');
          }
          handle = await open(this.file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
        }
        const record = {
          schemaVersion: 1 as const, eventId: randomUUID(), operationId, timestamp: new Date().toISOString(),
          session: this.session, stream: this.stream, sequence: this.sequence + 1,
          sessionSequence: this.sessionSequence + 1, action, risk, phase,
          actor: { ...this.actor, gitlabIdentity: context.userId && context.instance ? 'verified' as const : 'unknown' as const },
          context: safeContext(context), durationMs,
          ...(error ? { errorCode: error.errorCode, httpStatus: error.httpStatus } : {}),
          previousHash: this.previousHash
        };
        // Normalize undefined fields before hashing to match the persisted JSON.
        const hash = digest(record);
        const event: AuditEvent = { ...record, hash };
        const line = `${JSON.stringify(event)}\n`;
        if (Buffer.byteLength(line) > 64 * 1024) {
          throw new Error('审计事件超过单行大小限制。');
        }
        await handle.writeFile(line, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        if (newFile) {
          await this.syncDirectory();
        }
        this.sequence++;
        this.sessionSequence++;
        this.previousHash = hash;
        this.size += Buffer.byteLength(line);
        this.notify();
        return event;
      } catch {
        this.fault = true;
        this.notify();
        throw new AuditWriteError();
      } finally {
        if (handle) {
          await handle.close();
        }
      }
    });
  }

  private async scan(visit: (event: AuditEvent) => void | Promise<void>): Promise<{ bytes: number; files: number }> {
    await this.ensureDirectory();
    const names = (await readdir(this.directory)).filter(name => /^[\w-]+\.jsonl$/.test(name)).sort();
    let bytes = 0;
    for (const name of names) {
      const filename = path.join(this.directory, name);
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`审计文件类型无效: ${name}`);
      }
      bytes += stat.size;
      if (stat.size === 0) { continue; }
      let previousHash = '';
      let sequence = 0;
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      // Bound the read to this snapshot; another window can append its own stream.
      const input = handle.createReadStream({ encoding: 'utf8', start: 0, end: stat.size - 1, autoClose: false });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let readBytes = 0;
      try {
        for await (const line of lines) {
          readBytes += Buffer.byteLength(line) + 1;
          if (Buffer.byteLength(line) > 64 * 1024) {
            throw new Error(`审计记录过大: ${name}`);
          }
          const value: unknown = JSON.parse(line);
          if (!value || typeof value !== 'object' || !('hash' in value)) {
            throw new Error(`审计格式无效: ${name}`);
          }
          const { hash, ...body } = value as AuditEvent;
          if (body.schemaVersion !== 1 || body.stream !== name.slice(0, -6) ||
            body.sequence !== ++sequence || body.previousHash !== previousHash || digest(body) !== hash ||
            typeof body.operationId !== 'string' || typeof body.timestamp !== 'string' ||
            !Number.isFinite(Date.parse(body.timestamp)) || !body.context || !body.actor) {
            throw new Error(`审计校验失败: ${name}:${sequence}`);
          }
          previousHash = hash;
          await visit({ ...body, hash });
        }
        if (readBytes !== stat.size) {
          throw new Error(`审计文件末尾不完整或读取时发生变化: ${name}`);
        }
      } catch (error) {
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) { throw new AuditBusyError(); }
        throw error;
      } finally {
        lines.close();
        input.destroy();
        await handle.close();
      }
    }
    return { bytes, files: names.length };
  }

  async query(filter: AuditFilter = {}, offset = 0, limit = 100): Promise<AuditQuery> {
    return this.enqueue(async () => {
      const pending = new Set<string>();
      const terminal = new Set<string>();
      const stats = await this.scan(event => {
        if (event.phase === 'prepared') { pending.add(event.operationId); }
        if (['success', 'failed', 'unknown'].includes(event.phase)) { terminal.add(event.operationId); }
      });
      for (const id of terminal) { pending.delete(id); }
      const events: AuditEvent[] = [];
      let total = 0;
      await this.scan(event => {
        if (!matches(event, filter, pending)) { return; }
        total++;
        events.push(event);
        events.sort((a, b) => b.timestamp.localeCompare(a.timestamp) ||
          b.session.localeCompare(a.session) || b.sessionSequence - a.sessionSequence);
        if (events.length > offset + limit) { events.pop(); }
      });
      return { ...stats, events: events.slice(offset, offset + limit), total, unresolved: pending.size };
    }).catch(error => {
      if (!(error instanceof AuditBusyError)) {
        this.fault = true;
        this.notify();
      }
      throw error;
    });
  }

  async recover(): Promise<void> {
    try {
      await this.enqueue(async () => {
        await this.scan(() => {});
        this.fault = false;
        this.file = '';
      });
      await this.append(randomUUID(), 'audit.health-check', 'normal', 'success', { source: 'system' });
    } catch (error) {
      this.fault = true;
      this.notify();
      throw error;
    }
  }

  async exportTo(destination: string, format: 'jsonl' | 'csv', filter: AuditFilter = {}): Promise<number> {
    await this.query({}, 0, 0);
    await this.ensureDirectory();
    const directory = await realpath(this.directory);
    const parent = await realpath(path.dirname(destination));
    const resolved = path.join(parent, path.basename(destination));
    const relative = path.relative(directory, resolved);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('不能将导出文件写入原始审计目录。');
    }
    const op = await AuditOperation.begin(this, 'audit.export', 'sensitive', { format, source: 'command' });
    return op.execute(async () => this.enqueue(async () => {
      let handle: FileHandle | undefined;
      let created = false;
      let count = 0;
      try {
        handle = await open(resolved, 'wx', 0o600);
        created = true;
        const manifest = { type: 'export_manifest', schemaVersion: 1, exportedAt: new Date().toISOString(), filter };
        if (format === 'jsonl') {
          await handle.writeFile(`${JSON.stringify(manifest)}\n`);
        } else {
          await handle.writeFile('\uFEFFtimestamp,operationId,action,risk,phase,osUser,host,instance,project,mr,branch,userId,sha,context,errorCode\r\n');
        }
        // Export is a snapshot: serialized writes cannot interleave with this scan.
        const query = new Set<string>();
        const terminal = new Set<string>();
        await this.scan(event => {
          if (event.phase === 'prepared') { query.add(event.operationId); }
          if (['success', 'failed', 'unknown'].includes(event.phase)) { terminal.add(event.operationId); }
        });
        for (const id of terminal) { query.delete(id); }
        await this.scan(async event => {
          if (!matches(event, filter, query)) { return; }
          count++;
          if (format === 'jsonl') {
            await handle!.writeFile(`${JSON.stringify(event)}\n`);
          } else {
            const values = [event.timestamp, event.operationId, event.action, event.risk, event.phase,
              event.actor.osUser, event.actor.host, event.context.instance, event.context.project,
              event.context.mr, event.context.branch, event.context.userId, event.context.sha,
              JSON.stringify(event.context), event.errorCode];
            await handle!.writeFile(`${values.map(csvCell).join(',')}\r\n`);
          }
        });
        const footer = { type: 'export_summary', schemaVersion: 1, count, filter, exportedAt: manifest.exportedAt };
        if (format === 'jsonl') {
          await handle.writeFile(`${JSON.stringify(footer)}\n`);
        } else {
          const metadata = [manifest.exportedAt, '', 'export_summary', '', '', '', '', '', '', '', '', '', '',
            JSON.stringify(footer), ''];
          await handle.writeFile(`${metadata.map(csvCell).join(',')}\r\n`);
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        return count;
      } catch (error) {
        if (handle) { await handle.close(); handle = undefined; }
        if (created) { await unlink(resolved); }
        throw error;
      } finally {
        if (handle) { await handle.close(); }
      }
    }), count => ({ count }));
  }
}

function csvCell(value: unknown): string {
  let text = value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) { text = `'${text}`; }
  return `"${text.replace(/"/g, '""')}"`;
}

export class AuditOperation {
  readonly id = randomUUID();
  private start = Date.now();
  private executed = false;
  private terminal = false;

  private constructor(
    private store: AuditStore, readonly action: string, private risk: AuditRisk, private context: AuditContext
  ) {}

  static async begin(store: AuditStore, action: string, risk: AuditRisk, context: AuditContext): Promise<AuditOperation> {
    const op = new AuditOperation(store, action, risk, context);
    await op.record('requested');
    return op;
  }

  async record(phase: AuditPhase, context: AuditContext = {}, error?: { errorCode: string; httpStatus?: number }): Promise<void> {
    this.context = { ...this.context, ...context };
    await this.store.append(this.id, this.action, this.risk, phase, this.context, Date.now() - this.start, error);
    if (['cancelled', 'blocked'].includes(phase)) { this.terminal = true; }
  }

  async finish(phase: 'success' | 'cancelled' | 'blocked', error?: { errorCode: string; httpStatus?: number }): Promise<void> {
    if (!this.terminal) {
      await this.record(phase, {}, error);
      this.terminal = true;
    }
  }

  async execute<T>(effect: () => Promise<T>, resultContext?: (result: T) => AuditContext): Promise<T> {
    if (this.executed) {
      throw new Error('同一审计操作不能重复执行写入。');
    }
    this.executed = true;
    await this.record('prepared');
    let result: T;
    try {
      result = await effect();
    } catch (error) {
      const classification = auditError(error);
      try {
        await this.store.append(this.id, this.action, this.risk, classification.phase, this.context,
          Date.now() - this.start, classification);
        this.terminal = true;
      } catch {
        throw new AuditWriteError(false, true);
      }
      throw classification.phase === 'unknown' ? new AuditOutcomeUnknownError(error) : error;
    }
    try {
      await this.record('success', resultContext?.(result));
      this.terminal = true;
    } catch {
      throw new AuditWriteError(true);
    }
    return result;
  }
}

export class Audit {
  private static store = new AuditStore();
  private static ambient = new AsyncLocalStorage<AuditOperation>();

  static configure(store: AuditStore): void { this.store = store; }
  static get storage(): AuditStore { return this.store; }

  static async note(phase: AuditPhase, context: AuditContext = {}): Promise<void> {
    const op = this.ambient.getStore();
    if (op) { await op.record(phase, context); }
  }

  static async operation<T>(action: string, risk: AuditRisk, context: AuditContext, effect: () => Promise<T>): Promise<T> {
    const op = await AuditOperation.begin(this.store, action, risk, context);
    return this.ambient.run(op, async () => {
      try {
        const result = await effect();
        await op.finish(result === false ? 'cancelled' : 'success');
        return result;
      } catch (error) {
        if (!(error instanceof AuditWriteError)) {
          await op.finish('blocked', error instanceof AuditApiError
            ? { errorCode: 'PREFLIGHT_API_ERROR', httpStatus: error.status }
            : { errorCode: 'PRECONDITION_OR_VALIDATION_FAILED' });
        }
        throw error;
      }
    });
  }

  static async sensitive<T>(
    action: string, risk: AuditRisk, context: AuditContext, effect: () => Promise<T>,
    resultContext?: (result: T) => AuditContext
  ): Promise<T> {
    let op = this.ambient.getStore();
    if (!op || op.action !== action) {
      op = await AuditOperation.begin(this.store, action, risk, context);
    } else {
      await op.record('confirmed', context);
    }
    return op.execute(effect, resultContext);
  }

  static async event(action: string, context: AuditContext, risk: AuditRisk = 'normal'): Promise<void> {
    await this.store.append(randomUUID(), action, risk, 'success', context);
  }
}
