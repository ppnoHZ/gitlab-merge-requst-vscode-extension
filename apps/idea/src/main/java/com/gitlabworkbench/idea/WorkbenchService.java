package com.gitlabworkbench.idea;

import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.*;
import com.intellij.util.concurrency.AppExecutorUtil;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.function.Consumer;

@Service(Service.Level.PROJECT)
public final class WorkbenchService implements Disposable {
    public record Connection(String instance, String projectPath, String token) { public GitLabClient api() { return new GitLabClient(instance, token); } }
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
        String instance = GitLabClient.normalizeInstance(data.instance);
        if (data.projectPath.isBlank()) throw new IllegalStateException("请先配置项目路径，例如 group/project");
        String token = settings().token(instance);
        if (token == null || token.isBlank()) throw new IllegalStateException("请先在连接设置中保存 Token");
        return new Connection(instance, data.projectPath.trim(), token);
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
        generation.incrementAndGet();
        settings().getState().instance = instance;
        settings().getState().projectPath = path;
        todos = new GitLabClient.Todos(List.of(), List.of()); approvals = null; updated = ""; stale = true;
        status = "连接已更新，正在加载…"; changed();
        refresh(false);
    }
    public void refresh(boolean interactive) {
        if (disposed || !refreshing.compareAndSet(false, true)) return;
        long expected = generation.get();
        status = updated.isEmpty() ? "正在加载待办…" : "正在更新，保留 " + updated + " 的旧数据…"; stale = true; changed();
        executor.submit(() -> {
            try {
                GitLabClient.Todos loaded = connection().api().todos();
                if (expected != generation.get() || disposed) return;
                todos = loaded; approvals = loaded.reviews().size(); stale = false;
                updated = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"));
                status = "我提交 " + loaded.authored().size() + " · 待审批 " + approvals + " · 更新于 " + updated;
            } catch (RuntimeException error) {
                if (expected != generation.get() || disposed) return;
                approvals = null; stale = true;
                status = error.getMessage() + (updated.isEmpty() ? "" : " · 保留 " + updated + " 的旧数据");
                if (interactive) notifyError(error);
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
