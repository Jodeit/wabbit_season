import { makeShuffler, pick, rand } from '../core/util.js';
import { sfx } from '../audio/sfx.js';

/**
 * The miss table.
 *
 * The player cannot hit the wabbit — that is the joke and it is load-bearing.
 * What varies is *how* the shot fails, and how many style points the failure
 * is worth. Gags are split into two pools:
 *
 *   - `onTarget`: the shot was genuinely lined up, so he has to work for it.
 *     These are the big, expensive, cartoon-physics saves and score the most.
 *   - `wild`: the shot was never close, so the humiliation is the player's.
 *
 * Each gag receives an `api` of the live game objects plus an `fx` bag of
 * one-shot effects implemented by the hunt loop.
 */

export const ON_TARGET_GAGS = [
  {
    id: 'duck',
    label: 'He Ducked',
    score: 120,
    line: 'Oh, bad luck. Miles off.',
    run: ({ wabbit, fx }) => {
      wabbit.dodge(0);
      wabbit.setEmerge(0.06);
      fx.pellets({ high: true });
      sfx.duck();
      setTimeout(() => wabbit.setEmerge(1), 700);
    },
  },
  {
    id: 'teeth',
    label: 'Caught It In His Teeth',
    score: 260,
    line: 'Mm. Wants salt.',
    run: ({ wabbit, fx }) => {
      wabbit.setState('chew');
      fx.pellets({ toWabbit: true });
      sfx.munch();
      fx.spit();
    },
  },
  {
    id: 'bent',
    label: 'Barrel Tied In A Knot',
    score: 300,
    line: 'You\'ll want to get that seen to.',
    run: ({ shotgun, fx }) => {
      shotgun.setBent(true);
      sfx.boing();
      fx.shake(0.9);
      fx.soot();
      setTimeout(() => shotgun.setBent(false), 2600);
    },
  },
  {
    id: 'carrot',
    label: 'Bunted It With A Cawwot',
    score: 240,
    line: 'And that, I think, is four runs.',
    run: ({ wabbit, fx }) => {
      wabbit.dodge(-0.5);
      fx.pellets({ deflect: true });
      sfx.ricochet();
      sfx.munch();
    },
  },
  {
    id: 'sign',
    label: 'Wrong Season, Appawently',
    score: 210,
    line: 'It says quite clearly: duck season.',
    run: ({ fx }) => {
      fx.sign('DUCK\nSEASON');
      fx.pellets({ wide: true });
      setTimeout(() => fx.sign('WABBIT\nSEASON'), 1200);
      sfx.whistleDown();
    },
  },
  {
    id: 'decoy',
    label: 'You Shot A Cardboawd Cutout',
    score: 280,
    line: 'Over here, old boy.',
    run: ({ fx }) => {
      fx.decoyFall();
      sfx.whistleDown();
      setTimeout(() => { fx.relocateBehindPlayer(); sfx.pop(); }, 900);
    },
  },
  {
    id: 'ricochet',
    label: 'Wicochet! Wight Off Youw Head',
    score: 190,
    line: 'Ooh. That will smart.',
    run: ({ fx }) => {
      fx.pellets({ ricochet: true });
      sfx.ricochet();
      setTimeout(() => { sfx.bonk(); fx.shake(1.2); fx.stars(); }, 420);
    },
  },
  {
    id: 'kiss',
    label: 'He Kissed The Bawwel',
    score: 320,
    line: 'Mwah. No hard feelings.',
    run: ({ shotgun, fx }) => {
      fx.kissMark();
      shotgun.setBent(true);
      sfx.whistleDown();
      setTimeout(() => shotgun.setBent(false), 2200);
    },
  },
  {
    id: 'tunnel',
    label: 'He Dug A Tunnel',
    score: 230,
    line: 'Should have taken that left at Basingstoke.',
    run: ({ wabbit, fx }) => {
      wabbit.setState('hide');
      sfx.duck();
      setTimeout(() => { fx.relocateBehindPlayer(); sfx.pop(); }, 800);
    },
  },
  {
    id: 'anvil',
    label: 'Anvil. Obviously.',
    score: 350,
    line: 'Mind your head!',
    run: ({ fx }) => {
      sfx.whistleDown();
      setTimeout(() => { sfx.bonk(); fx.shake(1.6); fx.stars(); fx.soot(); }, 560);
    },
  },
];

