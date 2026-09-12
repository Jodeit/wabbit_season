import * as THREE from 'three';
import { clamp, damp, lerp, rand } from '../core/util.js';

/**
 * The hunter's double-barrel, rendered as a first-person view model.
 *
 * The model hangs off a rig that is re-parented depending on runtime: to an
 * XR controller when one exists, otherwise to the camera (phone AR, where the
 * device *is* the aim).  Two poses matter: hip (low, swaying, wide) and
 * shouldered (pulled to centre so you can look down the rib between barrels).
 */

/**
 * The gun is positioned as a fraction of the view frustum rather than in fixed
 * metres. A phone held in portrait has a very narrow horizontal field of view,
 * and a hip position measured in metres simply falls off the side of the
 * screen there; expressing it as "55% of the way to the right edge" holds up on
 * every aspect ratio and through an orientation change.
 */
/*
 * Depth of the *receiver* (the model's origin). The gun runs from roughly
 * +0.31 (butt) to -0.42 (muzzle) in local Z, so this has to be far enough out
 * that the stock does not end up pressed against the near plane and filling
 * half the screen.
 */
const GUN_DEPTH = 0.55;
const HIP_FRAC = { x: 0.55, y: -0.78 };
/*
 * Shouldered, the gun sits low enough that the target stays visible above the
 * bead. Raising it any further and the barrels eclipse whatever you are aiming
 * at, which makes the sight picture useless on a phone-sized screen.
 */
const ADS_FRAC = { x: 0.0, y: -0.30 };

const HIP_ROT = new THREE.Euler(0.10, -0.28, 0.06);
const ADS_ROT = new THREE.Euler(0, 0, 0);

const WOOD = 0x6b3b1c;
const BLUED = 0x33383f;
const BRASS = 0xc9a227;

function m(color, rough = 0.5, metal = 0.6) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

export class Shotgun {
  constructor() {
    this.rig = new THREE.Group();      // follows camera/controller
    this.recoilPivot = new THREE.Group();
    this.model = new THREE.Group();
    this.rig.add(this.recoilPivot);
    this.recoilPivot.add(this.model);

    this._build();

    this.ads = 0;              // 0 = hip, 1 = shouldered
    this.targetAds = 0;
    this.recoil = 0;
    this.sway = new THREE.Vector2();
    this.t = 0;
    this.bentAmount = 0;       // gag state: barrel tied in a knot
    this.targetBent = 0;
    this.smoke = [];

    /**
     * 'camera' — the device *is* the aim (a phone, or a headset with no
     * controller). The gun is framed against the screen.
     * 'controller' — a tracked hand holds it, so it simply points where the
     * hand points and screen-relative framing would be wrong.
     */
    this.mount = 'camera';
    this.hipPos = new THREE.Vector3();
    this.adsPos = new THREE.Vector3();
    this._aspect = 0;
    this._fov = 0;

    this.model.renderOrder = 10;
    this.model.traverse((o) => { if (o.isMesh) o.material.depthTest = true; });
  }

