import * as THREE from 'three';

/**
 * Monocular geometry from the camera image.
 *
 * Safari senses nothing — no depth, no planes, no tracking — so the game has
 * had to assume a floor and a fixed arm's length. But the camera image is not
 * nothing, and one cue in it is genuinely metric rather than a guess:
 *
 *   **the line where the floor stops.**
 *
 * With a known eye height and a known view direction, the pixel where a
 * surface meets the floor fixes that surface's distance exactly — it is the
 * ground-plane constraint, the same cue that lets you judge how far away a
 * kerb is with one eye shut. Everything else here serves that: contrast finds
 * the line, and brightness tells us which side of it is floor.
 *
 * What this is not: it is inference from one image, not measurement. It needs
 * the floor in shot and the phone roughly upright, it is fooled by rugs,
 * strong shadows and dark skirting, and it can say nothing whatever about what
 * is behind anything. Results are reported as inferred and drawn differently
 * from sensed surfaces, because a confident wrong answer is worse than an
 * honest estimate.
 */

const COLS = 48;              // analysis columns across the frame
const ROWS = 64;              // analysis rows
const EDGE_THRESHOLD = 14;    // luminance step that counts as a boundary
const MIN_DISTANCE = 0.4;
const MAX_DISTANCE = 6;
const STABLE_TOLERANCE = 0.45; // metres a column may move and still be trusted
const WALL_HEIGHT = 1.1;      // fallback height when no top edge is found
const RUN_TOLERANCE = 0.3;    // metres; columns this close are the same object
const MIN_RUN = 3;            // columns before a run is believed
const EDGE_STEP = 0.45;       // depth jump that counts as something to lean around
const DOOR_STEP = 0.9;        // how far a doorway must recede past its jambs

export class Vision {
  /**
   * @param {HTMLVideoElement|HTMLCanvasElement|null} source  anything
   *   drawable. A camera feed in Safari; a canvas holding this frame's XR
   *   camera image where a headset grants raw access.
   */
  constructor(source) {
    this.video = source;
    this.canvas = document.createElement('canvas');
    this.canvas.width = COLS;
    this.canvas.height = ROWS;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.luma = new Float32Array(COLS * ROWS);
    /** Last accepted distance per column, for temporal agreement. */
    this.previous = new Float32Array(COLS).fill(NaN);
    this.available = false;
  }

  get ready() {
    return this._sizeOf(this.video) > 0 && !!this.ctx;
  }

  _sizeOf(source) {
    return source ? (source.videoWidth ?? source.width ?? 0) : 0;
  }

