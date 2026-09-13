import * as THREE from 'three';
import { clamp, damp, lerp, rand } from '../core/util.js';

/**
 * Reginald Warren, Esq. — built entirely from primitives so the game ships
 * with no model files. He is a stack of spheres in a waistcoat, and he is not
 * remotely worried about you.
 *
 * Local space: feet at y=0, facing +Z, roughly 0.62m tall standing.
 */

const BURGUNDY = 0x7d2233;
const BRASS = 0xc9a227;
const GREY = 0xa9adb4;
const GREY_LIGHT = 0xc6cad1;
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

/**
 * Fur, as far as a material can fake it.
 *
 * Sheen is three's cloth term: a soft, wide, desaturated highlight riding the
 * grazing angles of a surface. On a rounded body it reads as light catching
 * the tips of fur rather than as a hard plastic specular, and it is most of
 * the difference between something that looks moulded and something warm.
 */
function fur(color, opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: opts.roughness ?? 0.95,
    metalness: 0,
    sheen: 1,
    sheenRoughness: opts.sheenRoughness ?? 0.55,
    sheenColor: new THREE.Color(opts.sheenColor ?? 0xfff1de),
  });
}

/**
 * A soft inked edge so he reads against a real room.
 *
 * Pure black at full thickness is the cel-shading of twenty years ago; a thin
 * warm brown separates him from the camera feed without announcing itself.
 */
function outline(mesh, scale = 1.035) {
  const shell = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color: 0x3a2418, side: THREE.BackSide })
  );
  shell.scale.multiplyScalar(scale);
  mesh.add(shell);
  return mesh;
}

/**
 * A body of revolution from a profile curve.
 *
 * The old body was a stack of separate spheres and it looked it: everywhere
 * two of them met left a crease the eye reads as "assembled from parts".
 * Lathing a single profile gives one unbroken surface from feet to shoulders,
 * which is the biggest single step away from that.
 */
function lathe(profile, segments = 44) {
  const points = profile.map(([y, r]) => new THREE.Vector2(Math.max(r, 0.0001), y));
  const geometry = new THREE.LatheGeometry(points, segments);
  geometry.computeVertexNormals();
  return geometry;
}

/** A tuft of fur: a soft cone, used in clumps along a silhouette. */
function tuft(length, radius, material) {
  const geometry = new THREE.ConeGeometry(radius, length, 7, 1);
  geometry.translate(0, length / 2, 0);
  return new THREE.Mesh(geometry, material);
}