export const WILD_GAGS = [
  {
    id: 'wide',
    label: 'Not Even Cwose',
    score: 15,
    line: 'Was that at me, or the lamp?',
    run: ({ fx }) => { fx.pellets({ wide: true }); },
  },
  {
    id: 'ceiling',
    label: 'You Shot The Ceiling',
    score: 20,
    line: 'The ceiling was unarmed, you know.',
    run: ({ fx }) => { fx.pellets({ high: true }); fx.dust(); },
  },
  {
    id: 'floor',
    label: 'You Shot The Floow',
    score: 20,
    line: 'The floor had it coming, I\'m sure.',
    run: ({ fx }) => { fx.pellets({ low: true }); fx.dust(); },
  },
  {
    id: 'hip',
    label: 'Fiwed Fwom The Hip. Bold.',
    score: 35,
    line: 'Ooh. From the hip. Very cavalier.',
    run: ({ fx }) => { fx.pellets({ wide: true }); fx.shake(0.5); },
  },
];

/** Fired at nothing at all — no wabbit in sight. */
export const EMPTY_GAGS = [
  { id: 'nobody', label: 'Nothing There', score: 5, line: 'Talking to yourself again?' },
  { id: 'jumpy', label: 'Jumpy, Awen\'t We', score: 5, line: 'Steady on. It was a curtain.' },
];

const nextOnTarget = makeShuffler(ON_TARGET_GAGS.map((g) => g.id));

/**
 * Choose the gag for a shot.
 * @param {object} shot - { onTarget, aiming, wabbitUp }
 */
export function chooseGag(shot) {
  if (!shot.wabbitUp) {
    return { ...pick(EMPTY_GAGS), run: () => {} };
  }
  if (shot.onTarget) {
    const id = nextOnTarget();
    const gag = ON_TARGET_GAGS.find((g) => g.id === id);
    // Shouldering the gun is rewarded even though it changes nothing.
    return { ...gag, score: Math.round(gag.score * (shot.aiming ? 1 : 0.6)) };
  }
  if (!shot.aiming) return WILD_GAGS.find((g) => g.id === 'hip');
  return pick(WILD_GAGS.filter((g) => g.id !== 'hip'));
}

/* ------------------------------------------------------------------ */
/* dialogue                                                            */
/* ------------------------------------------------------------------ */

/**
 * Things Reginald says when he pops up.
 *
 * He is a large, unhurried English gentleman who has never once been in
 * danger and knows it. The hunter's own Fudd-ish muttering is left alone —
 * the contrast between the two is most of the joke.
 */
export const POP_TAUNTS = [
  'Ah. You again.',
  'Frightfully sorry — were you aiming?',
  'One moment, I\'m having my elevenses.',
  'Lovely home. Dreadful hunting.',
  'Oh, don\'t mind me. Do carry on.',
  'Splendid gun. Shame about the chap holding it.',
  'You haven\'t hit anything yet, have you. Be honest.',
  'Take your time. I\'m on my holidays.',
  'Is this a hunt, or are we simply spending time together?',
  'Right then. Off you pop.',
  'You have the look of a man about to miss.',
  'I\'d offer you tea, but you seem busy.',
];

/** Things the hunter mutters to himself. */
export const HUNTER_LINES = [
  'Be vewy vewy quiet…',
  'That wascally wabbit!',
  'I\'ll get him this time, I will!',
  'Ooooh, I hate that wabbit!',
  'Come out and fight wike a wabbit!',
  'Shhh. He\'s awound heah somewheah.',
];

const nextTaunt = makeShuffler(POP_TAUNTS);
const nextHunterLine = makeShuffler(HUNTER_LINES);
export const randomTaunt = () => nextTaunt();
export const randomHunterLine = () => nextHunterLine();

/** End-of-hunt rank based on style points. */
export function rankFor(score) {
  if (score >= 2200) return 'Legendawy Failuwe — they\'ll write songs about this hunt.';
  if (score >= 1500) return 'Master of Missing. Truly elite incompetence.';
  if (score >= 900) return 'Seasoned Hunter. Seasoned, not successful.';
  if (score >= 450) return 'Pwomising Amateuw. The wabbit is barely trying.';
  if (score >= 150) return 'Weekend Wawwiow. Keep at it, chief.';
  return 'The wabbit didn\'t even notice you were there.';
}

export const randomMissWobble = () => rand(-1, 1);
