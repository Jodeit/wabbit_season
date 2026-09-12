import * as THREE from 'three';
import { pick } from '../core/util.js';

/**
 * Cover spots are the bridge between the real room and the game: each one is
 * a point on a real surface that the wabbit can rise from behind.
 *
 * Height above the floor is enough to guess what the furniture *is*, which is
 * what lets the game say "behind the kitchen island" instead of "at anchor 3".
 */

/**
 * How the wabbit gets into view at a spot. Real rooms are mostly walls and
 * flat-to-the-wall furniture, so "pop up from behind a waist-high surface" on
 * its own leaves a lot of rooms with nowhere to hide.
 */
export const KINDS = {
  surface: {
    id: 'surface',
    name: 'Pop up ovew',
    hint: 'A counter, an island, the end of a bed — he rises from behind it.',
    colour: 0x5f8f3a,
  },
  corner: {
    id: 'corner',
    name: 'Peew awound',
    hint: 'A corner, a doorframe, the edge of a wardrobe — he leans out sideways.',
    colour: 0x3a7f8f,
  },
  door: {
    id: 'door',
    name: 'Open a doow',
    hint: 'A closed door — he swings it open and strolls out.',
    colour: 0x8f5f3a,
  },
};

const KIND_LABELS = {
  corner: ['the cornew', 'the end of the bed', 'the edge of the wardwobe', 'the doowfwame'],
  door: ['the doow', 'the closet doow', 'the bathwoom doow'],
};

const HEIGHT_LABELS = [
  { max: 0.22, names: ['the floow', 'the rug', 'the skirting board'] },
  { max: 0.52, names: ['the coffee table', 'the end of the bed', 'the ottoman'] },
  { max: 0.78, names: ['the couch', 'the bed', 'the armchair'] },
  { max: 1.15, names: ['the kitchen island', 'the countertop', 'the desk', 'the dresser'] },
  { max: Infinity, names: ['the shelf', 'the top of the cabinets', 'the doorway'] },
];

export function labelForSpot(kind, y, floorY = 0) {
  if (KIND_LABELS[kind]) return pick(KIND_LABELS[kind]);
  const h = y - floorY;
  const band = HEIGHT_LABELS.find((b) => h < b.max) ?? HEIGHT_LABELS.at(-1);
  return pick(band.names);
}

/** A single marked hiding place. */
export class CoverSpot {
  constructor(position, normal, label, kind = 'surface', auto = false) {
    this.position = position.clone();
    this.normal = normal.clone().normalize();
    this.label = label;
    this.kind = kind;
    /** True when the game found this itself, rather than the player tapping. */
    this.auto = auto;
    // Which way he slides out from an edge. Picked once and kept, so a given
    // corner always behaves the same way and the player can learn it.
    this.sideSign = Math.random() < 0.5 ? -1 : 1;
    this.lastUsed = -Infinity;
    this.useCount = 0;
    this.marker = buildMarker(KINDS[kind]?.colour ?? 0x5f8f3a);
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

function buildMarker(colour) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.13, 0.17, 28),
    new THREE.MeshBasicMaterial({
      color: colour, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false,
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

  add(position, normal, kind = 'surface', auto = false) {
    const spot = new CoverSpot(
      position, normal, labelForSpot(kind, position.y, this.floorY), kind, auto);
    this.spots.push(spot);
    this.scene.add(spot.marker);
    return spot;
  }

  /** Drop every automatically detected spot, keeping the player's own. */
  removeAuto() {
    for (let i = this.spots.length - 1; i >= 0; i--) {
      if (!this.spots[i].auto) continue;
      this.scene.remove(this.spots[i].marker);
      this.spots[i].dispose();
      this.spots.splice(i, 1);
    }
  }

  /** Remove the most recent spot the player marked by hand. */
  removeLastManual() {
    for (let i = this.spots.length - 1; i >= 0; i--) {
      if (this.spots[i].auto) continue;
      const [spot] = this.spots.splice(i, 1);
      this.scene.remove(spot.marker);
      spot.dispose();
      return spot;
    }
    return null;
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
