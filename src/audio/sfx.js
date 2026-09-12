/**
 * Every sound is synthesised at runtime — the game ships with no audio files.
 * A cartoon hunt needs blasts, boings and slide-whistles, all of which are
 * cheap to build out of noise bursts and pitch ramps.
 */

let ctx = null;
let master = null;

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  return ctx;
}

export const audioReady = () => !!ctx && ctx.state === 'running';

function noiseBuffer(seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function env(node, { peak = 0.5, attack = 0.005, decay = 0.3, at = 0 }) {
  const g = ctx.createGain();
  const t = ctx.currentTime + at;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  node.connect(g);
  g.connect(master);
  return { gain: g, start: t, end: t + attack + decay };
}

function tone(type, freq, opts = {}) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime + (opts.at || 0));
  const e = env(osc, opts);
  osc.start(e.start);
  osc.stop(e.end + 0.05);
  return osc;
}

function burst(seconds, filterHz, opts = {}) {
  if (!ctx) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(seconds);
  const filt = ctx.createBiquadFilter();
  filt.type = opts.filterType || 'lowpass';
  filt.frequency.setValueAtTime(filterHz, ctx.currentTime + (opts.at || 0));
  if (opts.sweepTo) {
    filt.frequency.exponentialRampToValueAtTime(
      opts.sweepTo, ctx.currentTime + (opts.at || 0) + seconds);
  }
  src.connect(filt);
  const e = env(filt, opts);
  src.start(e.start);
  src.stop(e.end + 0.05);
}

/* ------------------------------------------------------------------ */
/* the sound board                                                     */
/* ------------------------------------------------------------------ */

export const sfx = {
  /** Big double-barrel boom: a noise slam plus a sub-thump. */
  blast() {
    if (!ctx) return;
    burst(0.45, 2600, { peak: 0.85, attack: 0.002, decay: 0.42, sweepTo: 180 });
    tone('sine', 90, { peak: 0.7, attack: 0.004, decay: 0.32 });
    tone('sine', 46, { peak: 0.5, attack: 0.01, decay: 0.5, at: 0.01 });
  },

  /** Dry click of an empty chamber. */
  dryFire() {
    burst(0.05, 5200, { peak: 0.3, attack: 0.001, decay: 0.05, filterType: 'highpass' });
    tone('square', 1400, { peak: 0.12, attack: 0.001, decay: 0.04 });
  },

  /** Shells racked into the breech. */
  reload() {
    burst(0.07, 3000, { peak: 0.25, attack: 0.002, decay: 0.07 });
    burst(0.07, 2200, { peak: 0.22, attack: 0.002, decay: 0.07, at: 0.16 });
    tone('square', 320, { peak: 0.1, attack: 0.003, decay: 0.08, at: 0.3 });
  },

  /** Shouldering the gun. */
  shoulder() {
    tone('triangle', 220, { peak: 0.1, attack: 0.01, decay: 0.12 });
  },

  /** The wabbit pops into view. */
  pop() {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.12);
    const e = env(osc, { peak: 0.35, attack: 0.006, decay: 0.16 });
    osc.start(e.start);
    osc.stop(e.end + 0.05);
  },

  /** He ducks back down: the pop, reversed. */
  duck() {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(820, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.16);
    const e = env(osc, { peak: 0.28, attack: 0.006, decay: 0.2 });
    osc.start(e.start);
    osc.stop(e.end + 0.05);
  },

  /** Classic spring boing for barrel-bending nonsense. */
  boing() {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(600, t);
    for (let i = 0; i < 7; i++) {
      const f = 600 * (i % 2 ? 0.45 : 1) * Math.pow(0.86, i);
      osc.frequency.exponentialRampToValueAtTime(Math.max(60, f), t + 0.05 + i * 0.055);
    }
    const e = env(osc, { peak: 0.4, attack: 0.005, decay: 0.55 });
    osc.start(e.start);
    osc.stop(e.end + 0.05);
  },

  /** Pellets pinging off something that should not deflect pellets. */
  ricochet() {
    if (!ctx) return;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const t = ctx.currentTime + i * 0.07;
      const f = 1800 + Math.random() * 1400;
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.28, t + 0.22);
      const e = env(osc, { peak: 0.16, attack: 0.002, decay: 0.24, at: i * 0.07 });
      osc.start(e.start);
      osc.stop(e.end + 0.05);
    }
  },

  /** Slide whistle, for anything that falls or deflates. */
  whistleDown() {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(1500, t);
    osc.frequency.exponentialRampToValueAtTime(160, t + 0.55);
    const e = env(osc, { peak: 0.22, attack: 0.02, decay: 0.6 });
    osc.start(e.start);
    osc.stop(e.end + 0.05);
  },

  /** Carrot crunch. */
  munch() {
    burst(0.09, 1500, { peak: 0.3, attack: 0.002, decay: 0.09 });
    burst(0.09, 1100, { peak: 0.26, attack: 0.002, decay: 0.09, at: 0.15 });
  },

  /** Anvil/iron bonk on the hunter's own head. */
  bonk() {
    tone('sine', 150, { peak: 0.55, attack: 0.002, decay: 0.35 });
    tone('square', 76, { peak: 0.25, attack: 0.002, decay: 0.4 });
    burst(0.2, 900, { peak: 0.3, attack: 0.002, decay: 0.22 });
  },

  /** Little sparkle when a hiding spot is marked. */
  mark() {
    tone('triangle', 660, { peak: 0.18, attack: 0.004, decay: 0.1 });
    tone('triangle', 990, { peak: 0.15, attack: 0.004, decay: 0.14, at: 0.08 });
  },

  /** End-of-hunt sting: the wabbit's fanfare, not yours. */
  fanfare() {
    [523, 659, 784, 1046].forEach((f, i) => {
      tone('triangle', f, { peak: 0.22, attack: 0.01, decay: 0.3, at: i * 0.13 });
    });
  },
};
