import * as THREE from 'three';
import { $, buzz, rand } from '../core/util.js';
import { sfx } from '../audio/sfx.js';
import { muzzleFlash, showGag, showTaunt, toast } from '../ui/screens.js';
import {
  chooseGag, randomHunterLine, randomTaunt, rankFor,
} from './gags.js';

const SHELLS = 2;
const RELOAD_TIME = 1.5;
const ENCOUNTERS = 10;          // how many times he bothers to show up
const ADS_HOLD = 0.12;          // seconds of hold before the gun is shouldered

/** Angular tolerance (radians) for "that shot was actually on target". */
const ON_TARGET_ADS = 0.085;
const ON_TARGET_HIP = 0.16;

/**
 * The hunt itself: a small state machine driving the wabbit in and out of
 * cover, plus the shooting that never, ever works.
 */
export class HuntPhase {
  constructor({ world, cover, wabbit, shotgun, effects }) {
    this.world = world;
    this.cover = cover;
    this.wabbit = wabbit;
    this.shotgun = shotgun;
    this.fx = effects;

    this.active = false;
    this.onComplete = null;
    /** Optional mirror for runtimes where the DOM HUD is not visible. */
    this.onHud = null;

    this.els = {
      score: $('#hud-score'),
      shells: $('#hud-shells'),
      misses: $('#hud-misses'),
      hint: $('#hunt-hint'),
    };

    this.reset();
    this.fxApi = this._buildFxApi();
  }

  reset() {
    this.score = 0;
    this.shells = SHELLS;
    this.shots = 0;
    this.misses = 0;
    this.reloadTimer = 0;
    this.encounters = 0;
    this.time = 0;
    this.gagCounts = new Map();
    this.bestGag = null;
    this.closestShot = Infinity;

    this.state = 'waiting';
    this.stateTimer = 1.2;
    this.currentSpot = null;
    this.holdTime = 0;
    this.holding = false;
    this.lockout = 0;          // brief input freeze while a gag plays out
  }

  /* ---------------- lifecycle ---------------- */

  start() {
    this.reset();
    this.active = true;
    this.cover.setMarkersVisible(false);
    this.wabbit.setState('hide');
    this._refreshHud();
    this.els.hint.style.opacity = '1';
    showTaunt(randomHunterLine(), 3000);
  }

  stop() {
    this.active = false;
    this.holding = false;
    this.shotgun.setAds(false);
    this.wabbit.setState('hide');
  }

  /* ---------------- input ---------------- */

  pressStart() {
    if (!this.active || this.lockout > 0) return;
    this.holding = true;
    this.holdTime = 0;
  }

  pressEnd() {
    if (!this.active) return;
    if (!this.holding) return;
    this.holding = false;
    this.shotgun.setAds(false);
    if (this.lockout > 0) return;
    this._fire(this.holdTime >= ADS_HOLD);
  }

  /* ---------------- firing ---------------- */

  _fire(aimed) {
    if (this.reloadTimer > 0) { sfx.dryFire(); return; }
    if (this.shells <= 0) { sfx.dryFire(); this._beginReload(); return; }

    this.shells--;
    this.shots++;
    this.misses++;                         // there is no other outcome
    this.shotgun.fire();
    sfx.blast();
    muzzleFlash();
    buzz([12, 30, 18]);

    const wabbitUp = this.wabbit.isUp && this.state === 'up';
    let angle = Infinity;
    if (wabbitUp) {
      angle = this.shotgun.angleTo(this.wabbit.aimPoint());
      this.closestShot = Math.min(this.closestShot, angle);
    }
    const tolerance = aimed ? ON_TARGET_ADS : ON_TARGET_HIP;
    const onTarget = wabbitUp && angle <= tolerance;

    const gag = chooseGag({ onTarget, aiming: aimed, wabbitUp });
    this._playGag(gag);

    if (this.shells <= 0) this._beginReload();
    this._refreshHud();
  }

  _playGag(gag) {
    try {
      gag.run?.({
        wabbit: this.wabbit,
        shotgun: this.shotgun,
        fx: this.fxApi,
        cover: this.cover,
      });
    } catch (err) {
      console.error('gag failed', gag.id, err);
    }

    this.score += gag.score;
    this.gagCounts.set(gag.id, (this.gagCounts.get(gag.id) ?? 0) + 1);
    if (!this.bestGag || gag.score > this.bestGag.score) this.bestGag = gag;

    showGag(gag.label);
    if (gag.line) setTimeout(() => showTaunt(gag.line, 2400), 520);

    // Let the gag breathe before the next shot or duck.
    this.lockout = 0.55;
    if (this.state === 'up') this.stateTimer = Math.max(this.stateTimer, 1.9);
  }

