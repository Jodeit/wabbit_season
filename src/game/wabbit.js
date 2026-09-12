import * as THREE from 'three';
import { clamp, damp, lerp, rand } from '../core/util.js';

/**
 * Wascal P. Wabbit — built entirely from primitives so the game ships with no
 * model files. He is a stack of spheres with an attitude problem.
 *
 * Local space: feet at y=0, facing +Z, roughly 0.62m tall standing.
 */

const GREY = 0xa9adb4;
const GREY_DARK = 0x7e838b;
const CREAM = 0xf3ece0;
const PINK = 0xe98ea4;
const CARROT = 0xef7a21;
const LEAF = 0x5f8f3a;

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.85,
    metalness: 0,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    ...opts.extra,
  });
}

/** Toon-ish rim so he reads against any real-world background. */
function outline(mesh, scale = 1.06) {
  const shell = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color: 0x1b1b20, side: THREE.BackSide })
  );
  shell.scale.multiplyScalar(scale);
  mesh.add(shell);
  return mesh;
}

function sphere(r, color, segments = 18) {
  return outline(new THREE.Mesh(new THREE.SphereGeometry(r, segments, segments), mat(color)));
}

export class Wabbit {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'wabbit';

    // Pivot lets the whole body rise out of / sink behind furniture.
    this.body = new THREE.Group();
    this.root.add(this.body);

    this._buildShadow();
    this._buildBody();
    this._buildHead();
    this._buildCarrot();

    this.t = 0;
    this.state = 'hidden';
    this.stateTime = 0;
    this.emergeAmount = 0;   // 0 = fully behind cover, 1 = fully up
    this.targetEmerge = 0;
    this.lean = 0;
    this.targetLean = 0;
    this.squash = 1;
    this.chewing = false;
    this.visibleRadius = 0.22;
    this.emergeMode = 'surface';   // surface | corner | door
    this.sideSign = 1;

