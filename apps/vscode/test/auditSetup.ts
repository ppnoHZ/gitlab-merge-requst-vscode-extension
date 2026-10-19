import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Audit, AuditStore } from '../src/audit';

// Each bundled test process owns and removes only its own temporary audit directory.
const directory = mkdtempSync(path.join(tmpdir(), 'gitlab-mr-audit-test-'));
Audit.configure(new AuditStore(directory, 'test'));
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
