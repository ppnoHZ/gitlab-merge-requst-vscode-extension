import { loadEnvFile } from 'node:process';
import { existsSync } from 'node:fs';
import { createApp } from './app';
import { readGitLabConfig } from './config';

if (existsSync('.env')) loadEnvFile('.env');

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
const server = createApp({ config: readGitLabConfig() });
server.listen(port, host, () => console.log(`GitLab workbench API listening on ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => { process.exitCode = 0; }));
}
