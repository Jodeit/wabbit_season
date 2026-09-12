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

const CELL = 0.07;        // must match the sampling grid
const SLAB = 0.35;        // separates parallel surfaces (two walls, floor/bed)

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
    const cellKey = `${Math.round(p[u] / CELL)},${Math.round(p[v] / CELL)}`;
    const cell = sheet.cells.get(cellKey);
    if (cell) {
      // Average repeats, which smooths sensor noise a little.
      cell.sum.add(p);
      cell.count++;
    } else {
      sheet.cells.set(cellKey, { sum: p.clone(), count: 1 });
    }
  }

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

export { CELL as SURFACE_CELL };
