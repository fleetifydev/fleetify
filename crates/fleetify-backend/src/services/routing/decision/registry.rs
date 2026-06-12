//! Registry of connected DecisionRouters. Built-in is mandatory and immortal.

use std::collections::HashMap;
use std::sync::Arc;

use crate::services::routing::traits::DecisionRouter;

pub struct DecisionRouterRegistry {
    pub(crate) routers: HashMap<String, Arc<dyn DecisionRouter>>,
    active: String,
}

impl DecisionRouterRegistry {
    pub fn new(builtin: Arc<dyn DecisionRouter>) -> Self {
        assert_eq!(
            builtin.id(),
            "builtin",
            "DecisionRouterRegistry::new requires the builtin router (id == \"builtin\")"
        );
        let mut routers = HashMap::new();
        routers.insert("builtin".to_string(), builtin);
        Self {
            routers,
            active: "builtin".into(),
        }
    }

    pub fn register(&mut self, r: Arc<dyn DecisionRouter>) {
        if r.id() == "builtin" {
            // Refuse to overwrite the immortal default.
            return;
        }
        self.routers.insert(r.id().to_string(), r);
    }

    /// Removing builtin is a no-op (immortal). Removing the currently-active
    /// router falls back to builtin.
    pub fn unregister(&mut self, id: &str) {
        if id == "builtin" {
            return;
        }
        self.routers.remove(id);
        if self.active == id {
            self.active = "builtin".into();
        }
    }

    /// Set the active router by id. Errors if id isn't registered.
    pub fn set_active(&mut self, id: &str) -> Result<(), String> {
        if self.routers.contains_key(id) {
            self.active = id.into();
            Ok(())
        } else {
            Err(format!("router {id} not registered"))
        }
    }

    /// Returns the active router. Falls back to builtin if active was somehow
    /// removed under us (defensive — shouldn't happen since unregister handles it).
    pub fn active(&self) -> Arc<dyn DecisionRouter> {
        self.routers
            .get(&self.active)
            .cloned()
            .unwrap_or_else(|| self.routers["builtin"].clone())
    }

    pub fn builtin(&self) -> Arc<dyn DecisionRouter> {
        self.routers["builtin"].clone()
    }

    /// `(id, display_name)` pairs for every registered router.
    pub fn list(&self) -> Vec<(String, String)> {
        self.routers
            .values()
            .map(|r| (r.id().to_string(), r.display_name().to_string()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::routing::capability_matrix::CapabilityMatrix;
    use crate::services::routing::decision::builtin::BuiltInRouter;

    fn matrix() -> CapabilityMatrix {
        toml::from_str(
            r#"
[agents.claude-code]
supports_tool_use = true
supports_vision = true
max_context = 200000
mcp_support = true
default_model = "claude-sonnet-4-6"
tiers = ["claude-sonnet-4-6"]
        "#,
        )
        .unwrap()
    }

    fn make_registry() -> DecisionRouterRegistry {
        let builtin: Arc<dyn DecisionRouter> = Arc::new(BuiltInRouter::new(matrix()));
        DecisionRouterRegistry::new(builtin)
    }

    #[test]
    fn active_defaults_to_builtin() {
        let reg = make_registry();
        assert_eq!(reg.active().id(), "builtin");
    }

    #[test]
    fn builtin_is_always_present() {
        let reg = make_registry();
        assert_eq!(reg.builtin().id(), "builtin");
    }

    #[test]
    fn unregister_builtin_is_noop() {
        let mut reg = make_registry();
        reg.unregister("builtin");
        assert_eq!(reg.active().id(), "builtin");
        assert_eq!(reg.builtin().id(), "builtin");
    }

    #[test]
    fn set_active_unknown_errors() {
        let mut reg = make_registry();
        let r = reg.set_active("notdiamond");
        assert!(r.is_err());
        assert_eq!(reg.active().id(), "builtin");
    }

    #[test]
    fn list_includes_builtin() {
        let reg = make_registry();
        let l = reg.list();
        assert!(l.iter().any(|(id, _)| id == "builtin"));
    }
}
