package com.gitlabworkbench.idea;

import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.wm.*;
import com.intellij.ui.JBColor;
import com.intellij.ui.components.*;
import com.intellij.ui.content.ContentFactory;
import org.jetbrains.annotations.NotNull;
import javax.swing.*;
import java.awt.*;
import java.util.*;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.function.Consumer;

public final class WorkbenchToolWindow implements ToolWindowFactory {
    @Override public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow window) {
        Panel panel = new Panel(project);
        var content = ContentFactory.getInstance().createContent(panel, "", false);
        content.setDisposer(panel); window.getContentManager().addContent(content);
    }
    private record Todo(String category, GitLabClient.Mr mr) { @Override public String toString() { return category + " · !" + mr.iid() + " " + mr.title() + (mr.conflict() ? " · 有冲突" : "") + " · " + mr.source() + " → " + mr.target(); } }
    private record Prepared(WorkbenchService.Connection connection, GitLabClient.Repo repo, GitLabClient.Ref base, String name, String kind) {}
    private record ConflictPreview(WorkbenchService.Connection connection, GitLabClient.Mr original, GitLabClient.Ref target) {}
    private record Replacement(WorkbenchService.Connection connection, WorkbenchSettings.Conflict task, GitLabClient.Mr original, GitLabClient.Ref source, GitLabClient.Ref target, String description, GitLabClient.Mr existing) {}
    private static final class Panel extends JPanel implements Disposable {
        private final Project project;
        private final WorkbenchService service;
        private final JLabel status = new JBLabel();
        private final JLabel branchStatus = new JBLabel("请加载分支");
        private final JTextField search = new JBTextField();
        private final DefaultListModel<GitLabClient.Ref> branches = new DefaultListModel<>();
        private final JList<GitLabClient.Ref> branchList = new JBList<>(branches);
        private final DefaultListModel<Todo> todos = new DefaultListModel<>();
        private final JList<Todo> todoList = new JBList<>(todos);
        private final List<JButton> buttons = new ArrayList<>();
        private final JButton more;
        private final javax.swing.tree.DefaultMutableTreeNode branchRoot = new javax.swing.tree.DefaultMutableTreeNode("远程分支");
        private final JTree branchTree = new JTree(branchRoot);
        private final JCheckBox commonOnly = new JCheckBox("仅常用分支", true);
        private GitLabClient.Todos displayed;
        private GitLabClient.Repo repo;
        private String loadedInstance = "", loadedPath = "", loadedSearch = "";
        private int next;
        private boolean disposed, branchLoading;
        Panel(Project project) {
            super(new BorderLayout(0, 6)); this.project = project; service = project.getService(WorkbenchService.class);
            JPanel actions = new JPanel(new FlowLayout(FlowLayout.LEFT));
            actions.add(button("连接设置", this::configure));
            actions.add(button("刷新待办", () -> service.refresh(true)));
            actions.add(button("新建 release", () -> createBranch("release")));
            actions.add(button("新建 hotfix", () -> createBranch("hotfix")));
            add(actions, BorderLayout.NORTH);
            JTabbedPane tabs = new JTabbedPane();
            JPanel branchPanel = new JPanel(new BorderLayout(0, 4));
            JPanel query = new JPanel(new BorderLayout()); query.add(search, BorderLayout.CENTER); query.add(button("搜索 / 刷新", () -> loadBranches(false)), BorderLayout.EAST);
            search.setToolTipText("分支关键词；可用 ^ 表示前缀，例如 ^release/"); search.addActionListener(event -> loadBranches(false));
            branchPanel.add(query, BorderLayout.NORTH);
            branchList.setCellRenderer(new DefaultListCellRenderer() {
                @Override public Component getListCellRendererComponent(JList<?> list, Object value, int index, boolean selected, boolean focus) {
                    super.getListCellRendererComponent(list, value, index, selected, focus);
                    GitLabClient.Ref ref = (GitLabClient.Ref)value; setText(ref.name() + "  " + ref.sha().substring(0, 8)); return this;
                }
            });
            branchTree.setRootVisible(false);
            branchTree.setShowsRootHandles(true);
            branchPanel.add(new JBScrollPane(branchTree), BorderLayout.CENTER);
            JPanel branchActions = new JPanel(new FlowLayout(FlowLayout.LEFT));
            branchActions.add(commonOnly); commonOnly.addActionListener(event -> rebuildBranchTree());
            branchActions.add(button("复制名称", () -> {
                var node = (javax.swing.tree.DefaultMutableTreeNode)branchTree.getLastSelectedPathComponent();
                if (node == null || !(node.getUserObject() instanceof GitLabClient.Ref ref)) throw new IllegalStateException("请选择分支，不能选择目录");
                com.intellij.openapi.ide.CopyPasteManager.getInstance().setContents(new java.awt.datatransfer.StringSelection(ref.name()));
            }));
            branchActions.add(button("打开分支", () -> {
                var node = (javax.swing.tree.DefaultMutableTreeNode)branchTree.getLastSelectedPathComponent();
                if (node == null || !(node.getUserObject() instanceof GitLabClient.Ref ref)) throw new IllegalStateException("请选择分支");
                BrowserUtil.browse(loadedInstance + "/" + loadedPath + "/-/tree/" + java.net.URLEncoder.encode(ref.name(), java.nio.charset.StandardCharsets.UTF_8));
            }));
            query.add(branchActions, BorderLayout.SOUTH);
            JPanel branchFooter = new JPanel(new BorderLayout()); more = button("加载更多", () -> loadBranches(true)); branchFooter.add(more, BorderLayout.EAST); branchFooter.add(branchStatus, BorderLayout.CENTER); branchPanel.add(branchFooter, BorderLayout.SOUTH);
            branchActions.add(button("检查分支 / release", this::inspectBranch));
            branchActions.add(button("创建 MR", this::createBranchMr));
            tabs.addTab("分支管理", branchPanel);
            JPanel todoPanel = new JPanel(new BorderLayout());
            todoList.setCellRenderer(new DefaultListCellRenderer() {
                @Override public Component getListCellRendererComponent(JList<?> list, Object value, int index, boolean selected, boolean focus) {
                    super.getListCellRendererComponent(list, value, index, selected, focus);
                    Todo todo = (Todo)value;
                    if (todo.mr.conflict()) { setForeground(JBColor.RED); setIcon(com.intellij.icons.AllIcons.General.Error); }
                    else setIcon(com.intellij.icons.AllIcons.Vcs.Branch);
                    setToolTipText(todo.mr.url()); return this;
                }
            });
            todoPanel.add(new JBScrollPane(todoList), BorderLayout.CENTER);
            JPanel mrActions = new JPanel(new FlowLayout(FlowLayout.LEFT));
            mrActions.add(button("打开 MR", () -> BrowserUtil.browse(selected().url())));
            mrActions.add(button("创建 conflict", this::createConflict));
            mrActions.add(button("关闭原冲突 MR", this::closeOriginal));
            mrActions.add(button("替代 MR / 处理指引", this::replacement));
            todoPanel.add(mrActions, BorderLayout.SOUTH); tabs.addTab("我的待办", todoPanel);
            add(tabs, BorderLayout.CENTER); add(status, BorderLayout.SOUTH);
            service.subscribe(this::render, this); render();
            if (!service.settings().getState().projectPath.isBlank()) loadBranches(false);
        }
        private JButton button(String label, Runnable action) {
            JButton button = new JButton(label); buttons.add(button);
            button.addActionListener(event -> { try { action.run(); } catch (RuntimeException error) { service.notifyError(error); } }); return button;
        }
        private void render() {
            if (disposed) return;
            if (branchLoading && !service.busy()) { branchLoading = false; branchStatus.setText("加载未完成，保留已有分支；请重试"); }
            status.setText(service.status); status.setToolTipText(service.status);
            buttons.forEach(button -> button.setEnabled(!service.busy())); more.setEnabled(!service.busy() && next > 0);
            WorkbenchSettings.Data config = service.settings().getState();
            if (!loadedInstance.isEmpty() && (!loadedInstance.equals(config.instance) || !loadedPath.equals(config.projectPath))) {
                branches.clear(); rebuildBranchTree(); next = 0; repo = null; branchStatus.setText("连接已变更，请重新加载分支"); more.setEnabled(false);
            }
            if (displayed != service.todos) {
                Todo selection = todoList.getSelectedValue(); displayed = service.todos; todos.clear();
                displayed.reviews().forEach(mr -> todos.addElement(new Todo(displayed.approvalsComplete() ? "待我审批" : "指派给我（审批状态未确认）", mr)));
                displayed.authored().forEach(mr -> todos.addElement(new Todo("我提交的", mr)));
                if (selection != null) for (int i = 0; i < todos.size(); i++) if (todos.get(i).mr.key().equals(selection.mr.key()) && todos.get(i).category.equals(selection.category)) todoList.setSelectedIndex(i);
            }
        }
        private <T> void run(Callable<T> action, Consumer<T> success) { service.run(action, value -> { if (!disposed) { try { success.accept(value); } catch (RuntimeException error) { service.notifyError(error); } } }); }
        private boolean confirm(String message, String title) { return Messages.showYesNoDialog(project, message, title, "确认", "取消", Messages.getQuestionIcon()) == Messages.YES; }
        private GitLabClient.Mr selected() { Todo value = todoList.getSelectedValue(); if (value == null) throw new IllegalStateException("请先选择 MR"); return value.mr; }
        private GitLabClient.Mr selectedFresh() { if (service.stale) throw new IllegalStateException("待办正在更新或显示旧数据，请刷新成功后重试"); return selected(); }
        private void configure() {
            if (new ConnectionDialog(project, service).showAndGet()) loadBranches(false);
        }
        private void loadBranches(boolean append) {
            if (service.busy()) return;
            String query = append ? loadedSearch : search.getText().trim(); int page = append ? next : 1;
            if (page == 0) return;
            branchLoading = true; branchStatus.setText("正在加载，保留已有分支…");
            run(() -> { var connection = service.connection(); var api = connection.api(); var project = api.project(connection.projectPath()); return new Object[]{connection, project, api.allBranches(project.id(), query)}; }, result -> {
                branchLoading = false;
                var connection = (WorkbenchService.Connection)result[0]; repo = (GitLabClient.Repo)result[1];
                @SuppressWarnings("unchecked") var refs = (List<GitLabClient.Ref>)result[2];
                branches.clear(); refs.forEach(branches::addElement); rebuildBranchTree();
                next = 0; loadedSearch = query; loadedInstance = connection.instance(); loadedPath = connection.projectPath();
                branchStatus.setText("已加载 " + branches.size() + " 个远程分支"); render();
            });
        }
        private GitLabClient.Ref selectedBranch() {
            var node = (javax.swing.tree.DefaultMutableTreeNode)branchTree.getLastSelectedPathComponent();
            if (node == null || !(node.getUserObject() instanceof GitLabClient.Ref ref)) throw new IllegalStateException("请选择真实分支");
            if (!loadedInstance.equals(service.settings().getState().instance) || !loadedPath.equals(service.settings().getState().projectPath)) throw new IllegalStateException("连接已变化，请刷新");
            return ref;
        }
        private void inspectBranch() {
            var selected = selectedBranch();
            run(() -> {
                var api = service.connection().api(); var source = api.ref(repo.id(), "branch", selected.name());
                var requests = api.targetingMrs(repo.id(), selected.name());
                StringBuilder text = new StringBuilder("分支：" + source.name() + "\nSHA：" + source.sha() + "\n\n以此分支为目标的 MR：\n");
                for (var mr : requests) text.append("!").append(mr.iid()).append(" · ").append(mr.state()).append(" · ").append(mr.source()).append("\n").append(mr.url()).append("\n");
                if (source.name().startsWith("release/")) {
                    String version = source.name().split("/")[1];
                    text.append("\n同版本 feature 分支：\n");
                    for (var feature : api.allBranches(repo.id(), "^feature/" + version + "/")) {
                        if (!feature.name().startsWith("feature/" + version + "/")) continue;
                        var matching = requests.stream().filter(mr -> mr.source().equals(feature.name())).toList();
                        text.append(feature.name()).append(" · ").append(matching.isEmpty() ? "尚未创建 MR" : matching.stream().map(mr -> "!" + mr.iid() + " " + mr.state()).toList()).append("\n");
                    }
                }
                return text.toString();
            }, text -> new TextDialog(project, "分支检查", "分支检查", text, false).showAndGet());
        }
        private void createBranchMr() {
            var selected = selectedBranch();
            String target = Messages.showInputDialog(project, "目标分支", "创建 MR", Messages.getQuestionIcon());
            if (target == null || target.isBlank()) return;
            run(() -> {
                var api = service.connection().api(); var source = api.ref(repo.id(), "branch", selected.name()); var destination = api.ref(repo.id(), "branch", target.trim());
                var diff = api.compare(repo.id(), source.sha(), destination.sha());
                return new Object[]{source, destination, BranchRules.description(source.name(), destination.name(), diff.commits(), diff.files(), "")};
            }, preview -> {
                var source = (GitLabClient.Ref)preview[0]; var destination = (GitLabClient.Ref)preview[1];
                TextDialog dialog = new TextDialog(project, "创建 MR", source.name() + " 合并到 " + destination.name(), (String)preview[2], true);
                if (!dialog.showAndGet() || !confirm("确认创建 " + source.name() + " → " + destination.name() + "？", "创建 MR")) return;
                run(() -> {
                    var api = service.connection().api();
                    if (!api.ref(repo.id(), "branch", source.name()).sha().equals(source.sha()) || !api.ref(repo.id(), "branch", destination.name()).sha().equals(destination.sha())) throw new IllegalStateException("分支已变化，请重新预览");
                    return api.createBranchMr(repo.id(), source.name(), destination.name(), dialog.title.getText(), dialog.text.getText());
                }, mr -> BrowserUtil.browse(mr.url()));
            });
        }

        private void rebuildBranchTree() {
            branchRoot.removeAllChildren();
            List<GitLabClient.Ref> sorted = new ArrayList<>();
            for (int i = 0; i < branches.size(); i++) sorted.add(branches.get(i));
            sorted.sort(Comparator.comparing(GitLabClient.Ref::name));
            for (var ref : sorted) {
                if (commonOnly.isSelected() && !ref.name().matches("^(feature|release|bugfix|hotfix|conflict)/.*|^(main|dev|tst|uat|pre)$")) continue;
                String[] parts = ref.name().split("/");
                var parent = branchRoot;
                for (int i = 0; i < parts.length - 1; i++) {
                    javax.swing.tree.DefaultMutableTreeNode found = null;
                    for (int j = 0; j < parent.getChildCount(); j++) {
                        var child = (javax.swing.tree.DefaultMutableTreeNode)parent.getChildAt(j);
                        if (parts[i].equals(child.getUserObject())) { found = child; break; }
                    }
                    if (found == null) { found = new javax.swing.tree.DefaultMutableTreeNode(parts[i]); parent.add(found); }
                    parent = found;
                }
                parent.add(new javax.swing.tree.DefaultMutableTreeNode(ref) {
                    @Override public String toString() { return parts[parts.length - 1] + " · " + ref.sha().substring(0, 8); }
                });
            }
            ((javax.swing.tree.DefaultTreeModel)branchTree.getModel()).reload();
        }
        private void createBranch(String kind) {
            var selectedNode = (javax.swing.tree.DefaultMutableTreeNode)branchTree.getLastSelectedPathComponent();
            String defaultBase = selectedNode != null && selectedNode.getUserObject() instanceof GitLabClient.Ref ref ? ref.name() : repo == null ? "main" : repo.defaultBranch();
            Fields dialog = new Fields(project, "新建 " + kind, new String[]{"基线类型（branch / tag）", "基线名称（hotfix 建议使用线上 Tag）", "版本号", "工单号（hotfix 必填）", "英文短描述（可选）"}, new String[]{"branch", defaultBase, "", "", ""}, -1);
            if (!dialog.showAndGet()) return;
            String baseKind = dialog.value(0).trim(), baseName = dialog.value(1).trim();
            if (!Set.of("branch", "tag").contains(baseKind)) throw new IllegalArgumentException("基线类型必须是 branch 或 tag");
            String name = BranchRules.development(kind, dialog.value(2), dialog.value(3), dialog.value(4));
            run(() -> { var connection = service.connection(); var api = connection.api(); var project = api.project(connection.projectPath()); return new Prepared(connection, project, api.ref(project.id(), baseKind, baseName), name, baseKind); }, prepared -> {
                if (!confirm("项目：" + prepared.repo.path() + "\n分支：" + name + "\n基线：" + prepared.base.name() + "\nSHA：" + prepared.base.sha() + "\n只创建远程分支。", "确认创建")) return;
                run(() -> prepared.connection.api().createBranch(prepared.repo.id(), name, prepared.kind, prepared.base.name(), prepared.base.sha()), created -> {
                    Messages.showInfoMessage(project, "已创建：" + created.name(), "分支创建成功"); loadBranches(false);
                });
            });
        }
        private void createConflict() {
            GitLabClient.Mr selected = selectedFresh();
            run(() -> {
                var connection = service.connection(); var api = connection.api(); var current = api.mr(selected.project(), selected.iid()); current.requireConflict();
                GitLabClient.sameVersion(selected, current);
                var source = api.ref(current.project(), "branch", current.source());
                if (!source.sha().equals(current.sha())) throw new IllegalStateException("Source 与 MR 提交尚未同步，请刷新");
                return new ConflictPreview(connection, current, api.ref(current.project(), "branch", current.target()));
            }, preview -> {
                String branch = BranchRules.conflict(preview.original.source());
                WorkbenchSettings.Conflict existing = tasks().stream().filter(task -> task.instance.equals(preview.connection.instance()) && task.project == preview.original.project() && task.branch.equals(branch)).findFirst().orElse(null);
                if (existing != null) {
                    if (existing.originalIid != preview.original.iid() || !existing.target.equals(preview.original.target())) throw new IllegalStateException("同名 conflict 属于另一处理任务，不能复用");
                    showGuide(existing); return;
                }
                if (!confirm("原 MR：!" + preview.original.iid() + "\n" + preview.original.source() + " → " + preview.original.target() + "\n从 Target 创建：" + branch + "\n基线 SHA：" + preview.target.sha() + "\n请按规范关闭原 MR；此按钮不会关闭 MR 或执行本地 Git 操作。", "创建 conflict")) return;
                run(() -> {
                    var api = preview.connection.api(); var current = api.mr(preview.original.project(), preview.original.iid()); current.requireConflict(); GitLabClient.sameVersion(preview.original, current);
                    if (api.branchExists(current.project(), branch)) throw new IllegalStateException("远程同名分支已存在且无关联，不能接管");
                    WorkbenchSettings.Conflict task = new WorkbenchSettings.Conflict(); task.instance = preview.connection.instance(); task.project = current.project(); task.originalIid = current.iid(); task.originalId = current.id(); task.originalUrl = current.url(); task.source = current.source(); task.sourceSha = current.sha(); task.target = current.target(); task.baseSha = preview.target.sha(); task.branch = branch;
                    var updatedTasks = new ArrayList<>(tasks()); updatedTasks.add(task); service.settings().getState().conflicts = updatedTasks; // Preserve association before the write.
                    api.createBranch(task.project, branch, "branch", task.target, task.baseSha); task.stage = "created"; return task;
                }, this::showGuide);
            });
        }
        private void closeOriginal() {
            GitLabClient.Mr selected = selectedFresh();
            run(() -> { var connection = service.connection(); var current = connection.api().mr(selected.project(), selected.iid()); current.requireConflict(); GitLabClient.sameVersion(selected, current); return new Object[]{connection, current}; }, result -> {
                var connection = (WorkbenchService.Connection)result[0]; var current = (GitLabClient.Mr)result[1];
                if (!confirm("关闭原冲突 MR !" + current.iid() + "？\n" + current.source() + " → " + current.target() + "\n后续需自行处理冲突，并创建替代 MR。", "关闭原 MR")) return;
                run(() -> { connection.api().closeOriginal(current); return true; }, ignored -> service.refresh(true));
            });
        }
        private List<WorkbenchSettings.Conflict> tasks() { return service.settings().getState().conflicts; }
        private void showGuide(WorkbenchSettings.Conflict task) {
            String text = "原 MR：" + task.originalUrl + "\nSource：" + task.source + "\nTarget：" + task.target + "\nconflict：" + task.branch
                + "\n\n1. 在 GitLab 或工作台关闭原冲突 MR。\n2. 在 IDEA 自带 Git 工具中获取并检出远程 conflict 分支。\n3. 将 Source 合入 conflict，用 IDEA 合并工具解决冲突。\n4. 检查、测试、提交并推送 conflict。\n5. 返回工作台创建替代 MR，目标固定为原 Target。\n\nGit Bash / POSIX 命令参考（先保存本地改动，已有本地分支时不要重复创建）：\n"
                + "git fetch origin\ngit switch --create '" + task.branch + "' --track 'origin/" + task.branch + "'\ngit merge --no-commit --no-ff 'origin/" + task.source + "'\n\n插件不执行这些命令，不自动提交、推送或解决冲突。";
            TextDialog guide = new TextDialog(project, "conflict 处理指引", "处理指引", text, false); guide.showAndGet();
        }
        private void replacement() {
            List<WorkbenchSettings.Conflict> available = tasks().stream().filter(task -> task.instance.equals(service.settings().getState().instance)).toList();
            if (available.isEmpty()) { Messages.showInfoMessage(project, "尚无关联的 conflict 任务，请从冲突 MR 创建分支。", "替代 MR"); return; }
            String[] labels = available.stream().map(task -> task.project + " · " + task.branch + " → " + task.target + " · !" + task.originalIid).toArray(String[]::new);
            int choice = Messages.showChooseDialog(project, "选择处理任务", "替代 MR / 处理指引", null, labels, labels[0]);
            if (choice < 0) return;
            WorkbenchSettings.Conflict task = available.get(choice);
            int action = Messages.showDialog(project, "完成本地解决并推送后再创建替代 MR。", task.branch, new String[]{"创建 / 打开替代 MR", "处理指引", "核对 / 恢复远程分支", "归档已合并任务", "取消"}, 0, Messages.getQuestionIcon());
            if (action == 1) { showGuide(task); return; }
            if (action == 2) {
                if (!confirm("仅在任务关联和 SHA 匹配时恢复 " + task.branch + "；不会覆盖现有分支。", "核对 / 恢复远程分支")) return;
                run(() -> {
                    var api = service.connection().api();
                    if (api.branchExists(task.project, task.branch)) {
                        if (task.stage.equals("planned") && !api.ref(task.project, "branch", task.branch).sha().equals(task.baseSha)) throw new IllegalStateException("远程分支已偏离任务基线，请人工核对");
                    } else {
                        if (!task.stage.equals("planned")) throw new IllegalStateException("已创建的 conflict 分支不再存在，请核对是否已合并清理");
                        var current = api.mr(task.project, task.originalIid);
                        if (current.id() != task.originalId || !current.source().equals(task.source) || !current.target().equals(task.target) || !current.sha().equals(task.sourceSha) || current.state().equals("merged")) throw new IllegalStateException("原 MR 已变化，请核对任务");
                        if (!api.ref(task.project, "branch", task.source).sha().equals(task.sourceSha)) throw new IllegalStateException("Source 已更新，请核对新提交");
                        api.createBranch(task.project, task.branch, "branch", task.target, task.baseSha);
                    }
                    if (task.stage.equals("planned")) task.stage = "created";
                    return task;
                }, this::showGuide); return;
            }
            if (action == 3) {
                if (task.replacementIid == 0) throw new IllegalStateException("尚未关联替代 MR，不能归档");
                if (!confirm("仅移除已合并任务记录，不删除本地或远程分支。", "归档任务")) return;
                run(() -> {
                    var current = service.connection().api().mr(task.project, task.replacementIid);
                    if (!current.state().equals("merged") || !current.source().equals(task.branch) || !current.target().equals(task.target)) throw new IllegalStateException("替代 MR 尚未合入原 Target");
                    service.settings().getState().conflicts = new ArrayList<>(tasks().stream().filter(existing -> existing != task).toList()); return true;
                }, ignored -> Messages.showInfoMessage(project, "任务已归档", "conflict")); return;
            }
            if (action != 0) return;
            run(() -> prepareReplacement(task), preview -> {
                if (preview.existing != null) { task.replacementIid = preview.existing.iid(); task.replacementUrl = preview.existing.url(); task.stage = preview.existing.state().equals("merged") ? "merged" : "mr"; BrowserUtil.browse(task.replacementUrl); return; }
                if (task.stage.equals("mrCreating") && !confirm("上次创建结果未确认，当前未查到替代 MR。请在 GitLab 核对，确认不存在后才重试。", "确认远程不存在 MR")) return;
                TextDialog edit = new TextDialog(project, "创建替代 MR", "(conflict-" + task.target + ") " + task.branch + " 合并到 " + task.target, preview.description, true);
                edit.reviewers.setText(String.join(",", preview.original.reviewers().stream().map(String::valueOf).toList()));
                if (!edit.showAndGet()) return;
                List<Long> reviewers = parseReviewers(edit.reviewers.getText());
                if (!confirm("固定目标：" + task.target + "\nReviewer ID：" + reviewers + "\n合并后删除源分支：YES；Squash：NO\n确认已解决冲突并完成测试？", "确认创建替代 MR")) return;
                run(() -> {
                    var api = preview.connection.api();
                    if (!api.ref(task.project, "branch", task.branch).sha().equals(preview.source.sha()) || !api.ref(task.project, "branch", task.target).sha().equals(preview.target.sha())) throw new IllegalStateException("预览后 Source 或 Target 已变化，请重新生成描述");
                    List<GitLabClient.Mr> duplicates = api.matchingMrs(task.project, task.branch, task.target);
                    if (duplicates.stream().anyMatch(mr -> mr.state().equals("opened"))) throw new IllegalStateException("已有开放替代 MR，请重新打开任务");
                    task.stage = "mrCreating";
                    var mr = api.createReplacement(task.project, task.branch, task.target, edit.title.getText().trim(), edit.text.getText(), reviewers);
                    task.replacementIid = mr.iid(); task.replacementUrl = mr.url(); task.stage = "mr";
                    return mr;
                }, mr -> { BrowserUtil.browse(mr.url()); service.refresh(false); if (!mr.reviewers().containsAll(reviewers)) Messages.showWarningDialog(project, "MR 已创建，但 Reviewer 分配未完整确认，请在 GitLab 核对，不要重复创建。", "Reviewer 核对"); });
            });
        }
        private Replacement prepareReplacement(WorkbenchSettings.Conflict task) {
            var connection = service.connection(); if (!connection.instance().equals(task.instance)) throw new IllegalStateException("任务实例与当前连接不一致");
            var api = connection.api();
            if (task.replacementIid > 0) {
                var existing = api.mr(task.project, task.replacementIid);
                if (!existing.source().equals(task.branch) || !existing.target().equals(task.target) || existing.sourceProject() != task.project || existing.targetProject() != task.project) throw new IllegalStateException("替代 MR 关联已变化");
                return new Replacement(connection, task, null, null, null, "", existing);
            }
            var original = api.mr(task.project, task.originalIid);
            if (original.id() != task.originalId || !original.source().equals(task.source) || !original.target().equals(task.target) || original.sourceProject() != task.project || original.targetProject() != task.project) throw new IllegalStateException("原 MR 关联已变化");
            var source = api.ref(task.project, "branch", task.branch); var target = api.ref(task.project, "branch", task.target);
            for (var existing : api.matchingMrs(task.project, task.branch, task.target)) if (existing.state().equals("opened") || existing.state().equals("merged") && existing.sha().equals(source.sha())) return new Replacement(connection, task, original, source, target, "", existing);
            if (!original.state().equals("closed")) throw new IllegalStateException("请按规范先关闭原冲突 MR，再创建替代 MR");
            if (source.sha().equals(task.baseSha)) throw new IllegalStateException("conflict 尚未推送新的处理提交");
            var diff = api.compare(task.project, source.sha(), target.sha());
            if (diff.commits().isEmpty() || diff.files().isEmpty()) throw new IllegalStateException("两个分支没有待合入的实际差异，请核对是否仍需替代 MR");
            return new Replacement(connection, task, original, source, target, BranchRules.description(task.branch, task.target, diff.commits(), diff.files(), task.originalUrl), null);
        }
        @Override public void dispose() { disposed = true; }
    }
    private static List<Long> parseReviewers(String value) {
        if (value.isBlank()) throw new IllegalArgumentException("请填写 Tech Leader 或指定高级工程师的 Reviewer ID");
        try { return Arrays.stream(value.split(",")).map(String::trim).map(Long::parseLong).peek(id -> { if (id <= 0) throw new IllegalArgumentException(); }).distinct().toList(); }
        catch (RuntimeException error) { throw new IllegalArgumentException("Reviewer ID 需为逗号分隔的正整数"); }
    }
    private static final class Fields extends DialogWrapper {
        private final JPanel panel = new JPanel(new GridLayout(0, 1, 0, 4));
        private final List<JTextField> fields = new ArrayList<>();
        Fields(Project project, String title, String[] labels, String[] values, int password) {
            super(project); setTitle(title);
            for (int i = 0; i < labels.length; i++) { panel.add(new JBLabel(labels[i])); JTextField field = i == password ? new JPasswordField() : new JBTextField(); field.setText(values[i]); fields.add(field); panel.add(field); }
            panel.setPreferredSize(new Dimension(540, labels.length * 55)); init();
        }
        String value(int index) { JTextField field = fields.get(index); return field instanceof JPasswordField password ? new String(password.getPassword()) : field.getText(); }
        @Override protected JComponent createCenterPanel() { return panel; }
    }
    private static final class TextDialog extends DialogWrapper {
        final JTextField title = new JBTextField(); final JTextField reviewers = new JBTextField(); final JTextArea text = new JBTextArea();
        private final JPanel panel = new JPanel(new BorderLayout(0, 5));
        TextDialog(Project project, String caption, String title, String body, boolean editable) {
            super(project); setTitle(caption); this.title.setText(title); text.setText(body); text.setEditable(editable);
            text.setLineWrap(true); text.setWrapStyleWord(true);
            if (editable) {
                JPanel fields = new JPanel(new GridLayout(0, 1, 0, 4)); fields.add(new JBLabel("标题")); fields.add(this.title); fields.add(new JBLabel("Reviewer 用户 ID（逗号分隔，可修改）")); fields.add(reviewers); panel.add(fields, BorderLayout.NORTH);
            }
            panel.add(new JBScrollPane(text), BorderLayout.CENTER); panel.setPreferredSize(new Dimension(700, 520)); init();
        }
        @Override protected JComponent createCenterPanel() { return panel; }
    }
}
