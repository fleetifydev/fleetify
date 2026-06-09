/**
 * Build-time feature flags.
 *
 * Studio mode (image/video generation) is hidden until the feature is
 * finished. While `STUDIO_ENABLED` is `false` every Studio surface is gated
 * off:
 *   - the sidebar Workspace/Studio mode toggle (app stays in Workspace),
 *   - the Settings → Providers Workspace/Studio mode bar (Workspace only),
 *   - the onboarding Studio selection + setup steps (Workspace only).
 *
 * Flip to `true` to restore all of them — no other code changes needed.
 */
// Typed as `boolean` (not the literal `false`) so the gating conditions read
// as real runtime checks — flipping to `true` needs no other edits.
export const STUDIO_ENABLED: boolean = false;