    this.setEmerge(0, true);
  }

  /* ----------------------------------------------------------------- */
  /**
   * A soft contact shadow on the surface he is standing on.
   *
   * Without one he reads as a sticker floating in front of the room no matter
   * how correct his position is: a shadow is most of what tells the eye that
   * something is resting on a surface rather than hovering near it. It lives
   * on the root rather than the body, so it stays put on the floor while he
   * rises and ducks.
   */
  _buildShadow() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.25)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.42),
      new THREE.MeshBasicMaterial({
        map: texture, transparent: true, depthWrite: false, opacity: 0,
      })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.006;   // just clear of the surface
    this.root.add(this.shadow);
  }

  _buildBody() {
    const torso = sphere(0.15, GREY);
    torso.scale.set(1, 1.15, 0.92);
    torso.position.y = 0.2;
    this.body.add(torso);
    this.torso = torso;

    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 16), mat(CREAM));
    belly.scale.set(1, 1.12, 0.8);
    belly.position.set(0, 0.19, 0.075);
    this.body.add(belly);

    // Feet: oversized, as tradition demands.
    for (const side of [-1, 1]) {
      const foot = sphere(0.055, GREY_DARK, 14);
      foot.scale.set(1, 0.7, 1.9);
      foot.position.set(side * 0.075, 0.045, 0.055);
      this.body.add(foot);
    }

    // Arms, parented so they can hold the carrot / wave a sign.
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.135, 0.26, 0.02);
      const arm = sphere(0.04, GREY, 12);
      arm.scale.set(1, 1.8, 1);
      arm.position.y = -0.055;
      pivot.add(arm);
      pivot.rotation.z = side * 0.25;
      this.body.add(pivot);
      this.arms.push(pivot);
    }

    const tail = sphere(0.05, CREAM, 12);
    tail.position.set(0, 0.2, -0.145);
    this.body.add(tail);
  }

  _buildHead() {
    const head = new THREE.Group();
    head.position.y = 0.42;
    this.body.add(head);
    this.head = head;

    const skull = sphere(0.105, GREY);
    skull.scale.set(1, 0.95, 1.05);
    head.add(skull);

    // Cheeks — the wide, smug muzzle.
    for (const side of [-1, 1]) {
      const cheek = sphere(0.052, CREAM, 14);
      cheek.position.set(side * 0.042, -0.032, 0.082);
      head.add(cheek);
    }

    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.019, 12, 12), mat(PINK));
    nose.position.set(0, 0.004, 0.118);
    head.add(nose);
    this.nose = nose;

    // Buck teeth: the single most important polygon budget in this project.
    const teeth = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.05, 0.014), mat(0xffffff));
    teeth.position.set(0, -0.052, 0.104);
    head.add(teeth);
    const gap = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.05, 0.004), mat(0xd8cfc0));
    gap.position.set(0, -0.052, 0.113);
    head.add(gap);

    // Eyes with lids we can drop into a half-lidded "really?" look.
    this.eyes = [];
    this.lids = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.026, 14, 14), mat(0xffffff));
      eye.position.set(side * 0.045, 0.032, 0.086);
      head.add(eye);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.013, 12, 12), mat(0x14141a));
      pupil.position.set(0, 0, 0.018);
      eye.add(pupil);
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.0275, 14, 10), mat(GREY));
      lid.position.copy(eye.position);
      lid.scale.y = 0.6;
      lid.position.y += 0.026;
      head.add(lid);
      this.eyes.push(eye);
      this.lids.push(lid);
    }

    // Ears on pivots so they can flop, perk and wiggle independently.
    this.ears = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.038, 0.085, -0.01);
      const ear = sphere(0.032, GREY, 14);
      ear.scale.set(0.62, 3.5, 0.5);
      ear.position.y = 0.105;
      const inner = new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 12), mat(PINK));
      inner.scale.set(0.5, 3.3, 0.45);
      inner.position.set(0, 0.105, 0.014);
      pivot.add(ear, inner);
      pivot.rotation.z = side * 0.16;
      head.add(pivot);
      this.ears.push(pivot);
    }
  }

  _buildCarrot() {
    const carrot = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.14, 10), mat(CARROT));
    body.rotation.x = Math.PI;         // tip pointing down
    carrot.add(body);
    for (let i = 0; i < 3; i++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.055, 6), mat(LEAF));
      leaf.position.set((i - 1) * 0.012, 0.088, 0);
      leaf.rotation.z = (i - 1) * 0.4;
      carrot.add(leaf);
    }
    carrot.position.set(0.13, 0.2, 0.06);
    carrot.rotation.z = -0.5;
    this.body.add(carrot);
    this.carrot = carrot;
  }

  /* ----------------------------------------------------------------- */
  /* placement                                                          */
  /* ----------------------------------------------------------------- */

  /**
   * Drop him at a cover spot, hidden, facing the player.
   *
   * @param {string} mode  how he enters view: 'surface' rises from behind,
   *   'corner' and 'door' lean out sideways past an edge.
   * @param {number} sideSign  which side he leans out from (-1 or 1).
   */
  placeAt(position, faceTowards, mode = 'surface', sideSign = 1) {
    this.root.position.copy(position);
    const look = new THREE.Vector3(faceTowards.x, position.y, faceTowards.z);
    this.root.lookAt(look);
    this.emergeMode = mode;
    this.sideSign = sideSign;
    this.setEmerge(0, true);
  }

  setEmerge(v, immediate = false) {
    this.targetEmerge = clamp(v, 0, 1);
    if (immediate) {
      this.emergeAmount = this.targetEmerge;
      this._applyEmerge();
    }
  }

  _applyEmerge() {
    const e = this.emergeAmount;

    if (this.emergeMode === 'surface') {
      // Sink below the cover plane so he reads as "ducking behind" it.
      this.body.position.set(0, lerp(-0.62, 0, e), 0);
      this.body.rotation.y = 0;
      this._peekLean = 0;
    } else {
      // Edges and doorways: slide out sideways past the obstruction and lean
      // his weight around it, which is how you actually peer around a corner.
      const hidden = 0.52 * this.sideSign;
      this.body.position.set(lerp(hidden, 0, e), 0, lerp(-0.1, 0, e));
      // Tip the body back toward cover so he looks ready to snap out of sight.
      this._peekLean = (1 - e) * 0.5 * this.sideSign;
      this.body.rotation.y = (1 - e) * 0.45 * this.sideSign;
    }

    this.body.visible = e > 0.015;
    this.root.visible = this.body.visible;
  }

  /** World-space point the player is meant to be shooting at. */
  aimPoint(target = new THREE.Vector3()) {
    return this.head.getWorldPosition(target);
  }

  get isUp() {
    return this.emergeAmount > 0.55;
  }

  /* ----------------------------------------------------------------- */
  /* states                                                             */
  /* ----------------------------------------------------------------- */

  setState(name) {
    this.state = name;
    this.stateTime = 0;
    if (name === 'peek') this.setEmerge(0.55);
    if (name === 'taunt') this.setEmerge(1);
    if (name === 'hide') this.setEmerge(0);
    if (name === 'chew') { this.setEmerge(1); this.chewing = true; }
    else this.chewing = name === 'taunt';
  }

  /** Snappy cartoon dodge — used the instant the player fires. */
  dodge(direction = Math.sign(rand(-1, 1)) || 1) {
    this.targetLean = direction * 1.15;
    this.squash = 0.78;
    this.setState('dodge');
  }

  update(dt, playerPos) {
    this.t += dt;
    this.stateTime += dt;

    this.emergeAmount = damp(this.emergeAmount, this.targetEmerge, 9, dt);
    this._applyEmerge();

    // Keep facing the hunter, lazily — he is never in a hurry.
    if (playerPos && this.emergeAmount > 0.05) {
      const dx = playerPos.x - this.root.position.x;
      const dz = playerPos.z - this.root.position.z;
      const want = Math.atan2(dx, dz);
      let delta = want - this.root.rotation.y;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.root.rotation.y += delta * (1 - Math.exp(-4 * dt));
    }

    // Idle breathing + ear sway.
    const breath = Math.sin(this.t * 3.1) * 0.012;
    this.torso.position.y = 0.2 + breath;
    this.head.position.y = 0.42 + breath * 1.4;

    for (let i = 0; i < this.ears.length; i++) {
      const side = i === 0 ? -1 : 1;
      const wiggle = Math.sin(this.t * 2.3 + i * 1.7) * 0.09;
      let base = side * 0.16;
      if (this.state === 'taunt') base = side * (0.16 + Math.sin(this.t * 9) * 0.35);
      if (this.state === 'peek') base = side * 0.05;      // ears flat, sneaking
      this.ears[i].rotation.z = damp(this.ears[i].rotation.z, base + wiggle, 8, dt);
      this.ears[i].rotation.x = Math.sin(this.t * 1.9 + i) * 0.06;
    }

    // Half-lidded smug look while taunting.
    const lidDrop = this.state === 'taunt' || this.state === 'chew' ? 0.014 : 0.026;
    for (const lid of this.lids) {
      lid.position.y = damp(lid.position.y, 0.032 + lidDrop, 10, dt);
    }

    // Chewing bobs the head and swings the carrot to his mouth.
    const carrotUp = this.chewing ? 1 : 0;
    this.carrot.position.x = damp(this.carrot.position.x, lerp(0.13, 0.055, carrotUp), 8, dt);
    this.carrot.position.y = damp(this.carrot.position.y, lerp(0.2, 0.37, carrotUp), 8, dt);
    this.carrot.rotation.z = damp(this.carrot.rotation.z, lerp(-0.5, -1.35, carrotUp), 8, dt);
    if (this.chewing) this.head.rotation.x = Math.sin(this.t * 14) * 0.05;
    else this.head.rotation.x = damp(this.head.rotation.x, 0, 8, dt);

    // Lean is the dodge; it springs back on its own.
    this.targetLean = damp(this.targetLean, 0, 5, dt);
    this.lean = damp(this.lean, this.targetLean, 16, dt);
    // `_applyEmerge` has already set the base pose for this frame, so the
    // dodge is added on top of it rather than replacing it.
    this.body.rotation.z = this.lean * 0.9 + (this._peekLean ?? 0);
    this.body.position.x += this.lean * 0.14;

    // Contact shadow: strongest and smallest when he is fully up and standing
    // on the surface, gone entirely once he is back behind cover.
    const e = this.emergeAmount;
    this.shadow.material.opacity = e * 0.85;
    const spread = lerp(1.25, 0.9, e);
    this.shadow.scale.set(spread, spread, 1);
    this.shadow.position.x = this.body.position.x;

    this.squash = damp(this.squash, 1, 7, dt);
    this.body.scale.set(1 / this.squash, this.squash, 1 / this.squash);

    // Peeking bob: he keeps bobbing in and out of cover to check on you.
    if (this.state === 'peek') {
      this.targetEmerge = 0.5 + Math.sin(this.stateTime * 2.4) * 0.16;
    }
  }

  dispose() {
    this.root.traverse((obj) => {
      obj.geometry?.dispose?.();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material?.dispose?.();
    });
  }
}
