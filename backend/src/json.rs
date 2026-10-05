use crate::error::ApiError;
use axum::{
    Json,
    extract::{FromRequest, Request},
};
use serde_json::Value;
pub struct ApiJson(pub Value);
impl<S: Send + Sync> FromRequest<S> for ApiJson {
    type Rejection = ApiError;
    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<Value>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error| {
                ApiError(
                    error.status(),
                    "Request body must be valid JSON and fit the request size limit".into(),
                )
            })
    }
}
