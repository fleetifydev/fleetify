# The Fleet scene

The Fleet screen shows every agent session on one of three orbits around the
Fleet core. A motion designer draws the scene in [Rive](https://rive.app); the
app feeds it live session data. This file is the contract between the two:
what the `.riv` file must contain, what the app writes into it, and how much
it may move.

The app owns **where** a session sits (its ring and its angle, from
`src/components/fleet/orbit-layout.ts`). The designer owns **how** it gets
there and how it looks on the way. As long as the names below stay the same,
the designer can change the visuals without a code change. A change to a name,
a type or an enum value is a code change, and is made in the same pull request
as this file.

## The file

One file, `fleet-scene.riv`, with:

- an artboard named `FleetScene`, with a state machine named `Main`;
- an artboard named `Session`, drawn once per session through an artboard list;
- view models named exactly as below, with data binding (no state machine
  inputs, no events: Rive deprecated both in favour of view models).

Exports must work in both Rive web runtimes: `@rive-app/webgl2` (the full
scene on macOS and Windows) and `@rive-app/canvas` (Linux and slow machines,
without feathering or heavy blend modes). Use Additive for light, not the
other blend modes; avoid blur.

## View models

### `FleetScene` (bound to the `FleetScene` artboard)

| Property | Type | Values | Meaning |
|---|---|---|---|
| `core` | enum | `idle`, `busy`, `attention` | `attention` while any session needs the user, `busy` while any is working, else `idle` |
| `motionLevel` | enum | `full`, `reduced`, `static` | `static` must show the final frame with no motion at all |
| `sessions` | list of `Session` | | one item per session on the map, at most 15 |
| `camera` | `Camera` | | |
| `theme` | `Theme` | | |

### `Session` (one list item, bound to the `Session` artboard)

| Property | Type | Values | Meaning |
|---|---|---|---|
| `id` | string | | stable; never shown |
| `phase` | enum | `spawning`, `working`, `needs`, `done`, `leaving` | what the session is doing |
| `ring` | enum | `needs`, `working`, `done` | which orbit it rests on (inner, middle, outer) |
| `slotAngle` | number | 0 to 360 | where on the ring it rests, in degrees, 0 = right, clockwise |
| `activity` | number | 0 to 1 | how much the agent is producing right now (tool calls and tokens); 0 when nothing flows |
| `accent` | color | | the agent's brand colour, for its mark only |
| `arrive` | trigger | | fired once when the session first appears |
| `nudge` | trigger | | fired when it moves to the inner ring, and again at long intervals while it still waits |
| `complete` | trigger | | fired once when it finishes |

### `Camera`

| Property | Type | Meaning |
|---|---|---|
| `focusX`, `focusY` | number | the point to centre, in scene units (0 to 1) |
| `zoom` | number | 1 = the whole map |

### `Theme` (global)

Colours for light and dark: `background`, `ring`, `label`, `core`, `waiting`
(`#fb923c`), `working` (`#4ade80`), `done`, `brand` (`--m-brand`). The app sets
them from the current theme; the file never hard-codes them.

## Labels, cards and input stay in HTML

Session titles, the question cards, Allow and Deny, and the list a screen
reader reads are HTML drawn over the scene, at the positions the app computes.
The `.riv` draws no text and takes no clicks. That keeps text crisp, keeps the
scene invisible to screen readers by design (the HTML carries the data), and
keeps a Rive update from breaking input.

## Motion budget

The orbit is a layout, not a planetary system: at rest nothing turns. Motion
is spent on three moments and nothing else.

| Moment | Motion | Budget |
|---|---|---|
| Spawn (`arrive`) | one short flight from the core to the session's slot, a faint trail drawn once | about 0.4 to 0.5 s, bounce 0 to 0.1 |
| Needs you (`nudge`) | one spring to the inner ring, then a small motion **in place** for a few cycles, then a still, redundant badge | at most two sessions move at once; repeat only at long intervals |
| Working | no loop; a soft glow that follows `activity` and stops when it is 0 | nothing moves when nothing flows |
| Done (`complete`) | a brief check, a fade toward grey, a slow short move to the outer ring | about 0.3 to 0.4 s for the check |
| Focus (`camera`) | one interruptible spring, bounce 0; siblings fade but stay in place; far jumps fade out and back in rather than fly | about 0.45 to 0.6 s |
| Idle | nothing: no breathing, no rotation | zero frames |

The numbers are a starting point, to be tuned in the app over days, not on a
first look. Why this shape: motion in place draws the eye with far less
distraction than motion that travels across the screen (Bartram, Ware and
Calvert, *Moticons*, 2003), and Apple's guidance is short, interruptible
springs with no bounce by default, and no sustained oscillation. The research
behind the choices is in the team's report on the Fleet scene technology.

## Edge cases the file must handle

- 0 sessions: the core alone, `idle`.
- 1 session, and 15 sessions (the cap: 4 inner, 6 middle, 5 outer).
- A session that changes phase mid-flight: the spring retargets from its
  current position; it never jumps.
- `motionLevel` switching to `static` mid-animation: snap to the final frame.
- Light and dark themes.

## What the designer delivers

- `fleet-scene.riv`, with the artboards, state machine and view models above.
- A short note of anything the names above do not cover.
- A recording of each moment in the motion budget, at 60 and 120 Hz.

## Performance rules for the app

- The Rive runtime runs with `enableSettling: true`: once nothing moves it
  stops drawing and requesting frames.
- The app writes state changes, never frames: session events are merged over
  100 to 250 ms and written as a diff (append, remove, set, fire).
- The scene stops while the window is hidden or minimised, drops ambient glow
  in Low Power Mode, and goes `static` with Reduce Motion or the "Pause
  motion" switch.
