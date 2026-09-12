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
    line: 'Missed me by *that* much, chief.',
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
    line: 'Mmf — needs salt.',
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
    line: 'You might wanna get that looked at.',
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
    line: 'And it is outta here!',
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
    line: 'Says right here: DUCK season.',
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
    line: 'Over here, sport.',
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
    line: 'That is gonna leave a mark.',
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
    line: 'Shoulda taken that left turn.',
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
    line: 'Heads up, chief!',
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
    line: 'Were you aiming at the lamp?',
    run: ({ fx }) => { fx.pellets({ wide: true }); },
  },
  {
    id: 'ceiling',
    label: 'You Shot The Ceiling',
    score: 20,
    line: 'The ceiling was unarmed, chief.',
    run: ({ fx }) => { fx.pellets({ high: true }); fx.dust(); },
  },
  {
    id: 'floor',
    label: 'You Shot The Floow',
    score: 20,
    line: 'Floor had it coming, I guess.',
    run: ({ fx }) => { fx.pellets({ low: true }); fx.dust(); },
  },
  {
    id: 'hip',
    label: 'Fiwed Fwom The Hip. Bold.',
    score: 35,
    line: 'Ooh, a gunslinger.',
    run: ({ fx }) => { fx.pellets({ wide: true }); fx.shake(0.5); },
  },
];

/** Fired at nothing at all — no wabbit in sight. */
export const EMPTY_GAGS = [
  { id: 'nobody', label: 'Nothing There', score: 5, line: 'Talking to yourself again?' },
  { id: 'jumpy', label: 'Jumpy, Awen\'t We', score: 5, line: 'Easy, chief. It was a curtain.' },
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

/** Things the wabbit says when he pops up. */
export const POP_TAUNTS = [
  'Ehhh… what\'s cookin\', chief?',
  'Lookin\' for someone?',
  'You call that a hunting rifle?',
  'Nice hat. Very sneaky.',
  'I\'ll be right here. Promise.',
  'Take your time. I\'ve got all day.',
  'Ooh, he\'s got the good shells out.',
  'Psst. Behind you. …made you look.',
  'You do know I do this for a living?',
  'Say, is this your kitchen? It\'s lovely.',
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
