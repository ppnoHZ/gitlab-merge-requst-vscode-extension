import { createServer } from 'node:http';
import type { WorkbenchStatus } from '@gitlab-workbench/core';

export function createApp() {
  return createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && request.url === '/api/health') {
      response.end(JSON.stringify({ status: 'ok', service: 'gitlab-workbench-api' }));
    } else if (request.method === 'GET' && request.url === '/api/status') {
      const status: WorkbenchStatus = { status: 'ok', gitlab: { connected: false } };
      response.end(JSON.stringify(status));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Not found' }));
    }
  });
}
