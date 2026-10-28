package com.gitlabworkbench.idea;

import java.util.List;
import java.util.Set;

public final class BranchRules {
    private BranchRules() {}
    public static String development(String kind, String version, String issue, String description) {
        version = version.trim(); issue = issue.trim(); description = description.trim();
        if (!Set.of("release", "hotfix").contains(kind)) throw new IllegalArgumentException("仅支持 release 和 hotfix");
        if (!version.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,79}") || invalidSegment(version)) throw new IllegalArgumentException("版本号格式无效");
        if (kind.equals("release")) return "release/" + version;
        if (!issue.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,99}")) throw new IllegalArgumentException("请填写有效工单号");
        if (!description.isEmpty() && !description.matches("[a-z0-9][a-z0-9-]{0,79}")) throw new IllegalArgumentException("短描述只能使用小写字母、数字和横线");
        return "hotfix/" + version + "/" + issue + (description.isEmpty() ? "" : "-" + description);
    }
    public static String conflict(String source) {
        source = source.trim();
        String[] segments = source.split("/", -1);
        if (source.length() > 240 || segments.length < 2 || !(segments[0].equals("release") || segments[0].equals("hotfix")) || (segments[0].equals("hotfix") && segments.length < 3)) throw new IllegalArgumentException("仅支持 release/<编号> 或 hotfix/<编号>/<工单号>");
        for (String segment : segments) if (!segment.matches("[A-Za-z0-9][A-Za-z0-9._-]*") || invalidSegment(segment)) throw new IllegalArgumentException("源分支名无效");
        return "conflict/" + source;
    }
    public static void target(String source, String target) {
        conflict(source);
        if (!Set.of("dev", "tst", "uat", "pre").contains(target)) throw new IllegalArgumentException("此入口仅支持 release/hotfix → dev/tst/uat/pre；其他场景请在原 Source 处理");
    }
    public static String renderTemplate(String template, String version, String issue, String description) {
        String result = template.replace("{version}", version.trim()).replace("{issue}", issue.trim())
            .replace("{description}", description.trim()).replace("{descriptionSuffix}", description.isBlank() ? "" : "-" + description.trim());
        if (result.contains("{") || result.length() > 240) throw new IllegalArgumentException("分支模板变量无效或名称过长");
        for (String segment : result.split("/", -1)) if (!segment.matches("[A-Za-z0-9][A-Za-z0-9._-]*") || invalidSegment(segment)) throw new IllegalArgumentException("生成的分支名无效");
        return result;
    }
    public static List<String> recommendedTargets(String source, List<String> candidates) {
        String kind = source.split("/")[0];
        return candidates.stream().filter(target -> !target.equals(source)).filter(target -> switch (kind) {
            case "feature", "bugfix" -> target.startsWith("release/");
            case "release", "hotfix" -> Set.of("main", "master", "dev", "tst", "uat", "pre").contains(target);
            case "conflict" -> target.startsWith("release/") || Set.of("dev", "tst", "uat", "pre").contains(target);
            case "main", "master" -> target.startsWith("release/") || Set.of("dev", "tst", "uat", "pre").contains(target);
            case "revert" -> target.startsWith("release/") || Set.of("main", "master", "dev", "tst", "uat", "pre").contains(target);
            default -> false;
        }).sorted(java.util.Comparator.comparingInt(target -> {
            String[] parts = source.split("/");
            return parts.length > 1 && target.equals("release/" + parts[1]) ? 0 : 1;
        })).toList();
    }
    private static boolean invalidSegment(String value) { return value.contains("..") || value.endsWith(".") || value.endsWith(".lock"); }
    public static String description(String source, String target, List<String> commits, List<String> files, String originalUrl) {
        String issue = "待补充真实工单";
        var match = java.util.regex.Pattern.compile("[A-Z][A-Z0-9]*-\\d+").matcher(source);
        if (match.find()) issue = match.group();
        return "## 分支信息\n- Source: `" + source + "`\n- Target: `" + target + "`\n\n## 工单信息\n" + issue
            + "\n\n## 提交历史（实际差异）\n" + lines(commits) + "\n\n## 变动文件（实际差异）\n" + lines(files)
            + "\n\n## 变更说明\n- 模块：\n- 摘要：\n- 影响范围：\n- 风险评估：\n\n## 自检清单\n- [ ] 已检查变更内容\n- [ ] 已完成相关测试\n- [ ] 已指定 Reviewer\n"
            + "\n## 备注\n原冲突 MR：" + originalUrl + "\n\n由 GitLab Workbench 根据两个分支的实际差异生成，请核对并补充。\n";
    }
    private static String lines(List<String> values) { return values.isEmpty() ? "无" : String.join("\n", values.stream().map(value -> "- " + value.replace("\n", " ")).toList()); }
}
