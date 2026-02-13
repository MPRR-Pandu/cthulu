use axum::{
    body::Body,
    http::{Request, Uri},
    middleware::Next,
    response::{IntoResponse, Redirect, Response},
};

pub async fn strip_trailing_slash(req: Request<Body>, next: Next) -> Response {
    let uri = req.uri();

    if let Some(path) = uri.path().strip_suffix('/') {
        let mut parts = uri.clone().into_parts();
        parts.path_and_query = Some(if let Some(query) = uri.query() {
            format!("{}?{}", path, query).parse().unwrap()
        } else {
            path.parse().unwrap()
        });

        let new_uri = Uri::from_parts(parts).unwrap();

        Redirect::permanent(&new_uri.to_string()).into_response()
    } else {
        next.run(req).await
    }
}
