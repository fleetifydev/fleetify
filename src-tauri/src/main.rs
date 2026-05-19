#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Tauri v2: keep main.rs trivial; all logic lives in lib.rs `run()` so the
// desktop and mobile entry points stay identical.
fn main() {
    fleetify_app_lib::run();
}
