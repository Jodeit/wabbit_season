import { $ } from '../core/util.js';

/**
 * Screen switcher over the DOM overlay. The overlay element doubles as the
 * WebXR `dom-overlay` root, so the same markup drives both runtime paths.
 */
const screens = new Map();
let current = null;

for (const el of document.querySelectorAll('[data-screen]')) {
  screens.set(el.dataset.screen, el);
}

export function show(name) {
  for (const [key, el] of screens) el.hidden = key !== name;
  current = name;
}

export const currentScreen = () => current;

let toastTimer = 0;
export function toast(message, ms = 2400) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/** Fires the white muzzle-flash wash over the whole overlay. */
export function muzzleFlash() {
  const el = $('#flash');
  el.classList.remove('fire');
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('fire');
}

function flashBanner(sel, text, ms) {
  const el = $(sel);
  el.textContent = text;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, ms);
}

export const showTaunt = (text, ms = 2600) => flashBanner('#taunt', text, ms);
export const showGag = (text, ms = 2200) => flashBanner('#gag', text, ms);

export function fatal(title, body) {
  $('#err-title').textContent = title;
  $('#err-body').textContent = body;
  show('error');
}

// Any button with data-goto is a plain navigation button.
for (const btn of document.querySelectorAll('[data-goto]')) {
  btn.addEventListener('click', () => show(btn.dataset.goto));
}
