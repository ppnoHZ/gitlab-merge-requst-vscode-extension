import { useEffect, useState } from 'react';
import { branchName, type BranchDraft, type BranchPreview, type BranchCreated, type BranchReference, type BaseKind } from '@gitlab-workbench/core';
import { api, externalLink } from './api';

export function BranchCreator({ projectId, csrfToken, enabled, onCreated }: { projectId: string; csrfToken: string; enabled: boolean; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BranchDraft>({ kind: 'release', version: '', issue: '', description: '', baseKind: 'branch', baseName: '' });
  const [refs, setRefs] = useState<BranchReference[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<BranchPreview>();
  const [result, setResult] = useState<BranchCreated>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void api<{ items: BranchReference[]; hasMore: boolean; defaultBranch?: string }>(`/api/projects/${projectId}/refs?${new URLSearchParams({ kind: draft.baseKind, search: query, page: String(page) })}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setRefs(current => [...new Map([...(page === 1 ? [] : current), ...value.items].map(item => [item.name, item])).values()]);
      setMore(value.hasMore);
      if (page === 1) setDraft(current => ({ ...current, baseName: current.baseName || (current.baseKind === 'branch' && value.items.some(item => item.name === value.defaultBranch) ? value.defaultBranch! : '') }));
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, projectId, draft.baseKind, query, page]);
  function change(patch: Partial<BranchDraft>) { setDraft(value => ({ ...value, ...patch })); setPreview(undefined); setResult(undefined); setError(''); }
  let name = ''; let validation = '';
  try { name = branchName(draft); } catch (reason) { validation = (reason as Error).message; }
  async function send(confirm: boolean) {
    setBusy(true); setError('');
    try {
      const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } };
      if (confirm && preview) {
        const created = await api<BranchCreated>(`/api/projects/${projectId}/branches`, { ...options, body: JSON.stringify({ ticket: preview.ticket }) });
        setResult(created); setPreview(undefined); onCreated();
      } else setPreview(await api<BranchPreview>(`/api/projects/${projectId}/branches/preview`, { ...options, body: JSON.stringify(draft) }));
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  if (!enabled) return <p className="scope-note">创建远程分支需要管理员启用写权限，并重新登录授权。</p>;
  return <section className="branch-creator"><button onClick={() => setOpen(value => !value)} disabled={busy}>{open ? '收起新建分支' : '新建 release / hotfix'}</button>{open && <div>
    <h3>新建远程分支</h3><p>只创建远程分支，不自动创建 MR 或切换本地分支。hotfix 请确认线上基线，必要时选择发布 Tag。</p>
    <fieldset disabled={busy}><div className="actions"><label>场景<select value={draft.kind} onChange={event => change({ kind: event.target.value as 'release' | 'hotfix' })}><option value="release">新建 release</option><option value="hotfix">新建 hotfix</option></select></label><label>版本号<input value={draft.version} onChange={event => change({ version: event.target.value })} placeholder="2.8.0" /></label>{draft.kind === 'hotfix' && <><label>工单号<input value={draft.issue} onChange={event => change({ issue: event.target.value })} placeholder="PROJ-123" /></label><label>描述（可选）<input value={draft.description} onChange={event => change({ description: event.target.value })} placeholder="fix-login" /></label></>}</div>
    <p>分支名称：<code>{name || validation}</code></p>
    <div className="actions"><label>基线类型<select value={draft.baseKind} onChange={event => { change({ baseKind: event.target.value as BaseKind, baseName: '' }); setRefs([]); setPage(1); setSearch(''); setQuery(''); }}><option value="branch">分支</option><option value="tag">Tag</option></select></label><label>搜索基线<input value={search} onChange={event => setSearch(event.target.value)} /></label><button onClick={() => { change({ baseName: '' }); setQuery(search.trim()); setPage(1); }}>搜索</button><label>基线<select value={draft.baseName} onChange={event => change({ baseName: event.target.value })}><option value="">{loading ? '正在加载…' : '请选择基线'}</option>{refs.map(ref => <option key={ref.name} value={ref.name}>{ref.name} · {ref.sha.slice(0, 8)}</option>)}</select></label>{more && <button disabled={loading} onClick={() => setPage(value => value + 1)}>加载更多</button>}</div>
    <button disabled={!name || !draft.baseName || loading} onClick={() => void send(false)}>预览并校验</button></fieldset>
    {preview && <div className="confirmation"><h4>确认创建 {preview.branch}</h4><p>基线：{preview.baseKind === 'tag' ? 'Tag' : '分支'} {preview.base.name}</p><p>提交：<code>{preview.base.sha}</code></p><p>{preview.base.title} {preview.base.committedDate && new Date(preview.base.committedDate).toLocaleString()}</p><p>确认有效期至 {new Date(preview.expiresAt).toLocaleTimeString()}，提交前将重新校验基线。</p><button disabled={busy} onClick={() => void send(true)}>{busy ? '正在处理…' : '确认创建远程分支'}</button><button disabled={busy} onClick={() => setPreview(undefined)}>取消</button></div>}
    {error && <p role="alert" className="warning">{error}</p>}
    {result && <div role="status"><h4>{result.recovered ? '已核对远程分支与确认提交一致' : '远程分支创建成功'}</h4><code>{result.branch}</code><div className="actions">{externalLink(result.webUrl) && <a href={externalLink(result.webUrl)} target="_blank" rel="noopener noreferrer">打开分支</a>}<button onClick={() => { void navigator.clipboard.writeText(result.branch).catch(() => setError('复制失败，请手动复制分支名称')); }}>复制名称</button></div>{result.auditWarning && <p className="warning">分支已创建，但结果审计写入失败，请联系管理员核对；不要重复创建。</p>}<p>{draft.kind === 'hotfix' ? '下一步：修复后创建回主分支的 MR，并同步维护中的 release。' : '下一步：在上线总览查看此版本及同版本功能分支。'}</p></div>}
  </div>}</section>;
}
