-- Container mode as first-class columns.
--
-- Until now the execution target lived entirely inside `sessions.project_path`
-- as a `docker://<id>/<abs-path>` URL string. One column cannot hold both
-- "which directory on the host" and "which container", which is why Container
-- shipped as a fourth *source tab* — mutually exclusive with Git by
-- construction. You could not have a container session on a worktree.
--
-- `exec_mode` is a discriminator rather than a boolean so `ssh`, `podman` and
-- `wsl` can land later without another migration:
--   'host'          — spawn on the host, in project_path (the default)
--   'docker-attach' — docker exec into a container the user already runs
--   'docker-run'    — Fleetify provisions the container and mounts project_path
ALTER TABLE sessions ADD COLUMN exec_mode TEXT NOT NULL DEFAULT 'host';
ALTER TABLE sessions ADD COLUMN container_id TEXT;
ALTER TABLE sessions ADD COLUMN container_workdir TEXT;
ALTER TABLE sessions ADD COLUMN container_image TEXT;
-- Tier B of the credential strategy: mount this provider's own credential
-- directory into the container. OFF by default — it carries a host login
-- across the boundary into a container that runs repository code, so it is
-- the user's explicit choice rather than a convenience default.
ALTER TABLE sessions ADD COLUMN container_mount_credentials INTEGER NOT NULL DEFAULT 0;

-- Backfill the PR #278 sessions, whose target is encoded in project_path.
--
-- `substr(project_path, 10)` drops the 9-character 'docker://' prefix. The
-- container id is everything up to the first '/' (ids cannot contain one, see
-- exec_target::valid_container_id), and the workdir is the rest, defaulting to
-- '/' when the marker carried no path.
--
-- project_path is deliberately left as-is. `Session::exec_target()` still
-- parses it as the fallback, so a row written by an older build against the
-- same DB — or a half-applied migration — resolves the same way rather than
-- becoming ambiguous.
UPDATE sessions
   SET exec_mode = 'docker-attach',
       container_id = CASE
           WHEN instr(substr(project_path, 10), '/') > 0
           THEN substr(substr(project_path, 10), 1, instr(substr(project_path, 10), '/') - 1)
           ELSE substr(project_path, 10)
       END,
       container_workdir = CASE
           WHEN instr(substr(project_path, 10), '/') > 0
           THEN substr(substr(project_path, 10), instr(substr(project_path, 10), '/'))
           ELSE '/'
       END
 WHERE project_path LIKE 'docker://%';
