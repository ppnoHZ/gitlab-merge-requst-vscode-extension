package com.gitlabworkbench.idea;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.*;
import com.intellij.util.concurrency.AppExecutorUtil;
import com.intellij.util.net.ssl.CertificateManager;
import java.time.Duration;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Consumer;

@Service(Service.Level.PROJECT)
public final class WorkbenchService implements Disposable {
    public record Connection(String instance, String projectPath, String token) {
        public GitLabClient api() {
            return new GitLabClient(instance, token, GitLabClient.clientBuilder(Duration.ofSeconds(20))
                .sslContext(CertificateManager.getInstance().getSslContext()).build());
        }
    }
    private final Project project;
    private final ExecutorService executor = AppExecutorUtil.createBoundedApplicationPoolExecutor("GitLab Workbench", 2);
    private final ScheduledFuture<?> poll;
    private final AtomicBoolean refreshing = new AtomicBoolean();
    private final AtomicBoolean operation = new AtomicBoolean();
    private final AtomicLong generation = new AtomicLong();
    private final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();
    private volatile boolean disposed;
    public volatile GitLabClient.Todos todos = new GitLabClient.Todos(List.of(), List.of());
    public volatile Integer approvals;
    public volatile String status = "请配置 GitLab 地址、项目路径和 Token", updated = "";
    public volatile boolean stale = true;
    public WorkbenchService(Project project) {
        this.project = project;
        poll = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(() -> refresh(false), 1, 60, TimeUnit.SECONDS);
    }
    public WorkbenchSettings settings() { return project.getService(WorkbenchSettings.class); }
    public Connection connection() {
        WorkbenchSettings.Data data = settings().getState();
        final String instance, projectPath;
        synchronized (data) { instance = GitLabClient.normalizeInstance(data.instance); projectPath = data.projectPath.trim(); }
        if (projectPath.isBlank()) throw new IllegalStateException("请先配置项目路径，例如 group/project");
        String token = settings().token(instance);
        if (token == null || token.isBlank()) throw new IllegalStateException("请先在连接设置中保存 Token");
        return new Connection(instance, projectPath, token);
    }
    public boolean busy() { return operation.get(); }
    public void subscribe(Runnable listener, Disposable owner) {
        listeners.add(listener);
        com.intellij.openapi.util.Disposer.register(owner, () -> listeners.remove(listener));
    }
    private void changed() {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (disposed || project.isDisposed()) return;
            listeners.forEach(Runnable::run);
            StatusBar bar = WindowManager.getInstance().getStatusBar(project);
            if (bar != null) bar.updateWidget(ApprovalWidgetFactory.ID);
        });
    }
    public void configure(String instance, String path) {
        WorkbenchSettings.Data data = settings().getState();
        synchronized (data) { data.instance = instance; data.projectPath = path; generation.incrementAndGet(); }
        todos = new GitLabClient.Todos(List.of(), List.of()); approvals = null; updated = ""; stale = true;
        status = "配置已保存，正在加载 GitLab 数据…"; changed();
        refresh(false);
    }
    public void refresh(boolean interactive) {
        if (disposed || !refreshing.compareAndSet(false, true)) return;
        long expected = generation.get();
        status = updated.isEmpty() ? "正在加载待办…" : "正在更新，保留 " + updated + " 的旧数据…"; stale = true; changed();
        executor.submit(() -> {
            try { completeRefresh(expected, connection().api().todos(), null, interactive); }
            catch (RuntimeException error) { completeRefresh(expected, null, error, interactive); }
        });
    }
    private void completeRefresh(long expected, GitLabClient.Todos loaded, RuntimeException error, boolean interactive) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (expected != generation.get() || disposed || project.isDisposed()) return;
                if (error == null) {
                    todos = loaded; approvals = loaded.approvalsComplete() ? loaded.reviews().size() : null; stale = false;
                    updated = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"));
                    status = "我提交 " + loaded.authored().size() + " · 待审批 " + (approvals == null ? "未确认（审批接口不可用）" : approvals) + " · 更新于 " + updated;
                } else {
                    approvals = null; stale = true;
                    status = error.getMessage() + " · 已保存的配置不会丢失" + (updated.isEmpty() ? "" : " · 保留 " + updated + " 的旧数据");
                    if (interactive) notifyError(error);
                }
            } finally {
                refreshing.set(false); changed();
                if (expected != generation.get() && !disposed) refresh(false);
            }
        });
    }
    public <T> void run(Callable<T> task, Consumer<T> success) {
        if (disposed || !operation.compareAndSet(false, true)) return;
        changed(); long expected = generation.get();
        executor.submit(() -> {
            try {
                T value = task.call();
                ApplicationManager.getApplication().invokeLater(() -> {
                    operation.set(false);
                    if (!disposed && !project.isDisposed() && expected == generation.get()) success.accept(value);
                    changed();
                });
            } catch (Exception error) { operation.set(false); if (!disposed) notifyError(error); changed(); }
        });
    }
    public void notifyError(Throwable error) {
        String message = error.getMessage() == null ? "操作失败，请核对 GitLab 连接" : error.getMessage();
        ApplicationManager.getApplication().invokeLater(() -> {
            if (!project.isDisposed()) NotificationGroupManager.getInstance().getNotificationGroup("GitLab Workbench").createNotification(message, NotificationType.ERROR).notify(project);
        });
    }
    @Override public void dispose() { disposed = true; generation.incrementAndGet(); poll.cancel(false); executor.shutdownNow(); listeners.clear(); }
}
