import * as THREE from 'three';

/**
 * Find hiding places in the scanned surface, so the player does not have to
 * point at each one and tap.
 *
 * The input is whatever the device sensed: points with surface normals. That
 * is enough to recover the room's flat pieces and the interesting places where
 * they stop or meet.
 *
 *   horizontal, at the lowest level   -> the floor
 *   horizontal, knee to counter high  -> something to pop up from behind
 *   vertical                          -> a wall
 *   two walls meeting                 -> a corner to lean around
 *   a wall that simply stops          -> an edge to lean around
 *
 * What it deliberately does not claim: a door. ARKit reports a door as part of
 * the wall plane it sits in, and nothing in hit-test data distinguishes the
 * two, so doors stay a manual tap rather than a confident guess.
 */

const HORIZONTAL = 0.75;     // |n.y| above this is a floor/table-like surface
const VERTICAL = 0.4;        // |n.y| below this is a wall-like surface
const MIN_SAMPLES = 14;      // per cluster, before it is believed
const Y_BIN = 0.1;           // metres, for grouping horizontal surfaces
const YAW_BIN = Math.PI / 9; // 20 degrees, for grouping wall orientations
const D_BIN = 0.2;           // metres, for separating parallel walls
const MERGE_DISTANCE = 0.7;  // spots closer than this are the same place
const FURNITURE_MIN = 0.25;  // above the floor
const FURNITURE_MAX = 1.35;

/** Group samples into flat pieces, keyed by orientation and offset. */
function cluster(samples, keyOf) {
  const groups = new Map();
  for (const s of samples) {
    const key = keyOf(s);
    if (key === null) continue;
    let g = groups.get(key);
    if (!g) {
      g = { count: 0, sum: new THREE.Vector3(), normal: new THREE.Vector3(), points: [] };
      groups.set(key, g);
    }
    g.count++;
    g.sum.add(s.p);
    g.normal.add(s.n);
    g.points.push(s.p);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.count < MIN_SAMPLES) continue;
    g.centre = g.sum.clone().divideScalar(g.count);
    g.normal.normalize();
    out.push(g);
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * @param {Array<{p: THREE.Vector3, n: THREE.Vector3}>} samples
 * @param {number} floorY
 * @param {THREE.Vector3} camPos
 * @returns {Array<{position, normal, kind, weight}>}
 */
export function detectSpots(samples, floorY, camPos) {
  if (samples.length < MIN_SAMPLES) return [];

  const horizontal = samples.filter((s) => Math.abs(s.n.y) > HORIZONTAL);
  const vertical = samples.filter((s) => Math.abs(s.n.y) < VERTICAL);

  const found = [];

  // --- things to pop up from behind ----------------------------------
  // Horizontal surfaces at furniture height. The interesting point is not the
  // middle of the bed, it is the edge of it facing the player.
  for (const g of cluster(horizontal, (s) => Math.round(s.p.y / Y_BIN))) {
    const height = g.centre.y - floorY;
    if (height < FURNITURE_MIN || height > FURNITURE_MAX) continue;

    let nearest = null;
    let best = Infinity;
    for (const p of g.points) {
      const d = p.distanceToSquared(camPos);
      if (d < best) { best = d; nearest = p; }
    }
    if (!nearest) continue;
    found.push({
      position: nearest.clone(),
      normal: new THREE.Vector3(0, 1, 0),
      kind: 'surface',
      weight: g.count,
    });
  }

  // --- things to lean around -----------------------------------------
  const walls = cluster(vertical, (s) => {
    const yaw = Math.atan2(s.n.x, s.n.z);
    const d = s.n.dot(s.p);
    return `${Math.round(yaw / YAW_BIN)}:${Math.round(d / D_BIN)}`;
  });

  // Two walls meeting make a corner. Their planes intersect in a vertical
  // line; it only counts if both walls actually have surface near that line,
  // otherwise it is two walls that never meet inside this room.
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i];
      const b = walls[j];
      const angle = Math.acos(THREE.MathUtils.clamp(
        Math.abs(a.normal.dot(b.normal)), -1, 1));
      if (angle < Math.PI / 4) continue;          // near-parallel: no corner

      const line = intersectVertical(a, b);
      if (!line) continue;
      if (!hasSurfaceNear(a.points, line) || !hasSurfaceNear(b.points, line)) continue;

      found.push({
        position: new THREE.Vector3(line.x, floorY + 0.05, line.z),
        // Face out of the corner, so he leans towards the room.
        normal: a.normal.clone().add(b.normal).normalize(),
        kind: 'corner',
        weight: Math.min(a.count, b.count) * 2,   // a real corner is a prize
      });
    }
  }

  // A wall that simply ends -- the edge of a wardrobe, an alcove, a doorway
  // reveal -- is worth leaning around too.
  for (const wall of walls.slice(0, 4)) {
    const along = new THREE.Vector3(0, 1, 0).cross(wall.normal).normalize();
    let min = null;
    let max = null;
    let minT = Infinity;
    let maxT = -Infinity;
    for (const p of wall.points) {
      const t = p.dot(along);
      if (t < minT) { minT = t; min = p; }
      if (t > maxT) { maxT = t; max = p; }
    }
    if (!min || maxT - minT < 0.8) continue;      // too small to have ends
    for (const edge of [min, max]) {
      found.push({
        position: new THREE.Vector3(edge.x, floorY + 0.05, edge.z),
        normal: wall.normal.clone(),
        kind: 'corner',
        weight: wall.count,
      });
    }
  }

  return prune(found, camPos);
}

/** Where two vertical planes cross, in plan view. Null if near-parallel. */
function intersectVertical(a, b) {
  const a1 = a.normal.x;
  const b1 = a.normal.z;
  const c1 = a.normal.dot(a.centre);
  const a2 = b.normal.x;
  const b2 = b.normal.z;
  const c2 = b.normal.dot(b.centre);
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-3) return null;
  return {
    x: (c1 * b2 - c2 * b1) / det,
    z: (a1 * c2 - a2 * c1) / det,
  };
}

function hasSurfaceNear(points, line, radius = 0.6) {
  const r2 = radius * radius;
  for (const p of points) {
    const dx = p.x - line.x;
    const dz = p.z - line.z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

/**
 * Merge duplicates and drop anything unplayable: too close to stand back
 * from, or too far to see him at. Best-supported spots win.
 */
function prune(found, camPos) {
  const kept = [];
  const ranked = found
    .map((f) => {
      const dist = f.position.distanceTo(camPos);
      let score = f.weight;
      if (dist < 0.8 || dist > 6) score *= 0.15;
      return { ...f, dist, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const spot of ranked) {
    if (spot.dist < 0.5 || spot.dist > 8) continue;
    if (kept.some((k) => k.position.distanceTo(spot.position) < MERGE_DISTANCE)) continue;
    kept.push(spot);
  }
  return kept;
}
