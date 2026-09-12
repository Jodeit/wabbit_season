import * as THREE from 'three';

/**
 * Real-world occlusion, built only from surface that was actually observed.
 *
 * The first version fitted a rectangle around each cluster of samples and used
 * that as the occluder. Cheap, and wrong: a bounding box spans everything
 * between its corners, including the parts of the room nothing was ever sensed
 * on. The result was a phantom sheet slicing the wabbit in half against a bare
 * wall, with no object anywhere near the cut.
 *
 * So the occluder is now the sensed surface itself — one small depth-only quad
 * per observed cell, in the same places as the visible scan patches. It hides
 * him where the room was genuinely seen, and nowhere else. Gaps where the scan
 * is thin are honest: better a wabbit that fails to hide than a wabbit sawn in
 * half by geometry that does not exist.
 */

const QUAD = 0.13;          // slightly wider than a scan cell, to close seams
const MAX = 4000;
/**
 * Push each quad back along its own normal.
 *
 * Without this the floor's occluder sits exactly at his feet and the bed's at
 * exactly his soles, and the depth test clips whatever is resting on the
 * surface. A couple of centimetres of bias keeps contact clean while still
 * hiding anything genuinely behind.
 */
const BIAS = 0.03;

export class Occluders {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(QUAD, QUAD),
      new THREE.MeshBasicMaterial({
        colorWrite: false,      // contributes depth only; paints nothing
        depthWrite: true,
        side: THREE.DoubleSide,
      }),
      MAX
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Drawn before everything else, so its depth is already in place.
    this.mesh.renderOrder = -10;
    this.group.add(this.mesh);

    this._built = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._scale = new THREE.Vector3(1, 1, 1);
    this._forward = new THREE.Vector3(0, 0, 1);
  }

  /** @param {Array<{p: THREE.Vector3, n: THREE.Vector3}>} samples */
  update(samples) {
    // Only extend; the scan only ever grows, so already-placed quads stand.
    if (samples.length <= this._built) return;

    for (let i = this._built; i < samples.length && i < MAX; i++) {
      const { p, n } = samples[i];
      this._q.setFromUnitVectors(this._forward, n);
      this._p.copy(p).addScaledVector(n, -BIAS);
      this._m.compose(this._p, this._q, this._scale);
      this.mesh.setMatrixAt(i, this._m);
    }
    this._built = Math.min(samples.length, MAX);
    this.mesh.count = this._built;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  setVisible(v) { this.group.visible = v; }

  get count() { return this.mesh.count; }

  clear() {
    this._built = 0;
    this.mesh.count = 0;
  }
}
