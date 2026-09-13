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
const WALL_HEIGHT = 1.1;      // how far up a surface to assume, from its base

export class Vision {
  constructor(video) {
    this.video = video;
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
    return !!this.video?.videoWidth && !!this.ctx;
  }

  /** Pull a frame and reduce it to a luminance field. */
  _grab() {
    this.ctx.drawImage(this.video, 0, 0, COLS, ROWS);
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
   * Turn the floor line into world geometry.
   *
   * @param {THREE.Camera} camera
   * @param {number} floorY
   * @returns {{points: Array, columns: number, confidence: number}}
   */
  analyse(camera, floorY = 0) {
    if (!this.ready) return { points: [], columns: 0, confidence: 0 };
    this._grab();
    this.available = true;

    const { rows, strength } = this._floorRows();
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
      for (let h = 0; h <= WALL_HEIGHT; h += 0.12) {
        points.push({
          p: new THREE.Vector3(base.x, floorY + h, base.z),
          n: normal.clone(),
          confidence,
        });
      }
    }

    return { points, columns: accepted, confidence: accepted / COLS };
  }
}

export { COLS as VISION_COLUMNS };
