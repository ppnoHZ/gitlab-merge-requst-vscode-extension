import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mainLabels, riskLabels, type WorkbenchStatus } from '@gitlab-workbench/core';
import './style.css';

function App() {
  const [state, setState] = useState<'loading' | 'available' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void fetch('/api/status', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('API unavailable');
      const status: WorkbenchStatus = await response.json();
      if (status.status !== 'ok' || status.gitlab?.connected !== false) throw new Error('Unexpected API response');
      setState('available');
    }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [attempt]);
  return <div className="layout">
    <aside>
      <div className="brand"><span className="mark">G</span><div>GitLab 工作台<small>RELEASE WORKSPACE</small></div></div>
      <div className="nav-caption">工作空间</div>
      <nav aria-label="工作台导航"><a href="#overview" aria-current="page">▦ <span>上线总览</span></a></nav>
      <div className="sidebar-footer"><span className="dot" /> Web 开发版</div>
    </aside>
    <main id="overview">
      <header><div className="breadcrumb">工作空间 <span>/</span> 上线总览</div><span className="connection">尚未连接 GitLab</span></header>
      <section className="heading"><div><p className="eyebrow">RELEASE OVERVIEW</p><h1>每个版本，一目了然。</h1><p>集中查看分支合入进度、发布风险与版本变更。</p></div><span className="edition">Web 工作台</span></section>
      <div className="metrics">{['待上线版本', '待合并 MR', '需要关注'].map((label, i) => <section className="metric" key={label}><span>{label}</span><strong>—</strong><small>{['版本进度', '变更清单', '上线风险'][i]}</small></section>)}</div>
      <section className="releases"><div className="section-title"><h2>版本与变更</h2><span>尚无项目数据</span></div>
        <div className="empty"><div className="empty-icon">⌘</div><h3>从连接你的 GitLab 开始</h3><p>连接公司 GitLab 后，在这里查看项目版本、合并进度和上线风险。</p><div className="tags">{[mainLabels.unmerged, riskLabels.missing, riskLabels.failed].map(label => <span key={label}>{label}</span>)}</div></div>
      </section>
      <footer aria-live="polite"><span className={`dot ${state}`} />{state === 'loading' ? '正在检查工作台服务…' : state === 'available' ? '工作台服务可用 · GitLab 连接尚未接入' : '无法连接工作台服务'}{state === 'error' && <button onClick={() => setAttempt(value => value + 1)}>重试</button>}</footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
