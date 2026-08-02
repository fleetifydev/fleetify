/**
 * Font stacks shared across the workspace panes.
 *
 * Lived as module-level constants inside workspace-panel.tsx until views
 * started moving into views/ — a view in its own file cannot reach them, and
 * copying the stacks per file is how they drift apart.
 */
export const MONO = "'SF Mono','Menlo','Monaco','Consolas',monospace";
export const SANS = "-apple-system,BlinkMacSystemFont,'Inter',system-ui,sans-serif";
