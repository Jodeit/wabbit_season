import * as THREE from 'three';

/**
 * Visualisation of what the device has actually understood about the room.
 *
 * This is a readout, not decoration, so it only ever draws data the runtime
 * really gave us, and it says which of three sources it came from:
 *
 *   'mesh'   real scene reconstruction (XRMesh) -- Quest 3 and similar
 *   'planes' real detected planes (XRPlane)     -- Android Chrome, others
 *   'points' sampled surface points             -- hit-test, or our own guess
 *
 * The last case covers iOS, where Safari exposes neither WebXR nor any depth
 * API. Those points are estimates rather than measurements, so they are drawn
 * in a different colour and reported as estimated. Rendering a convincing
 * solid mesh there would be inventing geometry the device never sensed.
 */

const MAX_POINTS = 4000;
const CELL = 0.07;          // metres; one patch per cell, so they tile
const PATCH = 0.105;        // slightly wider than a cell, so patches overlap

const SENSED = new THREE.Color(0x9fe870);
const UP_FALLBACK = new THREE.Vector3(0, 1, 0);

export class ScanMesh {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    // --- sampled surface ------------------------------------------------
    // Drawn as small patches lying *in* each sensed surface, oriented to its
    // normal, rather than screen-facing dots. Dots tell you a ray hit
    // something; overlapping patches show you the shape of the thing it hit,
    // and a swept wall fills in as a continuous sheet. This is as close to a
    // mesh as hit-test data honestly gets -- the runtimes that do real
    // reconstruction are handled separately, above.
    this.patches = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(PATCH, PATCH),
      new THREE.MeshBasicMaterial({
        color: SENSED,
        transparent: true,
        opacity: 0.3,   // a skin over the room, not a coat of paint
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
      MAX_POINTS
    );
    this.patches.count = 0;
    this.patches.frustumCulled = false;
    this.patches.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.patches);

    this.count = 0;
    this._cells = new Set();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._scale = new THREE.Vector3(1, 1, 1);
    this._up = new THREE.Vector3(0, 0, 1);

    // --- real geometry --------------------------------------------------
    this.geometryGroup = new THREE.Group();
    this.group.add(this.geometryGroup);
    this._tracked = new Map();       // XRPlane|XRMesh -> { object, changed }

    this.lineMaterial = new THREE.LineBasicMaterial({
      color: 0x9fe870, transparent: true, opacity: 0.65, depthWrite: false,
    });

    // --- the assumed floor -----------------------------------------------
    // Loose points alone read as confetti. With no depth sensor the model of
    // the room is "a floor at y = 0, and anything else about three metres
    // out", and drawing that floor states the assumption plainly instead of
    // leaving the player to infer it from scattered dots.
    this.assumedFloor = new THREE.GridHelper(8, 32, 0x6fb8ff, 0x3f6f9f);
    this.assumedFloor.material.transparent = true;
    this.assumedFloor.material.opacity = 0.3;
    this.assumedFloor.material.depthWrite = false;
    this.assumedFloor.visible = false;
    this.group.add(this.assumedFloor);

