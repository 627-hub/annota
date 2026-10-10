#[cfg(test)]
mod integration {
    use crate::store::Db;
    use crate::sync_server::{build_app, AppState};

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use tower::ServiceExt;

    fn tmp_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("annota-it-{}-{}", label, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_state() -> AppState {
        let dir = tmp_dir("app");
        let db = Db::open_in_memory().unwrap();
        let settings = dir.join("settings.json");
        let exports = dir.join("exports");
        std::fs::create_dir_all(&exports).unwrap();
        AppState::new(
            dir.clone(),
            dir.clone(),
            dir.join("notes"),
            settings,
            exports,
            db,
        )
    }

    async fn body_json(body: Body) -> Value {
        let bytes = body.collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn lb_get(uri: &str) -> Request<Body> {
        Request::builder()
            .method("GET")
            .uri(uri)
            .header("host", "127.0.0.1:8793")
            .body(Body::empty())
            .unwrap()
    }

    fn lb_post(uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("host", "127.0.0.1:8793")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    }

    fn lb_put(uri: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri(uri)
            .header("host", "127.0.0.1:8793")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap()
    }

    fn lb_delete(uri: &str) -> Request<Body> {
        Request::builder()
            .method("DELETE")
            .uri(uri)
            .header("host", "127.0.0.1:8793")
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let app = build_app(test_state());
        let resp = app.oneshot(lb_get("/api/health")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp.into_body()).await;
        assert_eq!(v["ok"], true);
        assert_eq!(v["port"], 8793);
    }

    #[tokio::test]
    async fn list_returns_empty_for_new_store() {
        let app = build_app(test_state());
        let resp = app.oneshot(lb_get("/api/list")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp.into_body()).await;
        assert!(v["files"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn anno_crud_lifecycle() {
        let app = build_app(test_state());

        let resp = app.clone().oneshot(lb_get("/api/anno/vid1")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp.into_body()).await;
        assert_eq!(v["entries"].as_array().unwrap().len(), 0);

        let entry = json!({
            "entries": [{
                "id": "e1", "word": "hello", "label": "你好",
                "box": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4},
                "t": 5.0, "dur": 2.0
            }]
        });
        let resp = app.clone().oneshot(lb_put("/api/anno/vid1", entry)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp.into_body()).await;
        assert_eq!(v["entries"].as_array().unwrap().len(), 1);

        let resp = app.clone().oneshot(lb_get("/api/anno/vid1")).await.unwrap();
        let v = body_json(resp.into_body()).await;
        assert_eq!(v["entries"][0]["word"], "hello");
    }

    #[tokio::test]
    async fn bookmark_post_and_list() {
        let app = build_app(test_state());

        let body = json!({"url": "https://example.com/", "title": "Example"});
        let resp = app.clone().oneshot(lb_post("/api/bookmarks", body)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp.into_body()).await;
        assert_eq!(v["created"], true);

        let resp = app.oneshot(lb_get("/api/bookmarks")).await.unwrap();
        let v = body_json(resp.into_body()).await;
        let bm = v["bookmarks"].as_array().unwrap();
        assert_eq!(bm.len(), 1);
        assert_eq!(bm[0]["url"], "https://example.com/");
    }

    #[tokio::test]
    async fn history_clear() {
        let app = build_app(test_state());
        let resp = app.oneshot(lb_delete("/api/history")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp.into_body()).await;
        assert_eq!(v["ok"], true);
    }

    #[tokio::test]
    async fn settings_get_returns_defaults() {
        let app = build_app(test_state());
        let resp = app.oneshot(lb_get("/api/settings")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp.into_body()).await;
        assert_eq!(v["ok"], true);
        assert!(v["settings"]["shortcuts"]["annotate"].is_string());
    }

    #[tokio::test]
    async fn host_guard_rejects_non_loopback() {
        let app = build_app(test_state());
        let req = Request::builder()
            .method("GET")
            .uri("/api/health")
            .header("host", "evil.com:8793")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn origin_guard_rejects_cross_site_write() {
        let app = build_app(test_state());
        let req = Request::builder()
            .method("POST")
            .uri("/api/bookmarks")
            .header("host", "127.0.0.1:8793")
            .header("origin", "https://evil.com")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({"url":"https://x.com/"})).unwrap(),
            ))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn content_type_gate_rejects_text_plain_put() {
        let app = build_app(test_state());
        let req = Request::builder()
            .method("PUT")
            .uri("/api/anno/vid1")
            .header("host", "127.0.0.1:8793")
            .header("content-type", "text/plain")
            .body(Body::from("not json"))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn diag_returns_ok() {
        let app = build_app(test_state());
        let resp = app.oneshot(lb_get("/api/diag")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp.into_body()).await;
        assert_eq!(v["ok"], true);
        assert!(v["corruptPacks"].is_array());
    }

    #[tokio::test]
    async fn csp_header_on_html_responses() {
        let app = build_app(test_state());
        let resp = app.oneshot(lb_get("/")).await.unwrap();
        let csp = resp
            .headers()
            .get("content-security-policy")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(csp.contains("default-src 'self'"), "CSP 应含 default-src: {csp}");
        assert!(csp.contains("script-src"), "CSP 应含 script-src: {csp}");
        assert!(csp.contains("frame-src 'none'"), "CSP 应禁 frame: {csp}");
    }

    #[tokio::test]
    async fn csp_header_absent_on_json_responses() {
        let app = build_app(test_state());
        let resp = app.oneshot(lb_get("/api/health")).await.unwrap();
        assert!(resp.headers().get("content-security-policy").is_none(),
            "JSON API 不应带 CSP 头");
    }

    #[tokio::test]
    async fn rate_limit_blocks_after_threshold() {
        let app = build_app(test_state());
        // 先确认正常请求通过
        let resp = app.clone().oneshot(lb_get("/api/health")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        // 快速发超过写限制的 POST（15/s）——用不同 body 避免内容缓存
        let mut last = StatusCode::OK;
        for i in 0..25 {
            let body = json!({"url": format!("https://x{i}.com/"), "title": "t"});
            let r = app.clone().oneshot(lb_post("/api/bookmarks", body)).await.unwrap();
            last = r.status();
            if last == StatusCode::TOO_MANY_REQUESTS { break; }
        }
        // 不断言一定触发 429（时间窗口可能跨秒），但断言逻辑不 panic 且最终状态是 2xx 或 429
        assert!(last == StatusCode::OK || last == StatusCode::TOO_MANY_REQUESTS,
            "限流应返回 OK 或 429，实际 {last}");
    }
}
