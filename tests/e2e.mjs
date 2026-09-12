/**
 * End-to-end smoke test for Wabbit Season.
 *
 * Drives the whole game in headless Chromium with a fake camera: capability
 * probe -> room scan -> hunt -> results, plus a pass that forces every gag in
 * the table to run so a typo in one of them cannot ship unnoticed.
 *
 *   npm test          (starts its own static server)
 *   BASE=http://host:port node tests/e2e.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
};

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const file = join(ROOT, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const own = process.env.BASE ? null : await startServer();
const BASE = process.env.BASE ?? own.base;

const errors = [];
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',
    '--use-gl=swiftshader',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, permissions: ['camera'], hasTouch: true, isMobile: true,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

try {
  console.log('\n• boot');
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  check('three.js and game modules load', await page.evaluate(() => !!window.WabbitSeason));
  check('title screen is shown', await page.isVisible('#screen-title'));
  check('capability probe reports a mode',
    /camera mode|Full AR ready/.test(await page.textContent('#support-line')),
    (await page.textContent('#support-line')).slice(0, 48));

  console.log('\n• session start');
  await page.click('#btn-start');
  await page.waitForTimeout(1200);
  check('scan screen is shown', await page.isVisible('#screen-scan'));
  check('camera passthrough is live',
    await page.evaluate(() => document.querySelector('#passthrough').classList.contains('live')));
  check('other screens stay hidden',
    await page.evaluate(() => getComputedStyle(document.querySelector('#screen-title')).display === 'none'));

  console.log('\n• surface estimation');
  const heights = await page.evaluate(() => {
    const { world } = window.WabbitSeason;
    const out = {};
    for (const deg of [-60, -12]) {
      world.camera.rotation.set((deg * Math.PI) / 180, 0, 0, 'YXZ');
      world.camera.updateMatrixWorld(true);
      out[deg] = +window.WabbitSeason.scanBackendHit().position.y.toFixed(2);
    }
    return out;
  });
  check('steep look-down lands on the floor', heights['-60'] < 0.1, `y=${heights['-60']}m`);
  check('shallow look-down lands at furniture height',
    heights['-12'] > 0.6 && heights['-12'] < 1.3, `y=${heights['-12']}m`);

  console.log('\n• marking cover (constrained sweep, as if lying in bed)');
  // Deliberately sweep only ~90 degrees. A player propped up in bed cannot
  // spin around, and the scan must still be completable from that arc.
  const ARC = Math.PI / 2;
  const kinds = ['surface', 'corner', 'door'];
  for (let i = 0; i < 12; i++) {
    await page.evaluate((y) => {
      const cam = window.WabbitSeason.world.camera;
      cam.rotation.set(-0.35, y, 0, 'YXZ');
      cam.updateMatrixWorld(true);
    }, -ARC / 2 + (i / 11) * ARC);
    await page.waitForTimeout(110);
    if (i % 4 === 0) {
      await page.click(`.kind[data-kind="${kinds[i / 4]}"]`);
      await page.mouse.move(195, 500);
      await page.mouse.down();
      await page.waitForTimeout(60);
      await page.mouse.up();
      await page.waitForTimeout(120);
    }
  }
  const marked = await page.evaluate(() => window.WabbitSeason.cover.count);
  check('taps on the canvas mark cover spots', marked >= 2, `${marked} spots`);
  check('spots are given furniture names',
    await page.evaluate(() => window.WabbitSeason.cover.spots.every((s) => !!s.label)));

  const spotKinds = await page.evaluate(() =>
    window.WabbitSeason.cover.spots.map((s) => `${s.kind}:${s.label}`));
  console.log(`        ${spotKinds.join('  |  ')}`);
  check('all three cover kinds can be marked',
    new Set(spotKinds.map((k) => k.split(':')[0])).size === 3);

  const meterPct = parseInt(
    await page.evaluate(() => document.querySelector('#scan-meter').style.width), 10);
  check('a ~90-degree sweep can still fill the meter', meterPct >= 100, `${meterPct}%`);
  check('start button unlocks', !(await page.isDisabled('#btn-scan-done')));

  // The bar is labelled "Scanning", so it must measure the sweep alone. It
  // used to be 70% weighted on marks and so capped at 30% before any were
  // made, stranding players who were sweeping to fill an already-full scan.
  const unmarked = await page.evaluate(() => {
    const { scan, cover } = window.WabbitSeason;
    const saved = cover.spots.slice();
    cover.spots.length = 0;
    scan._updateMeter();
    const pct = parseInt(document.querySelector('#scan-meter').style.width, 10);
    const hint = !document.querySelector('#tap-hint').hidden;
    const label = document.querySelector('#btn-scan-done').textContent;
    cover.spots.push(...saved);
    scan._updateMeter();
    return { pct, hint, label };
  });
  check('a finished sweep reads 100% with nothing marked yet',
    unmarked.pct >= 100, `${unmarked.pct}%`);
  check('the tap-to-mark prompt appears when nothing is marked', unmarked.hint);
  // The locked button should say what is happening and how far along it is,
  // rather than sitting there greyed out with no explanation.
  check('the locked button explains itself rather than just disabling',
    /of \d/.test(unmarked.label) && unmarked.label.length < 34, `"${unmarked.label}"`);

  console.log('\n• scan readout');
  const readout = await page.evaluate(() => ({
    text: document.querySelector('#scan-readout').textContent,
    cls: document.querySelector('#scan-readout').className,
    points: window.WabbitSeason.scanMesh.pointCount,
    visible: window.WabbitSeason.scanMesh.group.visible,
  }));
  console.log(`        "${readout.text}"`);
  check('the scan overlay is drawn', readout.visible);
  // Estimated surfaces are guesses, not measurements. Plotting them as points
  // would scatter dots through mid-air and read as a scan of nothing.
  check('no patches are drawn without a depth sensor', readout.points === 0,
    `${readout.points} points`);
  check('the assumed floor is drawn instead',
    await page.evaluate(() => window.WabbitSeason.scanMesh.assumedFloor.visible));
  check('estimated surfaces are reported as estimated, not sensed',
    /estimated/.test(readout.text) && readout.cls.includes('estimated'), readout.cls);

  // A device that really senses surfaces does get a point cloud.
  const sensedCloud = await page.evaluate(() => {
    const { scanMesh } = window.WabbitSeason;
    const T = window.__THREE;
    // A contiguous patch of wall, not a scattered line: isolated samples have
    // no neighbours to join to and correctly produce no surface.
    const n = new T.Vector3(0, 0, 1);
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 3; y++) {
        scanMesh.addPoint(new T.Vector3(x * 0.07, 0.6 + y * 0.07, -2), true, n);
      }
    }
    return {
      points: scanMesh.pointCount,
      text: scanMesh.describe(),
      floor: scanMesh.assumedFloor.visible,
    };
  });
  console.log(`        "${sensedCloud.text}"`);
  check('sensed surfaces do build a surface', sensedCloud.points === 12,
    `${sensedCloud.points} cells`);
  check('sensed surface is reported as area mapped', /m² of surface mapped/.test(sensedCloud.text));
  check('sensed surface is triangulated, not drawn as dots',
    await page.evaluate(() => {
      const { scanMesh } = window.WabbitSeason;
      scanMesh.rebuild();
      const pos = scanMesh.surface.geometry.getAttribute('position');
      return !!pos && pos.count > 0 && !!scanMesh.surfaceGeometry;
    }));

  // The real-geometry path cannot run in headless Chromium (no XR runtime), so
  // feed it a synthetic XRFrame shaped like the spec to prove it wires up.
  const planes = await page.evaluate(() => {
    const { scanMesh } = window.WabbitSeason;
    const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const mkPlane = (z) => ({
      planeSpace: { id: z },
      lastChangedTime: 1,
      polygon: [{x:-1,y:0,z:-1},{x:1,y:0,z:-1},{x:1,y:0,z:1},{x:-1,y:0,z:1}],
    });
    const frame = {
      detectedPlanes: new Set([mkPlane(1), mkPlane(2)]),
      getPose: () => ({ transform: { matrix: identity } }),
    };
    scanMesh.syncXRGeometry(frame, {});
    return { count: scanMesh.planeCount, source: scanMesh.source, desc: scanMesh.describe() };
  });
  console.log(`        "${planes.desc}"`);
  check('the assumed floor is dropped once real geometry arrives',
    !(await page.evaluate(() => {
      const { scanMesh } = window.WabbitSeason;
      scanMesh.setAssumedFloor(0, { x: 0, z: 0 });
      return scanMesh.assumedFloor.visible;
    })));
  check('detected planes are drawn as real geometry',
    planes.count === 2 && planes.source === 'planes', JSON.stringify(planes));

  const meshed = await page.evaluate(() => {
    const { scanMesh } = window.WabbitSeason;
    const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    const frame = {
      detectedMeshes: new Set([{
        meshSpace: { id: 'm' },
        lastChangedTime: 1,
        vertices: new Float32Array([0,0,0, 1,0,0, 0,1,0]),
        indices: new Uint32Array([0,1,2]),
      }]),
      getPose: () => ({ transform: { matrix: identity } }),
    };
    scanMesh.syncXRGeometry(frame, {});
    return { count: scanMesh.planeCount, source: scanMesh.source, desc: scanMesh.describe() };
  });
  console.log(`        "${meshed.desc}"`);
  check('a scene mesh is drawn as a wireframe and reported as meshed',
    meshed.source === 'mesh' && meshed.count === 1, JSON.stringify(meshed));

  console.log('\n• automatic hiding-spot detection');
  // Feed it a synthetic room the way a device would: two walls meeting in a
  // corner, plus a bed-height horizontal surface. Nothing is tapped.
  const auto = await page.evaluate(() => {
    const { scanMesh, cover, world, scan } = window.WabbitSeason;
    const T = window.__THREE;
    cover.clear();
    scanMesh.clear();

    const nA = new T.Vector3(0, 0, 1);    // wall facing +Z, at z = -3
    const nB = new T.Vector3(1, 0, 0);    // wall facing +X, at x = -2.5
    const up = new T.Vector3(0, 1, 0);
    for (let x = -2.5; x <= 1.5; x += 0.08) {
      for (let y = 0.1; y <= 2.2; y += 0.12) {
        scanMesh.addPoint(new T.Vector3(x, y, -3), true, nA);
      }
    }
    for (let z = -3; z <= 0.5; z += 0.08) {
      for (let y = 0.1; y <= 2.2; y += 0.12) {
        scanMesh.addPoint(new T.Vector3(-2.5, y, z), true, nB);
      }
    }
    // A bed: horizontal, 0.55m up, in front of the player.
    for (let x = -0.6; x <= 1.2; x += 0.08) {
      for (let z = -2.4; z <= -1.0; z += 0.08) {
        scanMesh.addPoint(new T.Vector3(x, 0.55, z), true, up);
      }
    }

    world.camera.position.set(0, 1.55, 0);
    world.camera.updateMatrixWorld(true);
    scan.lastDetectAt = -Infinity;
    scan.time = 999;
    scan._autoDetect();

    return cover.spots.map((s) => ({
      kind: s.kind,
      auto: s.auto,
      label: s.label,
      pos: [+s.position.x.toFixed(1), +s.position.y.toFixed(1), +s.position.z.toFixed(1)],
    }));
  });
  for (const a of auto) console.log(`        ${a.auto ? 'auto' : 'tap '} ${a.kind.padEnd(8)} ${JSON.stringify(a.pos)}  ${a.label}`);
  check('it finds hiding spots with no tapping at all', auto.length >= 2, `${auto.length} found`);
  check('every one is marked as automatic', auto.every((a) => a.auto));
  check('it finds the corner where two walls meet',
    auto.some((a) => a.kind === 'corner' && Math.abs(a.pos[0] + 2.5) < 0.6 && Math.abs(a.pos[2] + 3) < 0.6),
    JSON.stringify(auto.filter((a) => a.kind === 'corner').map((a) => a.pos)));
  // Standing him exactly on the corner line puts him inside the wall, where
  // the wall's own occluders would slice him in half.
  check('corner spots stand clear of the wall, not inside it',
    auto.filter((a) => a.kind === 'corner')
      .every((a) => a.pos[0] > -2.49 && a.pos[2] > -2.99),
    JSON.stringify(auto.filter((a) => a.kind === 'corner').map((a) => a.pos)));
  check('it finds the bed as something to pop up over',
    auto.some((a) => a.kind === 'surface' && Math.abs(a.pos[1] - 0.55) < 0.2),
    JSON.stringify(auto.filter((a) => a.kind === 'surface').map((a) => a.pos)));
  check('the start button unlocks without a single tap',
    !(await page.isDisabled('#btn-scan-done')));

  // A tap must still work when the hit test blinks out, as it does on iOS
  // over exactly the corners worth marking.
  const sticky = await page.evaluate(() => {
    const { scan, cover } = window.WabbitSeason;
    const T = window.__THREE;
    const before = cover.count;
    scan.backend.lastHit = null;
    scan.backend.stickyHit = {
      position: new T.Vector3(1, 0.5, -2), normal: new T.Vector3(0, 1, 0), real: true,
    };
    scan.backend.stickyHitAt = performance.now();
    scan.mark();
    return { added: cover.count > before, manual: cover.spots.some((s) => !s.auto) };
  });
  check('a tap still lands when the live hit test has dropped out',
    sticky.added && sticky.manual, JSON.stringify(sticky));

  console.log('\n• hunt');
  await page.click('#btn-scan-done');
  await page.waitForTimeout(400);
  check('hunt HUD is shown', await page.isVisible('#screen-hunt'));
  check('the scan overlay is cleared away for the hunt',
    !(await page.evaluate(() => window.WabbitSeason.scanMesh.group.visible)));
  check('the gun is on screen', await page.evaluate(() => {
    const { shotgun, world } = window.WabbitSeason;
    const T = window.__THREE;
    const wp = shotgun.model.getWorldPosition(new T.Vector3());
    const f = new T.Frustum().setFromProjectionMatrix(
      new T.Matrix4().multiplyMatrices(world.camera.projectionMatrix, world.camera.matrixWorldInverse));
    return shotgun.rig.visible && f.containsPoint(wp);
  }));

  await page.evaluate(() => { window.WabbitSeason.hunt.stateTimer = 0.0001; });
  await page.waitForTimeout(600);
  check('the wabbit shows up', await page.evaluate(() => window.WabbitSeason.hunt.state === 'up'));

  // Auto-detection never produces a door (by design), so the three emergence
  // routes are set up explicitly here.
  await page.evaluate(() => {
    const { cover } = window.WabbitSeason;
    const T = window.__THREE;
    const up = new T.Vector3(0, 1, 0);
    cover.add(new T.Vector3(1.0, 0.6, -2.0), up, 'surface');
    cover.add(new T.Vector3(-1.6, 0.1, -2.2), up, 'corner');
    cover.add(new T.Vector3(0.4, 0.1, -2.6), up, 'door');
  });

  // Each kind has to actually move him into view, by its own route.
  for (const kind of kinds) {
    const emerged = await page.evaluate(async (k) => {
      const { hunt, wabbit, cover, world } = window.WabbitSeason;
      const spot = cover.spots.find((s) => s.kind === k);
      if (!spot) return { ok: false, why: 'no spot' };
      hunt.currentSpot = spot;
      wabbit.placeAt(spot.position, world.camera.getWorldPosition(new window.__THREE.Vector3()),
        spot.kind, spot.sideSign);
      wabbit.setState('taunt');
      wabbit.setEmerge(1, true);
      const p = wabbit.body.position;
      return { ok: true, x: +p.x.toFixed(2), y: +p.y.toFixed(2), visible: wabbit.body.visible };
    }, kind);
    check(`'${kind}' brings him fully into view`,
      emerged.ok && emerged.visible && Math.abs(emerged.x) < 0.05 && Math.abs(emerged.y) < 0.05,
      JSON.stringify(emerged));

    const hidden = await page.evaluate((k) => {
      const { wabbit, cover, world } = window.WabbitSeason;
      const spot = cover.spots.find((s) => s.kind === k);
      wabbit.placeAt(spot.position, world.camera.getWorldPosition(new window.__THREE.Vector3()),
        spot.kind, spot.sideSign);
      wabbit.setEmerge(0, true);
      const p = wabbit.body.position;
      // Hidden means displaced out of sight: down for a surface, sideways
      // for an edge or a doorway.
      return { offset: +Math.max(Math.abs(p.x), Math.abs(p.y)).toFixed(2), visible: wabbit.body.visible };
    }, kind);
    check(`'${kind}' hides him out of sight`,
      !hidden.visible && hidden.offset > 0.4, JSON.stringify(hidden));
  }

  check('a door spot swings a door open', await page.evaluate(async () => {
    const { hunt, cover, effects } = window.WabbitSeason;
    const spot = cover.spots.find((s) => s.kind === 'door');
    const before = effects.temporary.length;
    hunt.fx.showDoor(spot, 2);
    return effects.temporary.length === before + 1;
  }));

  await page.evaluate(() => {
    const { world, wabbit } = window.WabbitSeason;
    world.camera.lookAt(wabbit.aimPoint());
    world.camera.updateMatrixWorld(true);
  });
  await page.mouse.move(195, 420);
  await page.mouse.down();
  await page.waitForTimeout(300);
  check('holding shoulders the gun', await page.evaluate(() => window.WabbitSeason.shotgun.ads > 0.8));
  await page.mouse.up();
  await page.waitForTimeout(500);

  const afterShot = await page.evaluate(() => {
    const h = window.WabbitSeason.hunt;
    return { shots: h.shots, misses: h.misses, score: h.score };
  });
  check('releasing fires', afterShot.shots === 1);
  check('every shot is a miss', afterShot.misses === afterShot.shots);
  check('a miss scores style points', afterShot.score > 0, `${afterShot.score} pts`);

  console.log('\n• gag table');
  const gags = await page.evaluate(async () => {
    const { hunt, wabbit } = window.WabbitSeason;
    const { ON_TARGET_GAGS, WILD_GAGS, EMPTY_GAGS } = window.__GAGS;
    const out = [];
    for (const gag of [...ON_TARGET_GAGS, ...WILD_GAGS, ...EMPTY_GAGS]) {
      wabbit.setState('taunt');
      wabbit.setEmerge(1, true);
      try {
        hunt._playGag({ ...gag, run: gag.run ?? (() => {}) });
        out.push({ id: gag.id, ok: true });
      } catch (e) {
        out.push({ id: gag.id, ok: false, error: String(e) });
      }
      await new Promise((r) => setTimeout(r, 240));
    }
    return out;
  });
  for (const g of gags) if (!g.ok) console.log(`        ${g.id}: ${g.error}`);
  check(`all ${gags.length} gags run without throwing`, gags.every((g) => g.ok));

  // Park the state machine so it cannot spawn a fresh encounter (and its
  // door) while we are waiting for the gag effects to expire.
  await page.evaluate(() => {
    const h = window.WabbitSeason.hunt;
    h.state = 'waiting';
    h.stateTimer = Number.MAX_SAFE_INTEGER;
  });
  await page.waitForTimeout(4000);
  const leaks = await page.evaluate(() => ({
    particles: window.WabbitSeason.effects.particles.length,
    temporary: window.WabbitSeason.effects.temporary.length,
  }));
  check('effects clean themselves up', leaks.particles === 0 && leaks.temporary === 0, JSON.stringify(leaks));

  console.log('\n• occlusion');
  const occ = await page.evaluate(() => {
    const { occluders, scanMesh } = window.WabbitSeason;
    scanMesh.rebuild();
    occluders.update(scanMesh.surfaceGeometry);
    return {
      triangles: occluders.count,
      shared: occluders.mesh.geometry === scanMesh.surfaceGeometry,
      visible: occluders.group.visible,
      colorWrite: occluders.material.colorWrite,
      depthWrite: occluders.material.depthWrite,
      surfaceDrawn: !!scanMesh.surface.geometry.getAttribute('position'),
      wireDrawn: !!scanMesh.wireframe.geometry.getAttribute('position'),
    };
  });
  check('the scan is triangulated into a connected mesh', occ.triangles > 0,
    `${occ.triangles} triangles`);
  check('the mesh is drawn as a surface with edges',
    occ.surfaceDrawn && occ.wireDrawn, JSON.stringify(occ));
  check('occluders write depth but paint nothing',
    occ.colorWrite === false && occ.depthWrite === true, JSON.stringify(occ));
  check('the occluder is the very mesh the player was shown', occ.shared);
  check('occluders are active during the hunt', occ.visible);

  console.log('\n• grounding');
  const shadow = await page.evaluate(() => {
    const { wabbit } = window.WabbitSeason;
    wabbit.setEmerge(1, true);
    wabbit.update(0.016, new window.__THREE.Vector3(0, 1.5, 0));
    const up = wabbit.shadow.material.opacity;
    wabbit.setEmerge(0, true);
    wabbit.update(0.016, new window.__THREE.Vector3(0, 1.5, 0));
    return { up, down: wabbit.shadow.material.opacity, parent: wabbit.shadow.parent === wabbit.root };
  });
  check('he casts a contact shadow when up', shadow.up > 0.5, JSON.stringify(shadow));
  check('the shadow fades as he ducks away', shadow.down < 0.05);
  check('the shadow stays on the surface, not on his body', shadow.parent);

  console.log('\n• results and replay');
  await page.click('#btn-quit');
  await page.waitForTimeout(900);
  check('results screen is shown', await page.isVisible('#screen-results'));
  check('final score is reported', +(await page.textContent('#res-score')) > 0);
  check('a rank is awarded', (await page.textContent('#res-rank')).length > 10);
  // Restarting the AR session between rounds is unreliable on iOS and throws
  // away the scanned room, so the session has to survive the results screen.
  check('the AR session survives the results screen',
    await page.evaluate(() => !!document.querySelector('#passthrough').srcObject));
  check('occluders stand down outside the hunt',
    !(await page.evaluate(() => window.WabbitSeason.occluders.group.visible)));

  await page.click('#btn-again');
  await page.waitForTimeout(600);
  const replay = await page.evaluate(() => ({
    phase: window.WabbitSeason.phase,
    spots: window.WabbitSeason.cover.count,
    live: !!document.querySelector('#passthrough').srcObject,
    score: window.WabbitSeason.hunt.score,
  }));
  check('Hunt Again replays without restarting the session',
    replay.phase === 'hunt' && replay.live, JSON.stringify(replay));
  check('it keeps the room that was already scanned', replay.spots > 0, `${replay.spots} spots`);
  check('the score resets for the new round', replay.score === 0);

  console.log('\n• leaving');
  await page.click('#screen-hunt #btn-quit');
  await page.waitForTimeout(600);
  await page.click('#screen-results [data-goto="title"]');
  await page.waitForTimeout(800);
  check('going back to the title releases the camera',
    await page.evaluate(() => !document.querySelector('#passthrough').srcObject));

  console.log('\n• diagnostics');
  await page.click('[data-goto="title"]').catch(() => {});
  const diag = await page.evaluate(() => {
    document.querySelector('#btn-diag').click();
    const text = document.querySelector('#diag-body').textContent;
    const open = !document.querySelector('#diag').hidden;
    document.querySelector('#diag-close').click();
    return { open, text };
  });
  check('the diagnostics panel opens', diag.open);
  check('the diagnostics panel can be interacted with', await page.evaluate(() => {
    const panel = document.querySelector('#diag');
    panel.hidden = false;
    const ok = getComputedStyle(document.querySelector('#diag-close')).pointerEvents !== 'none';
    panel.hidden = true;
    return ok;
  }));
  check('it reports the build id', /^build: /m.test(diag.text));
  check('it reports the runtime mode', /^mode: /m.test(diag.text));
  check('it reports scan state', /scanPatches: /.test(diag.text));

  console.log('\n• console');
  for (const e of errors) console.log(`        ${e}`);
  check('no console or page errors', errors.length === 0, `${errors.length} error(s)`);
} finally {
  await browser.close();
  own?.server.close();
}

console.log(`\n${failures.length ? `FAILED: ${failures.join(', ')}` : 'All checks passed.'}\n`);
process.exit(failures.length ? 1 : 0);
