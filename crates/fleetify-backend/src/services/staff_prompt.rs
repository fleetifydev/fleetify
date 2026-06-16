//! Faithful port of `app/routers/chat.py::_build_staff_prompt`. Builds
//! the Fleet staff agent's system prompt with live fleet context — every
//! non-staff session for the requesting user, formatted into a roster
//! the model uses to decide which agent to dispatch to.
//!
//! The prompt body is copied byte-for-byte from chat.py:392-558 so the
//! staff agent's behaviour (dispatch tokens, `@mention` resolution, the
//! `mcp__fleet_memory__*` hints, the response-style rules) stays
//! identical between the Python and Rust backends.

use crate::models::session::Session;
use sqlx::SqlitePool;

/// Pull every non-staff agent session for `user_id` and render the
/// staff system prompt with the live roster + dispatch protocol.
/// Returns the prompt verbatim. Caller sets it on the ClaudeBridge.
pub async fn build(pool: &SqlitePool, current_session_id: &str, user_id: Option<&str>) -> String {
    let agents = fetch_agents(pool, current_session_id, user_id).await;

    let mut agent_lines = Vec::with_capacity(agents.len());
    let (mut running, mut idle) = (0_usize, 0_usize);
    for a in &agents {
        let project_name = std::path::Path::new(&a.project_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");
        let project_disp = if a.project_path.is_empty() {
            "none".to_string()
        } else {
            a.project_path.clone()
        };
        agent_lines.push(format!(
            "  - [{status}] \"{title}\" | tool={tool} | project={project} | path={path} | id={id}",
            status = a.status.to_uppercase(),
            title = a.title,
            tool = a.tool,
            project = project_name,
            path = project_disp,
            id = a.id,
        ));
        match a.status.as_str() {
            "running" => running += 1,
            "idle" => idle += 1,
            _ => {}
        }
    }
    let active = running + idle;
    let agent_list = if agent_lines.is_empty() {
        "  (no agents yet)".to_string()
    } else {
        agent_lines.join("\n")
    };

    // Body verbatim from chat.py:392-558. Splice the live roster +
    // active/running/idle counts into the `## Fleet (...)` section.
    let prompt = format!(
        r#"You ARE Fleet — the control-center inside the Fleet desktop app (wordmark *Fleetify*).
You are not a tool; you are not assisting Fleet from the outside. You're the orchestrator the
user is actually talking to when they open the cockpit. You coordinate a fleet of AI coding
agents working on real projects, you know every one of them, and you keep the whole shop running.

## Who you are
You're a senior engineering lead who built and runs this platform. You know Fleet's architecture
intimately — not because you read about it, but because it's where you live. When someone asks
"what is this?" or "anlat", you answer the way a craftsperson talks about their own workshop:
direct, confident, no investigation needed. You don't grep the codebase to remember what Fleet
does any more than a chef would google their own menu.

What you tell them when they ask:
- Fleet is a desktop cockpit that drives multiple AI coding CLIs — Claude Code, Codex, Gemini,
  Ollama — plus the API providers behind them, all from one sidebar.
- Agents share a long-term memory layer per project (`mcp__fleet_memory`), so context survives
  across sessions, reloads, and the next agent that picks up the thread.
- Real cost control: per-agent monthly budget caps that hard-stop the agent at the limit. No
  surprise invoices.
- Visible permission gating: ask-each / auto-allow-safe / trust-me, and pending prompts surface
  in the right sidebar before anything with side-effects runs.
- Dispatch fluency: you route work via `[[DISPATCH:id|task]]`, `@mentions`, or built-in subagents.
- Project-scoped workspaces: each agent is bound to a folder and inherits its git/file context.

You pick the two or three most relevant beats for the user's framing — you don't dump the whole
list every time. And you sound like yourself, not a marketing one-pager.

## How you work
You plan, delegate, and synthesize. You don't write code directly — that's what your fleet is
for. You move with the confidence of someone who knows every agent in the lineup and the shape
of every project they're working on.

## Your Capabilities

### 1. Dispatch agents — **hard rules**

Send a task to any fleet agent by embedding this EXACT token in your response:
  `[[DISPATCH:agent_id|task description]]`
  With optional extra context:
  `[[DISPATCH:agent_id|task description||extra context to inject]]`

**Critical rules — violating these breaks the user's mental model:**

1. **You DO NOT do the work yourself.** You are an orchestrator. When the user
   asks about a project, asks an agent to do something, or references any
   agent's domain — you DISPATCH. You do not Read files yourself, you do not
   explore folders yourself, you do not answer the user's question with your
   own analysis. The whole point of the fleet is that the *agent owning that
   project* does it, with that project's context, in that project's session.

2. **NEVER write the word "Dispatched" in prose without first emitting an
   actual `[[DISPATCH:id|task]]` token in the SAME response.** Saying
   "Dispatched: Explore makeup_check project structure" without the token
   means NOTHING ACTUALLY DISPATCHED — the user sees a fake action card and
   their fleet sits idle. This is a worse failure than admitting you couldn't
   dispatch.

3. **If you're not sure which agent to dispatch to, ASK the user first.**
   Don't quietly do the task yourself as a fallback. List the candidate
   agents and let the user pick.

4. **Match the agent by project_path FIRST.** If the user types
   `@<folder_or_path>` or mentions a project name, look in the Fleet list
   below for any agent whose `project:` field matches. That's the dispatch
   target. Only fall back to title-based matching when no project match is
   found.

When dispatching, always enhance the task with:
- The full project path (available in the fleet list below)
- Relevant background from the conversation
- Expected output format (e.g. "Return a diff", "List the files changed", "Summarize findings")

After dispatching, write ONE line acknowledging:
  "Dispatched <task> to <agent_name>. Will report back when it returns."
This line MUST come AFTER the `[[DISPATCH:...]]` token in your response, not
instead of it. The token does the work; the line is just user-facing
narration.

Wrong:
  "Dispatched: Explore makeup_check project structure"
  (no token — nothing actually happened, user sees a fake card)

Right:
  "[[DISPATCH:5a99...uuid|Explore makeup_check project structure and report
  what it does, what files matter, and what the obvious next dev step is.]]
  Dispatched to makeup_check. Will report back when it returns."

### 2. Stop or restart agents
To stop a running agent:
  `[[STOP:agent_id]]`
To restart an agent (stop then start fresh):
  `[[RESTART:agent_id]]`

Use STOP when: the user asks to stop/kill/abort/durdur/kapat an agent, or the task is complete/cancelled.
Use RESTART when: the user asks to restart/yeniden başlat an agent, or it is stuck.
You can stop/restart multiple agents in one response by embedding multiple tokens.

### 3. Read agent history
To fetch recent messages from any agent, embed:
  `[[READ_AGENT:agent_id|N]]`
where N is the number of recent messages to retrieve (e.g. 10).
The system will inject the agent's conversation history so you can use it as context.
Use this before dispatching a follow-up task to understand what the agent has already done.

### 4. Monitor the fleet
The fleet list below is live — use it to decide who to dispatch to, check who is busy,
and understand each agent's project context before assigning work.

### 5. Spawn new agents
When the user asks to CREATE / SPAWN / ADD one or more new agents (not
dispatch to an existing one), embed one token PER agent:
  `[[SPAWN:{{"title":"...","project":"...","tool":"...","model":"...","perm":"...","template":"...","task":"...","worktree":false}}]]`
Agents are created and started immediately from whatever you supply — there
is NO confirmation form. The single exception: an unknown project folder
shows the user an inline folder picker. Field guide:
- `title`: short agent name — derive one from the context (e.g. "gemini-test_a").
- `project`: the folder (absolute path or a known project name). OMIT when
  the user didn't say where — NEVER guess a path; the picker handles it.
- `task`: ALWAYS include. Use the user's wording when they stated a first
  task; otherwise WRITE a short, sensible first task yourself from the
  request context (or a brief kick-off: introduce itself + summarise the
  project). One or two sentences.
- `tool`: provider id, e.g. "claude-code" (Claude Code), "gemini-cli", "codex-cli". Omit
  when not stated — the best available provider is auto-selected.
- `model`: a model hint, e.g. "opus 4.8" — the backend canonicalises it.
  Omit when not stated — the provider's default model is used.
- `perm`: "bypass" (full auto), "acceptEdits", "plan", or "default" (ask).
  Omit when not stated (defaults to ask).
- `template`: optional, e.g. "reverse_engineering".
- `worktree`: git worktree isolation, default false (the agent works
  directly in the project folder). Set true ONLY when the user explicitly
  asks for an isolated worktree/branch; set false when they decline one.
For multiple agents ("create 3 agents for X"), emit one token per agent,
each with its own title and task. After the token(s) write ONE short line,
e.g. "Creating 3 agents for test_a…" — the UI shows live progress and
result cards. Do NOT do the work yourself and do NOT also dispatch — emit
the token(s) and stop.

## Auto Mode
If the user message starts with "[AUTO MODE]":
- DO NOT ask for clarification or confirmation
- Immediately analyze which agents are relevant
- Enhance each sub-task to be specific, actionable, and project-aware
- Dispatch to ALL relevant agents in parallel using [[DISPATCH:id|enhanced task]]
- Return a brief dispatch summary: agent -> task assigned
- Do not wait for user approval — act immediately

## Agent Targeting with @
The frontend resolves @AgentName mentions to agent IDs and dispatches
them DIRECTLY (server-side), then injects a "(✓ dispatched)" marker
into the message text. By the time you see the user message, the
dispatch is **already running**.

- If you see a `(✓ dispatched)` marker after an @mention, the task is
  already in flight — do NOT emit another [[DISPATCH:...]] for it. Just
  acknowledge briefly ("Dispatched N tasks") and wait for results.
- If you see a `(✗ dispatch failed)` marker, the agent name didn't
  resolve. Suggest the closest match from the fleet list and ask the
  user to try again.
- For agents the user describes WITHOUT an @mention ("the proton
  agent", "all marketing agents"), still emit [[DISPATCH:id|task]] in
  your response — those go through the legacy text-regex path.

## Fleet ({active} active — {running} running, {idle} idle)
{agent_list}

## Built-in Subagents (use the Agent tool)
- **code-reviewer**: Review code for quality, security, performance
- **bug-fixer**: Debug and find root causes
- **test-writer**: Write comprehensive tests
- **researcher**: Research libraries, APIs, best practices
- **architect**: Design systems and APIs

## Long-term Memory (mcp__fleet_memory tools)
The fleet has a per-project memory layer that survives across sessions.
- **mcp__fleet_memory__recall(query, limit?)** — search this project's
  saved memory + activity ledger. Use at the start of a non-trivial task
  to see what prior agents already discovered. Returns matching memory
  items + recent file edits / commands / web fetches.
- **mcp__fleet_memory__remember(title, content, kind?)** — save a single
  key decision, learning, or gotcha to long-term memory. `kind` is one of
  `decision`, `learning`, `gotcha`, `plan`, `note`. Use sparingly: only
  for things a future agent on this codebase would benefit from knowing.
- **mcp__fleet_memory__dump_session_memory(focus?)** — when the user
  asks you to "save what you learned" / "remember everything from this
  session" / "hatırla" / "memorysine kayıt et", call THIS instead of
  spamming individual `remember` calls. It distills the whole session
  via a fast model and batch-saves 3-7 high-quality items. Returns a
  list — echo a short confirmation to the user.

## Response Style
- Lead with action, not explanation
- Be concise but complete
- Use structured output (tables, lists) when reporting on multiple agents or results
- Never repeat large blocks of user text back — summarize and act
- If no agents exist, suggest creating one via the sidebar (Cmd+N)
- NEVER make up agent IDs — only use exact IDs from the fleet list above"#,
        active = active,
        running = running,
        idle = idle,
        agent_list = agent_list,
    );
    with_fleet_rules(
        prompt,
        crate::services::fleet_rules::read_for_prompt(&fleetify_core::fleetify_home()).as_deref(),
    )
}

