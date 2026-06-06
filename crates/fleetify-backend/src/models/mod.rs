//! serde + sqlx::FromRow structs. Field names are the original snake_case
//! names — the unchanged React renderer and future wire-protocol parity
//! depend on these exact names.

pub mod account;
pub mod activity;
pub mod cost;
pub mod memory;
pub mod message;
pub mod plugin;
pub mod session;
pub mod user;
