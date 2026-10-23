package com.gitlabworkbench.idea;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.*;
import com.intellij.util.Consumer;
import org.jetbrains.annotations.NotNull;
import java.awt.event.MouseEvent;

public final class ApprovalWidgetFactory implements StatusBarWidgetFactory {
    public static final String ID = "GitLabWorkbench.Approvals";
    @Override public @NotNull String getId() { return ID; }
    @Override public @NotNull String getDisplayName() { return "GitLab 待审批 MR"; }
    @Override public boolean isAvailable(@NotNull Project project) { return true; }
    @Override public @NotNull StatusBarWidget createWidget(@NotNull Project project) { return new Widget(project); }
    @Override public void disposeWidget(@NotNull StatusBarWidget widget) { widget.dispose(); }
    @Override public boolean canBeEnabledOn(@NotNull StatusBar statusBar) { return true; }
    private static final class Widget implements StatusBarWidget, StatusBarWidget.TextPresentation {
        private final Project project;
        private final WorkbenchService service;
        Widget(Project project) { this.project = project; service = project.getService(WorkbenchService.class); }
        @Override public @NotNull String ID() { return ID; }
        @Override public WidgetPresentation getPresentation() { return this; }
        @Override public @NotNull String getText() { return service.approvals == null ? "待审批 ?" : (service.approvals > 0 ? "● " : "") + "待审批 " + service.approvals; }
        @Override public float getAlignment() { return 0.5f; }
        @Override public String getTooltipText() { return service.status + "；点击打开 GitLab 工作台。每 60 秒刷新。"; }
        @Override public Consumer<MouseEvent> getClickConsumer() { return event -> {
            ToolWindow window = ToolWindowManager.getInstance(project).getToolWindow("GitLab Workbench");
            if (window != null) window.activate(null);
            service.refresh(true);
        }; }
        @Override public void install(@NotNull StatusBar statusBar) {}
        @Override public void dispose() {}
    }
}
