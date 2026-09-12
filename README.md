# 🐰 Wabbit Season

An augmented-reality cartoon hunting parody that runs in a web browser.

Scan your actual living room with your phone's camera, mark the furniture a
rabbit could plausibly duck behind, then shoulder a virtual double-barrel and
try to shoot **Wascal P. Wabbit** as he pops up from behind your kitchen
island, the end of your bed, or around the corner.

You will miss. Every single time. That is the entire game — you're scored on
how spectacularly you fail, not on hitting anything.

> *"Be vewy vewy quiet. You're hunting in youw own wiving woom."*

## Playing it

Serve the folder over HTTPS (or `localhost`) and open it on your phone:

```bash
npm start          # http://localhost:8080
```

Camera access requires a secure context, so for phone testing either use
`localhost` via port-forwarding, or host it anywhere with TLS.

It is a plain static site with no build step, so it deploys as-is.
`.github/workflows/pages.yml` publishes it to GitHub Pages on every push to
the default branch — no build, it just uploads the repository — which is the
easiest way to get it onto a real phone:

**https://jodeit.github.io/wabbit_season/**

1. **Scan.** Sweep the phone slowly across whatever you can see. About a
   quarter turn is enough — you do not need to stand up or spin around.
2. **Mark cover.** Pick how he should use the spot, then tap the reticle on it:

   | Kind | For | What he does |
   |---|---|---|
   | **Pop up ovew** | A counter, an island, the end of a bed | Rises from behind it |
   | **Peew awound** | A corner, a doorframe, the edge of a wardrobe | Leans out sideways |
   | **Open a doow** | A closed door | Swings it open and strolls out |

   Most real rooms have their furniture pushed against the walls, so
   "pop up from behind a waist-high surface" on its own leaves a lot of rooms —
   bedrooms especially — with nowhere for him to hide. Corners and doors are
   what make it playable from a bed or an armchair.
3. **Hunt.** He appears at your real furniture, preferring spots you are
   *not* currently looking at.
4. **Aim.** Hold anywhere to shoulder the gun and look down the rib between the
   barrels; the brass bead is your sight. Release to fire.
5. **Miss.** He ducks, catches the buckshot in his teeth, bunts it with a
   carrot, ties your barrels in a knot, or holds up a sign reading DUCK SEASON.

## Device support

The game has two runtime paths and picks one automatically. The title screen
tells you which you got.

| | WebXR mode | Camera mode |
|---|---|---|
| **Where** | Android Chrome, Quest, other `immersive-ar` browsers | iPhone/iPad Safari, desktop, anything else with a camera |
| **Passthrough** | The XR compositor | `getUserMedia` video behind a transparent canvas |
| **Head tracking** | 6DoF, real world-locked content | 3DoF from the gyroscope |
| **Surfaces** | Real hit-testing against sensed geometry | Estimated from where you're looking |
| **Scan shows** | The real mesh or planes it detects | The floor and distance it assumes |

### What the scan actually captures

The scan draws what the device really gave it, and says which of three things
that is:

| Source | Drawn as | Where |
|---|---|---|
| `mesh` — scene reconstruction (`XRMesh`) | green wireframe | Quest 3 and similar |
| `planes` — detected planes (`XRPlane`) | green boundary polygons | Android Chrome |
| `points` — sampled surface points | blue dots + assumed floor grid | iOS, and hit-test-only runtimes |

**No LiDAR.** iPhones and iPads have a depth sensor, but Safari does not
expose it — there is no web API for ARKit's scene reconstruction, depth map or
LiDAR, and no WebXR session to hang one off. So on iOS nothing is measured.
The blue points are the surface the game is *assuming*: the reticle ray
clamped to about three metres, fanned across the viewport as you pan, plus a
grid drawn on the floor plane it assumes at `y = 0`.

That is why the estimated case is drawn in a different colour, labelled
"estimated — no depth sensor on this device", and never rendered as a solid
mesh. A convincing mesh there would be a prop: it would imply the game had
measured a room it cannot see.

