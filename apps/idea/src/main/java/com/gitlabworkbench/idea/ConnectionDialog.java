package com.gitlabworkbench.idea;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.openapi.util.Disposer;
import com.intellij.ui.components.*;
import com.intellij.util.concurrency.AppExecutorUtil;
import git4idea.repo.GitRepositoryManager;
import javax.swing.*;
import java.awt.*;
import java.util.concurrent.Callable;
import java.util.function.Consumer;

/** Saving never depends on GitLab availability; testing never writes settings. */
final class ConnectionDialog extends DialogWrapper {
    private final Project project;
    private final WorkbenchService service;
    private final JPanel panel = new JPanel(new GridLayout(0, 1, 0, 6));
    private final JTextField instance = new JBTextField(), path = new JBTextField();
    private final JPasswordField token = new JPasswordField();
    private final JButton test = new JButton("测试连接（不保存）");
    private final JLabel feedback = new JBLabel("保存无需联网；测试成功后仍需点击“保存配置”。");
    private final JLabel credentialStatus = new JBLabel();
    private record Remote(String root, String name, String url) {
        @Override public String toString() { return root + " · " + name; }
    }
    private final JComboBox<Remote> remotes = new JComboBox<>();
    private final JButton useRemote = new JButton("从 remote 填入");
    private boolean busy, saving, closed;
    private java.util.concurrent.Future<?> pending;

    ConnectionDialog(Project project, WorkbenchService service) {
        super(project);
        this.project = project; this.service = service;
        setTitle("GitLab 连接设置"); setOKButtonText("保存配置"); setCancelButtonText("取消");
        WorkbenchSettings.Data saved = service.settings().getState();
        instance.setText(saved.instance); path.setText(saved.projectPath);
        for (var repository : GitRepositoryManager.getInstance(project).getRepositories()) {
            repository.getRemotes().stream().sorted(java.util.Comparator.comparing(remote -> !remote.getName().equals("origin")))
                .forEach(remote -> remote.getUrls().forEach(url -> remotes.addItem(new Remote(repository.getRoot().getPresentableUrl(), remote.getName(), url))));
        }
        JPanel remoteRow = new JPanel(new BorderLayout(6, 0)); remoteRow.add(remotes, BorderLayout.CENTER); remoteRow.add(useRemote, BorderLayout.EAST);
        panel.add(new JBLabel("当前项目的 Git remote（只读取配置，不执行 fetch 或修改 Git）")); panel.add(remoteRow);
        panel.add(new JBLabel("GitLab 实例地址（例如 https://gitlab.company.com，支持部署子路径）")); panel.add(instance);
        panel.add(new JBLabel("项目路径或项目首页 URL（例如 group/subgroup/project）")); panel.add(path);
        panel.add(new JBLabel("Personal Access Token（api 权限；留空保留该实例已存凭据）")); panel.add(token);
        panel.add(credentialStatus);
        panel.add(test); panel.add(feedback);
        panel.add(new JBLabel("网络设置：Settings → HTTP Proxy / Server Certificates"));
        panel.setPreferredSize(new Dimension(720, 420));
        test.addActionListener(event -> testConnection());
        useRemote.addActionListener(event -> fillFromRemote());
        init();
        useRemote.setEnabled(remotes.getItemCount() > 0);
        if (saved.projectPath.isBlank()) {
            if (remotes.getItemCount() == 1) fillFromRemote();
            else feedback.setText(remotes.getItemCount() == 0 ? "未发现 Git remote，可手动填写；保存无需联网。" : "发现多个 remote，请选择后点击“从 remote 填入”。");
        }
        Disposer.register(getDisposable(), () -> { closed = true; token.setText(""); });
        instance.addFocusListener(new java.awt.event.FocusAdapter() {
            @Override public void focusLost(java.awt.event.FocusEvent event) { checkCredential(); }
        });
        checkCredential();
    }

    @Override protected JComponent createCenterPanel() { return panel; }
    @Override public JComponent getPreferredFocusedComponent() { return path.getText().isBlank() ? instance : path; }

