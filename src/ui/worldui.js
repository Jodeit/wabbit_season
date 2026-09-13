import * as THREE from 'three';

/**
 * In-world UI, for runtimes that cannot show the DOM inside a session.
 *
 * The whole HUD is DOM, composited over the camera by the `dom-overlay`
 * feature. That feature is a handheld-AR convenience and is not universal —
 * headset browsers commonly run `immersive-ar` without it. When it is missing,
 * every instruction, button and taunt silently disappears: the world renders
 * fine, so the game looks like it is working while being impossible to play.
 *
 * These panels are the fallback. Canvas textures on quads, billboarded to the
 * viewer, carrying the same words the DOM would have.
 */

const FONT = '"Trebuchet MS", "Gill Sans", system-ui, sans-serif';

function makePanel(widthPx, heightPx, worldWidth) {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(worldWidth, worldWidth * (heightPx / widthPx)),
    new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthTest: false, depthWrite: false,
    })
  );
  mesh.renderOrder = 100;       // UI is never hidden by the room
  mesh.visible = false;
  return { mesh, canvas, ctx: canvas.getContext('2d'), texture };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Word-wrap `text` to `maxWidth`, returning lines. */
function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

export class WorldUI {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.enabled = false;

    this.main = makePanel(1024, 512, 0.9);
    this.hudPanel = makePanel(1024, 200, 0.7);
    this.speech = makePanel(1024, 320, 0.7);

    // The main panel and HUD ride the camera; the speech bubble lives in the
    // world, above whoever is talking.
    camera.add(this.main.mesh);
    camera.add(this.hudPanel.mesh);
    this.main.mesh.position.set(0, -0.08, -1.3);
    this.hudPanel.mesh.position.set(0, 0.34, -1.3);
    scene.add(this.speech.mesh);

    this._speechAnchor = null;
    this._speechUntil = 0;

