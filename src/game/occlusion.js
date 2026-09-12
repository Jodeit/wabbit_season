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
  }

  /**
   * Adopt the scan's surface. The geometry is shared rather than copied, so
   * the occluder can never disagree with what the player was shown.
   *
   * @param {THREE.BufferGeometry|null} geometry
   */
  update(geometry) {
    if (!geometry || geometry === this._geometry) return;
    this._geometry = geometry;
    this.mesh.geometry = geometry;
  }

  setVisible(v) { this.group.visible = v; }

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
