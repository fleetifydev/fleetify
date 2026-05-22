-- Provider Router: decision log + session pin columns.
-- routing_decisions captures every routing call for audit + analytics.
-- sessions gains optional pinned_agent / pinned_model overrides and a
-- back-reference to the routing_decisions row that produced the current
-- choice (NULL when the user has pinned manually or no routing ran yet).

CREATE TABLE routing_decisions (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    task_flow TEXT NOT NULL,
    task_ref TEXT,
    agent TEXT NOT NULL,
    model TEXT NOT NULL,
    source TEXT NOT NULL,
    rationale TEXT,
    latency_ms INTEGER NOT NULL,
    fallback_used INTEGER NOT NULL DEFAULT 0,
    primary_router_if_fallback TEXT,
    candidates_json TEXT
);

CREATE INDEX idx_routing_decisions_ts ON routing_decisions(ts DESC);
CREATE INDEX idx_routing_decisions_task ON routing_decisions(task_flow, task_ref);

ALTER TABLE sessions ADD COLUMN pinned_agent TEXT;
ALTER TABLE sessions ADD COLUMN pinned_model TEXT;
ALTER TABLE sessions ADD COLUMN routing_decision_id TEXT REFERENCES routing_decisions(id);
