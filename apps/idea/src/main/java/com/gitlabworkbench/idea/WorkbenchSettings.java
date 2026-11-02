package com.gitlabworkbench.idea;

import com.intellij.credentialStore.CredentialAttributes;
import com.intellij.ide.passwordSafe.PasswordSafe;
import com.intellij.openapi.components.*;
import com.intellij.util.xmlb.XmlSerializerUtil;
import org.jetbrains.annotations.NotNull;
import java.util.ArrayList;
import java.util.List;

@Service(Service.Level.PROJECT)
@State(name = "GitLabWorkbench", storages = @Storage("gitlab-workbench.xml"))
public final class WorkbenchSettings implements PersistentStateComponent<WorkbenchSettings.Data> {
    public static final class Conflict {
        public String instance = "", branch = "", source = "", target = "", sourceSha = "", baseSha = "", originalUrl = "", replacementUrl = "", stage = "planned";
        public long project, originalIid, originalId, replacementIid;
    }
    public static final class Data {
        public String instance = "https://gitlab.com";
        public String projectPath = "";
        public boolean allowBranchDeletion = false;
        public boolean commonBranchesOnly = true;
        public String mainFilter = "全部";
        public String releaseTemplate = "release/{version}";
        public String hotfixTemplate = "hotfix/{version}/{issue}{descriptionSuffix}";
        public List<Conflict> conflicts = new ArrayList<>();
    }
    private final Data data = new Data();
    @Override public @NotNull Data getState() { return data; }
    @Override public void loadState(@NotNull Data state) { XmlSerializerUtil.copyBean(state, data); }
    public static CredentialAttributes credential(String instance) { return new CredentialAttributes("GitLab Workbench: " + GitLabClient.normalizeInstance(instance), "token", null, false); }
    public String token(String instance) { return PasswordSafe.getInstance().getPassword(credential(instance)); }
    public void storeToken(String instance, String token) { PasswordSafe.getInstance().setPassword(credential(instance), token); }
}