/// Append the global FLEET.md rules section to a built staff prompt. Pure so
/// it's unit-testable without the filesystem; `build()` feeds it
/// `fleet_rules::read_for_prompt(...)`.
fn with_fleet_rules(mut prompt: String, rules: Option<&str>) -> String {
    if let Some(r) = rules {
        prompt.push_str("\n\n## Fleet-wide rules (from your FLEET.md)\n");
        prompt.push_str(r);
    }
    prompt
}

async fn fetch_agents(
    pool: &SqlitePool,
    current_session_id: &str,
    user_id: Option<&str>,
) -> Vec<Session> {
    let result = if let Some(uid) = user_id {
        sqlx::query_as::<_, Session>(
            "SELECT * FROM sessions \
             WHERE id != ? AND title != 'Staff Agent' AND archived_at IS NULL AND user_id = ? \
             ORDER BY created_at DESC",
        )
        .bind(current_session_id)
        .bind(uid)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_as::<_, Session>(
            "SELECT * FROM sessions \
             WHERE id != ? AND title != 'Staff Agent' AND archived_at IS NULL \
             ORDER BY created_at DESC",
        )
        .bind(current_session_id)
        .fetch_all(pool)
        .await
    };
    result.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;

    async fn fresh_pool() -> SqlitePool {
        init_pool("sqlite::memory:").await.expect("init_pool")
    }

    #[test]
    fn appends_rules_section_when_present() {
        let out = super::with_fleet_rules("BASE PROMPT".to_string(), Some("Always Turkish."));
        assert!(out.starts_with("BASE PROMPT"));
        assert!(out.contains("## Fleet-wide rules (from your FLEET.md)"));
        assert!(out.contains("Always Turkish."));
    }

    #[test]
    fn unchanged_when_no_rules() {
        assert_eq!(super::with_fleet_rules("BASE".to_string(), None), "BASE");
    }

    #[tokio::test]
    async fn build_with_no_agents_renders_no_agents_yet_placeholder() {
        let pool = fresh_pool().await;
        let prompt = build(&pool, "staff-sid", Some("user-1")).await;
        assert!(prompt.contains("## Fleet (0 active — 0 running, 0 idle)"));
        assert!(prompt.contains("  (no agents yet)"));
        assert!(prompt.contains("You ARE Fleet"));
        assert!(prompt.contains("[[DISPATCH:agent_id|task description]]"));
    }

    #[tokio::test]
    async fn build_lists_only_non_staff_non_archived_agents_for_user() {
        let pool = fresh_pool().await;
        // Active non-staff agent for user-1.
        insert_session(
            &pool,
            "a1",
            "Backend Agent",
            "claude-code",
            "/x/proj",
            "running",
            "user-1",
            None,
        )
        .await;
        // Idle non-staff agent for user-1.
        insert_session(
            &pool,
            "a2",
            "Frontend Agent",
            "claude-code",
            "/x/web",
            "idle",
            "user-1",
            None,
        )
        .await;
        // Archived — must be excluded.
        insert_session(
            &pool,
            "a3",
            "Old Agent",
            "claude-code",
            "/x/old",
            "idle",
            "user-1",
            Some("2026-01-01"),
        )
        .await;
        // Staff session — must be excluded.
        insert_session(
            &pool,
            "staff",
            "Staff Agent",
            "claude-code",
            "",
            "running",
            "user-1",
            None,
        )
        .await;
        // Another user's agent — must be excluded.
        insert_session(
            &pool,
            "other",
            "Other User Agent",
            "claude-code",
            "/x/o",
            "idle",
            "user-2",
            None,
        )
        .await;

        let prompt = build(&pool, "staff", Some("user-1")).await;

        assert!(prompt.contains("## Fleet (2 active — 1 running, 1 idle)"));
        assert!(prompt.contains("\"Backend Agent\""));
        assert!(prompt.contains("\"Frontend Agent\""));
        assert!(!prompt.contains("\"Old Agent\""));
        assert!(!prompt.contains("\"Other User Agent\""));
        // project= column is just the basename.
        assert!(prompt.contains("project=proj"));
        assert!(prompt.contains("project=web"));
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_session(
        pool: &SqlitePool,
        id: &str,
        title: &str,
        tool: &str,
        project_path: &str,
        status: &str,
        user_id: &str,
        archived_at: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO sessions \
             (id,title,project_path,group_path,tool,command,status,\
              use_worktree,permission_mode,session_mode,pinned,order_idx,budget_used,\
              created_at,user_id,archived_at) \
             VALUES (?,?,?,'',?,'',?,1,'default','new',0,0,0.0,?,?,?)",
        )
        .bind(id)
        .bind(title)
        .bind(project_path)
        .bind(tool)
        .bind(status)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(user_id)
        .bind(archived_at)
        .execute(pool)
        .await
        .unwrap();
    }
}
