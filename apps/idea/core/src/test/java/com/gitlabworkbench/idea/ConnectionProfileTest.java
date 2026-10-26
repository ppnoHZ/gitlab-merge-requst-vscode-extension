package com.gitlabworkbench.idea;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ConnectionProfileTest {
    @Test void normalizesApiSuffixProjectHomeAndCloneSuffix() {
        var profile = ConnectionProfile.parse(" https://gitlab.test/gitlab/api/v4/ ", " https://gitlab.test/gitlab/group/subgroup/project.git/ ");
        assertEquals("https://gitlab.test/gitlab", profile.instance());
        assertEquals("group/subgroup/project", profile.projectPath());
        assertEquals("group/project", ConnectionProfile.parse("https://gitlab.test", "/group/project/").projectPath());
    }
    @Test void rejectsCrossInstanceAndNonProjectPages() {
        for (String path : new String[]{"https://evil.test/g/p", "https://gitlab.test/other/g/p", "g/p/-/tree/main", "g/../p", "", "p", "https://gitlab.test/gitlab/g/p?token=secret", "https://user@gitlab.test/gitlab/g/p"}) {
            assertThrows(IllegalArgumentException.class, () -> ConnectionProfile.parse("https://gitlab.test/gitlab", path), path);
        }
    }
    @Test void validatesAddressWithoutExposingCredentialsInErrors() {
        for (String address : new String[]{"gitlab.test", "https://secret@gitlab.test", "https://gitlab.test?token=secret", "https://gitlab.test/secret value"}) {
            var error = assertThrows(IllegalArgumentException.class, () -> ConnectionProfile.parse(address, "g/p"));
            assertFalse(error.getMessage().contains("secret"));
        }
    }
}
