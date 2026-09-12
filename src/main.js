import * as THREE from 'three';
import { $, isIOS, xrARSupported } from './core/util.js';
import { createWorld } from './core/world.js';
import { WebXRBackend } from './ar/webxr.js';
import { FallbackBackend } from './ar/fallback.js';
import { CoverSet } from './game/cover.js';
import { Reticle } from './game/reticle.js';
import { ScanMesh } from './game/scanmesh.js';
import { Occluders } from './game/occlusion.js';
import { Wabbit } from './game/wabbit.js';
import { Shotgun } from './game/shotgun.js';
import { Effects } from './game/effects.js';
import { ScanPhase } from './game/scan.js';
import { HuntPhase } from './game/hunt.js';
import { initAudio, sfx } from './audio/sfx.js';
import { fatal, show, toast } from './ui/screens.js';
import * as diagnostics from './ui/diagnostics.js';
import * as GAGS from './game/gags.js';

/* ------------------------------------------------------------------ */
/* one-time setup                                                      */
/* ------------------------------------------------------------------ */

const overlay = $('#overlay');
const world = createWorld($('#stage'));

const cover = new CoverSet(world.scene);
const reticle = new Reticle(world.scene);
const scanMesh = new ScanMesh(world.scene);
const occluders = new Occluders(world.scene);

const wabbit = new Wabbit();
world.scene.add(wabbit.root);
wabbit.setEmerge(0, true);

const shotgun = new Shotgun();
shotgun.attachTo(world.camera);
shotgun.layoutFor(world.camera);
shotgun.rig.visible = false;

const effects = new Effects({
  scene: world.scene,
  camera: world.camera,
  shotgun,
  wabbit,
  cover,
  overlay,
});

const scan = new ScanPhase({ world, backend: null, cover, reticle, scanMesh, occluders });
const hunt = new HuntPhase({ world, cover, wabbit, shotgun, effects });

let backend = null;
let phase = 'idle';          // idle | scan | hunt
let supportMode = 'unknown'; // webxr | fallback | none

/* ------------------------------------------------------------------ */
/* capability probe                                                    */
/* ------------------------------------------------------------------ */

async function probeSupport() {
  const line = $('#support-line');
  const hasXR = await xrARSupported();
  const hasCamera = !!navigator.mediaDevices?.getUserMedia;
  const secure = window.isSecureContext;

  if (!secure) {
    supportMode = 'none';
    line.textContent = 'This game needs HTTPS (or localhost) to reach the camera.';
    line.classList.add('warn');
    $('#btn-start').disabled = true;
    return;
  }

  if (hasXR) {
    supportMode = 'webxr';
    line.textContent = 'Full AR ready — real surface sensing, and the scan will draw what it detects.';
  } else if (hasCamera) {
    supportMode = 'fallback';
    // Be explicit about depth: iOS devices have LiDAR that the browser cannot
    // reach, so people reasonably assume the scan is measuring the room.
    line.textContent = isIOS()
      ? 'iPhone/iPad: Safari has no WebXR, and LiDAR is not exposed to web browsers — so this runs in camera mode with gyro aiming and estimated surfaces.'
      : 'No WebXR AR here — running in camera mode with estimated surfaces.';
  } else {
    supportMode = 'none';
    line.textContent = 'No AR and no camera available on this device.';
    line.classList.add('warn');
    $('#btn-start').disabled = true;
  }
}

/* ------------------------------------------------------------------ */
/* session start / stop                                                */
/* ------------------------------------------------------------------ */