  _build() {
    const barrels = new THREE.Group();
    // Two barrels side by side, muzzle toward -Z.
    for (const side of [-1, 1]) {
      const tube = new THREE.Mesh(
        new THREE.CylinderGeometry(0.021, 0.023, 0.52, 16), m(BLUED, 0.35, 0.85));
      tube.rotation.x = Math.PI / 2;
      tube.position.set(side * 0.023, 0, -0.27);
      barrels.add(tube);
      this[side < 0 ? 'barrelL' : 'barrelR'] = tube;
    }
    // Sighting rib between the barrels, plus the brass bead you line up.
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.006, 0.52), m(BLUED, 0.4, 0.7));
    rib.position.set(0, 0.016, -0.27);
    barrels.add(rib);

    // Oversized on purpose: this is the only aiming cue the player gets, and
    // a true-to-life bead is a couple of pixels across on a phone.
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 12),
      new THREE.MeshStandardMaterial({
        color: BRASS, emissive: 0xffb300, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.9,
      }));
    bead.position.set(0, 0.027, -0.525);
    barrels.add(bead);
    this.bead = bead;

    this.barrels = barrels;
    this.model.add(barrels);

    // Receiver + break-action lever.
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.056, 0.10), m(BLUED, 0.3, 0.8));
    receiver.position.set(0, -0.004, 0.035);
    this.model.add(receiver);

    const lever = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.018, 0.028), m(BRASS, 0.35, 0.9));
    lever.position.set(0, 0.028, 0.045);
    this.model.add(lever);

    // The stock is deliberately stubby and the butt plate is not modelled at
    // all: at a real length it sits centimetres from the eye and becomes an
    // opaque slab across the bottom of the screen. Everything from the wrist
    // back is behind the player's shoulder and simply never drawn.
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.046, 0.12), m(WOOD, 0.75, 0.05));
    stock.position.set(0, -0.034, 0.12);
    stock.rotation.x = -0.16;
    this.model.add(stock);

    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.028, 0.15), m(WOOD, 0.75, 0.05));
    fore.position.set(0, -0.02, -0.13);
    this.model.add(fore);

    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.0035, 8, 14, Math.PI * 1.4), m(BLUED, 0.4, 0.8));
    guard.position.set(0, -0.04, 0.075);
    guard.rotation.set(Math.PI / 2, 0, 0);
    this.model.add(guard);

    // Muzzle flash sprite, hidden until fired.
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd98a, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10), flashMat);
    flash.position.set(0, 0.002, -0.54);
    flash.scale.set(1, 1, 1.7);
    this.model.add(flash);
    this.flash = flash;

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.002, -0.54);
    this.model.add(this.muzzle);
  }

  /** Attach the rig to whatever drives aiming this session. */
  attachTo(parent, mount = 'camera') {
    parent.add(this.rig);
    this.rig.position.set(0, 0, 0);
    this.rig.rotation.set(0, 0, 0);
    this.mount = mount;
    // Invalidate the layout cache: the two mounts compute completely different
    // poses, so a cached frustum from before the switch would leave the gun
    // stuck in the other mount's position.
    this._fov = 0;
    this._aspect = 0;
  }

  setAds(on) {
    this.targetAds = on ? 1 : 0;
  }

  get isAiming() { return this.ads > 0.6; }

  /** Spread in radians — tight when shouldered, comically wide from the hip. */
  get spread() {
    return lerp(0.085, 0.016, this.ads);
  }

  /** World-space ray from the muzzle down the rib. */
  getAimRay(out = new THREE.Ray()) {
    this.muzzle.getWorldPosition(out.origin);
    const dir = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.model.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    out.direction.copy(dir);
    return out;
  }

  fire() {
    this.recoil = 1;
    this.flash.material.opacity = 1;
    this.flash.scale.set(rand(0.8, 1.4), rand(0.8, 1.4), rand(1.4, 2.2));
    this.flash.rotation.z = rand(0, Math.PI);
    this.spawnSmoke();
  }

  spawnSmoke() {
    const geo = new THREE.SphereGeometry(0.03, 8, 8);
    for (let i = 0; i < 6; i++) {
      const puff = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xd9d4cc, transparent: true, opacity: 0.5, depthWrite: false,
      }));
      this.muzzle.getWorldPosition(puff.position);
      puff.userData.vel = new THREE.Vector3(rand(-0.2, 0.2), rand(0.05, 0.35), rand(-0.2, 0.2));
      puff.userData.life = 0;
      puff.userData.max = rand(0.7, 1.3);
      this.smoke.push(puff);
      // Smoke is left behind in world space, not carried along with the gun.
      (this.rig.parent?.parent ?? this.rig).add(puff);
    }
  }

  /** Gag: tie the barrels in a knot (or untie them). */
  setBent(on) {
    this.targetBent = on ? 1 : 0;
  }

  /**
   * Recompute the hip/shouldered anchors from the camera's frustum. Cheap, and
   * only does work when the projection actually changed.
   */
  layoutFor(camera) {
    if (this.mount === 'controller') {
      // Held in a tracked hand: the gun sits just ahead of the grip and points
      // where the hand points. Framing it against the screen would drag it
      // away from the player's actual hand.
      this.hipPos.set(0, -0.02, -0.12);
      this.adsPos.set(0, -0.02, -0.12);
      return;
    }

    /*
     * Derive the frustum from the projection matrix rather than camera.fov.
     * Under WebXR the pose and projection are supplied by the runtime and
     * three writes projectionMatrix directly -- `fov` and `aspect` keep
     * whatever they held before the session and are simply wrong, which puts
     * the gun somewhere off the side of a headset's view.
     */
    const m = camera.projectionMatrix.elements;
    const halfH = GUN_DEPTH / m[5];
    const halfW = GUN_DEPTH / m[0];
    if (halfH === this._fov && halfW === this._aspect) return;
    this._fov = halfH;
    this._aspect = halfW;

    this.hipPos.set(halfW * HIP_FRAC.x, halfH * HIP_FRAC.y, -GUN_DEPTH);
    this.adsPos.set(halfW * ADS_FRAC.x, halfH * ADS_FRAC.y, -GUN_DEPTH);
  }

  update(dt, sceneRoot, camera) {
    this.t += dt;
    if (camera?.projectionMatrix) this.layoutFor(camera);
    this.ads = damp(this.ads, this.targetAds, 12, dt);
    this.recoil = damp(this.recoil, 0, 9, dt);
    this.bentAmount = damp(this.bentAmount, this.targetBent, 7, dt);

    // Pose blend between hip and shouldered.
    this.model.position.lerpVectors(this.hipPos, this.adsPos, this.ads);
    if (this.mount === 'controller') {
      this.model.rotation.set(0, 0, 0);
    } else {
      this.model.rotation.set(
        lerp(HIP_ROT.x, ADS_ROT.x, this.ads),
        lerp(HIP_ROT.y, ADS_ROT.y, this.ads),
        lerp(HIP_ROT.z, ADS_ROT.z, this.ads)
      );
    }

    // Idle breathing sway; much calmer when shouldered, and absent entirely
    // when a real hand is holding it — the hand already supplies the motion.
    const swayScale = this.mount === 'controller' ? 0 : lerp(1, 0.22, this.ads);
    this.model.position.x += Math.sin(this.t * 1.3) * 0.006 * swayScale;
    this.model.position.y += Math.sin(this.t * 2.1) * 0.005 * swayScale;
    this.model.rotation.z += Math.sin(this.t * 0.9) * 0.02 * swayScale;

    // Recoil: kick back and up, rolling the muzzle skyward.
    const r = this.recoil;
    this.recoilPivot.position.set(0, r * 0.02, r * 0.09);
    this.recoilPivot.rotation.set(-r * 0.55, r * 0.06, r * 0.1);

    this.flash.material.opacity = damp(this.flash.material.opacity, 0, 26, dt);

    // Bent-barrel gag: curl the tubes up and outward like a banana.
    const b = this.bentAmount;
    for (const [side, tube] of [[-1, this.barrelL], [1, this.barrelR]]) {
      tube.rotation.z = side * b * 0.9;
      tube.rotation.y = side * b * 0.5;
      tube.position.y = b * 0.05;
      tube.position.x = side * (0.023 + b * 0.05);
    }
    this.bead.visible = b < 0.3;

    this._updateSmoke(dt, sceneRoot);
  }

  _updateSmoke(dt, sceneRoot) {
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const p = this.smoke[i];
      p.userData.life += dt;
      const k = p.userData.life / p.userData.max;
      if (k >= 1) {
        p.parent?.remove(p);
        p.material.dispose();
        this.smoke.splice(i, 1);
        continue;
      }
      p.position.addScaledVector(p.userData.vel, dt);
      p.userData.vel.multiplyScalar(1 - 1.6 * dt);
      p.scale.setScalar(1 + k * 2.6);
      p.material.opacity = 0.5 * (1 - k);
      if (sceneRoot && p.parent !== sceneRoot) {
        sceneRoot.attach(p);
      }
    }
  }

  /** How close the aim ray passes to a world point, in radians. */
  angleTo(worldPoint) {
    const ray = this.getAimRay();
    const toTarget = worldPoint.clone().sub(ray.origin);
    const dist = toTarget.length();
    if (dist < 1e-4) return 0;
    toTarget.divideScalar(dist);
    return Math.acos(clamp(toTarget.dot(ray.direction), -1, 1));
  }
}
