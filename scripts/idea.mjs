import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../apps/idea/', import.meta.url));
const windows = process.platform === 'win32';
const child = spawn(windows ? 'gradlew.bat' : './gradlew', [...process.argv.slice(2), '--no-daemon'], { cwd, stdio: 'inherit', shell: windows });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
