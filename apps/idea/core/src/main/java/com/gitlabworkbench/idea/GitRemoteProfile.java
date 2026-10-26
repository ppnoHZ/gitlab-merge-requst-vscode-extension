package com.gitlabworkbench.idea;

import java.net.URI;
import java.util.Set;
import java.util.regex.Pattern;

/** Reads remote URLs only. SSH transport ports/credentials are never used for the web API. */
public final class GitRemoteProfile {
    private GitRemoteProfile() {}
    public static ConnectionProfile parse(String remote, String configuredInstance) {
        try {
            String value = remote.trim();
            if (!value.contains("://")) {
                var scp = Pattern.compile("(?:[^@/:]+@)?(\\[[^]]+]|[^/:]+):(.+)").matcher(value);
                if (!scp.matches()) throw new IllegalArgumentException();
                value = "ssh://" + scp.group(1) + "/" + scp.group(2);
            }
            URI url = URI.create(value);
            if (!Set.of("http", "https", "ssh").contains(url.getScheme()) || url.getHost() == null || url.getQuery() != null || url.getFragment() != null) throw new IllegalArgumentException();
            if (Set.of("github.com", "ssh.github.com", "bitbucket.org").contains(url.getHost().toLowerCase(java.util.Locale.ROOT))) {
                throw new IllegalArgumentException("当前仅支持 GitLab，请选择 GitLab remote");
            }
            boolean ssh = url.getScheme().equals("ssh");
            String authority = url.getHost() + (!ssh && url.getPort() != -1 ? ":" + url.getPort() : "");
            String instance = (ssh ? "https" : url.getScheme()) + "://" + authority;
            String path = url.getPath().replaceFirst("^/+", "");
            if (configuredInstance != null && !configuredInstance.isBlank()) {
                URI configured = URI.create(GitLabClient.normalizeInstance(configuredInstance));
                boolean sameServer = ssh ? configured.getHost().equalsIgnoreCase(url.getHost())
                    : configured.getScheme().equals(url.getScheme()) && configured.getRawAuthority().equalsIgnoreCase(authority);
                String prefix = configured.getPath().replaceFirst("^/+", "");
                if (sameServer && (prefix.isEmpty() || path.startsWith(prefix + "/"))) {
                    instance = configured.toString();
                    if (!prefix.isEmpty()) path = path.substring(prefix.length() + 1);
                }
            }
            return ConnectionProfile.parse(instance, path);
        } catch (IllegalArgumentException error) {
            // Never echo a remote URL: HTTPS clone URLs may contain credentials.
            if ("当前仅支持 GitLab，请选择 GitLab remote".equals(error.getMessage())) throw error;
            throw new IllegalArgumentException("无法从此 remote 识别 GitLab 项目，请使用 HTTPS/SSH 仓库地址或手动填写");
        }
    }
}
