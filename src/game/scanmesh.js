import * as THREE from 'three';
import { buildSurfaceGeometry } from './surface.js';

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

const SENSED = new THREE.Color(0x9fe870);
const UP_FALLBACK = new THREE.Vector3(0, 1, 0);

export class ScanMesh {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    // --- sampled surface ------------------------------------------------
    // Drawn as a connected mesh rather than loose patches: a surface with
    // visible edges is what makes a scan look like the device understands the
    // room, and unlike separate patches it can also be handed straight to the
    // occluder, seams and all gone.
    this.surface = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: SENSED,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.surface.frustumCulled = false;
    this.group.add(this.surface);

    this.wireframe = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: SENSED, transparent: true, opacity: 0.5, depthWrite: false,
      })
    );
    this.wireframe.frustumCulled = false;
    this.group.add(this.wireframe);

    /** Geometry of the sensed surface, shared with the occluders. */
    this.surfaceGeometry = null;
    this._builtFrom = 0;

    this.count = 0;
    this._cells = new Set();
    /** Raw {p, n} samples, kept for automatic hiding-spot detection. */
    this.samples = [];


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
    // One sample per cell, so sweeping covers ground instead of piling up.
    const key = `${Math.round(p.x / CELL)},${Math.round(p.y / CELL)},${Math.round(p.z / CELL)}`;
    if (this._cells.has(key)) return false;
    this._cells.add(key);
    if (this.count >= MAX_POINTS) return false;

    this.samples.push({ p: p.clone(), n: (normal ?? UP_FALLBACK).clone() });
    this.count++;
    if (real) this.sensed = true;
    return true;
  }

  /**
   * Re-triangulate the sensed surface. Cheap enough to call a few times a
   * second, but only does work when new cells have actually arrived.
   */
  rebuild() {
    if (this.count === this._builtFrom || this.count < 4) return;
    this._builtFrom = this.count;

    const geometry = buildSurfaceGeometry(this.samples);
    if (!geometry) return;

    this.surface.geometry.dispose();
    this.surface.geometry = geometry;
    this.wireframe.geometry.dispose();
    this.wireframe.geometry = new THREE.WireframeGeometry(geometry);
    this.surfaceGeometry = geometry;
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
    this._builtFrom = 0;
    this._cells.clear();
    this.samples.length = 0;
    this.surface.geometry.dispose();
    this.surface.geometry = new THREE.BufferGeometry();
    this.wireframe.geometry.dispose();
    this.wireframe.geometry = new THREE.BufferGeometry();
    this.surfaceGeometry = null;
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
