export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { Accept: 'application/json', ...options.headers } });
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new RequestError(response.status, '工作台服务返回了无效响应'); }
  if (!response.ok) throw new RequestError(response.status, typeof (data as { error?: unknown })?.error === 'string' ? (data as { error: string }).error : '请求失败，请重试');
  return data as T;
}
export function externalLink(value: string): string | undefined {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
