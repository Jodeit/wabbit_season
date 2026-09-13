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
import {
  initVoice, say, setVoiceEnabled, voiceAvailable, voiceEnabled, voiceName, warmVoice,
} from './audio/voice.js';
import { fatal, setBanterMirror, show, toast } from './ui/screens.js';
import * as diagnostics from './ui/diagnostics.js';
import { WorldUI } from './ui/worldui.js';
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
const worldUI = new WorldUI(world.scene, world.camera);
occluders.attach(scanMesh);

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
    if (isIOS()) offerXRViewer();
  } else {
    supportMode = 'none';
    line.textContent = 'No AR and no camera available on this device.';
    line.classList.add('warn');
    $('#btn-start').disabled = true;
  }
}

/**
 * On iOS, offer a one-tap jump into a WebXR browser.
 *
 * Safari cannot be talked into real AR — there is no immersive-ar session and
 * no way to polyfill one, because the tracking has to come from ARKit and the
 * page has no access to it. What *can* be done is hand the same URL to a
 * browser that does: the iQ3Connect XR Viewer (a fork of Mozilla's WebXR
 * Viewer) registers the `wxrv://` scheme and reopens `https://` + whatever
 * follows it. Same game, same link, real hit-testing.
 */
function offerXRViewer() {
  const link = $('#btn-xrviewer');
  if (!link) return;
  link.href = `wxrv://${location.host}${location.pathname}${location.search}`;
  link.hidden = false;
  $('#support-line').insertAdjacentHTML('afterend',
    '<p class="support">For real surface sensing on iPhone, open this page in a WebXR '
    + 'browser such as the <b>iQ3Connect XR Viewer</b> — it exposes ARKit, so the scan '
    + 'senses your actual walls and furniture. The button above jumps straight there '
    + 'if it is installed.</p>');
}

/* ------------------------------------------------------------------ */
/* session start / stop                                                */
/* ------------------------------------------------------------------ */

async function beginHunt() {
  initAudio();
  // iOS will not speak at all until speechSynthesis is touched inside a real
  // interaction, so the start tap is the only chance to open that door.
  warmVoice();

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

  /*
   * Headset browsers routinely grant immersive-ar without dom-overlay, and
   * then none of the DOM chrome is visible inside the session: the room and
   * the wabbit render, every instruction and button does not. Fall back to
   * panels drawn in the world, and let the scan finish itself since there is
   * no button to press.
   */
  const domVisible = backend.mode === 'fallback' || backend.hasDomOverlay;
  worldUI.setEnabled(!domVisible);
  scan.autoStart = !domVisible;
  if (!domVisible) {
    toast('No DOM overlay — using in-world panels.', 4000);
  }

  diagnostics.noteMode(backend.mode, {
    hitTest: backend.hasHitTest ?? false,
    enabledFeatures: [...(backend.session?.enabledFeatures ?? [])].join(',') || 'n/a',
    domOverlay: backend.hasDomOverlay ? (backend.session?.domOverlayState?.type ?? 'yes') : 'none',
    worldUI: worldUI.enabled,
    gunMount: shotgun.mount,
  });

  // Let the camera-only path snap its reticle to whatever it has inferred.
  backend.setSurfaceMesh?.(scanMesh.surface);

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

  // Controllers wake up and sleep; re-checking is cheap and avoids being
  // stuck head-mounted because nothing was tracked at session start.
  if (backend?.mode === 'webxr' && backend.session) mountGun(backend.session);

  if (phase === 'scan') {
    scan.update(dt, info);
    cover.update(dt);
  } else if (phase === 'hunt') {
    // Detected planes drift and grow as the runtime refines them, so the
    // occluders have to keep up rather than being frozen at scan time.
    scanMesh.syncXRGeometry(info.frame, info.refSpace);
    occluders.update(scanMesh);
    occluders.updateFromCover(cover);
    hunt.update(dt);
    cover.update(dt);
    wabbit.update(dt, playerPos);
    shotgun.update(dt, world.scene, world.camera);
  }

  effects.update(dt);
  worldUI.update();
  aimAtButtons();
}

const pickRay = new THREE.Raycaster();
const rayOrigin = new THREE.Vector3();
const rayDirection = new THREE.Vector3();

