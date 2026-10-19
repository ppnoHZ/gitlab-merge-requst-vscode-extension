import { useEffect, useState } from 'react';
import { mainLabels, riskLabels, updatedLabels, normalizeFilters, filterWebReleases, summarizeRelease, featureStateLabels, releaseOverviewMarkdown, filterDescription,
  type WebStatus, type WebProject, type WebProjectPage, type ReleaseOverviewSnapshot, type MainFilter, type RiskFilter, type UpdatedFilter } from '@gitlab-workbench/core';
import { api, RequestError, externalLink } from './api';

export function App() {
  const [status, setStatus] = useState<WebStatus>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [projects, setProjects] = useState<WebProject[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [snapshot, setSnapshot] = useState<ReleaseOverviewSnapshot>();
  const [checking, setChecking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [filters, setFilters] = useState(normalizeFilters());
  const [exportScope, setExportScope] = useState<'all' | 'filtered'>('filtered');
  const connected = status?.gitlab.connected === true;
  function failed(reason: unknown) {
    setError(reason instanceof Error ? reason.message : '请求失败，请重试');
    if (reason instanceof RequestError && reason.status === 401) {
      setStatus(current => current ? { ...current, csrfToken: undefined, gitlab: { ...current.gitlab, connected: false, user: undefined } } : undefined);
      setSnapshot(undefined); setProjects([]); setProjectId('');
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<WebStatus>('/api/status', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setStatus(result); }).catch(reason => { if (!controller.signal.aborted) failed(reason); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    setProjectsLoading(true); setError('');
    if (page === 1) setProjects([]);
    void api<WebProjectPage>(`/api/projects?${new URLSearchParams({ search: query, page: String(page) })}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setProjects(current => [...new Map([...(page === 1 ? [] : current), ...result.items].map(item => [item.id, item])).values()]);
      setHasMore(result.hasMore);
    }).catch(reason => { if (!controller.signal.aborted) failed(reason); })
      .finally(() => { if (!controller.signal.aborted) setProjectsLoading(false); });
    return () => controller.abort();
  }, [connected, query, page, attempt]);
  useEffect(() => {
    setSnapshot(undefined);
    if (!connected || !projectId) { setChecking(false); return; }
    const controller = new AbortController();
    setChecking(true); setError('');
    void api<ReleaseOverviewSnapshot>(`/api/projects/${projectId}/overview`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setSnapshot(result); })
      .catch(reason => { if (!controller.signal.aborted) failed(reason); }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [projectId, connected, refresh]);
  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': status?.csrfToken ?? '' } });
      setSnapshot(undefined); setProjectId(''); setProjects([]); setPage(1); setAttempt(value => value + 1);
      setStatus(undefined);
    } catch (reason) { failed(reason); }
  }
  function toggleMain(key: MainFilter) { setFilters(value => ({ ...value, main: value.main.includes(key) ? value.main.filter(item => item !== key) : [...value.main, key] })); }
  function toggleRisk(key: RiskFilter) { setFilters(value => ({ ...value, risks: value.risks.includes(key) ? value.risks.filter(item => item !== key) : [...value.risks, key] })); }
  const entries = filterWebReleases(snapshot?.entries ?? [], filters);
  const counts = (snapshot?.entries ?? []).map(summarizeRelease);
  function download() {
    if (!snapshot) return;
    const chosen = exportScope === 'all' ? snapshot.entries : entries;
    let text = releaseOverviewMarkdown({ ...snapshot, entries: chosen });
    text = text.replace('# 上线总览\n', `# 上线总览\n\n导出范围：${exportScope === 'all' ? '全部' : '当前筛选 · ' + filterDescription(filters)}\n`);
    if (!chosen.length && exportScope === 'filtered') text = text.replace('未发现 release/<版本> 分支。', '当前筛选没有匹配的 release 分支。');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'release-overview.md'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="layout">
    <aside><div className="brand"><span className="mark">G</span><div>GitLab 工作台<small>RELEASE WORKSPACE</small></div></div><div className="nav-caption">工作空间</div><nav aria-label="工作台导航"><a href="#overview" aria-current="page">▦ <span>上线总览</span></a></nav><div className="sidebar-footer"><span className="dot" /> Web 工作台</div></aside>
    <main id="overview">
      <header><div className="breadcrumb">工作空间 <span>/</span> 上线总览</div><div className="account"><span className="connection">{connected ? status.gitlab.user?.name : '尚未连接 GitLab'}</span>{connected && <button onClick={() => void logout()}>退出登录</button>}</div></header>
      <section className="heading"><div><p className="eyebrow">RELEASE OVERVIEW</p><h1>每个版本，一目了然。</h1><p>集中查看分支合入进度、发布风险与版本变更。</p></div>{!connected && status?.gitlab.configured && <a className="primary" href="/api/auth/login">使用 GitLab 登录</a>}</section>
      {error && <div className="alert" role="alert">{error}<button onClick={() => { setAttempt(value => value + 1); setRefresh(value => value + 1); }}>重试</button></div>}
      {connected && <section className="project-controls"><form onSubmit={event => { event.preventDefault(); setPage(1); setProjectId(''); setSnapshot(undefined); setQuery(search.trim()); }}><label htmlFor="project-search">搜索我的项目</label><div><input id="project-search" value={search} onChange={event => setSearch(event.target.value)} maxLength={200} placeholder="项目名称或路径" /><button type="submit">搜索</button></div></form><label>选择项目<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">{projectsLoading ? '正在加载项目…' : '请选择 GitLab 项目'}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.path_with_namespace}</option>)}</select></label>{hasMore && <button disabled={projectsLoading} onClick={() => setPage(value => value + 1)}>加载更多项目</button>}{!projectsLoading && !projects.length && <p>没有找到可访问的项目，请调整搜索条件或检查 GitLab 项目成员权限。</p>}</section>}
      <div className="metrics">{[['release 分支', snapshot?.entries.length], ['开放 MR', snapshot ? counts.reduce((sum, count) => sum + count.open, 0) : undefined], ['存在风险', snapshot ? snapshot.entries.filter((entry, i) => entry.error || entry.mainError || counts[i].open || counts[i].closed || counts[i]['not-created']).length : undefined]].map(([label, value]) => <section className="metric" key={String(label)}><span>{label}</span><strong>{value ?? '—'}</strong><small>完整数据统计</small></section>)}</div>
      <section className="releases"><div className="section-title"><h2>版本与变更</h2><div className="actions">{snapshot && <span>已筛选 {entries.length} / {snapshot.entries.length}</span>}{projectId && <button disabled={checking} onClick={() => setRefresh(value => value + 1)}>刷新检查</button>}</div></div>
        {snapshot && <div className="filters"><fieldset><legend>main 合入状态</legend>{(Object.keys(mainLabels) as MainFilter[]).map(key => <label key={key}><input type="checkbox" checked={filters.main.includes(key)} onChange={() => toggleMain(key)} />{mainLabels[key]}</label>)}</fieldset><fieldset><legend>上线风险</legend>{(Object.keys(riskLabels) as RiskFilter[]).map(key => <label key={key}><input type="checkbox" checked={filters.risks.includes(key)} onChange={() => toggleRisk(key)} />{riskLabels[key]}</label>)}</fieldset><div className="actions"><label>最近更新时间<select value={filters.updated} onChange={event => setFilters(value => ({ ...value, updated: event.target.value as UpdatedFilter }))}>{(Object.keys(updatedLabels) as UpdatedFilter[]).map(key => <option key={key} value={key}>{updatedLabels[key]}</option>)}</select></label><button onClick={() => setFilters(normalizeFilters())}>清除筛选</button><label>导出范围<select value={exportScope} onChange={event => setExportScope(event.target.value as 'all' | 'filtered')}><option value="filtered">当前筛选</option><option value="all">全部</option></select></label><button onClick={download}>导出 Markdown</button></div><p>同一维度多选取并集，不同维度取交集；时间按 release 最新提交计算。</p></div>}
        {checking ? <div className="empty" role="status"><h3>正在加载上线数据…</h3><p>正在读取全部分支、历史 MR，并检查 release 是否已合入 main。首次拉取仓库可能需要较长时间。</p></div> : snapshot ? <div className="release-list">{!entries.length && <p className="empty">{snapshot.entries.length ? '没有符合条件的上线分支，请调整筛选。' : '项目中没有 release/<版本> 分支。'}</p>}{entries.map(entry => { const count = summarizeRelease(entry); return <article className="release-card" key={entry.branch}><div className="release-heading"><h3>{entry.branch}</h3><span>{entry.error ? 'MR 状态未知' : `已合并 ${count.merged}/${entry.features.length}`}</span></div><p>{entry.mergedIntoMain === undefined ? 'main 状态未知' : entry.mergedIntoMain ? '已合入 main' : '尚未合入 main'}</p>{entry.mainError && <p className="warning">{entry.mainError}</p>}{entry.error && <p className="warning">{entry.error}</p>}{!entry.error && !entry.features.length && <p>无同版本 feature 或历史 MR，无法据此判定可上线。</p>}<ul>{entry.features.map(feature => <li key={feature.branch}><span>{feature.branch}</span><span className={`state ${feature.state}`}>{featureStateLabels[feature.state]}</span>{feature.mergeRequest && externalLink(feature.mergeRequest.web_url) && <a href={externalLink(feature.mergeRequest.web_url)} target="_blank" rel="noopener noreferrer">!{feature.mergeRequest.iid} {feature.mergeRequest.title}</a>}</li>)}</ul></article>; })}<p className="scope-note">仅检查 feature → release 的 MR 与 release → main 的代码合入状态，未校验 CI、审批或部署。MR 已合并不代表后续新增提交已合入。</p></div> : <div className="empty"><div className="empty-icon">⌘</div><h3>{connected ? '选择项目，开始上线检查' : status?.gitlab.configured ? '使用公司 GitLab 账号登录' : '尚未配置 GitLab 连接'}</h3><p>{connected ? '项目数据仅按当前登录账号的权限读取。' : status?.gitlab.configured ? '登录后选择项目，查看真实版本、合并进度和上线风险。' : '请管理员填写预留的 GitLab OAuth 配置，完成后即可登录并读取项目数据。'}</p></div>}
      </section><footer aria-live="polite"><span className={`dot ${error ? 'error' : status ? 'available' : 'loading'}`} />{status ? `工作台服务可用${status.gitlab.instance ? ' · ' + status.gitlab.instance : ''}` : '正在连接工作台服务…'}{snapshot && ` · 更新于 ${new Date(snapshot.updatedAt).toLocaleString()}`}</footer>
    </main>
  </div>;
}