**On iPhone this runs in camera mode.** Safari still ships no `immersive-ar`
session, so there is no WebXR AR on iOS at the time of writing regardless of
what a page asks for. Camera mode gets you the live camera feed, gyro aiming
and a wabbit in your room, but because there is no depth sensing it has to
*guess* where surfaces are: the reticle ray is clamped to about three metres,
so pointing at a shallow downward angle lands on furniture rather than sailing
over it onto the floor behind. The reticle turns blue whenever a placement is
estimated rather than sensed.

## How it works

No build step, no bundler, no framework. `index.html` loads ES modules
directly, and three.js is vendored in `vendor/` so the whole thing is a
self-contained static site that runs with the network unplugged. To switch to a
CDN instead, repoint the single entry in the import map.

There are **no asset files**. The wabbit, the shotgun and the props are built
from three.js primitives at runtime, and every sound — the blast, the boings,
the slide whistle, the anvil — is synthesised with the Web Audio API out of
noise bursts and pitch ramps.

```
src/
  main.js              bootstrap, capability probe, phase transitions
  core/
    world.js           renderer, scene, lighting
    util.js            maths and platform helpers
  ar/
    webxr.js           immersive-ar session, hit-test source, DOM overlay
    fallback.js        getUserMedia + DeviceOrientation, estimated surfaces
  game/
    scan.js            room-scan phase and sweep progress
    hunt.js            the hunt state machine and shooting
    cover.js           marked hiding spots, furniture naming, spot selection
    wabbit.js          the wabbit: geometry, animation, states
    shotgun.js         first-person view model, hip/shouldered poses
    gags.js            the miss table and the dialogue
    effects.js         particles, screen shake, signs, decoys
    reticle.js         placement reticle
    scanmesh.js        scan readout: real mesh/planes, or the assumed surface
  audio/sfx.js         procedural sound board
  ui/screens.js        screen switching and HUD banners
```

A few decisions worth knowing about:

- **The gun is laid out from the projection, not in metres.** A phone in
  portrait has a very narrow horizontal field of view, and a hip position
  measured in metres simply falls off the side of the screen there. The poses
  are expressed as fractions of the view frustum instead, so they hold up on
  any aspect ratio and through an orientation change.
- **The stock is deliberately stubby and the butt plate isn't modelled.** At
  true length it sits centimetres from the eye and becomes an opaque slab
  across the bottom of the screen.
- **Screen shake never moves the camera.** In WebXR the camera pose belongs to
  the device; yanking it around is both ignored and nauseating. The gun rocks
  and the DOM overlay jolts instead.
- **The scan never asks for more of a turn than a seated player has.** The
  sweep meter saturates at about 90°, and reads full at exactly the moment the
  start button unlocks. An earlier version wanted ~200° and stalled in the
  nineties, which reads as a gate that never opens even when nothing is
  actually blocked.
- **The scan visualisation never draws geometry the device did not sense.**
  Where there is real data it is rendered as-is; where there is not, the
  assumption is drawn in a different colour and named as an assumption.
- **The miss is decided before the pellets leave the barrel.** Whether the shot
  was lined up only selects *which* pool of gags it comes from: genuine
  on-target shots get the expensive cartoon-physics saves and score the most,
  wild ones get gags at the player's expense.

## Testing

```bash
npm install     # playwright, for the test only
npx playwright install chromium
npm test
```

`tests/e2e.mjs` drives the whole game in headless Chromium with a fake camera —
capability probe, room scan, hunt, results — and forces every gag in the table
to run so a typo in one of them can't ship unnoticed. It also asserts the
things that are easy to break by accident: that the gun is inside the view
frustum, that surface estimation puts furniture at furniture height, that
effects clean up after themselves, and that the camera is released at the end.

## About the parody

Wascal P. Wabbit and his exasperated hunter are an affectionate send-up of a
very old cartoon rivalry. The characters, dialogue, artwork and sounds here are
all original to this project — no studio assets are used, referenced or bundled.
