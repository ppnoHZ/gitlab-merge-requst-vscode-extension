package com.gitlabworkbench.idea;

import com.google.gson.*;
import com.sun.net.httpserver.*;
import org.junit.jupiter.api.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class GitLabClientTest {
    static final String SHA = "a".repeat(40), OTHER = "b".repeat(40);
    HttpServer server; ExecutorService executor; GitLabClient api; String base;
    volatile String mode = "normal"; volatile boolean created, closed;
    final AtomicInteger posts = new AtomicInteger(); final List<String> paths = Collections.synchronizedList(new ArrayList<>());
    volatile JsonObject body;
    @BeforeEach void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0); executor = Executors.newCachedThreadPool(); server.setExecutor(executor);
        server.createContext("/api/v4", exchange -> {
            try { handle(exchange); } catch (Throwable error) { exchange.close(); }
        }); server.start(); base = "http://127.0.0.1:" + server.getAddress().getPort(); api = new GitLabClient(base, "test-token");
    }
    @AfterEach void stop() { server.stop(0); executor.shutdownNow(); }
    void handle(HttpExchange exchange) throws Exception {
        assertEquals("test-token", exchange.getRequestHeaders().getFirst("PRIVATE-TOKEN"));
        String path = exchange.getRequestURI().getPath(), query = exchange.getRequestURI().getQuery(); paths.add(exchange.getRequestURI().toString());
        if (mode.equals("slow")) { Thread.sleep(500); send(exchange, 200, "{}"); return; }
        if (mode.equals("redirect")) { exchange.getResponseHeaders().set("Location", base + "/other"); send(exchange, 302, "{}"); return; }
        if (mode.startsWith("http-")) { send(exchange, Integer.parseInt(mode.substring(5)), "{\"message\":\"test-token must not be shown\"}"); return; }
        if (mode.equals("login-page")) { send(exchange, 200, "<html>SSO login test-token</html>"); return; }
        if (exchange.getRequestMethod().equals("POST")) {
            posts.incrementAndGet(); body = JsonParser.parseString(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
            if (path.endsWith("/branches")) { created = true; if (mode.equals("lost")) { send(exchange, 500, "{}"); return; } send(exchange, 201, ref(body.get("branch").getAsString(), body.get("ref").getAsString())); }
            else send(exchange, 201, mr(9, "conflict/release/1", "opened"));
            return;
        }
        if (exchange.getRequestMethod().equals("PUT")) { closed = true; send(exchange, mode.equals("lost") ? 500 : 200, mr(1, "release/1", "closed")); return; }
        if (path.endsWith("/user")) { send(exchange, 200, "{\"id\":7}"); return; }
        if (path.endsWith("/projects/g/p")) { send(exchange, 200, "{\"id\":3,\"path_with_namespace\":\"g/p\",\"web_url\":\"https://gitlab.test/g/p\",\"default_branch\":\"main\"}"); return; }
        if (path.endsWith("/branches")) {
            boolean second = query.contains("page=2"); exchange.getResponseHeaders().set("X-Next-Page", second ? "" : "2");
            send(exchange, 200, "[" + ref(second ? "release/2" : "release/1", SHA) + "]"); return;
        }
        if (path.contains("/branches/")) {
            String name = path.substring(path.indexOf("/branches/") + 10);
            if (!Set.of("main", "tst", "release/1").contains(name) && !created) { send(exchange, mode.equals("denied") ? 403 : 404, "{}"); return; }
            send(exchange, 200, ref(name, mode.equals("changed") ? OTHER : SHA)); return;
        }
        if (path.contains("/tags/")) { send(exchange, 200, ref("v1", SHA)); return; }
        if (path.endsWith("/compare")) { send(exchange, 200, "{\"compare_timeout\":" + mode.equals("truncated") + ",\"commits\":[{\"short_id\":\"abc\",\"title\":\"change\"}],\"diffs\":[{\"new_path\":\"actual.txt\",\"old_path\":\"actual.txt\"}]}"); return; }
        if (path.endsWith("/approvals")) {
            if (mode.equals("approval-failure")) { send(exchange, 403, "{}"); return; }
            send(exchange, 200, "{\"approved_by\":" + (path.contains("/2/") ? "[{\"user\":{\"id\":7}}]" : "[]") + "}"); return;
        }
        if (path.matches(".*/merge_requests/\\d+")) { long iid = Long.parseLong(path.substring(path.lastIndexOf('/') + 1)); send(exchange, 200, mr(iid, "release/1", closed ? "closed" : "opened")); return; }
        if (path.endsWith("/merge_requests")) { exchange.getResponseHeaders().set("X-Next-Page", ""); send(exchange, 200, "[" + mr(1, "release/1", "opened") + "," + mr(2, "release/1", "opened") + "," + mr(1, "release/1", "opened") + "]"); return; }
        send(exchange, 404, "{}");
    }
    static String ref(String name, String sha) { JsonObject result = new JsonObject(); result.addProperty("name", name); JsonObject commit = new JsonObject(); commit.addProperty("id", sha); result.add("commit", commit); return result.toString(); }
    static String mr(long iid, String source, String state) { return "{\"id\":" + (iid + 100) + ",\"iid\":" + iid + ",\"project_id\":3,\"source_project_id\":3,\"target_project_id\":3,\"title\":\"MR\",\"source_branch\":\"" + source + "\",\"target_branch\":\"tst\",\"sha\":\"" + SHA + "\",\"state\":\"" + state + "\",\"web_url\":\"https://gitlab.test/mr/" + iid + "\",\"has_conflicts\":true,\"detailed_merge_status\":\"conflict\",\"reviewers\":[{\"id\":7}]}"; }
    void send(HttpExchange exchange, int status, String content) throws Exception { byte[] bytes = content.getBytes(StandardCharsets.UTF_8); exchange.sendResponseHeaders(status, bytes.length); exchange.getResponseBody().write(bytes); exchange.close(); }
    @Test void paginationAndEncodedProjectPaths() { assertEquals(3, api.project("g/p").id()); var page = api.refs(3, "branch", 1, "^release/"); assertEquals(2, page.next()); assertEquals("release/2", api.refs(3, "branch", page.next(), "^release/").items().getFirst().name()); assertTrue(paths.stream().anyMatch(path -> path.contains("g%2Fp"))); }
    @Test void branchCreateUsesPinnedShaAndDoesNotOverwrite() { api.createBranch(3, "release/2", "tag", "v1", SHA); assertEquals(SHA, body.get("ref").getAsString()); assertThrows(IllegalStateException.class, () -> api.createBranch(3, "release/2", "tag", "v1", SHA)); assertEquals(1, posts.get()); }
    @Test void changedBaselineAnd403DoNotCreate() { mode = "changed"; assertThrows(IllegalStateException.class, () -> api.createBranch(3, "release/2", "branch", "main", SHA)); mode = "denied"; assertThrows(GitLabClient.ApiException.class, () -> api.createBranch(3, "release/2", "branch", "main", SHA)); assertEquals(0, posts.get()); }
    @Test void lostBranchResponseReconcilesWithoutAnotherPost() { mode = "lost"; assertEquals(SHA, api.createBranch(3, "conflict/release/1", "branch", "tst", SHA).sha()); assertEquals(1, posts.get()); }
    @Test void authoredAndApprovalCountsAreDistinctAndDeduplicated() { var todos = api.todos(); assertEquals(2, todos.authored().size()); assertEquals(1, todos.reviews().size()); assertTrue(todos.approvalsComplete()); }
    @Test void unavailableApprovalsKeepAuthoredMrsButDoNotInventACount() {
        mode = "approval-failure"; var todos = api.todos();
        assertEquals(2, todos.authored().size()); assertEquals(2, todos.reviews().size()); assertFalse(todos.approvalsComplete());
    }
    @Test void closesOnlyConfirmedVersionAndReconcilesLostResponse() { var original = api.mr(3, 1); mode = "lost"; api.closeOriginal(original); assertTrue(closed); api.closeOriginal(original); }
    @Test void comparisonUsesActualShasAndRejectsIncompleteData() { var result = api.compare(3, SHA, OTHER); assertEquals(List.of("M actual.txt"), result.files()); assertTrue(paths.getLast().contains("straight=false")); assertTrue(paths.getLast().contains("from=" + OTHER)); mode = "truncated"; assertThrows(IllegalStateException.class, () -> api.compare(3, SHA, OTHER)); }
    @Test void replacementForcesTargetRulesAndMergeOptions() { var result = api.createReplacement(3, "conflict/release/1", "tst", "Title", "Description", List.of(7L)); assertEquals(9, result.iid()); assertTrue(body.get("remove_source_branch").getAsBoolean()); assertFalse(body.get("squash").getAsBoolean()); assertEquals(7, body.getAsJsonArray("reviewer_ids").get(0).getAsInt()); assertThrows(IllegalArgumentException.class, () -> api.createReplacement(3, "conflict/release/1", "main", "Title", "Description", List.of(7L))); }
    @Test void requestTimeoutAndRedirectProtection() { mode = "slow"; assertThrows(GitLabClient.ApiException.class, () -> new GitLabClient(base, "test-token", Duration.ofMillis(80)).project("g/p")); mode = "redirect"; assertEquals(302, assertThrows(GitLabClient.ApiException.class, () -> api.project("g/p")).status); }
    @Test void validatesInstanceAndConflictRules() { assertThrows(IllegalArgumentException.class, () -> GitLabClient.normalizeInstance("https://token@gitlab.test")); assertThrows(IllegalArgumentException.class, () -> GitLabClient.normalizeInstance("file:///tmp")); assertEquals("https://gitlab.test", GitLabClient.normalizeInstance("https://gitlab.test/")); api.mr(3, 1).requireConflict(); }
    @Test void connectionTestChecksAuthenticationThenProjectWithoutWriting() {
        assertEquals(3, api.testConnection("g/p").id());
        assertEquals(List.of("/api/v4/user", "/api/v4/projects/g%2Fp"), paths); assertEquals(0, posts.get());
        paths.clear(); mode = "http-401";
        assertThrows(GitLabClient.ApiException.class, () -> api.testConnection("g/p"));
        assertEquals(List.of("/api/v4/user"), paths);
    }
    @Test void errorsExplainWhatToFixWithoutEchoingServerSecrets() {
        Map<Integer, String> cases = Map.of(401, "Token", 403, "权限", 404, "项目", 407, "代理", 429, "频繁", 502, "网关");
        cases.forEach((code, hint) -> {
            mode = "http-" + code;
            var error = assertThrows(GitLabClient.ApiException.class, () -> api.project("g/p"));
            assertEquals(code, error.status); assertTrue(error.getMessage().contains(hint)); assertFalse(error.getMessage().contains("test-token"));
        });
        mode = "login-page";
        var error = assertThrows(GitLabClient.ApiException.class, () -> api.project("g/p"));
        assertTrue(error.getMessage().contains("SSO")); assertFalse(error.getMessage().contains("test-token"));
    }
    @Test void networkDiagnosticsDistinguishDnsCertificatesAndTimeouts() {
        assertTrue(GitLabClient.networkError(new java.io.IOException(new UnknownHostException())).contains("DNS"));
        assertTrue(GitLabClient.networkError(new javax.net.ssl.SSLHandshakeException("secret")).contains("Server Certificates"));
        assertTrue(GitLabClient.networkError(new java.net.http.HttpTimeoutException("secret")).contains("超时"));
        assertTrue(GitLabClient.networkError(new ConnectException("secret")).contains("端口"));
    }
    @Test void usesConfiguredProxySelector() {
        ProxySelector old = ProxySelector.getDefault(); AtomicInteger selected = new AtomicInteger();
        try {
            ProxySelector.setDefault(new ProxySelector() {
                @Override public List<Proxy> select(URI uri) { selected.incrementAndGet(); return List.of(Proxy.NO_PROXY); }
                @Override public void connectFailed(URI uri, SocketAddress address, java.io.IOException error) {}
            });
            new GitLabClient(base, "test-token").project("g/p"); assertTrue(selected.get() > 0);
        } finally { ProxySelector.setDefault(old); }
    }
}
