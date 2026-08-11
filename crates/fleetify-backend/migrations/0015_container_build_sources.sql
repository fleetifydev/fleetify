-- Where a docker-run session's container comes from.
--
-- 0014 could only express "an image by name". A project usually already
-- describes its own environment — a Dockerfile, or a docker-compose.yml —
-- and re-typing that as an image name loses it. `container_source` says
-- which recipe to follow at provision time:
--   'image'      — pull/run `container_image` (the 0014 behaviour, default)
--   'dockerfile' — `docker build` `container_file` with the project as
--                  context, then run the built image
--   'compose'    — `docker compose -f container_file up -d`, then exec into
--                  the `container_service` container. The stack belongs to
--                  the user: Fleetify starts it idempotently and NEVER tears
--                  it down on session delete.
ALTER TABLE sessions ADD COLUMN container_source TEXT NOT NULL DEFAULT 'image';
-- Dockerfile or compose file path, relative to project_path (absolute also
-- accepted). NULL for 'image'.
ALTER TABLE sessions ADD COLUMN container_file TEXT;
-- Compose service whose container the agent runs in. NULL otherwise.
ALTER TABLE sessions ADD COLUMN container_service TEXT;
