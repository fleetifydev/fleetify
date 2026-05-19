use serde::{Deserialize, Serialize};

/// `cost_events` row. Mirrors `backend/app/models/cost.py::CostEvent`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct CostEvent {
    pub id: String,
    pub session_id: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost_usd: f64,
    pub timestamp: String,
}
