package com.gitlabworkbench.idea;

import java.net.URI;

/** Validated, non-secret connection fields. Accepts a copied GitLab project homepage. */
public record ConnectionProfile(String instance, String projectPath) {
    public static ConnectionProfile parse(String address, String project) {
        String instance = GitLabClient.normalizeInstance(address);
        String path = project.trim();
        if (path.startsWith("http://") || path.startsWith("https://")) {
            URI url;
            try { url = URI.create(path); }
            catch (IllegalArgumentException error) { throw new IllegalArgumentException("项目地址格式不正确，请填写 group/project 或项目首页 URL"); }
            URI server = URI.create(instance);
            if (!server.getScheme().equalsIgnoreCase(url.getScheme()) || !server.getRawAuthority().equalsIgnoreCase(url.getRawAuthority())
                || url.getUserInfo() != null || url.getQuery() != null || url.getFragment() != null
                || !url.getPath().startsWith(server.getPath() + "/")) {
                throw new IllegalArgumentException("项目 URL 必须属于上方配置的 GitLab 地址，且不含查询参数或锚点");
            }
            path = url.getPath().substring(server.getPath().length() + 1);
        }
        path = path.replaceAll("^/+|/+$", "").replaceFirst("\\.git$", "");
        if (!path.matches("[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+") || path.contains("/-/")
            || java.util.Arrays.stream(path.split("/")).anyMatch(part -> part.equals(".") || part.equals(".."))) {
            throw new IllegalArgumentException("请输入项目路径（group/project，支持子组）或项目首页 URL，不要填写分支/MR 页面");
        }
        return new ConnectionProfile(instance, path);
    }
}