function sphere(r, color, segments = 24) {
  return new THREE.Mesh(new THREE.SphereGeometry(r, segments, segments), fur(color));
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
    this.jiggle = 0;
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
    /*
     * One pear, lathed. Widest low down, tapering to narrow shoulders, so the
     * weight reads as sitting in his middle rather than being a ball with
     * things stuck to it.
     */
    const torso = new THREE.Mesh(lathe([
      [0.00, 0.080], [0.03, 0.128], [0.07, 0.162], [0.12, 0.183],
      [0.17, 0.192], [0.23, 0.188], [0.29, 0.172], [0.35, 0.142],
      [0.40, 0.110], [0.44, 0.082], [0.47, 0.055], [0.49, 0.000],
    ]), fur(GREY));
    torso.scale.set(1, 1, 0.94);
    outline(torso, 1.03);
    this.body.add(torso);
    this.torso = torso;

    // A paler front, sunk into the body so there is no edge where it meets.
    const belly = new THREE.Mesh(lathe([
      [0.03, 0.058], [0.07, 0.096], [0.12, 0.120], [0.17, 0.126],
      [0.22, 0.118], [0.27, 0.096], [0.31, 0.062], [0.33, 0.000],
    ]), fur(CREAM, { sheenColor: 0xffffff }));
    belly.scale.set(1.05, 1, 0.55);
    belly.position.set(0, 0.012, 0.095);
    this.body.add(belly);
    this.belly = belly;

    // A waistcoat, because he is a gentleman, whatever else he may be.
    const waistcoat = new THREE.Mesh(
      new THREE.TorusGeometry(0.166, 0.034, 12, 32), mat(BURGUNDY, { roughness: 0.6 }));
    waistcoat.rotation.x = Math.PI / 2;
    waistcoat.position.set(0, 0.145, 0.005);
    waistcoat.scale.set(1.02, 1, 0.94);
    this.body.add(waistcoat);
    this.waistcoat = waistcoat;

    for (let i = 0; i < 3; i++) {
      const button = new THREE.Mesh(
        new THREE.SphereGeometry(0.0125, 12, 12), mat(BRASS, { roughness: 0.3 }));
      button.position.set(0, 0.232 - i * 0.04, 0.128 - i * 0.012);
      this.body.add(button);
    }

    // The ruff. Does the real work: it breaks the hard seam where a sphere
    // head meets a lathed body, and a fur silhouette is most of what makes
    // an animal look drawn rather than moulded.
    const ruffMat = fur(GREY_LIGHT, { sheenColor: 0xffffff });
    this.ruff = new THREE.Group();
    this.ruff.position.y = 0.415;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const t = tuft(rand(0.075, 0.105), 0.042, ruffMat);
      t.position.set(Math.cos(a) * 0.092, 0, Math.sin(a) * 0.088);
      // Splayed outward and down, like a collar that has given up.
      t.rotation.set(Math.sin(a) * 1.25, -a, -Math.cos(a) * 1.25);
      this.ruff.add(t);
    }
    this.body.add(this.ruff);

    // Feet, turned out. Nothing about him is parallel.
    this.feet = [];
    for (const side of [-1, 1]) {
      const foot = new THREE.Mesh(lathe([
        [0.00, 0.052], [0.02, 0.062], [0.05, 0.055], [0.07, 0.000],
      ], 20), fur(GREY_DARK));
      foot.scale.set(1, 1, 1.95);
      foot.position.set(side * 0.105, 0.018, 0.055);
      foot.rotation.y = side * 0.26;
      this.body.add(foot);
      this.feet.push(foot);
    }

    // Stubby arms that do not remotely reach around him.
    this.arms = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.158, 0.255, 0.035);
      const arm = new THREE.Mesh(lathe([
        [0.00, 0.030], [0.03, 0.044], [0.08, 0.042], [0.12, 0.032], [0.14, 0.000],
      ], 18), fur(GREY));
      arm.position.y = -0.13;
      arm.rotation.z = Math.PI;
      pivot.add(arm);
      const paw = sphere(0.036, GREY_LIGHT, 16);
      paw.position.y = -0.145;
      pivot.add(paw);
      pivot.rotation.z = side * 0.46;
      this.body.add(pivot);
      this.arms.push(pivot);
    }

    // Tail: a puff of tufts rather than one smooth ball.
    const tail = new THREE.Group();
    tail.position.set(0, 0.19, -0.19);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const t = tuft(0.06, 0.034, ruffMat);
      t.position.set(Math.cos(a) * 0.026, Math.sin(a) * 0.026, 0);
      t.rotation.set(Math.PI / 2 + rand(-0.3, 0.3), 0, -a);
      tail.add(t);
    }
    this.body.add(tail);
  }

  _buildHead() {
    const head = new THREE.Group();
    head.position.y = 0.50;
    // Nothing about an appealing character is square to the camera.
    head.rotation.z = 0.06;
    this.body.add(head);
    this.head = head;

    const skull = new THREE.Mesh(lathe([
      [-0.145, 0.000], [-0.120, 0.072], [-0.085, 0.122], [-0.035, 0.156],
      [0.015, 0.168], [0.065, 0.158], [0.105, 0.124], [0.135, 0.070],
      [0.150, 0.000],
    ]), fur(GREY));
    skull.scale.set(1.02, 1, 0.98);
    outline(skull, 1.03);
    head.add(skull);

    // Muzzle: one blended mass rather than two balls side by side.
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.088, 24, 20),
      fur(CREAM, { sheenColor: 0xffffff }));
    muzzle.scale.set(1.34, 0.78, 0.84);
    muzzle.position.set(0, -0.058, 0.112);
    head.add(muzzle);

    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.026, 16, 16),
      mat(PINK, { roughness: 0.35 }));
    nose.scale.set(1.25, 0.9, 0.9);
    nose.position.set(0, -0.022, 0.188);
    head.add(nose);
    this.nose = nose;

    const teeth = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.046, 0.015),
      mat(0xfdfdfa, { roughness: 0.3 }));
    teeth.position.set(0, -0.098, 0.168);
    teeth.rotation.x = 0.12;
    head.add(teeth);

    // Cheek tufts: fur that catches the light at the silhouette.
    const tuftMat = fur(GREY_LIGHT, { sheenColor: 0xffffff });
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const t = tuft(rand(0.038, 0.058), 0.013, tuftMat);
        t.position.set(side * 0.115, -0.075 + i * 0.028, 0.075 - i * 0.014);
        t.rotation.set(0.25 + i * 0.1, 0, side * (1.45 + i * 0.1));
        head.add(t);
      }
    }

    /*
     * Eyes, which are where appeal actually lives.
     *
     * The old ones were small white beads with a black dot. These are large
     * and glossy, with a coloured iris, a deep pupil and a bright catchlight
     * held off-centre — the catchlight in particular is what stops an eye
     * reading as a painted sphere.
     */
    this.eyes = [];
    this.lids = [];
    for (const side of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(side * 0.075, 0.038, 0.108);
      eye.rotation.y = side * 0.28;
      head.add(eye);

      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.052, 24, 24),
        new THREE.MeshPhysicalMaterial({
          color: 0xfbfaf7, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05,
        }));
      eye.add(ball);

      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.03, 20, 20),
        new THREE.MeshPhysicalMaterial({
          color: 0x8a5a24, roughness: 0.2, clearcoat: 1,
          emissive: 0x2a1605, emissiveIntensity: 0.4,
        }));
      iris.scale.set(1, 1, 0.5);
      iris.position.z = 0.035;
      eye.add(iris);

      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 16),
        mat(0x120c08, { roughness: 0.1 }));
      pupil.scale.set(1, 1, 0.5);
      pupil.position.z = 0.047;
      eye.add(pupil);

      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff }));
      spark.position.set(-0.017, 0.019, 0.049);
      eye.add(spark);

      // A heavy, unimpressed lid.
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.055, 20, 14),
        fur(GREY));
      lid.position.set(0, 0.038, 0);
      eye.add(lid);

      this.eyes.push(eye);
      this.lids.push(lid);
    }

    // Brows, which do more for expression than anything else on the face.
    this.brows = [];
    for (const side of [-1, 1]) {
      const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.0095, 0.072, 4, 8),
        fur(GREY_DARK));
      brow.position.set(side * 0.078, 0.112, 0.128);
      brow.rotation.set(0, 0, Math.PI / 2 + side * 0.22);
      head.add(brow);
      this.brows.push(brow);
    }

    // Ears on pivots so they can flop, perk and wiggle independently.
    // One sits up and one flops: symmetry is the enemy here.
    this.ears = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.058, 0.115, -0.018);
      const ear = new THREE.Mesh(lathe([
        [0.00, 0.018], [0.04, 0.034], [0.12, 0.040], [0.20, 0.034],
        [0.25, 0.022], [0.27, 0.000],
      ], 20), fur(GREY));
      ear.scale.set(0.72, 1, 0.5);
      outline(ear, 1.04);
      const inner = new THREE.Mesh(lathe([
        [0.02, 0.012], [0.05, 0.024], [0.12, 0.029], [0.19, 0.023],
        [0.23, 0.012], [0.245, 0.000],
      ], 18), fur(PINK, { sheenColor: 0xffd9e2 }));
      inner.scale.set(0.62, 1, 0.34);
      inner.position.z = 0.012;
      pivot.add(ear, inner);
      // Tufts at the base, where a real ear meets the head.
      for (let i = 0; i < 2; i++) {
        const t = tuft(0.03, 0.012, tuftMat);
        t.position.set(side * 0.026, -0.005, 0.02 - i * 0.03);
        t.rotation.set(1.1 - i * 0.3, 0, side * 1.1);
        pivot.add(t);
      }
      pivot.rotation.z = side * 0.16;
      head.add(pivot);
      this.ears.push(pivot);
    }
    // The left ear has given up and hangs.
    this.earFlop = [0.0, 1.0];

    // A monocle. Entirely impractical, which is rather the point.
    //
    // Parented to the eye rather than placed on the head, so it rings that eye
    // no matter how the head is tilted -- positioned by hand it drifted off
    // the face and read as a stray wire.
    const rightEye = this.eyes[1];
    const monocle = new THREE.Mesh(
      new THREE.TorusGeometry(0.062, 0.006, 10, 28), mat(BRASS, { roughness: 0.25 }));
    monocle.position.z = 0.03;
    rightEye.add(monocle);
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.058, 24),
      new THREE.MeshPhysicalMaterial({
        color: 0xdff0ff, transparent: true, opacity: 0.16,
        roughness: 0.05, clearcoat: 1,
      })
    );
    lens.position.z = 0.031;
    rightEye.add(lens);

    const chain = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0022, 0.0022, 0.17, 6), mat(BRASS));
    chain.position.set(0.135, -0.055, 0.115);
    chain.rotation.z = 0.5;
    head.add(chain);
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
    carrot.position.set(0.215, 0.185, 0.12);
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
    // Arriving anywhere sets the belly going.
    if (Math.abs(clamp(v, 0, 1) - this.targetEmerge) > 0.4) this.jiggle = 0.09;
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
    this.jiggle = 0.12;
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
    // Slower, deeper breathing: there is a lot of rabbit to move.
    const breath = Math.sin(this.t * 2.2) * 0.016;
    this.torso.position.y = breath;
    this.head.position.y = 0.50 + breath * 1.2;
    this.ruff.position.y = 0.415 + breath * 1.1;

    // The belly keeps moving after the rest of him has stopped.
    this.jiggle = damp(this.jiggle, 0, 3.4, dt);
    const wobble = Math.sin(this.t * 17) * this.jiggle;
    this.belly.scale.set(1 + wobble, 1 - wobble * 0.7, 0.62 + wobble * 0.4);
    this.waistcoat.scale.set(1.02 + wobble * 0.8, 1 - wobble * 0.5, 0.94);
    this.torso.scale.set(1 + wobble * 0.5, 1 - wobble * 0.4, 0.94 + wobble * 0.3);

    for (let i = 0; i < this.ears.length; i++) {
      const side = i === 0 ? -1 : 1;
      const flop = this.earFlop[i];
      const wiggle = Math.sin(this.t * 2.3 + i * 1.7) * 0.09 * (1 - flop * 0.6);
      let base = side * (0.16 + flop * 0.55);
      if (this.state === 'taunt') base += side * Math.sin(this.t * 9) * 0.3 * (1 - flop * 0.5);
      if (this.state === 'peek') base = side * (0.05 + flop * 0.5);
      this.ears[i].rotation.z = damp(this.ears[i].rotation.z, base + wiggle, 8, dt);
      // The flopped one hangs forward and swings a little behind the other.
      this.ears[i].rotation.x = damp(
        this.ears[i].rotation.x,
        flop * 0.85 + Math.sin(this.t * 1.9 + i) * 0.06,
        7, dt);
    }

    // Heavy lids, and brows that do the actual expression.
    const smug = this.state === 'taunt' || this.state === 'chew';
    const lidY = smug ? 0.016 : 0.038;
    for (const lid of this.lids) {
      lid.position.y = damp(lid.position.y, lidY, 10, dt);
    }
    for (let i = 0; i < this.brows.length; i++) {
      const side = i === 0 ? -1 : 1;
      // One brow lifts when he is enjoying himself. Never both.
      const raise = smug && side > 0 ? 0.022 : 0;
      this.brows[i].position.y = damp(this.brows[i].position.y, 0.112 + raise, 8, dt);
      this.brows[i].rotation.z = damp(
        this.brows[i].rotation.z,
        Math.PI / 2 + side * (0.22 + (smug && side > 0 ? 0.2 : 0)),
        8, dt);
    }

    // Chewing bobs the head and swings the carrot to his mouth.
    const carrotUp = this.chewing ? 1 : 0;
    this.carrot.position.x = damp(this.carrot.position.x, lerp(0.215, 0.075, carrotUp), 8, dt);
    this.carrot.position.y = damp(this.carrot.position.y, lerp(0.185, 0.335, carrotUp), 8, dt);
    this.carrot.rotation.z = damp(this.carrot.rotation.z, lerp(-0.5, -1.35, carrotUp), 8, dt);
    if (this.chewing) this.head.rotation.x = Math.sin(this.t * 14) * 0.05;
    else this.head.rotation.x = damp(this.head.rotation.x, 0, 8, dt);
    // A slight, permanent head tilt: square-to-camera is what made him read
    // as a model rather than a character.
    this.head.rotation.z = damp(
      this.head.rotation.z, smug ? 0.13 : 0.06, 6, dt);

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
