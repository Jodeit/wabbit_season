import * as THREE from 'three';
import { rand } from '../core/util.js';

/**
 * One-shot visual effects used by the gag table.
 *
 * Screen shake is deliberately *not* done by moving the camera: in WebXR the
 * camera pose belongs to the device, and yanking it around is both ignored
 * and nauseating. Instead the gun rocks and the DOM overlay jolts.
 */

function textTexture(text, { bg = '#fdf3dd', fg = '#2a1a08', size = 256 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, size - 10, size - 10);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = String(text).split('\n');
  const fontSize = Math.floor(size / (1.6 + lines.length * 0.75));
  ctx.font = `900 ${fontSize}px "Trebuchet MS", sans-serif`;
  lines.forEach((line, i) => {
    ctx.fillText(line, size / 2, size / 2 + (i - (lines.length - 1) / 2) * fontSize * 1.05, size - 30);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  /**
   * @param {object} ctx - { scene, camera, shotgun, wabbit, cover, overlay }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.particles = [];
    this.temporary = [];     // objects with a lifetime, removed on expiry
    this.shakeAmount = 0;
    this.sign = null;
  }

  /* ---------------- particles ---------------- */

  _addParticle(mesh, vel, life, opts = {}) {
    mesh.userData = { vel, life: 0, max: life, gravity: opts.gravity ?? 0, fade: opts.fade ?? true, spin: opts.spin ?? 0 };
    this.ctx.scene.add(mesh);
    this.particles.push(mesh);
    return mesh;
  }

  /**
   * Buckshot. Where it goes is pure theatre — the outcome was decided before
   * the pellets left the barrel.
   */
  pellets(opts = {}) {
    const { shotgun, wabbit } = this.ctx;
    const ray = shotgun.getAimRay();
    const geo = new THREE.SphereGeometry(0.011, 6, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.35, metalness: 0.9 });

    const count = opts.ricochet ? 5 : 9;
    for (let i = 0; i < count; i++) {
      const dir = ray.direction.clone();

      if (opts.toWabbit && wabbit) {
        // Straight into his teeth.
        dir.copy(wabbit.aimPoint().sub(ray.origin).normalize());
      } else if (opts.deflect) {
        dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), rand(-0.9, 0.9));
        dir.y += rand(0.2, 0.7);
      } else if (opts.high) {
        dir.y += rand(0.22, 0.5);
      } else if (opts.low) {
        dir.y -= rand(0.22, 0.5);
      } else if (opts.wide) {
        dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), rand(-0.45, 0.45));
        dir.y += rand(-0.2, 0.25);
      } else if (opts.ricochet) {
        dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), rand(-0.3, 0.3));
      } else {
        dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), rand(-0.1, 0.1));
      }
      dir.normalize();

      const pellet = new THREE.Mesh(geo, mat);
      pellet.position.copy(ray.origin);
      this._addParticle(pellet, dir.multiplyScalar(rand(9, 14)), rand(0.5, 0.9), { gravity: -3.5 });
    }

    if (opts.ricochet) {
      // Send a couple straight back at the hunter for the bonk.
      setTimeout(() => this._ricochetBack(), 260);
    }
  }

  _ricochetBack() {
    const { camera } = this.ctx;
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    const geo = new THREE.SphereGeometry(0.012, 6, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.3, metalness: 0.9 });
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(geo, mat);
      p.position.copy(camPos).add(new THREE.Vector3(rand(-1.2, 1.2), rand(-0.4, 0.9), rand(-1.6, -0.8))
        .applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion())));
      const toward = camPos.clone().sub(p.position).normalize().multiplyScalar(rand(5, 8));
      this._addParticle(p, toward, 0.45);
    }
  }

  /** Grey puff where something got hit that isn't a wabbit. */
  dust() {
    const { shotgun } = this.ctx;
    const ray = shotgun.getAimRay();
    const at = ray.origin.clone().addScaledVector(ray.direction, rand(1.5, 3));
    const geo = new THREE.SphereGeometry(0.05, 8, 8);
    for (let i = 0; i < 5; i++) {
      const puff = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0xcfc7b8, transparent: true, opacity: 0.55, depthWrite: false,
      }));
      puff.position.copy(at).add(new THREE.Vector3(rand(-0.1, 0.1), rand(-0.1, 0.1), rand(-0.1, 0.1)));
      this._addParticle(puff, new THREE.Vector3(rand(-0.5, 0.5), rand(0.2, 0.9), rand(-0.5, 0.5)), 0.9);
    }
  }

  /** He spits the buckshot back out, one pellet at a time. */
  spit() {
    const { wabbit, camera } = this.ctx;
    if (!wabbit) return;
    const from = wabbit.aimPoint();
    const toward = camera.getWorldPosition(new THREE.Vector3()).sub(from).normalize();
    const geo = new THREE.SphereGeometry(0.012, 6, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.3, metalness: 0.9 });
    for (let i = 0; i < 6; i++) {
      setTimeout(() => {
        const p = new THREE.Mesh(geo, mat);
        p.position.copy(from);
        const dir = toward.clone().add(new THREE.Vector3(rand(-0.3, 0.3), rand(0, 0.4), rand(-0.3, 0.3)));
        this._addParticle(p, dir.normalize().multiplyScalar(rand(3, 5)), 1.1, { gravity: -6 });
      }, i * 110);
    }
  }

  /** Cartoon stars orbiting the player's own head. */
  stars() {
    const { camera } = this.ctx;
    const tex = textTexture('★', { bg: 'rgba(0,0,0,0)', fg: '#ffd23f', size: 128 });
    const group = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      sprite.scale.setScalar(0.09);
      sprite.userData.phase = (i / 6) * Math.PI * 2;
      group.add(sprite);
    }
    group.position.set(0, 0.16, -0.42);
    camera.add(group);
    this._addTemporary(group, 2.4, (obj, k) => {
      for (const s of obj.children) {
        const a = s.userData.phase + k * 9;
        s.position.set(Math.cos(a) * 0.2, Math.sin(a * 1.7) * 0.045, Math.sin(a) * 0.12);
        s.material.opacity = 1 - k;
      }
    }, () => camera.remove(group));
  }

  /** Powder-burn vignette across the whole overlay. */
  soot() {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '3',
      background: 'radial-gradient(circle at 50% 52%, rgba(0,0,0,0) 22%, rgba(28,20,10,.82) 62%)',
      transition: 'opacity 1.6s ease',
    });
    this.ctx.overlay.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 900);
    setTimeout(() => el.remove(), 2700);
  }

  /** Jolt the overlay and rock the gun. */
  shake(amount = 1) {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
    const overlay = this.ctx.overlay;
    const kick = () => {
      const x = rand(-1, 1) * 8 * amount;
      const y = rand(-1, 1) * 8 * amount;
      overlay.style.transform = `translate(${x}px, ${y}px)`;
    };
    let n = 0;
    const id = setInterval(() => {
      kick();
      if (++n > 8) { clearInterval(id); overlay.style.transform = ''; }
    }, 34);
  }

  /** The wabbit holds up a hand-lettered sign. */
  showSign(text) {
    const { wabbit } = this.ctx;
    if (!wabbit) return;
    if (this.sign) {
      this.sign.material.map?.dispose();
      this.sign.material.map = textTexture(text);
      this.sign.material.needsUpdate = true;
      return;
    }
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.3),
      new THREE.MeshBasicMaterial({ map: textTexture(text), transparent: true, side: THREE.DoubleSide })
    );
    const stick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.008, 0.18, 6),
      new THREE.MeshStandardMaterial({ color: 0x8a5a2a })
    );
    stick.position.y = -0.22;
    plane.add(stick);
    plane.position.set(0.14, 0.62, 0.14);
    wabbit.body.add(plane);
    this.sign = plane;
    plane.scale.setScalar(0.01);

    this._addTemporary(plane, 3.2, (obj, k) => {
      const grow = Math.min(1, k * 8);
      obj.scale.setScalar(grow * (k > 0.9 ? (1 - k) * 10 : 1));
      obj.rotation.z = Math.sin(k * 14) * 0.08;
      obj.lookAt(this.ctx.camera.getWorldPosition(new THREE.Vector3()));
    }, () => {
      wabbit.body.remove(plane);
      plane.material.map?.dispose();
      plane.material.dispose();
      plane.geometry.dispose();
      this.sign = null;
    });
  }

  /** A flat cardboard wabbit tips over where the real one was standing. */
  decoyFall() {
    const { wabbit, scene } = this.ctx;
    if (!wabbit) return;
    const tex = textTexture('🐰', { bg: '#d9b483', fg: '#2a1a08', size: 256 });
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.5),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true })
    );
    wabbit.root.getWorldPosition(board.position);
    board.position.y += 0.28;
    board.quaternion.copy(wabbit.root.getWorldQuaternion(new THREE.Quaternion()));
    scene.add(board);
    wabbit.setState('hide');

    this._addTemporary(board, 1.6, (obj, k) => {
      obj.rotation.x = -k * k * 1.5;
      obj.position.y -= 0.004;
    }, () => {
      scene.remove(board);
      tex.dispose();
      board.material.dispose();
      board.geometry.dispose();
    });
  }

  /** Lipstick print, left on the muzzle where the bead used to be. */
  kissMark() {
    const { shotgun } = this.ctx;
    const tex = textTexture('💋', { bg: 'rgba(0,0,0,0)', fg: '#c02a4a', size: 128 });
    const decal = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    decal.scale.setScalar(0.06);
    decal.position.copy(shotgun.muzzle.position);
    shotgun.model.add(decal);
    this._addTemporary(decal, 3.0, (obj, k) => { obj.material.opacity = 1 - Math.max(0, k - 0.7) / 0.3; },
      () => {
        shotgun.model.remove(decal);
        tex.dispose();
        decal.material.dispose();
      });
  }

  /**
   * A door that swings open, holds while he is out, then closes behind him.
   * Hinged on the opposite side to the one he leans out from, so the door
   * never swings through the wabbit.
   */
  showDoor(spot, holdSeconds = 3) {
    const { scene, camera } = this.ctx;
    const width = 0.78;
    const height = 1.98;
    const hingeSign = -(spot.sideSign ?? 1);

    const hinge = new THREE.Group();
    hinge.position.copy(spot.position);
    hinge.position.y = this.ctx.cover?.floorY ?? 0;
    // Stand the hinge up facing the player, then step it out to the door edge.
    const toCamera = camera.getWorldPosition(new THREE.Vector3()).sub(hinge.position);
    hinge.rotation.y = Math.atan2(toCamera.x, toCamera.z);
    hinge.translateX(hingeSign * (width / 2));

    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, 0.04),
      new THREE.MeshStandardMaterial({ color: 0xb9a184, roughness: 0.85, metalness: 0 })
    );
    panel.position.set(-hingeSign * (width / 2), height / 2, 0);
    hinge.add(panel);

    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.9 })
    );
    knob.position.set(-hingeSign * (width * 0.82), height * 0.46, 0.04);
    hinge.add(knob);

    scene.add(hinge);

    const openFor = Math.max(1.2, holdSeconds);
    const total = openFor + 1.2;
    const swing = (Math.PI / 2) * 1.05 * hingeSign;

    const baseYaw = hinge.rotation.y;

    this._addTemporary(hinge, total, (obj, k) => {
      const t = k * total;
      let amount;
      if (t < 0.6) amount = t / 0.6;                       // swing open
      else if (t < total - 0.6) amount = 1;                // held open
      else amount = Math.max(0, (total - t) / 0.6);        // swing shut
      obj.rotation.y = baseYaw + swing * amount;
    }, () => {
      scene.remove(hinge);
      hinge.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    });
    return hinge;
  }

  /* ---------------- plumbing ---------------- */

  _addTemporary(object, life, onUpdate, onDone) {
    this.temporary.push({ object, life, t: 0, onUpdate, onDone });
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const d = p.userData;
      d.life += dt;
      if (d.life >= d.max) {
        this.ctx.scene.remove(p);
        if (p.material.map) p.material.map.dispose();
        p.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      d.vel.y += d.gravity * dt;
      p.position.addScaledVector(d.vel, dt);
      if (d.fade && p.material.transparent) {
        p.material.opacity = 1 - d.life / d.max;
      }
    }

    for (let i = this.temporary.length - 1; i >= 0; i--) {
      const item = this.temporary[i];
      item.t += dt;
      const k = Math.min(1, item.t / item.life);
      item.onUpdate?.(item.object, k);
      if (item.t >= item.life) {
        item.onDone?.();
        this.temporary.splice(i, 1);
      }
    }

    this.shakeAmount = Math.max(0, this.shakeAmount - dt * 2);
  }

  clear() {
    for (const p of this.particles) {
      this.ctx.scene.remove(p);
      p.material?.dispose?.();
    }
    this.particles.length = 0;
    for (const item of this.temporary) item.onDone?.();
    this.temporary.length = 0;
    this.ctx.overlay.style.transform = '';
  }
}

export { textTexture };
