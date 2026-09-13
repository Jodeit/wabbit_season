/**
 * Reginald's voice.
 *
 * Speech synthesis rather than recorded lines, for the same reason every other
 * sound here is synthesised: the game ships with no asset files, and a rabbit
 * who only says ten recorded things stops being funny on the eleventh.
 *
 * Availability is uneven — some browsers have no voices at all, some load them
 * asynchronously, and iOS refuses to speak until it has seen a user gesture.
 * All of that degrades to silence; the captions carry the joke either way.
 */

const PREFERRED = [
  // Reasonably plummy English voices, best first.
  'Daniel', 'Arthur', 'Oliver', 'George', 'Google UK English Male',
  'Microsoft Ryan', 'Serena', 'Google UK English Female',
];

const STORAGE_KEY = 'wabbit-season:voice';

let voice = null;
let ready = false;
let enabled = true;
let warmed = false;

function supported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Pick the most English-sounding voice available. */
function chooseVoice() {
  if (!supported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  for (const name of PREFERRED) {
    const match = voices.find((v) => v.name.includes(name));
    if (match) return match;
  }
  return voices.find((v) => v.lang === 'en-GB')
    ?? voices.find((v) => v.lang?.startsWith('en-GB'))
    ?? voices.find((v) => v.lang?.startsWith('en'))
    ?? voices[0];
}

export function initVoice() {
  if (!supported()) return;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) enabled = stored === 'on';
  } catch {
    // Private browsing and friends: keep the default.
  }
  const load = () => { voice = chooseVoice(); ready = !!voice; };
  load();
  // Most browsers populate the list asynchronously, some more than once.
  window.speechSynthesis.addEventListener?.('voiceschanged', load);
}

/**
 * Must be called from a user gesture.
 *
 * iOS will not speak at all until speechSynthesis has been touched inside a
 * real interaction, and silently drops everything before that.
 */
export function warmVoice() {
  if (!supported() || warmed) return;
  warmed = true;
  try {
    const nudge = new SpeechSynthesisUtterance(' ');
    nudge.volume = 0;
    window.speechSynthesis.speak(nudge);
  } catch {
    // Nothing to recover: the captions still carry every line.
  }
}

export function setVoiceEnabled(on) {
  enabled = on;
  try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* fine */ }
  if (!on && supported()) window.speechSynthesis.cancel();
}

export const voiceEnabled = () => enabled;
export const voiceAvailable = () => supported() && ready;
export const voiceName = () => voice?.name ?? 'none';

/**
 * Say a line, interrupting whatever he was saying.
 * He talks over himself constantly; that is in character.
 */
export function say(text, { pitch = 0.8, rate = 0.95 } = {}) {
  if (!enabled || !supported()) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = 'en-GB';
    }
    // Low and unhurried: he is a large rabbit who has never been in a rush.
    utterance.pitch = pitch;
    utterance.rate = rate;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch {
    // Speech is a bonus, never a dependency.
  }
}
