import * as THREE from 'three';

/**
 * Renderer, scene and camera shared by both AR backends.
 *
 * The canvas is transparent in every mode: in WebXR the compositor puts the
 * real world behind it, and in the camera fallback a <video> element does the
 * same job. Nothing here should ever clear to an opaque colour.
 */
export function createWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearAlpha(0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(
    68, window.innerWidth / window.innerHeight, 0.02, 60);
  camera.position.set(0, 1.6, 0);
  scene.add(camera);

  // Lighting that flatters cartoon primitives without a real-world probe:
  // soft sky/ground fill, one key from above-front, one cool rim from behind.
  const hemi = new THREE.HemisphereLight(0xfff4e0, 0x40372c, 1.5);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff0d6, 1.6);
  key.position.set(1.4, 3.2, 1.8);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xbcd8ff, 0.7);
  rim.position.set(-1.8, 1.4, -2.2);
  scene.add(rim);

  // The key light comes from the room; the view model faces away from it and
  // would otherwise render as a black slab. This one rides the camera.
  const viewLight = new THREE.DirectionalLight(0xffffff, 1.1);
  viewLight.position.set(0.4, 0.6, 1);
  camera.add(viewLight);
  camera.add(viewLight.target);
  viewLight.target.position.set(0, -0.3, -1);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));

  return { renderer, scene, camera, hemi, key, rim, viewLight, resize };
}
