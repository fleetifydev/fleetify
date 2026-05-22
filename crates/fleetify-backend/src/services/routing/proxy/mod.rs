//! Proxy Gateways — providers sit behind these. Pluggable: direct (no proxy,
//! always available), weave (Task 12), litellm (Task 13), openrouter/inworld (v1.1).

pub mod direct;
pub mod registry;
