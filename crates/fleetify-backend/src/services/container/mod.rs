//! Running a session's agent inside a container.
//!
//! [`crate::services::exec_target`] answers *where* a turn runs; this module
//! answers *how* — which binary exists on the other side of the boundary,
//! which credentials can cross it, which flags the CLI needs because the
//! container replaced its own sandbox, and (for containers Fleetify itself
//! provisions) the lifecycle around them.
//!
//! Split from `exec_target` on purpose: that module stays a pure parser with
//! no provider knowledge, so the "where" question keeps its 20 unit tests and
//! its single responsibility.

pub mod credentials;
pub mod lifecycle;
pub mod providers;
pub mod spawn;

pub use providers::{spec_for, ContainerSupport, ProviderContainerSpec};
