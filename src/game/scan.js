import * as THREE from 'three';
import { $, clamp } from '../core/util.js';
import { sfx } from '../audio/sfx.js';
import { toast } from '../ui/screens.js';

const MIN_SPOTS = 2;
const MAX_SPOTS = 6;
const YAW_BINS = 16;

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
  constructor({ world, backend, cover, reticle }) {
    this.world = world;
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
    };

    this.els.done.addEventListener('click', () => this.finish());
    this.els.undo.addEventListener('click', () => this.undo());
  }

  start() {
    this.active = true;
    this.bins.clear();
    this.samples = 0;
    this.time = 0;
    this.cover.clear();
    this.cover.setMarkersVisible(true);
    this.reticle.setVisible(true);
    this._renderMarks();
  }

  stop() {
    this.active = false;
    this.reticle.setVisible(false);
  }

  /** Called every frame while scanning. */
  update(dt, info) {
    if (!this.active) return;
    this.time += dt;
    this.reticle.update(info.hit, dt);

    if (info.hit) {
      this.cover.noteSurface(info.hit.position);

      // Sample no faster than ~8Hz so the meter reflects time and motion.
      if (this.time - this.lastSampleAt > 0.12) {
        this.lastSampleAt = this.time;
        this.samples++;
        const dir = this.world.camera.getWorldDirection(new THREE.Vector3());
        const yaw = Math.atan2(dir.x, dir.z);
        const bin = Math.floor(((yaw + Math.PI) / (Math.PI * 2)) * YAW_BINS) % YAW_BINS;
        this.bins.add(bin);
      }
    }

    this._updateMeter();
  }

  get sweepProgress() {
    const coverage = this.bins.size / (YAW_BINS * 0.55);   // ~9 bins is a full sweep
    const density = this.samples / 90;
    return clamp(Math.min(coverage, 1) * 0.7 + Math.min(density, 1) * 0.3, 0, 1);
  }

  _updateMeter() {
    const spotProgress = clamp(this.cover.count / MIN_SPOTS, 0, 1);
    const pct = Math.round((this.sweepProgress * 0.5 + spotProgress * 0.5) * 100);
    this.els.meter.style.width = `${pct}%`;

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
      this.els.sub.textContent = 'Now tap the reticle on something he could duck behind.';
    } else {
      this.els.sub.textContent = 'Sweep slowly. Look at your floor and furniture.';
    }
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
    const spot = this.cover.add(hit.position, hit.normal);
    sfx.mark();
    this._renderMarks();
    toast(`Marked: ${spot.label}`, 1600);
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
