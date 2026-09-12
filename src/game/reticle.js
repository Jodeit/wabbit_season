import * as THREE from 'three';
import { damp } from '../core/util.js';

/** The placement reticle shown during the scan phase. */
export class Reticle {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.07, 0.095, 32),
      new THREE.MeshBasicMaterial({
        color: 0xf6e7c8, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false,
      })
    );
    this.dot = new THREE.Mesh(
      new THREE.CircleGeometry(0.016, 16),
      new THREE.MeshBasicMaterial({ color: 0xef7a21, transparent: true, opacity: 0.9, depthWrite: false })
    );
    this.group.add(this.ring, this.dot);

    // Cross ticks so the reticle reads as an instrument, not a decal.
    const tickGeo = new THREE.PlaneGeometry(0.03, 0.005);
    const tickMat = new THREE.MeshBasicMaterial({ color: 0xf6e7c8, transparent: true, opacity: 0.8, depthWrite: false });
    for (let i = 0; i < 4; i++) {
      const tick = new THREE.Mesh(tickGeo, tickMat);
      const a = (i / 4) * Math.PI * 2;
      tick.position.set(Math.cos(a) * 0.115, Math.sin(a) * 0.115, 0);
      tick.rotation.z = a;
      this.group.add(tick);
    }

    scene.add(this.group);
    this.pulse = 0;
    this.estimated = false;
  }

  /** @param {{position: THREE.Vector3, normal: THREE.Vector3, real: boolean}|null} hit */
  update(hit, dt) {
    if (!hit) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.position.copy(hit.position);

    // The reticle geometry faces +Z, so align that axis to the surface normal.
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
    this.group.quaternion.slerp(q, 1 - Math.exp(-14 * dt));

    // Estimated placements (no depth sensing) are tinted so the difference
    // between "the device sees this surface" and "we guessed" is visible.
    const color = hit.real ? 0xf6e7c8 : 0x9fd0ff;
    this.ring.material.color.setHex(color);

    this.pulse += dt * 3.2;
    const s = 1 + Math.sin(this.pulse) * 0.07;
    this.group.scale.setScalar(s);
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
  }
}