    private ConnectionProfile profile() { return ConnectionProfile.parse(instance.getText(), path.getText()); }
    private void fillFromRemote() {
        Remote remote = (Remote) remotes.getSelectedItem();
        if (remote == null) return;
        try {
            ConnectionProfile profile = GitRemoteProfile.parse(remote.url(), instance.getText());
            instance.setText(profile.instance()); path.setText(profile.projectPath()); setErrorText(null);
            feedback.setText("已从 remote 识别。请核对网页地址；SSH 端口不等于网页端口，必要时调整后测试。 ");
            if (panel.isShowing()) checkCredential();
        } catch (RuntimeException error) { showError(error); }
    }
    private void checkCredential() {
        final String address;
        try { address = GitLabClient.normalizeInstance(instance.getText()); }
        catch (RuntimeException error) { credentialStatus.setText("填写有效的 GitLab 地址后可检查已保存凭据。"); return; }
        credentialStatus.setText("正在检查该实例的已保存凭据…");
        AppExecutorUtil.getAppExecutorService().submit(() -> {
            String message;
            try {
                String secret = service.settings().token(address);
                message = secret == null || secret.isBlank() ? "该实例尚未保存 Token。" : "该实例已保存 Token，无需重复填写（为安全起见不回显）。";
            } catch (RuntimeException error) { message = "无法读取凭据，请检查 IDEA PasswordSafe / Passwords 设置。"; }
            String status = message;
            ApplicationManager.getApplication().invokeLater(() -> {
                if (closed || project.isDisposed()) return;
                try { if (address.equals(GitLabClient.normalizeInstance(instance.getText()))) credentialStatus.setText(status); }
                catch (RuntimeException ignored) { /* Address is being edited. */ }
            }, ModalityState.any());
        });
    }
    private String enteredToken() { char[] value = token.getPassword(); try { return new String(value).trim(); } finally { java.util.Arrays.fill(value, '\0'); } }
    private void testConnection() {
        if (busy) return;
        try {
            ConnectionProfile profile = profile(); String entered = enteredToken();
            background(false, "正在验证 Token 和项目访问权限…", () -> {
                String secret = entered.isBlank() ? service.settings().token(profile.instance()) : entered;
                if (secret == null || secret.isBlank()) throw new IllegalArgumentException("该 GitLab 地址没有已保存的 Token，请填写 Personal Access Token（api 权限）");
                return new WorkbenchService.Connection(profile.instance(), profile.projectPath(), secret).api().testConnection(profile.projectPath());
            }, repo -> feedback.setText("连接成功：" + repo.path() + "。请点击“保存配置”保存当前输入。"));
        } catch (RuntimeException error) { showError(error); }
    }

    @Override protected void doOKAction() {
        if (busy) return;
        try {
            ConnectionProfile profile = profile(); String entered = enteredToken();
            background(true, "正在保存配置和凭据…", () -> {
                // PasswordSafe must run off the UI thread. Blank never erases a saved credential.
                if (!entered.isBlank()) service.settings().storeToken(profile.instance(), entered);
                return profile;
            }, saved -> {
                service.configure(saved.instance(), saved.projectPath());
                project.save();
                close(OK_EXIT_CODE);
            });
        } catch (RuntimeException error) { showError(error); }
    }

    private <T> void background(boolean saving, String message, Callable<T> work, Consumer<T> success) {
        busy = true; this.saving = saving; setErrorText(null); feedback.setText(message); enableInputs(false);
        ModalityState modality = ModalityState.stateForComponent(panel);
        pending = AppExecutorUtil.getAppExecutorService().submit(() -> {
            T result = null; Exception failure = null;
            try { result = work.call(); } catch (Exception error) { failure = error; }
            T value = result; Exception error = failure;
            ApplicationManager.getApplication().invokeLater(() -> {
                if (closed || project.isDisposed()) return;
                busy = false; enableInputs(true);
                if (error != null) showError(error);
                else { try { success.accept(value); } catch (RuntimeException e) { showError(e); } }
            }, modality);
        });
    }
    private void enableInputs(boolean enabled) {
        instance.setEnabled(enabled); path.setEnabled(enabled); token.setEnabled(enabled); test.setEnabled(enabled);
        remotes.setEnabled(enabled); useRemote.setEnabled(enabled && remotes.getItemCount() > 0);
        setOKActionEnabled(enabled); getCancelAction().setEnabled(enabled || !saving);
    }
    @Override public void doCancelAction() {
        if (busy && saving) return;
        if (pending != null) pending.cancel(true);
        super.doCancelAction();
    }
    private void showError(Exception error) {
        feedback.setText("操作未完成，当前输入已保留，可修改后重试。");
        setErrorText(error.getMessage() == null ? "操作失败，请检查 IDEA 日志和 PasswordSafe 设置。" : error.getMessage());
    }
}
