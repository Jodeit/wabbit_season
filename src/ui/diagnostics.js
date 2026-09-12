import { $ } from '../core/util.js';

/**
 * On-device diagnostics.
 *
 * This game is a static site on GitHub Pages: there is no server, no logging
 * and no telemetry, so nothing about a play session reaches anyone but the
 * player. That is the right default for an app pointed at someone's bedroom,
 * but it does mean a bug report is whatever the player can describe.
 *
 * So the troubleshooting state is collected locally and shown on demand, with
 * a copy button. Nothing is transmitted; the player chooses what to share.
 */

const state = {
  build: document.body.dataset.build || 'dev',
  mode: null,
  xr: null,
  errors: [],
};

export function noteMode(mode, detail = {}) {
  state.mode = mode;
  state.xr = { ...state.xr, ...detail };
}

export function noteError(where, err) {
  state.errors.push(`${where}: ${err?.message ?? err}`);
  if (state.errors.length > 8) state.errors.shift();
}

window.addEventListener('error', (e) => noteError('window', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => noteError('promise', e.reason));

/** @param {object} live  counters sampled at the moment the panel opens */
export function snapshot(live = {}) {
  return {
    build: state.build,
    url: location.href,
    mode: state.mode ?? 'not started',
    ...state.xr,
    ...live,
    viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
    secureContext: window.isSecureContext,
    hasXR: !!navigator.xr,
    hasCamera: !!navigator.mediaDevices?.getUserMedia,
    hasOrientation: typeof window.DeviceOrientationEvent !== 'undefined',
    ua: navigator.userAgent,
    errors: state.errors.length ? state.errors : 'none',
  };
}

export function install(getLive) {
  const panel = $('#diag');
  const body = $('#diag-body');
  const open = () => {
    const data = snapshot(getLive?.() ?? {});
    body.textContent = Object.entries(data)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? `\n  ${v.join('\n  ')}` : v}`)
      .join('\n');
    panel.hidden = false;
  };

  $('#btn-diag')?.addEventListener('click', open);
  $('#diag-close').addEventListener('click', () => { panel.hidden = true; });
  $('#diag-copy').addEventListener('click', async () => {
    const text = body.textContent;
    try {
      await navigator.clipboard.writeText(text);
      $('#diag-copy').textContent = 'Copied';
    } catch {
      // Clipboard is blocked in plenty of embedded webviews; selecting the
      // text is a workable fallback and beats a silent no-op.
      const range = document.createRange();
      range.selectNodeContents(body);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      $('#diag-copy').textContent = 'Select & copy';
    }
    setTimeout(() => { $('#diag-copy').textContent = 'Copy'; }, 2000);
  });

  $('#build-id').textContent = state.build;
  return { open };
}
