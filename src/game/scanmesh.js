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

/*
 * Sized for a whole room, not a stream of single rays.
 *
 * A phone accumulates a few hundred samples over a sweep; a headset hands over
 * its entire space setup at once, and a floor alone can be several thousand
 * cells. With a small cap the floor consumes the whole budget before the walls
 * are read -- and the walls are where the corners to hide behind are, so the
 * game finds nowhere to hide in a fully mapped room.
 */
const MAX_POINTS = 20000;
const CELL = 0.07;          // metres; one patch per cell, so they tile

/**
 * What each label the runtime reports is good for. Anything not listed —
 * floor, ceiling, wall art, lamps — is either not somewhere to hide or is
 * better handled by the geometric corner finder.
 */
const KIND_FOR_LABEL = {
  couch: 'surface',
  sofa: 'surface',
  table: 'surface',
  desk: 'surface',
  bed: 'surface',
  storage: 'surface',
  shelf: 'surface',
  cabinet: 'surface',
  screen: 'corner',
  door: 'door',
  doorframe: 'door',
  window: 'corner',
  'wall art': 'corner',
};

const SENSED = new THREE.Color(0x9fe870);
/** Inferred surfaces are drawn cooler, so they never pass for measured ones. */
const INFERRED = new THREE.Color(0x74d0ff);
const UP_FALLBACK = new THREE.Vector3(0, 1, 0);

