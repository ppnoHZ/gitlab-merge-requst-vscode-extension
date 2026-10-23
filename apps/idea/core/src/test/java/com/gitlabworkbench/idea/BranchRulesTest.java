package com.gitlabworkbench.idea;

import com.google.gson.*;
import org.junit.jupiter.api.Test;
import java.nio.file.*;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class BranchRulesTest {
    @Test void sharedNamingContracts() throws Exception {
        JsonArray cases = JsonParser.parseString(Files.readString(Path.of(System.getProperty("contracts.path")))).getAsJsonArray();
        for (JsonElement item : cases) {
            JsonObject row = item.getAsJsonObject();
            java.util.function.Supplier<String> name = () -> {
                if (text(row, "kind").equals("conflict")) {
                    if (row.has("target")) BranchRules.target(text(row, "source"), text(row, "target"));
                    return BranchRules.conflict(text(row, "source"));
                }
                return BranchRules.development(text(row, "kind"), text(row, "version"), text(row, "issue"), text(row, "description"));
            };
            if (row.has("invalid")) assertThrows(IllegalArgumentException.class, name::get, row.toString());
            else assertEquals(text(row, "expected"), name.get(), row.toString());
        }
    }
    @Test void descriptionPreservesTemplateAndUsesOnlySuppliedDifference() {
        String result = BranchRules.description("conflict/hotfix/H1/FOC-9", "tst", List.of("abc123 Actual change"), List.of("M actual.txt"), "https://gitlab.test/mr/1");
        for (String expected : List.of("分支信息", "工单信息", "FOC-9", "自检清单", "Actual change", "actual.txt", "https://gitlab.test/mr/1", "生成")) assertTrue(result.contains(expected));
        assertFalse(result.contains("unrelated.txt"));
    }
    private String text(JsonObject row, String key) { return row.has(key) ? row.get(key).getAsString() : ""; }
}
