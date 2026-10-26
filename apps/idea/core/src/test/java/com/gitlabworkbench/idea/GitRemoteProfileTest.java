package com.gitlabworkbench.idea;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class GitRemoteProfileTest {
    @Test void readsHttpsSshAndScpRemotesWithSubgroups() {
        for (String remote : new String[]{"https://gitlab.test/g/sub/p.git", "git@gitlab.test:g/sub/p.git", "ssh://git@gitlab.test:2222/g/sub/p.git"}) {
            assertEquals(new ConnectionProfile("https://gitlab.test", "g/sub/p"), GitRemoteProfile.parse(remote, ""));
        }
    }
    @Test void preservesWebPortAndConfiguredDeploymentPrefix() {
        assertEquals(new ConnectionProfile("http://gitlab.test:8080/gitlab", "g/p"),
            GitRemoteProfile.parse("http://gitlab.test:8080/gitlab/g/p.git", "http://gitlab.test:8080/gitlab"));
        assertEquals(new ConnectionProfile("https://gitlab.test:8443", "g/p"),
            GitRemoteProfile.parse("ssh://git@gitlab.test:2222/g/p.git", "https://gitlab.test:8443"));
        assertEquals(new ConnectionProfile("https://gitlab.test:8443", "g/p"),
            GitRemoteProfile.parse("https://gitlab.test:8443/g/p.git", "https://unrelated.test"));
    }
    @Test void stripsCloneCredentialsAndRejectsUnsupportedRemotesWithoutLeakingSecrets() {
        assertEquals(new ConnectionProfile("https://gitlab.test", "g/p"), GitRemoteProfile.parse("https://user:secret@gitlab.test/g/p.git", ""));
        for (String value : new String[]{"/tmp/secret.git", "file:///secret.git", "https://gitlab.test/g/p?secret=1", "git@github.com:g/p.git"}) {
            var error = assertThrows(IllegalArgumentException.class, () -> GitRemoteProfile.parse(value, ""));
            assertFalse(error.getMessage().contains("secret"));
        }
    }
}