/** Point the controller (or gaze) at the in-world buttons. */
function aimAtButtons() {
  if (!worldUI.enabled || !worldUI.buttons.length) return;
  const source = shotgun.mount === 'controller' ? shotgun.rig.parent : world.camera;
  if (!source) return;
  source.getWorldPosition(rayOrigin);
  rayDirection.set(0, 0, -1)
    .applyQuaternion(source.getWorldQuaternion(new THREE.Quaternion()));
  pickRay.set(rayOrigin, rayDirection);
  worldUI.pick(pickRay);
}

/* ------------------------------------------------------------------ */
/* input                                                               */
/* ------------------------------------------------------------------ */

function pressStart() {
  if (phase === 'hunt') hunt.pressStart();
}

function pressEnd() {
  // A press aimed at a button is a button press, not a shot.
  if (worldUI.press()) return;
  if (phase === 'scan') scan.mark();
  else if (phase === 'hunt') hunt.pressEnd();
  else if (phase === 'results' && worldUI.enabled) huntAgain();
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
  session.addEventListener('inputsourceschange', () => mountGun(session));
  mountGun(session);
}

/**
 * A visible line down the controller's aim.
 *
 * Inside an immersive session the browser stops drawing its own pointer, so
 * without this the player has a controller in their hand and nothing on screen
 * telling them where it is pointing.
 */
function addAimRay(controller) {
  if (controller.userData.aimRay) return;
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -6),
  ]);
  const ray = new THREE.Line(geometry, new THREE.LineBasicMaterial({
    color: 0xef7a21, transparent: true, opacity: 0.45, depthWrite: false,
  }));
  ray.name = 'aim-ray';
  controller.add(ray);
  controller.userData.aimRay = ray;
}

/**
 * Give the gun to a tracked hand if there is one.
 *
 * On a phone the device is the aim and the gun belongs on screen. In a headset
 * the player has a controller, and a gun welded to their forehead is both
 * strange to look at and impossible to aim with.
 */
function mountGun(session) {
  const held = [...(session.inputSources ?? [])]
    .findIndex((src) => src.targetRayMode === 'tracked-pointer');
  if (held < 0) {
    if (shotgun.mount !== 'camera') shotgun.attachTo(world.camera, 'camera');
    return;
  }
  if (shotgun.mount === 'controller') return;
  const controller = world.renderer.xr.getController(held);
  // The controller object is only posed while it is in the scene graph.
  if (!controller.parent) world.scene.add(controller);
  addAimRay(controller);
  shotgun.attachTo(controller, 'controller');
}

// Taps on HUD buttons must not also pull the trigger inside an XR session.
overlay.addEventListener('beforexrselect', (e) => {
  if (isOverlayControl(e.target)) e.preventDefault();
});

/* ------------------------------------------------------------------ */
/* phase transitions                                                   */
/* ------------------------------------------------------------------ */

setBanterMirror((kind, text) => {
  if (!worldUI.enabled) return;
  // Taunts belong to the wabbit, so they appear above him; the gag verdict is
  // about the shot, so it goes on the main panel.
  if (kind === 'taunt' && wabbit.root.visible) {
    worldUI.say(text, wabbit.aimPoint());
  } else {
    worldUI.show('Wabbit Season', text);
    setTimeout(() => { if (phase === 'hunt') worldUI.hideMain(); }, 1800);
  }
});

hunt.onHud = (score, shells, misses, reloading) => {
  worldUI.hud(score, reloading ? '…' : '•'.repeat(shells).padEnd(2, '·'), misses);
};

scan.onProgress = (s) => {
  if (!worldUI.enabled) return;
  const pct = Math.round(s.sweepProgress * 100);
  if (s.autoStartAt > 0) {
    worldUI.show('Weady', `${s.cover.count} hiding spots found.`,
      `Starting in ${s.autoStartRemaining}…`);
  } else if (s.cover.count > 0) {
    worldUI.show('Scanning', `${pct}% swept · ${s.cover.count} hiding spots found.`,
      'Keep looking around the woom');
  } else {
    worldUI.show('Scanning the woom', `${pct}% swept · ${s.scanMesh.describe()}`,
      'Look around slowly');
  }
};

scan.onComplete = () => startHunt();

