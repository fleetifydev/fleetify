//! Routing module — `DecisionRouter` and `ProxyGateway` traits + shared core types.
//! Spec: docs/superpowers/specs/2026-05-22-provider-router-design.md

pub mod traits;
pub mod capability_matrix;
pub mod intent;
pub mod agent_selector;
pub mod decision;

pub use traits::{
    AgentCandidate, AgentKind, ComplexityHint, DecisionRouter, DecisionSource, Message,
    ProviderKind, ProxyGateway, RouterDecision, RouterError, RoutingTask, TaskFlow,
    WorkspaceHints,
};
