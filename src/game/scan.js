import * as THREE from 'three';
import { $, clamp } from '../core/util.js';
import { sfx } from '../audio/sfx.js';
import { toast } from '../ui/screens.js';
import { KINDS } from './cover.js';
import { ScanMesh } from './scanmesh.js';
import { detectRoom } from './detect.js';

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
/** How often to re-run automatic hiding-spot detection, in seconds. */
const DETECT_EVERY = 0.6;
/** Seconds to hold a finished scan before starting itself, with no button. */
const AUTO_START_DELAY = 3;

/** Turn a runtime semantic label into something the hunter would say. */
function prettyLabel(label) {
  if (!label) return null;
  const named = String(label).toLowerCase().replace(/_/g, ' ');
  return `the ${named.replace(/r/g, 'w')}`;
}

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
  constructor({ world, backend, cover, reticle, scanMesh, occluders }) {
    this.world = world;
    this.scanMesh = scanMesh;
    this.occluders = occluders;
    this.backend = backend;
    this.cover = cover;
    this.reticle = reticle;
    this.active = false;
    this.onComplete = null;

    this.bins = new Set();
    this.lastSampleAt = 0;
    this.lastDetectAt = -Infinity;
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
      tapHint: $('#tap-hint'),
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
    this.els.tapHint.hidden = true;
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

    if (this.time - this.lastDetectAt > DETECT_EVERY) {
      this.lastDetectAt = this.time;
      this._autoDetect();
    }

    if (info.hit) {
      this.cover.noteSurface(info.hit.position);

      // Sample no faster than ~8Hz so the meter reflects time and motion.
      if (this.time - this.lastSampleAt > 0.12) {
        this.lastSampleAt = this.time;
        // Only sensed surfaces go into the cloud. An estimated point is not a
        // measurement of anything -- plotting a fan of them at a fixed guessed
        // distance scatters dots through mid-air and across the ceiling, which
        // looks like a scan while corresponding to nothing in the room.
        if (info.hit.real) {
          this.scanMesh.addPoint(info.hit.position, true, info.hit.normal);
        }
        const dir = this.world.camera.getWorldDirection(new THREE.Vector3());
        const yaw = Math.atan2(dir.x, dir.z);
        const bin = Math.floor(((yaw + Math.PI) / (Math.PI * 2)) * YAW_BINS) % YAW_BINS;
        this.bins.add(bin);
      }
    }

    this._updateMeter();

    if (this.autoStart) this._tickAutoStart(dt);
    this.onProgress?.(this);
  }

  /** Count down and start the hunt, for sessions with no visible buttons. */
  _tickAutoStart(dt) {
    const ready = this.sweepProgress >= 1 && this.cover.count >= MIN_SPOTS;
    if (!ready) {
      this.autoStartAt = 0;
      return;
    }
    this.autoStartAt += dt;
    if (this.autoStartAt >= AUTO_START_DELAY) this.finish();
  }

  get autoStartRemaining() {
    return Math.max(0, Math.ceil(AUTO_START_DELAY - this.autoStartAt));
  }

  /**
   * How much of a sweep has been done, 0..1.
   *
   * Just angular coverage. A second "sample density" term used to be blended
   * in at 30%, which meant a player who had swept the whole arc still sat at
   * 85% until enough samples had trickled in -- another bar that looks stuck
   * for reasons it never explains. Bins only fill on frames where a surface
   * was actually sampled, so coverage already implies the sampling happened.
   */
  get sweepProgress() {
    /*
     * A headset does not need sweeping at all.
     *
     * It hands over its whole room in one go, from its own space setup, rather
     * than a surface at a time as the player looks around. Asking such a
     * player to sweep is asking them to fill a bar that has nothing to measure
     * -- the bins only fill on frames with a hit test, which a headset may not
     * even offer, so the meter would sit at zero with the room already on
     * screen.
     */
    if (this.scanMesh.source !== 'points' && this.scanMesh.count > 0) return 1;
    return clamp(this.bins.size / SWEEP_BINS, 0, 1);
  }

  _updateMeter() {
    /*
     * The bar under "Scanning the woom..." measures the scan, and nothing
     * else.
     *
     * It used to be 70% weighted on how many spots you had marked, so with
     * none marked it could not go past 30% no matter how well you swept. That
     * put players in a trap: the label says scanning, so they sweep, and the
     * bar sits at a third looking like a scan that will not finish -- when in
     * fact the sweep was long done and the game was waiting on a tap it had
     * never clearly asked for. Marking is a separate step and now says so.
     */
    const pct = Math.round(clamp(this.sweepProgress, 0, 1) * 100);
    this.els.meter.style.width = `${pct}%`;

    this.els.readout.textContent = this.scanMesh.describe();
    this.els.readout.classList.toggle('sensed', this.scanMesh.sensed);
    this.els.readout.classList.toggle('estimated', !this.scanMesh.sensed);

    const remaining = MIN_SPOTS - this.cover.count;
    if (remaining > 0) {
      this.els.done.disabled = true;
      // Reads as an instruction rather than a dead button, since this is the
      // step people were getting stuck on.
      this.els.done.textContent =
        `Looking for spots · ${this.cover.count} of ${MIN_SPOTS}`;
    } else {
      this.els.done.disabled = false;
      this.els.done.textContent = `Stawt Hunting (${this.cover.count} spots)`;
    }

    // The big unmissable prompt, until they have marked their first spot.
    // Only nag about tapping when sweeping has not turned anything up, since
    // finding the spots is the game's job first and the player's second.
    this.els.tapHint.hidden = !(this.cover.count === 0 && this.sweepProgress >= 1);

    const auto = this.cover.spots.filter((s) => s.auto).length;
    if (this.cover.count >= MAX_SPOTS) {
      this.els.sub.textContent = 'That is plenty of places to hide. Let\'s go.';
    } else if (auto > 0) {
      this.els.sub.textContent = this.cover.count >= MIN_SPOTS
        ? 'Found some hiding spots — keep sweeping, or start the hunt.'
        : 'Found one — keep sweeping for more.';
    } else if (this.cover.count > 0) {
      this.els.sub.textContent = 'Tap more furniture, or start the hunt.';
    } else if (this.scanMesh.source !== 'points') {
      this.els.sub.textContent = 'Got your woom from the headset — finding hiding spots.';
    } else if (this.sweepProgress >= 1) {
      this.els.sub.textContent = 'Looking for hiding spots — keep sweeping the woom.';
    } else {
      this.els.sub.textContent = 'Sweep slowly across whatever you can see.';
    }
  }

  /**
   * Look for hiding places in what has been scanned, and keep the marked set
   * in sync with them.
   *
   * Automatic spots are replaced wholesale each pass, because the detection
   * improves as more of the room arrives; anything the player marked by hand
   * is left alone, since that was a deliberate choice and should not be
   * second-guessed by a heuristic.
   */
  _autoDetect() {
    if (!this.scanMesh.sensed || !this.scanMesh.samples.length) return;

    const camPos = this.world.camera.getWorldPosition(new THREE.Vector3());
    this.scanMesh.setFloorY(this.cover.floorY);
    // What the runtime named beats what we inferred, so it goes first and the
    // geometric finder only fills in around it.
    const named = this.scanMesh.semanticSpots(camPos);
    const { spots: inferred } = detectRoom(
      this.scanMesh.samples, this.cover.floorY, camPos);
    // Named spots win ties; an inferred one on top of a known couch is the
    // same couch, described worse.
    const detected = [...named];
    for (const spot of inferred) {
      const duplicate = detected.some((d) =>
        d.position.distanceTo(spot.position) < (d.kind === spot.kind ? 0.7 : 0.3));
      if (!duplicate) detected.push(spot);
    }
    // The scan's own geometry is the occluder, so the two can never disagree.
    this.scanMesh.rebuild();
    this.occluders.update(this.scanMesh);
    this.occluders.updateFromCover(this.cover);
    if (!detected.length) return;

    const manual = this.cover.spots.filter((s) => !s.auto).length;
    const room = Math.max(0, MAX_SPOTS - manual);
    const wanted = detected.slice(0, room);

    // Nothing to do if the detection has not actually changed anything.
    const auto = this.cover.spots.filter((s) => s.auto);
    const same = auto.length === wanted.length && auto.every((s, i) =>
      s.position.distanceTo(wanted[i].position) < 0.2 && s.kind === wanted[i].kind);
    if (same) return;

    this.cover.removeAuto();
    for (const spot of wanted) {
      this.cover.add(spot.position, spot.normal, spot.kind, true, prettyLabel(spot.label));
    }
    this._renderMarks();
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
    // A live hit is best, but a recent one is far better than refusing a tap
    // the player was right to make: on iOS the hit test only reports surfaces
    // inside a finished ARKit plane, so it blinks out over exactly the corners
    // and doorframes worth marking.
    const fresh = this.backend.lastHit;
    const sticky = this.backend.stickyHit;
    const stickyAge = performance.now() - (this.backend.stickyHitAt ?? 0);
    const hit = fresh ?? (stickyAge < 2000 ? sticky : null);
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
    // Only ever takes back one of the player's own marks; the detected ones
    // come straight back on the next detection pass anyway.
    const removed = this.cover.removeLastManual();
    if (removed) {
      this._renderMarks();
      toast('Unmarked.', 1200);
    }
  }

  _renderMarks() {
    this.els.list.innerHTML = '';
    for (const spot of this.cover.spots) {
      const pill = document.createElement('span');
      pill.className = spot.auto ? 'mark-pill auto' : 'mark-pill';
      pill.textContent = spot.auto ? `◆ ${spot.label}` : spot.label;
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
