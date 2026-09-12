import * as THREE from 'three';
import { $, clamp } from '../core/util.js';
import { sfx } from '../audio/sfx.js';
import { toast } from '../ui/screens.js';
import { KINDS } from './cover.js';
import { ScanMesh } from './scanmesh.js';

const MIN_SPOTS = 2;
const MAX_SPOTS = 6;
const YAW_BINS = 16;
/*
 * How much of a turn counts as a finished sweep, in yaw bins (each bin is
 * 360/16 = 22.5 degrees). Four bins is about 90 degrees.
 *
 * This used to demand nine bins -- roughly 200 degrees -- which quietly
 * assumed the player was standing in the middle of a room and free to spin
 * around. Someone playing propped up in bed can comfortably sweep about a
 * quarter turn, so the meter could never fill and looked like a hard gate
 * even though the start button was already unlocked.
 */
const SWEEP_BINS = 4;

/**
 * The room-scan phase.
 *
 * Two things happen at once: the device (or our estimate) feeds us surface
 * points, and the player taps to mark furniture the wabbit could hide behind.
 * The progress meter rewards actually sweeping the room — it tracks how many
 * compass bins the player has pointed the camera into, so standing still and
 * tapping the same couch six times does not fill it.
 */
export class ScanPhase {
  constructor({ world, backend, cover, reticle, scanMesh }) {
    this.world = world;
    this.scanMesh = scanMesh;
    this.backend = backend;
    this.cover = cover;
    this.reticle = reticle;
    this.active = false;
    this.onComplete = null;

    this.bins = new Set();
    this.samples = 0;
    this.lastSampleAt = 0;
    this.time = 0;

    this.els = {
      meter: $('#scan-meter'),
      sub: $('#scan-sub'),
      list: $('#mark-list'),
      done: $('#btn-scan-done'),
      undo: $('#btn-scan-undo'),
      kinds: $('#kind-list'),
      kindHint: $('#kind-hint'),
      readout: $('#scan-readout'),
    };

    this.kind = 'surface';
    for (const btn of this.els.kinds.querySelectorAll('.kind')) {
      btn.addEventListener('click', () => this.setKind(btn.dataset.kind));
    }

    this.els.done.addEventListener('click', () => this.finish());
    this.els.undo.addEventListener('click', () => this.undo());
  }

  start() {
    this.active = true;
    document.body.classList.add('scanning');
    this.bins.clear();
    this.samples = 0;
    this.time = 0;
    this.cover.clear();
    this.scanMesh.clear();
    this.scanMesh.setVisible(true);
    this.cover.setMarkersVisible(true);
    this.reticle.setVisible(true);
    this.setKind('surface');
    this._renderMarks();
  }

  stop() {
    this.active = false;
    document.body.classList.remove('scanning');
    this.reticle.setVisible(false);
    // The captured geometry is scaffolding for placing cover, not scenery --
    // leaving it up during the hunt clutters the real room.
    this.scanMesh.setVisible(false);
  }

  /** Called every frame while scanning. */
  update(dt, info) {
    if (!this.active) return;
    this.time += dt;
    this.reticle.update(info.hit, dt);

    // Real room geometry, where the runtime actually has some.
    this.scanMesh.syncXRGeometry(info.frame, info.refSpace);

    this.scanMesh.setAssumedFloor(
      this.cover.floorY, this.world.camera.getWorldPosition(new THREE.Vector3()));

    if (info.hit) {
      this.cover.noteSurface(info.hit.position);

      // Sample no faster than ~8Hz so the meter reflects time and motion.
      if (this.time - this.lastSampleAt > 0.12) {
        this.lastSampleAt = this.time;
        this.samples++;
        // Only sensed surfaces go into the cloud. An estimated point is not a
        // measurement of anything -- plotting a fan of them at a fixed guessed
        // distance scatters dots through mid-air and across the ceiling, which
        // looks like a scan while corresponding to nothing in the room.
        if (info.hit.real) this.scanMesh.addPoint(info.hit.position, true);
        const dir = this.world.camera.getWorldDirection(new THREE.Vector3());
        const yaw = Math.atan2(dir.x, dir.z);
        const bin = Math.floor(((yaw + Math.PI) / (Math.PI * 2)) * YAW_BINS) % YAW_BINS;
        this.bins.add(bin);
      }
    }

    this._updateMeter();
  }

