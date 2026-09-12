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
   quarter turn fills the bar — you do not need to stand up or spin around.
   The bar measures the sweep and nothing else; marking spots is the next step.
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
| `points` — sensed surface samples | green patches lying in the surface | hit-test-only runtimes (incl. the iOS XR Viewer) |
| *(nothing sensed)* | assumed floor grid only | iOS Safari |

**No LiDAR in Safari.** iPhones and iPads have a depth sensor, but Safari does
not expose it — there is no web API for ARKit's scene reconstruction, depth
map or LiDAR, and no WebXR session to hang one off. So in Safari nothing is
measured, and **no points are plotted at all**: an estimate is not a
measurement, and a fan of dots at a guessed distance scatters through mid-air
and across the ceiling, looking like a scan of a room while corresponding to
nothing in it. What is drawn instead is the grid on the floor plane the game
assumes, which is the actual model, labelled "No depth sensor — surfaces are
estimated".

Surface patches only ever appear where a device really sensed something.
They are drawn lying *in* the surface, oriented to its normal, rather than as
screen-facing dots: dots tell you a ray hit something, overlapping patches
show the shape of what it hit, and a swept wall fills in as a sheet. The
readout gives the area covered rather than a sample count.

### Getting real AR on an iPhone

The [iQ3Connect XR Viewer](https://github.com/iq3connectdev/iQ3ConnectXRViewer)
(a maintained fork of Mozilla's WebXR Viewer) is an iOS browser that exposes
ARKit through a real `immersive-ar` session — `local-floor`, `hit-test` and
`dom-overlay` are all supported. Opened in it, this game takes its WebXR path
and gets genuinely sensed surfaces, green points and all.

One thing it requires: that app renders the camera feed **natively behind a
transparent `WKWebView`** (`webView.isOpaque = false`) rather than compositing
it the way Chrome does. Any opaque `background` on `html`/`body` is therefore a
sheet of paint over the camera, and the passthrough never appears. This page
keeps its root elements transparent and lets the menu screens paint their own
backdrops.

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
- **The sweep meter measures the sweep.** It saturates at about 90°, so a
  seated player can finish it. Two earlier versions got this wrong in the same
  way: one demanded ~200°, and one was 70% weighted on marked spots, so it
  capped at 30% before anything was marked — a bar under the word "Scanning"
  that cannot fill by scanning sends people on a hunt for a step that does not
  exist. Marking is a separate step with its own prompt.
- **The scan visualisation never draws geometry the device did not sense.**
  Real data is rendered as-is. Where there is none, the only thing drawn is
  the assumption itself — the floor plane — named as an assumption. Estimated
  points are not plotted at all.
- **Nothing on the page may be opaque.** The camera arrives either behind the
  canvas (`<video>`), through the XR compositor, or behind the whole webview
  (iOS WebXR browsers). Only the last one breaks loudly, and only on a device
  that is awkward to test.
- **The miss is decided before the pellets leave the barrel.** Whether the shot
  was lined up only selects *which* pool of gags it comes from: genuine
  on-target shots get the expensive cartoon-physics saves and score the most,
  wild ones get gags at the player's expense.

## Diagnostics and cache-busting

There is no server, no logging and no telemetry — nothing about a play session
leaves the device. That is the right default for an app pointed at someone's
bedroom, but it means a bug report is whatever the player can describe. So the
title screen carries a **build id** and a **diagnostics** panel: runtime mode,
granted XR features, DOM-overlay state, scan counters, recent errors, and a
copy button. Nothing is transmitted; the player chooses what to share.

The build id matters for a second reason. GitHub Pages sets its own cache
headers and offers no way to change them, and an iOS `WKWebView` will keep
serving a cached ES module graph long after a deploy — the page reloads, the
modules do not, and a fix silently never lands. `tools/stamp.mjs` runs at
deploy time and appends `?v=<short-sha>` to every local module specifier,
stylesheet and import-map entry, so a new build is a new set of URLs. If the
build id on screen does not match the latest commit, the device is serving a
stale copy.

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
