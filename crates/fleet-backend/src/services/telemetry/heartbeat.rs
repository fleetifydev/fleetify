//! Device presence heartbeat. Long-running task that emits one
//! `device_heartbeat` event every `HEARTBEAT_INTERVAL_S` so the cloud
//! keeps `telemetry_device.last_seen_at` fresh — that's how the
//! dashboard shows a workstation as "online" even when no agent
//! session is actively running.

use std::time::Duration;

use chrono::Utc;

use super::emitters::emit_heartbeat;

pub const HEARTBEAT_INTERVAL_S: u64 = 60;

/// Long-running task. Started at backend serve() startup alongside the
/// WS client loop. Never returns (cancellation expected on shutdown).
pub async fn run_heartbeat_loop() {
    // First beat fires immediately so the device shows up on the
    // dashboard as soon as the WS client gets a bearer.
    loop {
        if let Err(e) = emit_heartbeat(Utc::now()).await {
            tracing::warn!(
                target: "fleetify.telemetry",
                "telemetry: heartbeat emit failed ({e}); will retry"
            );
        }
        tokio::time::sleep(Duration::from_secs(HEARTBEAT_INTERVAL_S)).await;
    }
}