  get sweepProgress() {
    const coverage = this.bins.size / SWEEP_BINS;
    const density = this.samples / 45;
    return clamp(Math.min(coverage, 1) * 0.7 + Math.min(density, 1) * 0.3, 0, 1);
  }

  _updateMeter() {
    const spotProgress = clamp(this.cover.count / MIN_SPOTS, 0, 1);
    // The meter means "ready to hunt", so it must read full at exactly the
    // moment the start button unlocks. Blending the sweep in at the end would
    // leave it stuck in the nineties, which is the same lie in a smaller size:
    // a bar that cannot fill reads as a gate no matter how close it gets.
    const ready = spotProgress >= 1
      ? 1
      : this.sweepProgress * 0.3 + spotProgress * 0.7;
    const pct = Math.round(clamp(ready, 0, 1) * 100);
    this.els.meter.style.width = `${pct}%`;

    this.els.readout.textContent = this.scanMesh.describe();
    this.els.readout.classList.toggle('sensed', this.scanMesh.sensed);
    this.els.readout.classList.toggle('estimated', !this.scanMesh.sensed);

    const remaining = MIN_SPOTS - this.cover.count;
    if (remaining > 0) {
      this.els.done.disabled = true;
      this.els.done.textContent = remaining === 1
        ? 'Mark 1 more hiding spot'
        : `Mark ${remaining} more hiding spots`;
    } else {
      this.els.done.disabled = false;
      this.els.done.textContent = `Stawt Hunting (${this.cover.count} spots)`;
    }

    if (this.cover.count >= MAX_SPOTS) {
      this.els.sub.textContent = 'That is plenty of places to hide. Let\'s go.';
    } else if (this.cover.count > 0) {
      this.els.sub.textContent = 'Tap more furniture, or start the hunt.';
    } else if (this.sweepProgress > 0.45) {
      this.els.sub.textContent = 'Now pick a kind below and tap to mark it.';
    } else {
      this.els.sub.textContent = 'Sweep slowly across whatever you can see.';
    }
  }

  /** Choose what the next tap marks. */
  setKind(kind) {
    if (!KINDS[kind]) return;
    this.kind = kind;
    for (const btn of this.els.kinds.querySelectorAll('.kind')) {
      btn.classList.toggle('is-on', btn.dataset.kind === kind);
    }
    this.els.kindHint.textContent = KINDS[kind].hint;
  }

  /** Player tapped the screen (or squeezed the trigger) to mark cover. */
  mark() {
    if (!this.active) return;
    const hit = this.backend.lastHit;
    if (!hit) {
      toast('Point at a surface first — floor, counter, couch.');
      return;
    }
    if (this.cover.count >= MAX_SPOTS) {
      toast('Six hiding spots is already unsporting.');
      return;
    }
    this.cover.add(hit.position, hit.normal, this.kind);
    sfx.mark();
    this._renderMarks();
  }

  undo() {
    const removed = this.cover.removeLast();
    if (removed) {
      this._renderMarks();
      toast('Unmarked.', 1200);
    }
  }

  _renderMarks() {
    this.els.list.innerHTML = '';
    for (const spot of this.cover.spots) {
      const pill = document.createElement('span');
      pill.className = 'mark-pill';
      pill.textContent = spot.label;
      this.els.list.appendChild(pill);
    }
    this.els.undo.style.visibility = this.cover.count ? 'visible' : 'hidden';
    this._updateMeter();
  }

  finish() {
    if (this.cover.count < MIN_SPOTS) return;
    this.stop();
    this.onComplete?.();
  }
}

export { MIN_SPOTS, MAX_SPOTS };
