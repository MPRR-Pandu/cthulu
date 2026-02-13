use axum::{
    body::Body,
    http::{Request, Uri},
    middleware::Next,
    response::Response,
};
use tracing::Span;

pub async fn enrich_current_span_middleware(req: Request<Body>, next: Next) -> Response {
    let uri: &Uri = req.uri();

    let host = req
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("UNKNOWN");

    let current_span = Span::current();

    current_span.record("http.uri", &uri.path());
    current_span.record("http.host", &host);
    if let Some(query) = uri.query() {
        current_span.record("http.query", &query);
    }

    next.run(req).await
}
