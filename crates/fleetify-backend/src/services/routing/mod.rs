//! Routing module — `DecisionRouter` and `ProxyGateway` traits + shared core types.
//! Spec: docs/superpowers/specs/2026-05-22-provider-router-design.md

pub mod agent_selector;
pub mod capability_matrix;
pub mod decision;
pub mod intent;
pub mod orchestrator;
pub mod persist;
pub mod proxy;
pub mod setup;
pub mod traits;

pub use orchestrator::{RouteOutcome, RoutingOrchestrator};
pub use traits::{
    AgentCandidate, AgentKind, ComplexityHint, DecisionRouter, DecisionSource, Message,
    ProviderKind, ProxyGateway, RouterDecision, RouterError, RoutingTask, TaskFlow, WorkspaceHints,
};
