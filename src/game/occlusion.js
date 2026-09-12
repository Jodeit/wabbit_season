import * as THREE from 'three';

/**
 * Real-world occlusion, on a device with no depth buffer of its own.
 *
 * Without this, everything the game draws floats on top of the camera image:
 * the wabbit behind your bed renders *over* the duvet, which is what makes an
 * AR scene read as a sticker rather than something in the room.
 *
 * The trick is to draw the surfaces we detected as invisible geometry that
 * still writes depth. They paint nothing, so the camera feed shows through
 * untouched, but anything behind them is depth-rejected and disappears — so
 * the bed hides his legs, and a wall hides him completely.
 *
 * Only walls and furniture tops become occluders. The floor is left out: he
 * stands on it, and a plane at exactly his feet would z-fight with them.
 */

const MIN_SAMPLES = 30;     // only well-supported surfaces get to hide things
const MARGIN = 0.15;        // grow each rectangle slightly to close seams

export class Occluders {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.material = new THREE.MeshBasicMaterial({
      colorWrite: false,     // contributes depth only; paints nothing
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this._signature = '';
  }

  /** @param {Array} planes  rectangles from detectRoom() */
  update(planes) {
    const usable = planes.filter((p) => p.count >= MIN_SAMPLES);

    // Rebuilding every frame would churn geometry for no reason; the detected
    // surfaces only change when the scan does.
    const signature = usable
      .map((p) => `${p.centre.x.toFixed(1)},${p.centre.y.toFixed(1)},${p.centre.z.toFixed(1)}`)
      .join('|');
    if (signature === this._signature) return;
    this._signature = signature;

    this.clear();
    for (const plane of usable) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.position.copy(plane.centre);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal);
      mesh.scale.set(plane.width + MARGIN, plane.height + MARGIN, 1);
      // Drawn before anything else, so its depth is already in place.
      mesh.renderOrder = -10;
      this.group.add(mesh);
    }
  }

  setVisible(v) { this.group.visible = v; }

  get count() { return this.group.children.length; }

  clear() {
    for (const child of [...this.group.children]) this.group.remove(child);
  }
}
