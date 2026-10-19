import { spawn } from 'node:child_process';

const children = [
  spawn('npm', ['run', 'dev:api'], { stdio: 'inherit', detached: process.platform !== 'win32' }),
  spawn('npm', ['run', 'dev:web'], { stdio: 'inherit', detached: process.platform !== 'win32' })
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      if (child.pid) process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM');
    } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
  }
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));
for (const child of children) {
  child.on('error', error => { console.error(error); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
