import * as THREE from 'three';

/**
 * The real thing: an `immersive-ar` session with hit-testing against the
 * device's understanding of the room, plus DOM overlay so the HUD markup is
 * reused verbatim inside the headset/phone session.
 */
export class WebXRBackend {
  constructor(world, overlayRoot) {
    this.mode = 'webxr';
    this.world = world;
    this.overlayRoot = overlayRoot;
    this.session = null;
    this.hitTestSource = null;
    this.viewerSpace = null;
    this.refSpace = null;
    this.frameCallback = null;
    this.onEnd = null;
    this.lastHit = null;
    this.stickyHit = null;
    this.stickyHitAt = 0;
    this.hasHitTest = false;
    this.hasDomOverlay = false;
    this.refSpace = null;
    this._clock = new THREE.Clock();
  }

  async start() {
    const { renderer } = this.world;
    renderer.xr.enabled = true;

    const init = {
      requiredFeatures: ['local-floor'],
      optionalFeatures: [
        'hit-test', 'dom-overlay', 'light-estimation', 'anchors',
        // Real room geometry where the runtime has it: planes on Android
        // Chrome, a full scene mesh on headsets that do reconstruction.
        'plane-detection', 'mesh-detection',
      ],
      domOverlay: { root: this.overlayRoot },
    };

    let session;
    try {
      session = await navigator.xr.requestSession('immersive-ar', init);
    } catch (err) {
      // Some runtimes reject the whole session if any optional feature is
      // unknown to them; retry with the bare minimum before giving up.
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hit-test', 'dom-overlay'],
        domOverlay: { root: this.overlayRoot },
      });
    }

    this.session = session;
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);

    this.refSpace = renderer.xr.getReferenceSpace();

    /*
     * Whether the page's DOM is actually composited into the session.
     *
     * `dom-overlay` is a handheld-AR convenience and is not universal: headset
     * browsers commonly grant `immersive-ar` without it. Requesting it is not
     * the same as getting it, and when it is missing every button and caption
     * silently vanishes while the 3D scene keeps rendering -- the game looks
     * like it works and cannot be played.
     */
    this.hasDomOverlay = !!session.domOverlayState
      || !!session.enabledFeatures?.includes?.('dom-overlay');

    try {
      this.viewerSpace = await session.requestReferenceSpace('viewer');
      this.hitTestSource = await session.requestHitTestSource({ space: this.viewerSpace });
      this.hasHitTest = true;
    } catch {
      // No hit-test on this runtime (some headsets) — the game falls back to
      // placing cover at a fixed distance along the aim ray.
      this.hasHitTest = false;
    }

    session.addEventListener('end', () => {
      this.session = null;
      this.hitTestSource = null;
      this.onEnd?.();
    });

    renderer.setAnimationLoop((time, frame) => this._tick(time, frame));
    return this;
  }

  _tick(time, frame) {
    const dt = Math.min(this._clock.getDelta(), 0.1);
    this.lastHit = frame ? this._readHit(frame) : null;
    /*
     * Hold on to the most recent real hit.
     *
     * Standalone iOS WebXR browsers run their hit test against the geometry of
     * already-detected ARKit planes only, so aiming at a corner, a doorframe,
     * or anywhere a plane has not finished growing returns nothing at all --
     * and a tap in that instant would otherwise be thrown away with a "point
     * at a surface first" that the player had, in fact, just done.
     */
    if (this.lastHit) {
      this.stickyHit = this.lastHit;
      this.stickyHitAt = performance.now();
    }
    this.frameCallback?.(dt, { frame, hit: this.lastHit, refSpace: this.refSpace });
    this.world.renderer.render(this.world.scene, this.world.camera);
  }

  _readHit(frame) {
    if (!this.hitTestSource || !this.refSpace) return null;
    const results = frame.getHitTestResults(this.hitTestSource);
    if (!results.length) return null;
    const pose = results[0].getPose(this.refSpace);
    if (!pose) return null;

    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const position = new THREE.Vector3().setFromMatrixPosition(m);
    // Hit-test poses are oriented with +Y along the surface normal.
    const normal = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(m)).normalize();
    return { position, normal, real: true };
  }

  setFrameCallback(fn) { this.frameCallback = fn; }

  async stop() {
    this.world.renderer.setAnimationLoop(null);
    try { await this.session?.end(); } catch { /* already gone */ }
    this.session = null;
  }
}