    this.source = 'points';
    this.sensed = false;
  }

  get planeCount() { return this._tracked.size; }
  get pointCount() { return this.count; }

  /**
   * Record a sensed surface sample.
   * @param {THREE.Vector3} p
   * @param {boolean} real    true when the device sensed it
   * @param {THREE.Vector3} [normal]  surface normal, for orienting the patch
   */
  addPoint(p, real, normal = null) {
    // One patch per cell, so sweeping covers ground instead of piling up.
    const key = `${Math.round(p.x / CELL)},${Math.round(p.y / CELL)},${Math.round(p.z / CELL)}`;
    if (this._cells.has(key)) return false;
    this._cells.add(key);
    if (this.count >= MAX_POINTS) return false;

    // Lie the patch in the surface. Without a normal it faces up, which is
    // right for the floor and no worse than a dot anywhere else.
    this._q.setFromUnitVectors(this._up, normal ?? UP_FALLBACK);
    this._m.compose(p, this._q, this._scale);
    this.patches.setMatrixAt(this.count, this._m);

    this.count++;
    this.patches.count = this.count;
    this.patches.instanceMatrix.needsUpdate = true;
    if (real) this.sensed = true;
    return true;
  }

  /**
   * Sync against the real geometry in an XRFrame, if this runtime reports any.
   * Planes and meshes both carry a `lastChangedTime`, so untouched ones are
   * left alone rather than rebuilt every frame.
   */
  syncXRGeometry(frame, refSpace) {
    if (!frame || !refSpace) return;

    const meshes = frame.detectedMeshes;
    const planes = frame.detectedPlanes;
    const set = (meshes?.size ? meshes : planes) ?? null;
    if (!set) return;

    this.source = meshes?.size ? 'mesh' : 'planes';
    this.sensed = true;

    const seen = new Set();
    for (const item of set) {
      seen.add(item);
      const known = this._tracked.get(item);
      if (known && known.changed === item.lastChangedTime) {
        this._poseObject(known.object, item, frame, refSpace);
        continue;
      }
      known?.object.parent?.remove(known.object);
      known?.object.geometry?.dispose?.();

      const object = meshes?.size ? this._buildMesh(item) : this._buildPlane(item);
      if (!object) continue;
      this.geometryGroup.add(object);
      this._poseObject(object, item, frame, refSpace);
      this._tracked.set(item, { object, changed: item.lastChangedTime });
    }

    // Drop anything the runtime stopped tracking.
    for (const [item, entry] of this._tracked) {
      if (seen.has(item)) continue;
      entry.object.parent?.remove(entry.object);
      entry.object.geometry?.dispose?.();
      this._tracked.delete(item);
    }
  }

  _poseObject(object, item, frame, refSpace) {
    const space = item.meshSpace ?? item.planeSpace;
    const pose = space && frame.getPose(space, refSpace);
    if (!pose) { object.visible = false; return; }
    object.visible = true;
    object.matrix.fromArray(pose.transform.matrix);
    object.matrix.decompose(object.position, object.quaternion, object.scale);
  }

  /** Scene-reconstruction mesh, drawn as a wireframe. */
  _buildMesh(xrMesh) {
    if (!xrMesh.vertices?.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(xrMesh.vertices, 3));
    if (xrMesh.indices) geo.setIndex(new THREE.BufferAttribute(xrMesh.indices, 1));
    return new THREE.LineSegments(new THREE.WireframeGeometry(geo), this.lineMaterial);
  }

  /** Detected plane, drawn as its boundary polygon. */
  _buildPlane(xrPlane) {
    const poly = xrPlane.polygon;
    if (!poly?.length) return null;
    const pts = poly.map((v) => new THREE.Vector3(v.x, v.y, v.z));
    pts.push(pts[0].clone());
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), this.lineMaterial);
  }

  /** Human-readable summary for the scan HUD. */
  describe() {
    const n = this._tracked.size;
    const plural = (word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (this.source === 'mesh') return `${plural('surface')} meshed · ${this.count} points`;
    if (this.source === 'planes') return `${plural('plane')} detected · ${this.count} points`;
    if (this.sensed) {
      const area = this.count * CELL * CELL;
      return `${area.toFixed(1)} m² of surface mapped`;
    }
    return 'No depth sensor — surfaces are estimated';
  }

  /**
   * Show the floor we are assuming, at `y`, centred under the player. Only
   * meaningful while nothing real has been sensed -- once the device reports
   * actual geometry, that geometry is the truth and the guess is dropped.
   */
  setAssumedFloor(y, centre) {
    const show = !this.sensed;
    this.assumedFloor.visible = show;
    if (!show) return;
    // Snapped to whole metres so the grid stays put in the room instead of
    // sliding along with the viewer, which would destroy the sense that it is
    // anchored to anything.
    this.assumedFloor.position.set(
      Math.round(centre?.x ?? 0), y, Math.round(centre?.z ?? 0));
  }

  setVisible(v) { this.group.visible = v; }

  clear() {
    this.count = 0;
    this._cells.clear();
    this.patches.count = 0;
    for (const [, entry] of this._tracked) {
      entry.object.parent?.remove(entry.object);
      entry.object.geometry?.dispose?.();
    }
    this._tracked.clear();
    this.source = 'points';
    this.sensed = false;
    this.assumedFloor.visible = false;
  }
}
