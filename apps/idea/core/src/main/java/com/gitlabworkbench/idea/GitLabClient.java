package com.gitlabworkbench.idea;

import com.google.gson.*;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;

/** No local Git writes. HTTP redirects are refused so credentials stay on the configured instance. */
public final class GitLabClient {
    public record Ref(String name, String sha) {}
    public record Repo(long id, String path, String url, String defaultBranch) {}
    public record Mr(long id, long iid, long project, long sourceProject, long targetProject, String title, String source, String target, String sha, String state, String url, boolean conflict, String mergeStatus, List<Long> reviewers) {
        public String key() { return project + ":" + iid; }
        public void requireConflict() {
            if (!state.equals("opened") || !conflict || Set.of("checking", "unchecked", "preparing", "approvals_syncing").contains(mergeStatus)) throw new IllegalStateException("MR 已关闭、无确认的冲突或状态计算中，请刷新");
            if (sourceProject != targetProject || targetProject != project) throw new IllegalStateException("暂不支持跨仓库 MR");
            BranchRules.target(source, target); requireSha(sha);
        }
    }
    public record Page<T>(List<T> items, int next) {}
    public record Todos(List<Mr> authored, List<Mr> reviews) {}
    public record Comparison(List<String> commits, List<String> files) {}
    public static final class ApiException extends RuntimeException {
        public final int status;
        ApiException(String message, int status) { super(message); this.status = status; }
    }
    private record Response(JsonElement data, int next) {}
    private final URI instance;
    private final String token;
    private final HttpClient http;
    private final Duration timeout;
    public GitLabClient(String instance, String token) { this(instance, token, Duration.ofSeconds(20)); }
    GitLabClient(String instance, String token, Duration timeout) {
        this.instance = URI.create(normalizeInstance(instance)); this.token = Objects.requireNonNull(token); this.timeout = timeout;
        if (token.isBlank()) throw new IllegalArgumentException("请先配置 Token");
        http = HttpClient.newBuilder().connectTimeout(timeout).followRedirects(HttpClient.Redirect.NEVER).build();
    }
    public static String normalizeInstance(String value) {
        URI uri = URI.create(value.trim());
        if (!("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) throw new IllegalArgumentException("请填写不含凭据、查询参数的 GitLab HTTP(S) 网页地址");
        return uri.toString().replaceAll("/+$", "");
    }
    public static String enc(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20"); }
    private Response request(String method, String path, JsonObject body) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(instance + "/api/v4" + path)).timeout(timeout).header("PRIVATE-TOKEN", token).header("Accept", "application/json");
        if (body == null) builder.method(method, HttpRequest.BodyPublishers.noBody());
        else builder.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body.toString()));
        try {
            HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) throw new ApiException("GitLab 请求失败（HTTP " + response.statusCode() + "），请核对权限或远程状态", response.statusCode());
            JsonElement data;
            try { data = JsonParser.parseString(response.body()); }
            catch (RuntimeException error) { throw new ApiException("GitLab 返回无效数据；写入操作请核对远程结果", 0); }
            String next = response.headers().firstValue("X-Next-Page").orElse(null);
            return new Response(data, next == null ? -1 : next.isBlank() ? 0 : Integer.parseInt(next));
        } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new ApiException("操作已取消；写入结果请核对远程状态", 0); }
        catch (java.io.IOException error) { throw new ApiException("GitLab 连接失败或超时；写入结果可能未确认，请核对远程状态", 0); }
    }
    private JsonObject get(String path) { return request("GET", path, null).data.getAsJsonObject(); }
    private Page<JsonObject> page(String path, int number) {
        Response response = request("GET", path + (path.contains("?") ? "&" : "?") + "per_page=100&page=" + number, null);
        List<JsonObject> items = new ArrayList<>();
        for (JsonElement item : response.data.getAsJsonArray()) items.add(item.getAsJsonObject());
        int next = response.next < 0 ? items.size() == 100 ? number + 1 : 0 : response.next;
        if (next != 0 && next <= number) throw new IllegalStateException("GitLab 分页响应无效");
        return new Page<>(List.copyOf(items), next);
    }
    private List<JsonObject> all(String path) {
        List<JsonObject> items = new ArrayList<>();
        for (int page = 1, count = 0; page != 0; count++) {
            if (count >= 10000 || Thread.currentThread().isInterrupted()) throw new IllegalStateException("列表未完整加载，请缩小范围后重试");
            Page<JsonObject> result = page(path, page); items.addAll(result.items); page = result.next;
        }
        return items;
    }
    public Repo project(String path) {
        JsonObject value = get("/projects/" + enc(path));
        return new Repo(id(value, "id"), str(value, "path_with_namespace"), webUrl(value, "web_url"), str(value, "default_branch"));
    }
    public Page<Ref> refs(long project, String kind, int page, String search) {
        if (!Set.of("branch", "tag").contains(kind)) throw new IllegalArgumentException("基线类型无效");
        Page<JsonObject> result = page("/projects/" + project + "/repository/" + (kind.equals("tag") ? "tags" : "branches") + "?search=" + enc(search), page);
        return new Page<>(result.items.stream().map(GitLabClient::ref).toList(), result.next);
    }
    public Ref ref(long project, String kind, String name) { return ref(get("/projects/" + project + "/repository/" + (kind.equals("tag") ? "tags" : "branches") + "/" + enc(name))); }
    public boolean branchExists(long project, String name) {
        try { ref(project, "branch", name); return true; } catch (ApiException error) { if (error.status == 404) return false; throw error; }
    }
    public Ref createBranch(long project, String name, String kind, String base, String expectedSha) {
        requireSha(expectedSha);
        if (!ref(project, kind, base).sha.equals(expectedSha)) throw new IllegalStateException("基线已更新，请重新预览");
        if (branchExists(project, name)) throw new IllegalStateException("同名分支已存在，不会覆盖");
        JsonObject body = new JsonObject(); body.addProperty("branch", name); body.addProperty("ref", expectedSha);
        try {
            Ref result = ref(request("POST", "/projects/" + project + "/repository/branches", body).data.getAsJsonObject());
            if (!result.name.equals(name) || !result.sha.equals(expectedSha)) throw new ApiException("创建结果未确认", 0);
            return result;
        } catch (RuntimeException error) {
            if (error instanceof ApiException apiError && apiError.status != 0 && apiError.status < 500 && apiError.status != 408) throw error;
            try { Ref actual = ref(project, "branch", name); if (actual.sha.equals(expectedSha)) return actual; } catch (RuntimeException ignored) {}
            throw new IllegalStateException("创建结果尚未确认，请查询同名分支后再操作，不要重复创建");
        }
    }
    public Mr mr(long project, long iid) { return mr(get("/projects/" + project + "/merge_requests/" + iid)); }
    public Todos todos() {
        long user = id(get("/user"), "id");
        Map<String, Mr> details = new HashMap<>();
        List<Mr> reviews = new ArrayList<>(); Set<String> reviewed = new HashSet<>();
        for (JsonObject item : all("/merge_requests?scope=all&state=opened&reviewer_id=" + user)) {
            Mr value = mr(item); if (!reviewed.add(value.key())) continue; value = mr(value.project, value.iid); details.put(value.key(), value);
            if (!value.state.equals("opened")) continue;
            JsonArray approved = get("/projects/" + value.project + "/merge_requests/" + value.iid + "/approvals").getAsJsonArray("approved_by");
            if (approved == null) throw new IllegalStateException("审批状态不完整，不能确定待审批数量");
            boolean mine = false;
            for (JsonElement approval : approved) if (id(approval.getAsJsonObject().getAsJsonObject("user"), "id") == user) mine = true;
            if (!mine) reviews.add(value);
        }
        List<Mr> authored = new ArrayList<>(); Set<String> seen = new HashSet<>();
        for (JsonObject item : all("/merge_requests?scope=all&state=opened&author_id=" + user)) {
            Mr value = mr(item); if (!seen.add(value.key())) continue;
            value = details.containsKey(value.key()) ? details.get(value.key()) : mr(value.project, value.iid);
            if (value.state.equals("opened")) authored.add(value);
        }
        return new Todos(List.copyOf(authored), List.copyOf(reviews));
    }
    public void closeOriginal(Mr expected) {
        Mr current = mr(expected.project, expected.iid); sameVersion(expected, current);
        if (current.state.equals("closed")) return;
        current.requireConflict();
        JsonObject body = new JsonObject(); body.addProperty("state_event", "close");
        try { request("PUT", "/projects/" + current.project + "/merge_requests/" + current.iid, body); }
        catch (ApiException error) { if (error.status != 0 && error.status < 500) throw error; }
        if (!mr(current.project, current.iid).state.equals("closed")) throw new IllegalStateException("关闭结果尚未确认，请核对原 MR");
    }
    public List<Mr> matchingMrs(long project, String source, String target) {
        return all("/projects/" + project + "/merge_requests?state=all&source_branch=" + enc(source) + "&target_branch=" + enc(target)).stream().map(GitLabClient::mr)
            .filter(item -> item.source.equals(source) && item.target.equals(target) && item.sourceProject == project && item.targetProject == project).toList();
    }
    public Comparison compare(long project, String sourceSha, String targetSha) {
        requireSha(sourceSha); requireSha(targetSha);
        JsonObject value = get("/projects/" + project + "/repository/compare?from=" + enc(targetSha) + "&to=" + enc(sourceSha) + "&straight=false");
        if (bool(value, "compare_timeout") || !value.has("commits") || !value.has("diffs")) throw new IllegalStateException("提交差异未完整返回，请在 GitLab 核对后再创建 MR");
        List<String> commits = new ArrayList<>(), files = new ArrayList<>();
        for (JsonElement element : value.getAsJsonArray("commits")) { JsonObject commit = element.getAsJsonObject(); commits.add(str(commit, "short_id") + " " + str(commit, "title")); }
        for (JsonElement element : value.getAsJsonArray("diffs")) {
            JsonObject diff = element.getAsJsonObject();
            if (bool(diff, "too_large") || bool(diff, "collapsed")) throw new IllegalStateException("GitLab 差异被截断，请在浏览器核对");
            files.add((bool(diff, "new_file") ? "A " : bool(diff, "deleted_file") ? "D " : bool(diff, "renamed_file") ? "R " + str(diff, "old_path") + " → " : "M ") + str(diff, "new_path"));
        }
        return new Comparison(List.copyOf(commits), List.copyOf(files));
    }
    public Mr createReplacement(long project, String source, String target, String title, String description, List<Long> reviewers) {
        if (!source.startsWith("conflict/") || title.isBlank()) throw new IllegalArgumentException("替代 MR 参数无效");
        BranchRules.target(source.substring("conflict/".length()), target);
        JsonObject body = new JsonObject(); body.addProperty("source_branch", source); body.addProperty("target_branch", target); body.addProperty("title", title); body.addProperty("description", description);
        body.addProperty("remove_source_branch", true); body.addProperty("squash", false);
        JsonArray ids = new JsonArray(); reviewers.forEach(ids::add); body.add("reviewer_ids", ids);
        Mr created = mr(request("POST", "/projects/" + project + "/merge_requests", body).data.getAsJsonObject());
        if (!created.source.equals(source) || !created.target.equals(target) || created.project != project) throw new IllegalStateException("MR 创建响应不匹配，请核对远程结果，不要重复创建");
        return created;
    }
    public static void sameVersion(Mr expected, Mr actual) {
        if (expected.id != actual.id || expected.project != actual.project || !expected.source.equals(actual.source) || !expected.target.equals(actual.target) || !expected.sha.equals(actual.sha) || expected.sourceProject != actual.sourceProject || expected.targetProject != actual.targetProject) throw new IllegalStateException("MR 源/目标或提交已变化，请刷新后重试");
    }
    static Ref ref(JsonObject object) { String sha = str(object.getAsJsonObject("commit"), "id"); requireSha(sha); return new Ref(str(object, "name"), sha); }
    static Mr mr(JsonObject object) {
        List<Long> reviewers = new ArrayList<>();
        if (object.has("reviewers")) for (JsonElement user : object.getAsJsonArray("reviewers")) reviewers.add(id(user.getAsJsonObject(), "id"));
        return new Mr(id(object, "id"), id(object, "iid"), id(object, "project_id"), optionalId(object, "source_project_id"), optionalId(object, "target_project_id"), str(object, "title"), str(object, "source_branch"), str(object, "target_branch"), text(object, "sha"), str(object, "state"), webUrl(object, "web_url"), bool(object, "has_conflicts") || text(object, "detailed_merge_status").equals("conflict"), text(object, "detailed_merge_status"), List.copyOf(reviewers));
    }
    static String webUrl(JsonObject value, String key) {
        String result = str(value, key); URI uri = URI.create(result);
        if (!Set.of("https", "http").contains(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) throw new IllegalStateException("GitLab 页面链接无效");
        return result;
    }
    static String str(JsonObject value, String key) { String result = text(value, key); if (result.isEmpty()) throw new IllegalStateException("GitLab 响应缺少 " + key); return result; }
    static String text(JsonObject value, String key) { return value != null && value.has(key) && !value.get(key).isJsonNull() ? value.get(key).getAsString() : ""; }
    static long id(JsonObject value, String key) { long result = optionalId(value, key); if (result <= 0) throw new IllegalStateException("GitLab ID 无效"); return result; }
    static long optionalId(JsonObject value, String key) { return value != null && value.has(key) && !value.get(key).isJsonNull() ? value.get(key).getAsLong() : 0; }
    static boolean bool(JsonObject value, String key) { return value.has(key) && !value.get(key).isJsonNull() && value.get(key).getAsBoolean(); }
    static void requireSha(String value) { if (!value.matches("(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})")) throw new IllegalStateException("提交 SHA 无效"); }
}
