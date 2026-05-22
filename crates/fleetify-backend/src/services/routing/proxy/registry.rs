//! Registry of connected ProxyGateways. DirectGateway ("none-proxy") is
//! mandatory and immortal. Mirrors decision::registry::DecisionRouterRegistry.

use std::collections::HashMap;
use std::sync::Arc;

use crate::services::routing::traits::ProxyGateway;

pub struct ProxyGatewayRegistry {
    pub(crate) gateways: HashMap<String, Arc<dyn ProxyGateway>>,
    active: String,
}

impl ProxyGatewayRegistry {
    pub fn new(direct: Arc<dyn ProxyGateway>) -> Self {
        assert_eq!(
            direct.id(),
            "none-proxy",
            "ProxyGatewayRegistry::new requires DirectGateway (id == \"none-proxy\")"
        );
        let mut gateways = HashMap::new();
        gateways.insert("none-proxy".to_string(), direct);
        Self {
            gateways,
            active: "none-proxy".into(),
        }
    }

    pub fn register(&mut self, g: Arc<dyn ProxyGateway>) {
        if g.id() == "none-proxy" {
            return;
        }
        self.gateways.insert(g.id().to_string(), g);
    }

    pub fn unregister(&mut self, id: &str) {
        if id == "none-proxy" {
            return;
        }
        self.gateways.remove(id);
        if self.active == id {
            self.active = "none-proxy".into();
        }
    }

    pub fn set_active(&mut self, id: &str) -> Result<(), String> {
        if self.gateways.contains_key(id) {
            self.active = id.into();
            Ok(())
        } else {
            Err(format!("gateway {id} not registered"))
        }
    }

    pub fn active(&self) -> Arc<dyn ProxyGateway> {
        self.gateways
            .get(&self.active)
            .cloned()
            .unwrap_or_else(|| self.gateways["none-proxy"].clone())
    }

    pub fn direct(&self) -> Arc<dyn ProxyGateway> {
        self.gateways["none-proxy"].clone()
    }

    pub fn list(&self) -> Vec<(String, String)> {
        self.gateways
            .values()
            .map(|g| (g.id().to_string(), g.display_name().to_string()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::routing::proxy::direct::DirectGateway;

    fn make_registry() -> ProxyGatewayRegistry {
        let d: Arc<dyn ProxyGateway> = Arc::new(DirectGateway);
        ProxyGatewayRegistry::new(d)
    }

    #[test]
    fn active_defaults_to_direct() {
        assert_eq!(make_registry().active().id(), "none-proxy");
    }

    #[test]
    fn unregister_direct_is_noop() {
        let mut reg = make_registry();
        reg.unregister("none-proxy");
        assert_eq!(reg.active().id(), "none-proxy");
    }

    #[test]
    fn set_active_unknown_errors() {
        let mut reg = make_registry();
        let r = reg.set_active("weave");
        assert!(r.is_err());
        assert_eq!(reg.active().id(), "none-proxy");
    }

    #[test]
    fn list_includes_direct() {
        let l = make_registry().list();
        assert!(l.iter().any(|(id, _)| id == "none-proxy"));
    }
}