  /** Pull a frame and reduce it to a luminance field. */
  _grab(source) {
    this.ctx.drawImage(source, 0, 0, COLS, ROWS);
    const { data } = this.ctx.getImageData(0, 0, COLS, ROWS);
    for (let i = 0, p = 0; i < this.luma.length; i++, p += 4) {
      // Rec. 601 luma: cheap, and closer to perceived contrast than a mean.
      this.luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
  }

  _at(x, y) { return this.luma[y * COLS + x]; }

  /**
   * Find, per column, the row where the floor gives way to something standing
   * on it. Scanning upward from the bottom finds the *nearest* such boundary,
   * which is the one that occludes.
   */
  _floorRows() {
    const rows = new Int16Array(COLS).fill(-1);
    const strength = new Float32Array(COLS);

    for (let x = 0; x < COLS; x++) {
      let best = 0;
      let bestRow = -1;
      // Ignore the very bottom (often the player's own body or a table edge
      // right under the lens) and the top half (ceiling and far wall).
      for (let y = ROWS - 4; y > ROWS * 0.3; y--) {
        const above = this._at(x, y - 2);
        const below = this._at(x, y + 1);
        const step = Math.abs(below - above);
        if (step < EDGE_THRESHOLD || step <= best) continue;
        best = step;
        bestRow = y;
      }
      rows[x] = bestRow;
      strength[x] = best;
    }
    return { rows, strength };
  }

  /**
   * For each column, the row where the thing standing on the floor *ends*.
   *
   * Scanning up from the floor boundary to the next strong contrast step finds
   * the top of the couch, the back of the chair, the head of the doorway. With
   * the distance already fixed by the floor line, that row gives the object's
   * height — and height is what separates something to vault behind from
   * something to lean around.
   */
  _topRows(floorRows) {
    const tops = new Int16Array(COLS).fill(-1);
    for (let x = 0; x < COLS; x++) {
      const from = floorRows[x];
      if (from < 0) continue;
      let best = 0;
      let bestRow = -1;
      for (let y = from - 3; y > 2; y--) {
        const step = Math.abs(this._at(x, y - 2) - this._at(x, y + 1));
        if (step < EDGE_THRESHOLD || step <= best) continue;
        best = step;
        bestRow = y;
      }
      tops[x] = bestRow;
    }
    return tops;
  }

  /**
   * Turn the floor line into world geometry.
   *
   * @param {THREE.Camera} camera
   * @param {number} floorY
   * @returns {{points: Array, columns: number, confidence: number}}
   */
  analyse(camera, floorY = 0, source = this.video) {
    if (!this.ctx || this._sizeOf(source) <= 0) {
      return { points: [], columns: 0, confidence: 0, spots: [] };
    }
    this._grab(source);
    this.available = true;

    const { rows, strength } = this._floorRows();
    const tops = this._topRows(rows);
    /** Per-column depth profile, for reading features out of afterwards. */
    const profile = new Array(COLS).fill(null);
    const origin = camera.getWorldPosition(new THREE.Vector3());
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);

    const points = [];
    let accepted = 0;

    for (let x = 0; x < COLS; x++) {
      const row = rows[x];
      if (row < 0) { this.previous[x] = NaN; continue; }

      // Pixel centre -> normalised device coordinates -> a world ray.
      const nx = ((x + 0.5) / COLS) * 2 - 1;
      const ny = -(((row + 0.5) / ROWS) * 2 - 1);
      const dir = new THREE.Vector3(nx, ny, 0.5).unproject(camera).sub(origin).normalize();
      if (dir.y > -0.03) { this.previous[x] = NaN; continue; }   // at or above the horizon

      const base = new THREE.Vector3();
      if (!new THREE.Ray(origin, dir).intersectPlane(floorPlane, base)) {
        this.previous[x] = NaN;
        continue;
      }
      const distance = base.distanceTo(origin);
      if (distance < MIN_DISTANCE || distance > MAX_DISTANCE) {
        this.previous[x] = NaN;
        continue;
      }

      // One frame is a coincidence. Only trust a column that says the same
      // thing twice, which rejects most flicker, noise and passing shadows.
      const last = this.previous[x];
      this.previous[x] = distance;
      if (!Number.isFinite(last) || Math.abs(last - distance) > STABLE_TOLERANCE) continue;
      accepted++;

      // The surface faces the player, standing on the floor at that point.
      const normal = origin.clone().sub(base).setY(0);
      if (normal.lengthSq() < 1e-4) continue;
      normal.normalize();

      const confidence = Math.min(1, strength[x] / 60);

      // How tall is it? Intersect the top-edge ray with the vertical plane
      // standing on the base point — exact, given the distance is exact.
      let topY = NaN;
      if (tops[x] >= 0) {
        const tny = -(((tops[x] + 0.5) / ROWS) * 2 - 1);
        const topDir = new THREE.Vector3(nx, tny, 0.5).unproject(camera).sub(origin).normalize();
        const face = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, base);
        const meet = new THREE.Vector3();
        if (new THREE.Ray(origin, topDir).intersectPlane(face, meet)) {
          const h = meet.y - floorY;
          if (h > 0.1 && h < 2.6) topY = floorY + h;
        }
      }

      profile[x] = { distance, base, normal, topY, confidence };

      // Build the surface only as high as the thing actually is.
      const top = Number.isFinite(topY) ? topY : floorY + WALL_HEIGHT;
      for (let h = 0; floorY + h <= top; h += 0.12) {
        points.push({
          p: new THREE.Vector3(base.x, floorY + h, base.z),
          n: normal.clone(),
          confidence,
        });
      }
    }

