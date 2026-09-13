import * as THREE from 'three';
import { Vision } from './vision.js';

/**
 * Camera-passthrough fallback for devices with no `immersive-ar`.
 *
 * This exists mostly for iPhone: Safari still ships no WebXR AR session, so
 * the only way to put a wabbit in your kitchen on an iPhone is to composite
 * WebGL over a live `getUserMedia` feed and drive the camera from the gyro.
 *
 * There is no depth sensing here, so "scanning" becomes an estimate: the
 * reticle ray is intersected with an assumed floor plane, which is accurate
 * enough for furniture-height cover in a normal room.
 */

const DEFAULT_EYE_HEIGHT = 1.55;
/** How far down the reticle ray an un-sensed surface is assumed to be (metres). */
const MAX_REACH = 3.0;

export class FallbackBackend {
  constructor(world, videoEl) {
    this.mode = 'fallback';
    this.world = world;
    this.video = videoEl;
    this.stream = null;
    this.frameCallback = null;
    this.onEnd = null;
    this.hasHitTest = false;
    this.hasDomOverlay = true;
    this.eyeHeight = DEFAULT_EYE_HEIGHT;
    this.lastHit = null;

    this._clock = new THREE.Clock();
    this._running = false;
    this._orientation = { alpha: 0, beta: 0, gamma: 0, screen: 0, got: false };
    this._onDeviceOrientation = this._onDeviceOrientation.bind(this);
    this._raycaster = new THREE.Raycaster();
    /** Reads geometry out of the camera image; Safari has nothing else. */
    this.vision = new Vision(videoEl);
    this._surfaceMesh = null;
    this._floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  }

  /**
   * Must be called from a user gesture on iOS.
   *
   * Order matters here. `DeviceOrientationEvent.requestPermission()` requires
   * transient user activation, and awaiting `getUserMedia` first spends it on
   * the camera prompt -- so asking for the camera before the gyroscope loses
   * head tracking entirely on iOS. The gyroscope is asked for first, while the
   * tap that started the session is still fresh.
   */
  async start() {
    await this._startOrientation();
    await this._startCamera();

    this.world.camera.position.set(0, this.eyeHeight, 0);
    this._running = true;
    this.world.renderer.setAnimationLoop(() => this._tick());
    return this;
  }

  async _startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('NO_CAMERA_API');
    }
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err?.name === 'NotAllowedError') throw new Error('CAMERA_DENIED');
      // Retry without the facing-mode preference (desktop webcams, etc).
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }
    this.video.srcObject = this.stream;
    this.video.classList.add('live');
    await this.video.play().catch(() => { /* autoplay policies; muted+playsinline covers it */ });
  }

  async _startOrientation() {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return;                     // desktop: camera stays fixed forward

    if (typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') return;    // playable, just not head-tracked
      } catch {
        return;
      }
    }
    window.addEventListener('deviceorientation', this._onDeviceOrientation, true);
  }

  _onDeviceOrientation(e) {
    if (e.alpha === null && e.beta === null && e.gamma === null) return;
    this._orientation.alpha = e.alpha || 0;
    this._orientation.beta = e.beta || 0;
    this._orientation.gamma = e.gamma || 0;
    this._orientation.screen = (screen.orientation?.angle ?? window.orientation ?? 0);
    this._orientation.got = true;
  }

  /** Device orientation angles -> camera quaternion (Z-X'-Y'' intrinsic). */
  _applyOrientation() {
    if (!this._orientation.got) return;
    const d2r = Math.PI / 180;
    const alpha = this._orientation.alpha * d2r;
    const beta = this._orientation.beta * d2r;
    const gamma = this._orientation.gamma * d2r;
    const orient = this._orientation.screen * d2r;

    const euler = new THREE.Euler(beta, alpha, -gamma, 'YXZ');
    const q = new THREE.Quaternion().setFromEuler(euler);
    // Device frame looks along -Z when flat; rotate so "holding it up" faces forward.
    q.multiply(new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)));
    // Compensate for the screen being rotated in the user's hand.
    q.multiply(new THREE.Quaternion(0, 0, -Math.sin(orient / 2), Math.cos(orient / 2)));

    this.world.camera.quaternion.copy(q);
  }

  _tick() {
    const dt = Math.min(this._clock.getDelta(), 0.1);
    this._applyOrientation();
    this.lastHit = this._estimateHit();
    this.frameCallback?.(dt, { frame: null, hit: this.lastHit, refSpace: null });
    this.world.renderer.render(this.world.scene, this.world.camera);
  }

  /**
   * No depth data, so the surface has to be guessed from where the player is
   * looking.
   *
   * Intersecting the floor plane alone is wrong for furniture: pointing at a
   * kitchen island from across the room is only a shallow downward angle, and
   * that ray sails over the island to land on the floor well behind it. So the
   * ray is clamped to arm's-reach-plus room distance, and the floor only wins
   * when it is nearer than that clamp — i.e. when you really are looking down
   * at the floor in front of you.
   */
  _estimateHit() {
    const camera = this.world.camera;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    return this._estimateAlong(dir);
  }

  _estimateAlong(dir) {
    const camera = this.world.camera;
    const origin = camera.getWorldPosition(new THREE.Vector3());

    // Anything the image has already told us about beats a guess.
    if (this._surfaceMesh?.geometry?.getAttribute('position')) {
      this._raycaster.set(origin, dir);
      const hit = this._raycaster.intersectObject(this._surfaceMesh, false)[0];
      if (hit) {
        return {
          position: hit.point.clone(),
          normal: hit.face
            ? hit.face.normal.clone().transformDirection(this._surfaceMesh.matrixWorld)
            : new THREE.Vector3(0, 1, 0),
          real: false,
          inferred: true,
        };
      }
    }

    const ray = new THREE.Ray(origin, dir);
    const floorPoint = new THREE.Vector3();
    const meetsFloor = dir.y < -0.02 && ray.intersectPlane(this._floorPlane, floorPoint);
    const floorDistance = meetsFloor ? origin.distanceTo(floorPoint) : Infinity;

    if (floorDistance <= MAX_REACH) {
      return { position: floorPoint, normal: new THREE.Vector3(0, 1, 0), real: false };
    }

    // Furniture: place at the clamped distance and treat the surface as facing
    // the player, which is what "he pops up from behind it" needs.
    const position = origin.clone().addScaledVector(dir, MAX_REACH);
    position.y = Math.max(position.y, this._floorPlane.constant);
    const normal = dir.clone().negate();
    normal.y = 0;
    if (normal.lengthSq() < 1e-4) normal.set(0, 1, 0);
    normal.normalize();
    return { position, normal, real: false };
  }

  setFrameCallback(fn) { this.frameCallback = fn; }

  async stop() {
    this._running = false;
    this.world.renderer.setAnimationLoop(null);
    window.removeEventListener('deviceorientation', this._onDeviceOrientation, true);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.video.classList.remove('live');
    this.onEnd?.();
  }
}
