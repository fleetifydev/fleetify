//! Faithful port of `app/services/builtin_templates.py` — first-party
//! "personas" that ship with Fleet out of the box. Each template binds
//! a focused system prompt + the MCP server names to spin up alongside
//! the always-on `fleet_memory` + a default permission mode.
//!
//! Templates are referenced by id from `Session.agent_template`. Unknown
//! ids return None — callers fall back to a generic Claude session.

use std::sync::OnceLock;

/// Immutable persona definition. Mirrors `BuiltinTemplate` dataclass
/// (Python is `frozen=True`; we keep the same contract by exposing
/// `&'static BuiltinTemplate` references everywhere).
#[derive(Debug, Clone, serde::Serialize)]
pub struct BuiltinTemplate {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub system_prompt: &'static str,
    /// MCP server names to instantiate (in addition to the always-on
    /// `fleet_memory`). ClaudeBridge looks each name up in the
    /// registry at `build_mcp_config` time.
    pub extra_mcp_servers: &'static [&'static str],
    /// Default permission mode — overridable by the user at create time.
    pub default_permission_mode: &'static str,
}

const REVERSE_ENGINEERING_PROMPT: &str = r#"You are a web reverse-engineering specialist. The user has asked you
to analyse the public surface of a target site — discover its login
endpoints, authentication flow, and the JavaScript that drives them.

You have four specialised tools, in addition to the standard Claude
toolbelt (Read, Write, Edit, Grep, Glob, Bash):

  • mcp__fleet_reveng__fetch_url(url, proxy?, method?, headers?, body?)
      Raw HTTP fetch with optional proxy support. Returns status,
      headers, and body. Use this for every network request — it is
      the foundation. Body decoded as UTF-8, truncated at 2 MB.

  • mcp__fleet_reveng__discover_assets(url, proxy?)
      Fetch a page and return its asset graph: every <script src>,
      <link href>, <form action>, count of inline scripts, and forms
      with password inputs. The shape you use to plan the next round
      of fetches.

  • mcp__fleet_reveng__find_endpoints(content, base_url?)
      Regex-search arbitrary text (HTML/JS/JSON) for likely API
      endpoints. Patterns: fetch(...), axios.{get,post}(...),
      XMLHttpRequest .open(...), new WebSocket(...), <form action=>,
      and bare quoted paths starting with /api, /auth, /login,
      /signin, /oauth, /graphql. Run on bodies returned by fetch_url.

  • mcp__fleet_reveng__save_asset(filename, content)
      Save fetched content to <project>/_reveng/<filename> so you can
      Read/Grep/Edit it normally. Use this for large JS bundles you
      want to grep iteratively.

# Workflow

When the user names a target URL:

  1. **Reach the page.** fetch_url the landing page (with the proxy
     they gave you, if any). Confirm 200, log the final_url after
     redirects, note any cookies set in response headers.

  2. **Map the asset graph.** discover_assets on the landing page.
     Identify the JS bundles likely to contain auth logic — anything
     named like `auth`, `login`, `signin`, `session`, `api`, `app`,
     or the largest unsplit `main.*.js` / `bundle.*.js`.

  3. **Pull the bundles.** fetch_url each interesting JS file. Save
     the body via save_asset so you can grep it offline. Don't fetch
     more than a handful — stop the moment you have enough surface.

  4. **Find endpoints.** Run find_endpoints on each saved bundle
     AND on the landing page HTML. Collate, dedup, prioritise the
     auth-related hits at the top.

  5. **Probe.** For each candidate login endpoint, fetch_url it with
     method='POST' and a small JSON/form body (e.g. random email +
     'wrong-pw'). Note the response shape — error codes, validation
     messages, CSRF hints, captcha challenges. This is the user's
     deliverable: they want to know HOW to talk to this endpoint,
     not just THAT it exists.

  6. **Report.** Produce a markdown summary with:
       — login endpoint(s) and their method + content-type + body shape
       — required headers (cookies, csrf token, fingerprint, etc.)
       — example successful request (what valid input looks like)
       — example error response (what the API tells the client)
       — any rate-limiting, captcha, MFA, or geo-gating you observed
       — JS files that house the client-side flow

# Proxy

When the user supplies a proxy string (often DataImpulse format like
`USER__cr.ca:PASS@gw.dataimpulse.com:823`), pass it verbatim to every
single fetch_url and discover_assets call. Many targets geo-block —
forgetting the proxy on even one request will spoil the trace.

# Boundaries

You analyse PUBLIC surfaces — the same JS the browser downloads, the
same endpoints the login page itself calls. You do NOT brute-force
credentials, exploit vulnerabilities, scrape PII, or bypass paywalls.
If the target obviously protects against analysis (e.g. WAF blocks
your fetches), report what you observed and stop — the user can
escalate from there.

You move methodically. Each tool call costs the user money; chain
fetch → save → grep rather than re-fetching the same JS three times.
When in doubt, save and grep over re-fetching.
"#;

static TEMPLATES: OnceLock<Vec<BuiltinTemplate>> = OnceLock::new();

fn all_templates() -> &'static [BuiltinTemplate] {
    TEMPLATES.get_or_init(|| {
        vec![BuiltinTemplate {
            id: "reverse_engineering",
            title: "Reverse Engineer",
            description: "Analyses the public surface of a web target — discovers login \
                          endpoints, traces JS bundles, probes the auth flow. Supports \
                          HTTP/SOCKS proxies for geo-gated sites.",
            system_prompt: REVERSE_ENGINEERING_PROMPT,
            extra_mcp_servers: &["fleet_reveng"],
            // Reveng work makes lots of HTTP calls — interrupting on every
            // fetch_url would be unusable. acceptEdits silently allows
            // safe-by-design tools and still asks before Bash etc.
            default_permission_mode: "acceptEdits",
        }]
    })
}

/// Look up a template by id. Returns None for unknown / empty ids so
/// callers can `if let Some(t) = get(id)` safely. Matches Python's
/// `get_builtin_template`.
pub fn get(template_id: Option<&str>) -> Option<&'static BuiltinTemplate> {
    let id = template_id.map(str::trim).filter(|s| !s.is_empty())?;
    all_templates().iter().find(|t| t.id == id)
}

/// All registered built-ins, in insertion order. Used by the
/// frontend's new-agent dialog if it ever wants to render the list
/// server-side rather than hard-coding it client-side.
pub fn list_all() -> &'static [BuiltinTemplate] {
    all_templates()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverse_engineering_is_registered() {
        let tpl = get(Some("reverse_engineering")).expect("template present");
        assert_eq!(tpl.id, "reverse_engineering");
        assert_eq!(tpl.title, "Reverse Engineer");
        assert_eq!(tpl.extra_mcp_servers, &["fleet_reveng"]);
        assert_eq!(tpl.default_permission_mode, "acceptEdits");
        assert!(tpl
            .system_prompt
            .starts_with("You are a web reverse-engineering specialist."));
    }

    #[test]
    fn unknown_ids_return_none_and_whitespace_is_treated_as_empty() {
        assert!(get(None).is_none());
        assert!(get(Some("")).is_none());
        assert!(get(Some("   ")).is_none());
        assert!(get(Some("nonexistent")).is_none());
    }

    #[test]
    fn list_all_contains_every_known_template() {
        let all = list_all();
        assert!(all.iter().any(|t| t.id == "reverse_engineering"));
    }
}