async function beginHunt() {
  initAudio();

  try {
    backend = supportMode === 'webxr'
      ? new WebXRBackend(world, overlay)
      : new FallbackBackend(world, $('#passthrough'));
    scan.backend = backend;
    backend.onEnd = handleSessionEnd;
    await backend.start();
  } catch (err) {
    handleStartError(err);
    return;
  }

  diagnostics.noteMode(backend.mode, {
    hitTest: backend.hasHitTest ?? false,
    enabledFeatures: [...(backend.session?.enabledFeatures ?? [])].join(',') || 'n/a',
    domOverlay: backend.session?.domOverlayState?.type ?? 'none',
  });

  if (backend.mode === 'webxr') wireXRInput(backend.session);
  if (backend.mode === 'webxr' && !backend.hasHitTest) {
    toast('No surface sensing on this headset — placements are estimated.', 3600);
  }

  backend.setFrameCallback(onFrame);

  shotgun.rig.visible = false;
  cover.clear();
  scan.start();
  phase = 'scan';
  show('scan');
}

function handleStartError(err) {
  console.error('could not start AR session', err);
  diagnostics.noteError('session start', err);
  const code = err?.message;
  if (code === 'CAMERA_DENIED') {
    fatal('No Camewa, No Hunt', 'Camera access was blocked. Allow it in your browser settings and try again — the whole game is played through the camera.');
  } else if (code === 'NO_CAMERA_API') {
    fatal('No Camewa Found', 'This browser does not expose a camera. Try Safari on iOS, or Chrome on Android.');
  } else if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    fatal('Pewmission Denied', 'The AR session was refused. It usually needs to start from a tap, over HTTPS.');
  } else {
    fatal('Twouble Stawting', `The AR session could not start: ${err?.message ?? err}`);
  }
  show('error');
}

function handleSessionEnd() {
  // The user exited AR (headset menu, back gesture) mid-game.
  if (phase === 'hunt') {
    finishHunt(hunt.buildSummary());
  } else if (phase === 'scan') {
    phase = 'idle';
    scan.stop();
    show('title');
  }
}

async function endSession() {
  try { await backend?.stop(); } catch { /* nothing to clean up */ }
  backend = null;
}

/* ------------------------------------------------------------------ */
/* frame loop                                                          */
/* ------------------------------------------------------------------ */

const playerPos = new THREE.Vector3();

function onFrame(dt, info) {
  world.camera.getWorldPosition(playerPos);

  if (phase === 'scan') {
    scan.update(dt, info);
    cover.update(dt);
  } else if (phase === 'hunt') {
    hunt.update(dt);
    cover.update(dt);
    wabbit.update(dt, playerPos);
    shotgun.update(dt, world.scene, world.camera);
  }

  effects.update(dt);
}

/* ------------------------------------------------------------------ */
/* input                                                               */
/* ------------------------------------------------------------------ */

function pressStart() {
  if (phase === 'hunt') hunt.pressStart();
}

function pressEnd() {
  if (phase === 'scan') scan.mark();
  else if (phase === 'hunt') hunt.pressEnd();
}

/** Pointer input: used by the fallback backend and by desktop testing. */
function isOverlayControl(target) {
  return !!target?.closest?.('button, a, input, .card');
}

window.addEventListener('pointerdown', (e) => {
  if (isOverlayControl(e.target)) return;
  pressStart();
});
window.addEventListener('pointerup', (e) => {
  if (isOverlayControl(e.target)) return;
  pressEnd();
});
window.addEventListener('pointercancel', () => {
  if (phase === 'hunt') { hunt.holding = false; shotgun.setAds(false); }
});

/** XR input: screen taps in handheld AR, triggers on controllers. */
function wireXRInput(session) {
  session.addEventListener('selectstart', pressStart);
  session.addEventListener('selectend', pressEnd);
}

// Taps on HUD buttons must not also pull the trigger inside an XR session.
overlay.addEventListener('beforexrselect', (e) => {
  if (isOverlayControl(e.target)) e.preventDefault();
});

/* ------------------------------------------------------------------ */
/* phase transitions                                                   */
/* ------------------------------------------------------------------ */

scan.onComplete = () => startHunt();

function startHunt() {
  phase = 'hunt';
  reticle.setVisible(false);
  shotgun.rig.visible = true;
  // Real surfaces hide him during the hunt; during the scan they would hide
  // the scan overlay the player is trying to read.
  occluders.setVisible(true);
  show('hunt');
  hunt.start();
}

