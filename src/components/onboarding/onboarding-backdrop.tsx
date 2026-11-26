/**
 * The moving backdrop behind the screens before the main shell: soft light in
 * the brand blue (`--m-brand`, docs/BRAND.md) drifting slowly from side to
 * side. App mounts it once for all of those screens, so it carries on from
 * one to the next.
 *
 * Decoration only: hidden from assistive technology and never in the way of
 * a click or a window drag (`pointer-events: none`). Still, without motion,
 * when the system asks for reduced motion. The styles are in globals.css
 * (`.onboarding-backdrop`).
 */
export function OnboardingBackdrop() {
  return (
    <div className="onboarding-backdrop" data-testid="onboarding-backdrop" aria-hidden="true">
      <span className="onboarding-backdrop__light onboarding-backdrop__light--a" />
      <span className="onboarding-backdrop__light onboarding-backdrop__light--b" />
      <span className="onboarding-backdrop__light onboarding-backdrop__light--c" />
    </div>
  );
}
