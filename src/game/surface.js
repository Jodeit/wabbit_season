import * as THREE from 'three';

/**
 * Turn scattered surface samples into a connected triangle mesh.
 *
 * Discrete patches, one per sample, read as confetti that happens to lie flat.
 * What a room scanner shows — Quest's scene mesh, an iPad room capture — is a
 * continuous surface with visible edges, and the reason that reads as "the
 * device understands this room" is that the pieces are *joined*.
 *
 * There is no volume here to march cubes through: hit-test gives points on
 * surfaces, not an inside and an outside. But each sample carries a normal,
 * and a surface with a known normal is locally a height field. So samples are
 * grouped by which way they face and how far along that direction they sit,
 * and each group is triangulated across its own 2D grid. Neighbouring cells
 * become quads; missing cells simply leave a hole, which is the honest
 * depiction of a part of the room that was never swept.
 */

/*
 * The triangulation grid is deliberately coarser than the sampling grid.
 *
 * A hit test delivers one ray per frame, so sweeping a wall traces thin lines
 * of samples with gaps between them. At sampling resolution those lines never
 * form a contiguous square of four corners, no quad is ever emitted, and the
 * surface comes out empty — which is exactly how a device that was sensing
 * the room perfectly well ended up occluding nothing at all.
 */
const GRID = 0.13;
const SLAB = 0.35;        // separates parallel surfaces (two walls, floor/bed)
/** Passes of hole-filling between observed cells. */
const CLOSE_PASSES = 2;

/** Which way does this normal mostly point: 0 = x, 1 = y, 2 = z. */
function dominantAxis(n) {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ay >= ax && ay >= az) return 1;
  return ax >= az ? 0 : 2;
}

/** The two axes that span a surface facing along `axis`. */
const SPAN = [
  ['y', 'z'],   // facing x
  ['x', 'z'],   // facing y
  ['x', 'y'],   // facing z
];
const ALONG = ['x', 'y', 'z'];

/**
 * @param {Array<{p: THREE.Vector3, n: THREE.Vector3}>} samples
 * @returns {THREE.BufferGeometry|null}
 */
export function buildSurfaceGeometry(samples) {
  if (samples.length < 4) return null;

  // --- bucket samples into co-planar sheets -----------------------------
  const sheets = new Map();
  for (const { p, n } of samples) {
    const axis = dominantAxis(n);
    const along = ALONG[axis];
    const sign = n[along] >= 0 ? 1 : -1;
    const slab = Math.round(p[along] / SLAB);
    const key = `${axis}:${sign}:${slab}`;

    let sheet = sheets.get(key);
    if (!sheet) {
      sheet = { axis, cells: new Map() };
      sheets.set(key, sheet);
    }

    const [u, v] = SPAN[axis];
    const cellKey = `${Math.round(p[u] / GRID)},${Math.round(p[v] / GRID)}`;
    const cell = sheet.cells.get(cellKey);
    if (cell) {
      // Average repeats, which smooths sensor noise a little.
      cell.sum.add(p);
      cell.count++;
    } else {
      sheet.cells.set(cellKey, { sum: p.clone(), count: 1 });
    }
  }

  // --- bridge the gaps between sweep lines -------------------------------
  for (const sheet of sheets.values()) closeHoles(sheet);

  // --- triangulate each sheet across its own grid -----------------------
  const positions = [];
  const centre = new THREE.Vector3();

  for (const sheet of sheets.values()) {
    const at = (i, j) => {
      const cell = sheet.cells.get(`${i},${j}`);
      if (!cell) return null;
      return centre.copy(cell.sum).divideScalar(cell.count).clone();
    };

    for (const key of sheet.cells.keys()) {
      const [i, j] = key.split(',').map(Number);
      // A quad needs all four corners; a missing one leaves a hole, which is
      // exactly what an unswept patch of room should look like.
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i, j + 1);
      const d = at(i + 1, j + 1);
      if (!a || !b || !c || !d) continue;
      positions.push(
        a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z,
        a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z
      );
    }
  }

  if (!positions.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Fill cells that sit between observations.
 *
 * A cell with occupied neighbours on opposite sides is a gap in a surface that
 * was genuinely seen either side of it, so filling it interpolates between
 * measurements rather than inventing them. A cell out on its own stays empty:
 * that is the difference between closing a hole and making up a room.
 */
function closeHoles(sheet) {
  for (let pass = 0; pass < CLOSE_PASSES; pass++) {
    const added = [];
    const seen = new Set();

    for (const key of sheet.cells.keys()) {
      const [ci, cj] = key.split(',').map(Number);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const i = ci + di;
        const j = cj + dj;
        const candidate = `${i},${j}`;
        if (sheet.cells.has(candidate) || seen.has(candidate)) continue;
        seen.add(candidate);

        const left = sheet.cells.get(`${i - 1},${j}`);
        const right = sheet.cells.get(`${i + 1},${j}`);
        const down = sheet.cells.get(`${i},${j - 1}`);
        const up = sheet.cells.get(`${i},${j + 1}`);
        const neighbours = [left, right, down, up].filter(Boolean);

        // Spanned on an axis, or nearly surrounded.
        const spanned = (left && right) || (down && up);
        if (!spanned && neighbours.length < 3) continue;

        const sum = new THREE.Vector3();
        for (const n of neighbours) sum.addScaledVector(n.sum, 1 / n.count);
        added.push([candidate, { sum: sum.divideScalar(neighbours.length), count: 1 }]);
      }
    }

    if (!added.length) break;
    for (const [key, cell] of added) sheet.cells.set(key, cell);
  }
}

export { GRID as SURFACE_CELL };