hunt.onComplete = (summary) => finishHunt(summary);

async function finishHunt(summary) {
  if (phase === 'results') return;
  phase = 'results';
  hunt.stop();
  effects.clear();
  shotgun.rig.visible = false;
  occluders.setVisible(false);
  wabbit.setEmerge(0, true);
  /*
   * The AR session deliberately stays open.
   *
   * Ending it and requesting a fresh one for the next round is unreliable --
   * on iOS WebXR browsers the restart often fails or hangs, and even when it
   * works the player pays for a new permission prompt and a fresh ARKit
   * world-tracking warm-up, losing every surface already scanned. The results
   * screen is DOM, and dom-overlay renders DOM inside the session perfectly
   * well, so it can simply appear over the live camera.
   */
  renderResults(summary);
  show('results');
  sfx.fanfare();
}

/** Play again without touching the session, keeping the scanned room. */
function huntAgain() {
  if (!backend?.session && backend?.mode !== 'fallback') {
    beginHunt();                 // session really is gone; start from scratch
    return;
  }
  if (cover.count === 0) {
    phase = 'scan';
    scan.start();
    show('scan');
    return;
  }
  startHunt();
}

function renderResults(s) {
  $('#res-score').textContent = String(s.score);
  $('#res-rank').textContent = s.rank;
  $('#res-title').textContent = s.shots === 0
    ? 'You Didn\'t Even Shoot'
    : 'The Wabbit Wins Again';

  const lines = [
    ['Shots fired', s.shots],
    ['Wabbits hit', `${s.hits} (as expected)`],
    ['Times he popped up', s.encounters],
    ['Different humiliations', s.distinctGags],
  ];
  if (s.closestDegrees !== null) {
    lines.push(['Closest you came', `${s.closestDegrees.toFixed(1)}° off`]);
  }
  if (s.bestGag) lines.push(['Finest moment', s.bestGag.label]);

  const ul = $('#res-lines');
  ul.innerHTML = '';
  for (const [k, v] of lines) {
    const li = document.createElement('li');
    li.innerHTML = `<span></span><b></b>`;
    li.firstChild.textContent = k;
    li.lastChild.textContent = String(v);
    ul.appendChild(li);
  }
}

/* ------------------------------------------------------------------ */
/* menu wiring                                                         */
/* ------------------------------------------------------------------ */

$('#btn-start').addEventListener('click', beginHunt);
$('#btn-howto').addEventListener('click', () => show('howto'));
for (const btn of document.querySelectorAll('[data-goto="title"]')) {
  btn.addEventListener('click', async () => {
    if (backend) {
      phase = 'idle';
      occluders.setVisible(false);
      await endSession();
    }
  });
}
$('#btn-again').addEventListener('click', huntAgain);
$('#btn-quit').addEventListener('click', () => finishHunt(hunt.buildSummary()));

document.addEventListener('visibilitychange', () => {
  if (document.hidden && phase === 'hunt') {
    hunt.holding = false;
    shotgun.setAds(false);
  }
});

diagnostics.install(() => ({
  phase,
  supportMode,
  coverSpots: cover.count,
  scanSource: scanMesh.source,
  occluders: occluders.count,
  scanPatches: scanMesh.pointCount,
  scanSensed: scanMesh.sensed,
  realGeometry: scanMesh.planeCount,
}));

probeSupport();
show('title');

// Keep a handle around for debugging from the console (and for the smoke tests).
window.__THREE = THREE;
window.__GAGS = GAGS;
window.WabbitSeason = {
  world, cover, wabbit, shotgun, hunt, scan, effects, scanMesh, occluders,
  get backend() { return backend; },
  get phase() { return phase; },
  scanBackendHit: () => backend?._estimateHit?.() ?? backend?.lastHit ?? null,
};
