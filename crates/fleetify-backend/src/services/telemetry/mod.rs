//! Telemetry pipeline = the only path from local agent loop to the
//! Fleetify cloud dashboard. Faithful subset of `services/telemetry/*.py`.
//!
//! Phase-2 cut implemented:
//! - `device_id::get_or_create()` → stable per-machine UUID persisted
//!   to `<HOME>/.fleetify/device.json`.
//! - `outbox` → sqlite-backed durable queue at
//!   `<HOME>/.fleetify/telemetry-outbox.sqlite`. Enqueue / peek_pending /
//!   mark_acked / bump_attempt / count.
//! - `emitters` → `emit_{session_start,session_stop,cost,status_change,
//!   activity,heartbeat}` write to the outbox and pulse a Notify so the
//!   eventual `ws_client` flushes immediately.
//!
//! Deferred to follow-up commits:
//! - `ws_client::run_ws_client_loop` (339 LOC Python — WebSocket to
//!   fleetify.dev with replay + dedup via `seen_id`).
//! - `heartbeat::run_heartbeat_loop` (50 LOC — 60 s timer calling
//!   `emit_heartbeat`).
//!
//! Privacy tier: "Standard + identifying" — titles + paths allowed,
//! never prompt content / file content / command stdio.

pub mod device_id;
pub mod emitters;
pub mod heartbeat;
pub mod outbox;
pub mod ws_client;

pub use device_id::{get_or_create, DeviceInfo};
pub use emitters::{
    emit_activity, emit_cost, emit_heartbeat, emit_session_start, emit_session_stop,
    emit_status_change,
};
pub use heartbeat::run_heartbeat_loop;
pub use ws_client::{run_ws_client_loop, BearerSource};
