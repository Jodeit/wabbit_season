import * as THREE from 'three';
import { pick } from '../core/util.js';

/**
 * Cover spots are the bridge between the real room and the game: each one is
 * a point on a real surface that the wabbit can rise from behind.
 *
 * Height above the floor is enough to guess what the furniture *is*, which is
 * what lets the game say "behind the kitchen island" instead of "at anchor 3".
 */

const HEIGHT_LABELS = [
  { max: 0.22, names: ['the floow', 'the rug', 'the skirting board'] },
  { max: 0.52, names: ['the coffee table', 'the end of the bed', 'the ottoman'] },
  { max: 0.78, names: ['the couch', 'the bed', 'the armchair'] },
  { max: 1.15, names: ['the kitchen island', 'the countertop', 'the desk', 'the dresser'] },
  { max: Infinity, names: ['the shelf', 'the top of the cabinets', 'the doorway'] },
];

export function labelForHeight(y, floorY = 0) {
  const h = y - floorY;
  const band = HEIGHT_LABELS.find((b) => h < b.max) ?? HEIGHT_LABELS.at(-1);
  return pick(band.names);
}

/** A single marked hiding place. */
export class CoverSpot {
  constructor(position, normal, label) {
    this.position = position.clone();
    this.normal = normal.clone().normalize();
    this.label = label;
    this.lastUsed = -Infinity;
    this.useCount = 0;
    this.marker = buildMarker();
    this.marker.position.copy(this.position);

    // Lay the ring flat on horizontal surfaces, flush on vertical ones.
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(this.normal.dot(up)) > 0.7) {
      this.marker.rotation.x = -Math.PI / 2;
      this.isHorizontal = true;
    } else {
      this.marker.lookAt(this.position.clone().add(this.normal));
      this.isHorizontal = false;
    }
  }

  setMarkerVisible(v) { this.marker.visible = v; }

  dispose() {
    this.marker.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
  }
}

function buildMarker() {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.13, 0.17, 28),
    new THREE.MeshBasicMaterial({
      color: 0x5f8f3a, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false,
    })
  );
  group.add(ring);
  const inner = new THREE.Mesh(
    new THREE.RingGeometry(0.03, 0.055, 20),
    new THREE.MeshBasicMaterial({
      color: 0xef7a21, side: THREE.DoubleSide, transparent: true, opacity: 0.7, depthWrite: false,
    })
  );
  group.add(inner);
  group.userData.spin = ring;
  return group;
}

/**
 * Holds every marked spot and decides where the wabbit shows up next.
 */
export class CoverSet {
  constructor(scene) {
    this.scene = scene;
    this.spots = [];
    // Both backends put the floor at y = 0: WebXR because the session uses a
    // `local-floor` reference space, the fallback because it assumes an eye
    // height. Surface samples can only ever push this *down* (a sunken room,
    // or a player who is shorter than the assumption).
    this.floorY = 0;
  }

  get count() { return this.spots.length; }

  /** Track the lowest surface we have seen; that is the floor. */
  noteSurface(point) {
    if (point.y < this.floorY) this.floorY = point.y;
  }

  add(position, normal) {
    const spot = new CoverSpot(position, normal, labelForHeight(position.y, this.floorY));
    this.spots.push(spot);
    this.scene.add(spot.marker);
    return spot;
  }

  removeLast() {
    const spot = this.spots.pop();
    if (!spot) return null;
    this.scene.remove(spot.marker);
    spot.dispose();
    return spot;
  }

  setMarkersVisible(v) {
    for (const s of this.spots) s.setMarkerVisible(v);
  }

  /**
   * Pick the next hiding place. Prefers spots that are *not* currently in the
   * player's view — half the joke is him appearing where you just weren't
   * looking — and avoids reusing the spot he just came from.
   *
   * @param {THREE.Camera} camera
   * @param {CoverSpot|null} avoid
   */
  chooseNext(camera, avoid = null, now = 0) {
    if (!this.spots.length) return null;

    const camPos = camera.getWorldPosition(new THREE.Vector3());
    const camDir = camera.getWorldDirection(new THREE.Vector3());

    const candidates = this.spots.filter((s) => s !== avoid);
    const pool = candidates.length ? candidates : this.spots;

    let best = null;
    let bestScore = -Infinity;
    for (const spot of pool) {
      const toSpot = spot.position.clone().sub(camPos);
      const dist = toSpot.length();
      if (dist < 1e-3) continue;
      toSpot.divideScalar(dist);

      // Off-screen is worth the most, then peripheral, then dead ahead.
      const facing = toSpot.dot(camDir);       // 1 = straight ahead
      let score = facing < 0.25 ? 1.6 : facing < 0.7 ? 1.0 : 0.35;

      // Playable range: too close is no fun, too far and he is a dot.
      if (dist < 0.9) score *= 0.35;
      else if (dist > 5.5) score *= 0.4;
      else score *= 1.25;

      score *= 1 / (1 + spot.useCount * 0.45);          // spread him around
      score *= now - spot.lastUsed < 12 ? 0.4 : 1;      // cool-down
      score *= 0.7 + Math.random() * 0.6;               // keep it unpredictable

      if (score > bestScore) { bestScore = score; best = spot; }
    }

    const chosen = best ?? pool[0];
    chosen.useCount++;
    chosen.lastUsed = now;
    return chosen;
  }

  /** Spot furthest behind the player — used by the "he's behind you" gags. */
  chooseBehind(camera) {
    if (!this.spots.length) return null;
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    let best = this.spots[0];
    let bestDot = Infinity;
    for (const spot of this.spots) {
      const d = spot.position.clone().sub(camPos).normalize().dot(camDir);
      if (d < bestDot) { bestDot = d; best = spot; }
    }
    return best;
  }

  update(dt) {
    for (const s of this.spots) {
      s.marker.userData.spin.rotation.z += dt * 0.6;
    }
  }

  clear() {
    for (const s of this.spots) {
      this.scene.remove(s.marker);
      s.dispose();
    }
    this.spots.length = 0;
  }
}
