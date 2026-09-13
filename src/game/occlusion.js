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

    /*
     * Occluders standing in for cover the player marked by hand.
     *
     * Where nothing is sensed at all — Safari, with no depth of any kind —
     * there is no room geometry to hide him behind, and he floats in front of
     * everything. But a marked spot is not a guess: it is the player pointing
     * at their own kitchen island and saying "that is a thing to hide behind".
     * Taking them at their word is the one honest source of occlusion left.
     */
    this.marked = new THREE.Group();
    this.group.add(this.marked);
    this._markedKey = '';
    this._markerGeometry = new THREE.PlaneGeometry(0.9, 0.9);
  }

  /**
   * Build stand-in occluders from spots the player marked.
   * Only "pop up over" spots: those are the ones with something between the
   * player and the wabbit. He stands clear of corners and doorways.
   */
  updateFromCover(cover) {
    const surfaces = cover.spots.filter((s) => s.kind === 'surface');
    const key = surfaces
      .map((s) => `${s.position.x.toFixed(2)},${s.position.y.toFixed(2)},${s.position.z.toFixed(2)}`)
      .join('|');
    if (key === this._markedKey) return;
    this._markedKey = key;

    for (const child of [...this.marked.children]) this.marked.remove(child);
    if (this.runtime) return;      // real geometry is already doing this job

    for (const spot of surfaces) {
      const quad = new THREE.Mesh(this._markerGeometry, this.material);
      quad.position.copy(spot.position);
      quad.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), spot.normal);
      // Dropped slightly, so it hides what is behind the surface without
      // clipping the feet of whoever is standing on it.
      quad.position.addScaledVector(spot.normal, -0.04);
      quad.renderOrder = -10;
      quad.frustumCulled = false;
      this.marked.add(quad);
    }
  }

  get markedCount() { return this.marked.children.length; }

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