    return {
      points,
      columns: accepted,
      confidence: accepted / COLS,
      spots: extractSpots(profile, origin, floorY),
    };
  }
}

/**
 * Read hiding places out of the depth profile.
 *
 * This is the part that answers "the end of the couch, the chair, the doorway".
 * None of those are visible as *surfaces* — they are visible as **changes**:
 *
 *   a run of columns at one distance, with a measurable top   -> furniture
 *   a step between adjacent columns                           -> an edge to lean around
 *   a run that recedes far behind its neighbours              -> a doorway
 *
 * The floor line alone could never produce them, which is why a perfectly good
 * depth estimate still found nowhere to hide.
 */
function extractSpots(profile, origin, floorY) {
  const spots = [];

  // --- group columns into runs of agreeing distance ---
  const runs = [];
  let current = null;
  for (let x = 0; x < COLS; x++) {
    const col = profile[x];
    if (!col) { current = null; continue; }
    if (current && Math.abs(col.distance - current.distance) < RUN_TOLERANCE) {
      current.columns.push(col);
      current.distance = (current.distance * (current.columns.length - 1) + col.distance)
        / current.columns.length;
      current.end = x;
    } else {
      current = { start: x, end: x, distance: col.distance, columns: [col] };
      runs.push(current);
    }
  }

  const solid = runs.filter((r) => r.columns.length >= MIN_RUN);

  for (let i = 0; i < solid.length; i++) {
    const run = solid[i];
    const mid = run.columns[Math.floor(run.columns.length / 2)];
    const heights = run.columns.map((c) => c.topY).filter(Number.isFinite);
    const topY = heights.length >= Math.max(2, run.columns.length * 0.4)
      ? heights.reduce((a, b) => a + b) / heights.length
      : NaN;

    const behind = mid.normal.clone().negate().multiplyScalar(0.22);

    // Furniture: a measurable top at a height you could duck behind.
    if (Number.isFinite(topY) && topY - floorY > 0.3 && topY - floorY < 1.35) {
      spots.push({
        position: mid.base.clone().add(behind).setY(topY),
        normal: new THREE.Vector3(0, 1, 0),
        kind: 'surface',
        weight: 400 + run.columns.length * 10,
      });
    }

    // A doorway: the floor carries on well past everything either side of it,
    // and nothing crosses it low down.
    // Every jamb we can see must be nearer than the opening. A doorway at the
    // edge of frame shows only one of them, and requiring both missed those
    // entirely -- which is most doorways, since you rarely hold a phone with
    // one centred.
    const neighbours = [solid[i - 1], solid[i + 1]].filter(Boolean);
    const recedes = neighbours.length > 0
      && neighbours.every((n) => run.distance - n.distance > DOOR_STEP);
    if (recedes && (!Number.isFinite(topY) || topY - floorY > 1.7)) {
      spots.push({
        position: mid.base.clone().setY(floorY + 0.02),
        normal: mid.normal.clone(),
        kind: 'door',
        weight: 700,
      });
    }
  }

  // --- steps between runs: the end of the couch, the edge of the chair ---
  for (let i = 1; i < solid.length; i++) {
    const a = solid[i - 1];
    const b = solid[i];
    const step = Math.abs(a.distance - b.distance);
    if (step < EDGE_STEP) continue;
    // Stand him at the near side; that is the bit he can lean around.
    const near = a.distance < b.distance ? a : b;
    const col = a.distance < b.distance ? near.columns.at(-1) : near.columns[0];
    spots.push({
      position: col.base.clone().setY(floorY + 0.02),
      normal: col.normal.clone(),
      kind: 'corner',
      weight: 500 + step * 100,
    });
  }

  void origin;
  return spots;
}

export { COLS as VISION_COLUMNS };
