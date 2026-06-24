//! Backend-owned delegation batches. A batch is the unit the Fleet Hub
//! delegation flow tracks: N dispatches fired through `dispatch_exec::dispatch_one`,
//! each with a queued→running→done|failed lifecycle. In-memory only (v1, no
//! persistence); capped so the registry can't grow unbounded (oldest evicted,
//! logged — no silent caps).
//!
//! Outcomes are read back from the persisted `dispatch_result` message via
//! `dispatch_exec::read_dispatch_outcome` once each spawned run completes — the
//! dispatch engine itself is untouched.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::routers::AppState;
use crate::services::auto_planner::PlanDispatch;
use crate::services::dispatch_exec::{dispatch_one, read_dispatch_outcome, DispatchSpec};

/// Keep at most this many batches; evict the oldest (by `created_at`) over cap.
const MAX_BATCHES: usize = 40;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DispatchStatus {
    Queued,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct DispatchState {
    pub target_id: String,
    pub target_title: String,
    pub task: String,
    pub status: DispatchStatus,
    pub summary: String,
    pub error: String,
}
impl DispatchState {
    pub fn queued(target_id: &str, target_title: &str, task: &str) -> Self {
        Self {
            target_id: target_id.into(),
            target_title: target_title.into(),
            task: task.into(),
            status: DispatchStatus::Queued,
            summary: String::new(),
            error: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Batch {
    /// Internal key; serialized as `batch_id` for the client contract.
    #[serde(rename = "batch_id")]
    pub id: String,
    /// Owner — used for ownership scoping; never serialized to the client.
    #[serde(skip)]
    pub user_id: Option<String>,
    pub created_at: String,
    pub dispatches: Vec<DispatchState>,
    pub done: bool,
}

fn registry() -> &'static Mutex<HashMap<String, Batch>> {
    static R: OnceLock<Mutex<HashMap<String, Batch>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn recompute_done(b: &mut Batch) {
    b.done = b
        .dispatches
        .iter()
        .all(|d| matches!(d.status, DispatchStatus::Done | DispatchStatus::Failed));
}

/// Insert a batch (all dispatches already seeded). Evicts the oldest when over
/// cap. Returns the batch id. Public so tests can drive the lifecycle directly.
pub fn register_batch(user_id: Option<&str>, dispatches: Vec<DispatchState>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let mut batch = Batch {
        id: id.clone(),
        user_id: user_id.map(String::from),
        created_at: chrono::Utc::now().to_rfc3339(),
        dispatches,
        done: false,
    };
    recompute_done(&mut batch);
    let mut reg = registry().lock().unwrap();
    if reg.len() >= MAX_BATCHES {
        if let Some(oldest) = reg
            .values()
            .min_by(|a, b| a.created_at.cmp(&b.created_at))
            .map(|b| b.id.clone())
        {
            reg.remove(&oldest);
            tracing::info!(
                target: "fleet-delegate",
                evicted = %oldest,
                "batch registry over cap; evicted oldest",
            );
        }
    }
    reg.insert(id.clone(), batch);
    id
}

pub fn get_batch(batch_id: &str) -> Option<Batch> {
    registry().lock().unwrap().get(batch_id).cloned()
}

pub fn batch_belongs_to(batch_id: &str, user_id: Option<&str>) -> bool {
    match get_batch(batch_id) {
        Some(b) => b.user_id.as_deref() == user_id,
        None => false,
    }
}

/// Transition a single dispatch's status (matched by the original `target_id`
/// the plan carried). Empty `summary`/`error` leave the existing value.
pub fn set_status(
    batch_id: &str,
    target_id: &str,
    status: DispatchStatus,
    summary: &str,
    error: &str,
) {
    let mut reg = registry().lock().unwrap();
    if let Some(b) = reg.get_mut(batch_id) {
        if let Some(d) = b.dispatches.iter_mut().find(|d| d.target_id == target_id) {
            d.status = status;
            if !summary.is_empty() {
                d.summary = summary.into();
            }
            if !error.is_empty() {
                d.error = error.into();
            }
        }
        recompute_done(b);
    }
}

fn set_title(batch_id: &str, target_id: &str, title: &str) {
    let mut reg = registry().lock().unwrap();
    if let Some(b) = reg.get_mut(batch_id) {
        if let Some(d) = b.dispatches.iter_mut().find(|d| d.target_id == target_id) {
            d.target_title = title.into();
        }
    }
}

/// Fire a planned set of dispatches under one batch. Each dispatch is resolved
/// and guarded by `dispatch_one`; a guard rejection marks that dispatch
/// `Failed` without stopping the others (partial success). Returns the batch
/// id immediately; the per-dispatch tasks update status as they progress.
pub fn start_batch(
    st: AppState,
    user_id: Option<&str>,
    caller_session_id: &str,
    dispatches: Vec<PlanDispatch>,
) -> String {
    let seed: Vec<DispatchState> = dispatches
        .iter()
        .map(|d| DispatchState::queued(&d.target_id, &d.target_id, &d.task))
        .collect();
    let batch_id = register_batch(user_id, seed);

    for d in dispatches {
        let bid = batch_id.clone();
        let caller = caller_session_id.to_string();
        let st = st.clone();
        let spec = DispatchSpec {
            agent_ref: d.target_id.clone(),
            task: d.task.clone(),
        };
        tokio::spawn(async move {
            set_status(&bid, &d.target_id, DispatchStatus::Running, "", "");
            match dispatch_one(&st, &caller, &spec).await {
                Ok((target, join)) => {
                    set_title(&bid, &d.target_id, &target.title);
                    // Wait for the bridge run to finish, then read its outcome
                    // back from the persisted dispatch_result on the caller.
                    let _ = join.await;
                    match read_dispatch_outcome(&st.auth.pool, &caller, &target.id).await {
                        Some(o) if o.success => {
                            set_status(&bid, &d.target_id, DispatchStatus::Done, &o.summary, "")
                        }
                        Some(o) => {
                            set_status(&bid, &d.target_id, DispatchStatus::Failed, "", &o.summary)
                        }
                        None => set_status(
                            &bid,
                            &d.target_id,
                            DispatchStatus::Failed,
                            "",
                            "agent produced no result",
                        ),
                    }
                }
                Err(e) => set_status(
                    &bid,
                    &d.target_id,
                    DispatchStatus::Failed,
                    "",
                    &format!("{e:?}"),
                ),
            }
        });
    }
    batch_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_lifecycle_records_and_reads() {
        let id = register_batch(
            Some("user-1"),
            vec![
                DispatchState::queued("t1", "Alpha", "do a"),
                DispatchState::queued("t2", "Beta", "do b"),
            ],
        );
        let got = get_batch(&id).expect("batch exists");
        assert_eq!(got.dispatches.len(), 2);
        assert_eq!(got.dispatches[0].status, DispatchStatus::Queued);
        assert!(!got.done);

        set_status(&id, "t1", DispatchStatus::Done, "ok", "");
        let got = get_batch(&id).unwrap();
        assert_eq!(got.dispatches[0].status, DispatchStatus::Done);
        assert_eq!(got.dispatches[0].summary, "ok");
        assert!(!got.done); // t2 still queued

        set_status(&id, "t2", DispatchStatus::Failed, "", "budget");
        let got = get_batch(&id).unwrap();
        assert_eq!(got.dispatches[1].error, "budget");
        assert!(got.done); // all terminal
    }

    #[test]
    fn get_batch_unknown_returns_none() {
        assert!(get_batch("does-not-exist").is_none());
    }

    #[test]
    fn batch_belongs_to_scopes_by_user() {
        let id = register_batch(Some("owner"), vec![DispatchState::queued("t", "T", "x")]);
        assert!(batch_belongs_to(&id, Some("owner")));
        assert!(!batch_belongs_to(&id, Some("intruder")));
        assert!(!batch_belongs_to("nope", Some("owner")));
    }
}