function startHunt() {
  phase = 'hunt';
  reticle.setVisible(false);
  shotgun.rig.visible = true;
  // Real surfaces hide him during the hunt; during the scan they would hide
  // the scan overlay the player is trying to read.
  occluders.setVisible(true);
  worldUI.hideMain();
  worldUI.setButtons(huntButtons());
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
  worldUI.hideHud();
  worldUI.setButtons(worldUI.enabled
    ? [{ label: 'Hunt Again', action: () => huntAgain() }]
    : []);
  if (worldUI.enabled) {
    worldUI.show('The Wabbit Wins', `${summary.score} style points. ${summary.rank}`,
      'Pull the trigger to hunt again');
  }
  renderResults(summary);
  show('results');
  sfx.fanfare();
}

/**
 * Pause mid-hunt.
 *
 * In the DOM this is a screen; in a headset it is the in-world buttons, since
 * there is no browser chrome inside a session to reach for.
 */
function pauseHunt(on) {
  if (phase !== 'hunt') return;
  hunt.setPaused(on);
  if (on) {
    show('paused');
    worldUI.show('Paused', 'He\'ll wait. He\'s got all day.');
    worldUI.setButtons([
      { label: 'Wesume', action: () => pauseHunt(false) },
      { label: 'Westawt', action: () => { pauseHunt(false); startHunt(); } },
      { label: 'End', action: () => { pauseHunt(false); finishHunt(hunt.buildSummary()); } },
    ]);
  } else {
    show('hunt');
    worldUI.hideMain();
    worldUI.setButtons(huntButtons());
  }
}

/** The standing controls offered during a hunt, for headset players. */
function huntButtons() {
  return [
    { label: 'Pause', action: () => pauseHunt(true) },
    { label: 'Westawt', action: () => startHunt() },
    { label: 'End', action: () => finishHunt(hunt.buildSummary()) },
  ];
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

function refreshVoiceButton() {
  const btn = $('#btn-voice');
  if (!btn) return;
  btn.textContent = `Weginald's Voice: ${voiceEnabled() ? 'On' : 'Off'}`;
  btn.disabled = !voiceAvailable();
  if (!voiceAvailable()) btn.textContent = 'Weginald\'s Voice: unavailable here';
}
$('#btn-voice').addEventListener('click', () => {
  setVoiceEnabled(!voiceEnabled());
  refreshVoiceButton();
  if (voiceEnabled()) say('Ah. There you are.');
});
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
$('#btn-pause').addEventListener('click', () => pauseHunt(true));
$('#btn-resume').addEventListener('click', () => pauseHunt(false));
$('#btn-restart').addEventListener('click', () => { pauseHunt(false); startHunt(); });
$('#btn-end').addEventListener('click', () => {
  pauseHunt(false);
  finishHunt(hunt.buildSummary());
});

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
  visionColumns: scan.visionColumns,
  cameraAccess: backend?.hasCameraAccess ?? (backend?.mode === 'fallback'),
  fusion: scan.fusion
    ? `${scan.fusion.compared} checked, ${Math.round(scan.fusion.agreement * 100)}% agree, `
      + `${scan.fusion.meanError.toFixed(2)}m mean error, ${scan.fusion.rejected} rejected`
    : 'no measurements to check against',
  calibratedEyeHeight: scan.calibratedEyeHeight?.toFixed(2) ?? 'assumed',
  roomMismatch: scan.roomMismatch,
  occluders: `${occluders.count} tri / ${occluders.markedCount} marked`,
  voice: voiceAvailable() ? `${voiceName()} (${voiceEnabled() ? 'on' : 'off'})` : 'unavailable',
  scanPatches: scanMesh.pointCount,
  scanSensed: scanMesh.sensed,
  realGeometry: scanMesh.planeCount,
}));

initVoice();
// Voice lists load asynchronously in most browsers.
setTimeout(refreshVoiceButton, 400);
refreshVoiceButton();

probeSupport();
show('title');

// Keep a handle around for debugging from the console (and for the smoke tests).
window.__THREE = THREE;
window.__GAGS = GAGS;
window.WabbitSeason = {
  world, cover, wabbit, shotgun, hunt, scan, effects, scanMesh, occluders, worldUI,
  get backend() { return backend; },
  get phase() { return phase; },
  scanBackendHit: () => backend?._estimateHit?.() ?? backend?.lastHit ?? null,
};
