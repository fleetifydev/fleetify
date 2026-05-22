//! Decision Routers — Layer 2 of the two-layer router. Pluggable: builtin (always
//! available, offline), notdiamond (Task 11), weave (Task 12), inworld (v1.1).

pub mod builtin;
pub mod registry;