  _beginReload() {
    this.reloadTimer = RELOAD_TIME;
    setTimeout(() => sfx.reload(), 220);
  }

  /* ---------------- wabbit state machine ---------------- */

  _appear() {
    const spot = this.cover.chooseNext(this.world.camera, this.currentSpot, this.time);
    if (!spot) return;
    this.currentSpot = spot;

    const camPos = this.world.camera.getWorldPosition(new THREE.Vector3());
    this.wabbit.placeAt(spot.position, camPos, spot.kind, spot.sideSign);
    this.wabbit.setState(Math.random() < 0.35 ? 'peek' : 'taunt');

    this.encounters++;
    this.state = 'up';
    this.stateTimer = rand(2.6, 4.6);

    if (spot.kind === 'door') {
      // The door has to be open before he can stroll through it, so the
      // entrance is delayed to sit behind the swing.
      this.fx.showDoor(spot, this.stateTimer);
      sfx.creak();
      this.wabbit.setEmerge(0, true);
      setTimeout(() => {
        if (this.active && this.state === 'up') {
          this.wabbit.setEmerge(1);
          sfx.pop();
          buzz(18);
        }
      }, 620);
    } else {
      sfx.pop();
      buzz(18);
    }

    showTaunt(randomTaunt(), 2600);
  }

  _hide() {
    this.wabbit.setState('hide');
    sfx.duck();
    this.state = 'waiting';
    this.stateTimer = rand(1.3, 2.8);
  }

  /* ---------------- per-frame ---------------- */

  update(dt) {
    if (!this.active) return;
    this.time += dt;
    this.lockout = Math.max(0, this.lockout - dt);

    if (this.holding) {
      this.holdTime += dt;
      if (this.holdTime >= ADS_HOLD && !this.shotgun.isAiming) {
        this.shotgun.setAds(true);
        sfx.shoulder();
      } else if (this.holdTime >= ADS_HOLD) {
        this.shotgun.setAds(true);
      }
    }

    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.shells = SHELLS;
        this._refreshHud();
      }
    }

    this.stateTimer -= dt;
    if (this.stateTimer <= 0) {
      if (this.state === 'waiting') {
        if (this.encounters >= ENCOUNTERS) return this._finish();
        this._appear();
      } else if (this.state === 'up') {
        this._hide();
      }
    }

    // The hint fades out once the player has clearly got the idea.
    if (this.shots >= 2) this.els.hint.style.opacity = '0';

    this._refreshHud();
  }

  _refreshHud() {
    this.onHud?.(this.score, this.shells, this.misses, this.reloadTimer > 0);
    this.els.score.textContent = String(this.score);
    this.els.misses.textContent = String(this.misses);
    this.els.shells.textContent = this.reloadTimer > 0
      ? '…'
      : '•'.repeat(this.shells).padEnd(SHELLS, '·');
  }

  /* ---------------- effects wiring ---------------- */

  _buildFxApi() {
    const fx = this.fx;
    return {
      pellets: (opts) => fx.pellets(opts),
      dust: () => fx.dust(),
      spit: () => fx.spit(),
      stars: () => fx.stars(),
      soot: () => fx.soot(),
      shake: (a) => fx.shake(a),
      sign: (text) => fx.showSign(text),
      decoyFall: () => fx.decoyFall(),
      kissMark: () => fx.kissMark(),
      relocateBehindPlayer: () => this._relocateBehindPlayer(),
    };
  }

  /** "He's behind you" — move him to the spot furthest out of view and pop. */
  _relocateBehindPlayer() {
    const spot = this.cover.chooseBehind(this.world.camera) ?? this.currentSpot;
    if (!spot) return;
    this.currentSpot = spot;
    const camPos = this.world.camera.getWorldPosition(new THREE.Vector3());
    this.wabbit.placeAt(spot.position, camPos, spot.kind, spot.sideSign);
    this.wabbit.setState('taunt');
    this.state = 'up';
    this.stateTimer = Math.max(this.stateTimer, 3.0);
    toast(`He’s behind you — ${spot.label}!`, 2200);
  }

  /* ---------------- results ---------------- */

  _finish() {
    this.stop();
    const summary = this.buildSummary();
    this.onComplete?.(summary);
  }

  buildSummary() {
    const accuracyDegrees = this.closestShot === Infinity
      ? null
      : (this.closestShot * 180) / Math.PI;
    return {
      score: this.score,
      shots: this.shots,
      misses: this.misses,
      hits: 0,
      encounters: this.encounters,
      distinctGags: this.gagCounts.size,
      bestGag: this.bestGag,
      closestDegrees: accuracyDegrees,
      rank: rankFor(this.score),
    };
  }
}

export { ENCOUNTERS, SHELLS };