/** Standard even-odd test, in the plane's own X/Z. */
function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const zi = poly[i].z;
    const zj = poly[j].z;
    if ((zi > z) !== (zj > z)
      && x < ((poly[j].x - poly[i].x) * (z - zi)) / (zj - zi) + poly[i].x) {
      inside = !inside;
    }
  }
  return inside;
}

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
    this.surface.visible = true;

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
    // Paints nothing, writes depth: the room hides things without being seen.
    this.occluderMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: true, side: THREE.DoubleSide,
    });
    this._occludersOn = false;
    this._floorY = 0;

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

  /** Anything we have geometry for, however it was arrived at. */
  get hasSurface() { return this.sensed || this.inferred; }

  /**
   * Record a sample inferred from the camera image rather than measured.
   *
   * Kept distinct from a sensed one throughout: it drives the same surface,
   * detection and occlusion, but it is never allowed to claim it was measured.
   */
  addInferred(p, normal) {
    const added = this.addPoint(p, false, normal);
    if (added) {
      this.inferred = true;
      if (this.source === 'points') this.source = 'vision';
      this.surface.material.color.set(INFERRED);
      this.wireframe.material.color.set(INFERRED);
    }
    return added;
  }

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
    this.surface.visible = false;   // the runtime's own geometry is drawn instead

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
      this._tracked.set(item, {
        object,
        changed: item.lastChangedTime,
        label: item.semanticLabel ?? '',
      });

      // Feed the room into the same sample pipeline the hit test uses.
      //
      // A headset does not hand over surfaces one ray at a time: it hands over
      // the whole room at once, from its own space setup. Everything
      // downstream -- finding hiding places, triangulating a surface,
      // occlusion -- reads `samples`, so without this the game sits at zero
      // scanned forever while a perfectly good room mesh is on screen.
      this._harvest(item, object.matrix, !!meshes?.size);
    }

    // Drop anything the runtime stopped tracking.
    for (const [item, entry] of this._tracked) {
      if (seen.has(item)) continue;
      entry.object.parent?.remove(entry.object);
      entry.object.geometry?.dispose?.();
      this._tracked.delete(item);
    }
  }

  /**
   * Turn a detected plane or mesh into surface samples on the usual grid.
   * @param {THREE.Matrix4} matrix  the item's world transform
   */
  _harvest(item, matrix, isMesh) {
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const basis = new THREE.Matrix3().setFromMatrix4(matrix);

    if (isMesh) {
      const v = item.vertices;
      const idx = item.indices;
      if (!v || !idx) return;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      for (let i = 0; i + 2 < idx.length; i += 3) {
        a.fromArray(v, idx[i] * 3).applyMatrix4(matrix);
        b.fromArray(v, idx[i + 1] * 3).applyMatrix4(matrix);
        c.fromArray(v, idx[i + 2] * 3).applyMatrix4(matrix);
        normal.copy(c).sub(b).cross(point.copy(a).sub(b)).normalize();
        if (!Number.isFinite(normal.x)) continue;
        // Centroid, plus the corners, so large triangles still fill their
        // cells rather than contributing a single point in the middle.
        point.copy(a).add(b).add(c).divideScalar(3);
        this.addPoint(point, true, normal);
        this.addPoint(a, true, normal);
        this.addPoint(b, true, normal);
        this.addPoint(c, true, normal);
      }
      return;
    }

    const poly = item.polygon;
    if (!poly?.length) return;
    // A plane's normal is its local +Y; its polygon lies in local X/Z.
    normal.set(0, 1, 0).applyMatrix3(basis).normalize();

    let minX = Infinity; let maxX = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    for (const v of poly) {
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    }
    for (let x = minX; x <= maxX; x += CELL) {
      for (let z = minZ; z <= maxZ; z += CELL) {
        if (!pointInPolygon(x, z, poly)) continue;
        point.set(x, 0, z).applyMatrix4(matrix);
        this.addPoint(point, true, normal);
      }
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

  /**
   * Scene-reconstruction mesh: a wireframe to look at, and the solid surface
   * behind it to hide things.
   *
   * Drawing it as lines alone left occlusion to a re-triangulation of sampled
   * points, which is hopeless for a scene mesh — a whole wall can be two
   * triangles, so sampling its corners and centre yields nothing resembling a
   * surface, and the wabbit walks straight through the couch.
   */
  _buildMesh(xrMesh) {
    if (!xrMesh.vertices?.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(xrMesh.vertices, 3));
    if (xrMesh.indices) geo.setIndex(new THREE.BufferAttribute(xrMesh.indices, 1));

    const group = new THREE.Group();
    group.add(this._asDisplay(new THREE.LineSegments(
      new THREE.WireframeGeometry(geo), this.lineMaterial)));
    group.add(this._asOccluder(new THREE.Mesh(geo, this.occluderMaterial)));
    return group;
  }

  /** Detected plane: its boundary to look at, its filled area to hide things. */
  _buildPlane(xrPlane) {
    const poly = xrPlane.polygon;
    if (!poly?.length) return null;

    const group = new THREE.Group();
    const pts = poly.map((v) => new THREE.Vector3(v.x, v.y, v.z));
    pts.push(pts[0].clone());
    group.add(this._asDisplay(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts), this.lineMaterial)));

    // Fan-triangulate the polygon. Detected planes are convex in practice, and
    // a fan is exact for those and close enough for the rest.
    const verts = [];
    for (let i = 1; i + 1 < poly.length; i++) {
      verts.push(
        poly[0].x, poly[0].y, poly[0].z,
        poly[i].x, poly[i].y, poly[i].z,
        poly[i + 1].x, poly[i + 1].y, poly[i + 1].z
      );
    }
    if (verts.length) {
      const solid = new THREE.BufferGeometry();
      solid.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      group.add(this._asOccluder(new THREE.Mesh(solid, this.occluderMaterial)));
    }
    return group;
  }

  _asDisplay(object) {
    object.userData.role = 'display';
    return object;
  }

  _asOccluder(object) {
    object.userData.role = 'occluder';
    object.visible = false;
    object.renderOrder = -10;      // depth laid down before anything is drawn
    object.frustumCulled = false;
    return object;
  }

  /** Toggle the real room's solid geometry as occluders. */
  setOccludersVisible(on) {
    this._occludersOn = on;
    this.geometryGroup.traverse((o) => {
      if (o.userData.role === 'occluder') o.visible = on;
    });
  }

  /** Does the runtime give us real geometry to occlude with? */
  get hasRuntimeOccluders() {
    return this._tracked.size > 0;
  }

  /**
   * Hiding places the runtime has already named for us.
   *
   * A headset does not just hand over geometry, it hands over meaning: every
   * plane carries a semanticLabel like "couch", "table", "door" or "window".
   * Guessing furniture from clusters of points is what you do when nobody told
   * you what anything is — when the device has already said "this is a couch",
   * using that beats inferring it, and it is the only way to know a door is a
   * door rather than part of the wall it sits in.
   */
  semanticSpots(camPos) {
    const spots = [];
    for (const [item, entry] of this._tracked) {
      const kind = KIND_FOR_LABEL[String(entry.label).toLowerCase()];
      if (!kind) continue;

      const poly = item.polygon;
      if (!poly?.length) continue;
      const matrix = entry.object.matrix;

      // Work in world space, and take the edge furthest from the player: the
      // interesting part of a couch is the side he can duck behind.
      let farthest = null;
      let best = -Infinity;
      const centre = new THREE.Vector3();
      const point = new THREE.Vector3();
      for (const v of poly) {
        point.set(v.x, v.y, v.z).applyMatrix4(matrix);
        centre.add(point);
        const d = point.distanceToSquared(camPos);
        if (d > best) { best = d; farthest = point.clone(); }
      }
      if (!farthest) continue;
      centre.divideScalar(poly.length);

      const normal = new THREE.Vector3(0, 1, 0)
        .applyMatrix3(new THREE.Matrix3().setFromMatrix4(matrix)).normalize();

      if (kind === 'surface') {
        const away = farthest.clone().sub(camPos).setY(0).normalize().multiplyScalar(0.18);
        spots.push({
          position: farthest.add(away), normal: new THREE.Vector3(0, 1, 0),
          kind, weight: 5000, label: entry.label,
        });
      } else {
        // A door or window is a vertical opening: stand him in it, on the
        // floor, facing out into the room.
        const out = normal.clone().setY(0).normalize();
        if (out.lengthSq() < 0.1) continue;
        if (out.dot(camPos.clone().sub(centre)) < 0) out.negate();
        spots.push({
          position: new THREE.Vector3(centre.x, this._floorY, centre.z)
            .addScaledVector(out, 0.1),
          normal: out,
          kind,
          weight: 6000,
          label: entry.label,
        });
      }
    }
    return spots;
  }

  setFloorY(y) { this._floorY = y; }

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
    if (this.inferred) {
      const area = this.count * CELL * CELL;
      return `${area.toFixed(1)} m² inferred from the camera image`;
    }
    return 'No depth sensor — surfaces are estimated';
  }

  /**
   * Show the floor we are assuming, at `y`, centred under the player. Only
   * meaningful while nothing real has been sensed -- once the device reports
   * actual geometry, that geometry is the truth and the guess is dropped.
   */
  setAssumedFloor(y, centre) {
    const show = !this.hasSurface;
    this.assumedFloor.visible = show;
    if (!show) return;
    // Snapped to whole metres so the grid stays put in the room instead of
    // sliding along with the viewer, which would destroy the sense that it is
    // anchored to anything.
    this.assumedFloor.position.set(
      Math.round(centre?.x ?? 0), y, Math.round(centre?.z ?? 0));
  }

  /**
   * Show or hide the scan overlay. The room's occluders are deliberately not
   * affected: they have to keep working through the hunt, when the overlay
   * itself is out of the way.
   */
  setVisible(v) {
    this.surface.visible = v && this.source === 'points';
    this.wireframe.visible = v;
    this.assumedFloor.visible = v && !this.hasSurface;
    this.geometryGroup.traverse((o) => {
      if (o.userData.role === 'display') o.visible = v;
    });
  }

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
    this.inferred = false;
    this.surface.material.color.set(SENSED);
    this.wireframe.material.color.set(SENSED);
    this.assumedFloor.visible = false;
  }
}