    /**
     * Buttons the controller can point at.
     *
     * A headset player has no keyboard, no touchscreen and no browser chrome
     * inside the session, so without something to aim at there is no way to
     * pause or start over — the only exit is taking the headset off.
     */
    this.buttons = [];
    this.buttonGroup = new THREE.Group();
    camera.add(this.buttonGroup);
    this.buttonGroup.position.set(0, -0.42, -1.3);
    this._hovered = null;
  }

  /** @param {Array<{label: string, action: Function}>} items */
  setButtons(items) {
    for (const b of this.buttons) {
      this.buttonGroup.remove(b.panel.mesh);
      b.panel.texture.dispose();
    }
    this.buttons = [];
    if (!this.enabled) return;

    const width = 0.34;
    const gap = 0.04;
    const total = items.length * width + (items.length - 1) * gap;
    items.forEach((item, i) => {
      const panel = makePanel(384, 160, width);
      panel.mesh.position.x = -total / 2 + width / 2 + i * (width + gap);
      panel.mesh.visible = true;
      this.buttonGroup.add(panel.mesh);
      const button = { ...item, panel };
      this.buttons.push(button);
      this._paintButton(button, false);
    });
  }

  _paintButton(button, hovered) {
    const { ctx, canvas, texture } = button.panel;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = hovered ? '#ef7a21' : 'rgba(20, 13, 5, 0.9)';
    roundRect(ctx, 6, 6, w - 12, h - 12, 28);
    ctx.fill();
    ctx.strokeStyle = hovered ? '#2a1a08' : 'rgba(246, 231, 200, 0.55)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.fillStyle = hovered ? '#21150a' : '#f6e7c8';
    ctx.font = `800 52px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(button.label, w / 2, h / 2, w - 50);
    ctx.textBaseline = 'alphabetic';
    texture.needsUpdate = true;
  }

  /**
   * Point a ray at the buttons. Returns the one under it, if any.
   * @param {THREE.Raycaster} raycaster
   */
  pick(raycaster) {
    if (!this.enabled || !this.buttons.length) return null;
    const meshes = this.buttons.map((b) => b.panel.mesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    const found = hit ? this.buttons.find((b) => b.panel.mesh === hit.object) : null;
    if (found !== this._hovered) {
      if (this._hovered) this._paintButton(this._hovered, false);
      if (found) this._paintButton(found, true);
      this._hovered = found ?? null;
    }
    return found ?? null;
  }

  /** Activate whatever is currently under the pointer. */
  press() {
    if (!this._hovered) return false;
    this._hovered.action();
    return true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) {
      this.main.mesh.visible = false;
      this.hudPanel.mesh.visible = false;
      this.speech.mesh.visible = false;
      this.setButtons([]);
    }
  }

  /** Big instruction panel: title, body, and a call to action. */
  show(title, body, prompt = '') {
    if (!this.enabled) return;
    const { ctx, canvas, texture } = this.main;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(20, 13, 5, 0.88)';
    roundRect(ctx, 8, 8, w - 16, h - 16, 40);
    ctx.fill();
    ctx.strokeStyle = 'rgba(246, 231, 200, 0.5)';
    ctx.lineWidth = 5;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ef7a21';
    ctx.font = `900 76px ${FONT}`;
    ctx.fillText(title, w / 2, 130, w - 120);

    ctx.fillStyle = '#f6e7c8';
    ctx.font = `500 48px ${FONT}`;
    const lines = wrap(ctx, body, w - 160);
    lines.slice(0, 4).forEach((line, i) => ctx.fillText(line, w / 2, 230 + i * 62));

    if (prompt) {
      ctx.fillStyle = '#9fe870';
      ctx.font = `800 44px ${FONT}`;
      ctx.fillText(prompt, w / 2, h - 60, w - 120);
    }

    texture.needsUpdate = true;
    this.main.mesh.visible = true;
  }

  hideMain() { this.main.mesh.visible = false; }

  /** Compact score strip during the hunt. */
  hud(score, shells, misses) {
    if (!this.enabled) return;
    const { ctx, canvas, texture } = this.hudPanel;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(20, 13, 5, 0.8)';
    roundRect(ctx, 8, 8, w - 16, h - 16, 34);
    ctx.fill();

    const cells = [['STYLE', score], ['SHELLS', shells], ['MISSES', misses]];
    ctx.textAlign = 'center';
    cells.forEach(([label, value], i) => {
      const x = (w / 3) * (i + 0.5);
      ctx.fillStyle = 'rgba(246, 231, 200, 0.6)';
      ctx.font = `700 30px ${FONT}`;
      ctx.fillText(label, x, 66);
      ctx.fillStyle = '#f6e7c8';
      ctx.font = `900 74px ${FONT}`;
      ctx.fillText(String(value), x, 148);
    });

    texture.needsUpdate = true;
    this.hudPanel.mesh.visible = true;
  }

  hideHud() { this.hudPanel.mesh.visible = false; }

  /** A speech bubble in the world, above `anchor`. */
  say(text, anchor, seconds = 2.6) {
    if (!this.enabled) return;
    const { ctx, canvas, texture } = this.speech;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#fdf3dd';
    roundRect(ctx, 8, 8, w - 16, h - 16, 48);
    ctx.fill();
    ctx.strokeStyle = '#2a1a08';
    ctx.lineWidth = 8;
    ctx.stroke();

    ctx.fillStyle = '#2a1a08';
    ctx.textAlign = 'center';
    ctx.font = `italic 800 58px ${FONT}`;
    const lines = wrap(ctx, text, w - 120);
    const top = h / 2 - ((lines.length - 1) * 70) / 2 + 20;
    lines.slice(0, 3).forEach((line, i) => ctx.fillText(line, w / 2, top + i * 70));

    texture.needsUpdate = true;
    this._speechAnchor = anchor;
    this._speechUntil = performance.now() + seconds * 1000;
    this.speech.mesh.visible = true;
  }

  update() {
    if (!this.enabled) return;
    if (this.speech.mesh.visible) {
      if (performance.now() > this._speechUntil) {
        this.speech.mesh.visible = false;
      } else if (this._speechAnchor) {
        this.speech.mesh.position.copy(this._speechAnchor).add(new THREE.Vector3(0, 0.5, 0));
        this.speech.mesh.quaternion.copy(
          this.camera.getWorldQuaternion(new THREE.Quaternion()));
      }
    }
  }
}
