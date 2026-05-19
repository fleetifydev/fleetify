//! Shared, I/O-free domain types for the Fleetify backend + shell.

/// Backend wire-protocol version. Bumped only on breaking WS/REST changes.
pub const PROTOCOL_VERSION: u32 = 1;

/// Top-level error shared across crates. Concrete variants are added per phase.
#[derive(Debug, thiserror::Error)]
pub enum FleetError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("{0}")]
    Other(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_version_is_one() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }

    #[test]
    fn fleet_error_displays() {
        assert_eq!(FleetError::NotFound("x".into()).to_string(), "not found: x");
        assert_eq!(FleetError::Unauthorized.to_string(), "unauthorized");
    }
}
