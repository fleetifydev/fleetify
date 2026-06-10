//! Build-time snapshot of the models registry. The single source of per-model
//! effort: `effort_capability` resolves through here. Overlaid by the live
//! remote catalog elsewhere for model LISTS; this provides the effort
//! descriptor (+ an offline baseline). Regenerate by re-copying
//! dist/models.json from fleetify-models whenever effort metadata changes.
use crate::providers::capabilities::EffortCapability;
use std::collections::HashMap;
use std::sync::OnceLock;

const SNAPSHOT: &str = include_str!("../../assets/models-snapshot.json");

/// (provider_catalog_id, model_id) → effort, parsed once from the snapshot.
pub fn snapshot_effort(provider_id: &str, model_id: &str) -> EffortCapability {
    static MAP: OnceLock<HashMap<(String, String), EffortCapability>> = OnceLock::new();
    let map = MAP.get_or_init(|| {
        let mut m = HashMap::new();
        let Ok(v) = serde_json::from_str::<serde_json::Value>(SNAPSHOT) else {
            return m;
        };
        let Some(provs) = v.get("providers").and_then(|p| p.as_object()) else {
            return m;
        };
        for prov in provs.values() {
            let Some(pid) = prov.get("id").and_then(|x| x.as_str()) else {
                continue;
            };
            let Some(models) = prov.get("models").and_then(|x| x.as_array()) else {
                continue;
            };
            for model in models {
                let Some(mid) = model.get("id").and_then(|x| x.as_str()) else {
                    continue;
                };
                let eff = model
                    .get("effort")
                    .and_then(EffortCapability::from_json)
                    .unwrap_or(EffortCapability::None);
                m.insert((pid.to_string(), mid.to_string()), eff);
            }
        }
        m
    });
    map.get(&(provider_id.to_string(), model_id.to_string()))
        .cloned()
        .unwrap_or(EffortCapability::None)
}
