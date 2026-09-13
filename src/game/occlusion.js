import * as THREE from 'three';

/**
 * Real-world occlusion, from the same mesh the scan draws.
 *
 * Two earlier versions got this wrong in instructive ways. Fitting a rectangle
 * around each cluster of samples invented occluders across parts of the room
 * nothing was ever sensed on, which sliced the wabbit in half against a bare
 * wall. Replacing that with one quad per observed cell was honest but seamy:
 * thousands of unjoined squares with gaps between them.
 *
 * Now that the scan is triangulated into a connected surface, that surface is
 * the occluder. It is drawn with colour writing off, so it paints nothing and
 * the camera feed shows through untouched, but it writes depth — anything
 * behind it is rejected. It hides him exactly where the room was seen, and
 * nowhere else.
 */
export class Occluders {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.material = new THREE.MeshBasicMaterial({
      colorWrite: false,      // contributes depth only; paints nothing
      depthWrite: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    // Drawn before everything else, so its depth is already in place.
    this.mesh.renderOrder = -10;
    this.group.add(this.mesh);

    this._geometry = null;
    this._scanMesh = null;
    this.runtime = false;
  }

  /**
   * Adopt whatever the scan can offer.
   *
   * Where the runtime supplies real room geometry, that geometry occludes
   * directly — it is already posed and tracked, and re-deriving a surface from
   * points sampled off it only loses fidelity. Our own triangulation is for
   * the case where all we ever had was points.
   *
   * @param {import('./scanmesh.js').ScanMesh} scanMesh
   */
  update(scanMesh) {
    this.runtime = scanMesh.hasRuntimeOccluders;
    scanMesh.setOccludersVisible(this.runtime && this.group.visible);

    // Our triangulation would only fight the real thing for the depth buffer.
    this.mesh.visible = !this.runtime;
    if (this.runtime) return;

    const geometry = scanMesh.surfaceGeometry;
    if (!geometry || geometry === this._geometry) return;
    this._geometry = geometry;
    this.mesh.geometry = geometry;
  }

  setVisible(v) {
    this.group.visible = v;
    this._scanMesh?.setOccludersVisible(this.runtime && v);
  }

  /** Remember the scan so visibility changes can reach the runtime geometry. */
  attach(scanMesh) { this._scanMesh = scanMesh; }

  /** Triangles currently able to hide him. */
  get count() {
    const position = this.mesh.geometry.getAttribute('position');
    return position ? position.count / 3 : 0;
  }

  clear() {
    this._geometry = null;
    this.mesh.geometry = new THREE.BufferGeometry();
  }
}
