# Brand colour

Fleetify's own colour, the one the app wears before anyone picks a theme. Users
will be able to choose other colours; this is the default identity they start
from.

## Calm blue

| Theme | Hex | Token |
|---|---|---|
| Light | `#3d6ad6` | `--m-brand` in `:root` ([`src/globals.css`](../src/globals.css)) |
| Dark | `#6f8fe8` | `--m-brand` in `.dark` |

Today it colours the moving backdrop behind the screens before the main shell
(`OnboardingBackdrop`), where it shows as large, soft pools of light at low
opacity.

## Why this colour

Fleetify is used by developers who run several AI agents at once and watch over
them, often for hours and mostly in a dark theme. The colour should help them stay
calm but alert, and feel in control.

- **Calm, not dull.** Arousal rises from blue and green towards red, and blue,
  blue-green and green rate among the most pleasant hues; saturation and
  brightness move emotional response even more than hue does
  ([Valdez & Mehrabian 1994](https://pubmed.ncbi.nlm.nih.gov/7996122/);
  [Wilms & Oberfeld 2018](https://pubmed.ncbi.nlm.nih.gov/28612080/)).
- **Approach, not avoidance.** Blue primes approach motivation and helps creative
  work; red primes avoidance and vigilance
  ([Mehta & Zhu 2009](https://pubmed.ncbi.nlm.nih.gov/19197022/)). Planning and
  handing out work to agents is the creative part of the job.
- **Low saturation on dark surfaces.** Saturated colours vibrate against a dark
  background and strain the eyes
  ([Material Design, dark theme](https://m2.material.io/design/color/dark-theme)).
- **In the periphery.** A tool that is watched all day should inform without
  pulling attention ([calm technology](https://en.wikipedia.org/wiki/Calm_technology)).
  A cool, soft colour stays in the background and leaves the foreground to the
  agents' state.
- **Nobody else's colour.** Fleetify runs Claude Code, Codex, OpenCode and more
  side by side. Orange reads as Claude, black and white as OpenAI; the brand
  colour belongs to none of the agents.

The research is young and its effects depend on context
([Elliot 2015](https://www.frontiersin.org/articles/10.3389/fpsyg.2015.00368/full)):
treat it as direction, not proof.

## Rules

- **Never a status colour.** Status colours keep one meaning each: green for a
  running session, amber for attention, red for an error. The brand colour stays
  out of that set, so a real warning never looks like decoration, and decoration
  never dulls a warning.
- **Keep it soft.** Use it at low opacity or low saturation for large areas. If
  a solid fill is ever needed, check its contrast against the text on it (WCAG AA,
  4.5:1 for body text).
- **One brand colour.** The rest of the interface stays neutral. Don't add a
  second decorative colour next to it.
- **Read it from the token.** Use `var(--m-brand)`; don't copy the hex values into
  components, so a theme can change it in one place.

Candidates considered: teal, indigo, sky blue, violet, sage, amber and rose.
Teal was the close second (as calm, more distinctive, but near the running
green); indigo and violet are common across AI products; amber and rose raise
arousal and sit next to the warning colours; sage is too close to the running
green.
