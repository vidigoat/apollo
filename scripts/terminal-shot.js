#!/usr/bin/env node
/**
 * A screenshot of `npm run demo`, taken without a human holding a camera.
 *
 *   npm run terminal-shot
 *
 * A terminal screenshot taken by hand depends on somebody's font, somebody's theme and somebody's
 * window width, and it goes stale silently the moment the demo's output changes. The demo here is
 * deterministic by design — that is the whole point of the fixture — so the screenshot should be
 * too.
 *
 * The output is deterministic, so it does not need a person. This runs the demo, converts its ANSI
 * colours to HTML, and screenshots that. The result is the real output of the real command; nothing
 * is retyped and nothing is arranged.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME =
  process.env.CHROME ||
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
   '/Applications/Chromium.app/Contents/MacOS/Chromium',
   '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('No Chrome found. Set CHROME=/path/to/chrome.');
  process.exit(1);
}

/** The sixteen colours a terminal has, as a terminal actually shows them. */
const SGR = {
  0: null,          // reset
  1: 'b',           // bold
  2: 'dim',
  31: '#e0574a', 32: '#6fbf73', 33: '#d9a441', 34: '#6f9fd8',
  35: '#b48ead', 36: '#5fb3b3', 37: '#d8dee9',
};

const esc = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/**
 * ANSI to HTML.
 *
 * Deliberately small: this handles the codes the demo actually emits — bold, dim, and the eight
 * foreground colours — and passes anything else through as text rather than guessing. A converter
 * that silently drops an unknown code would produce a screenshot missing something that was there.
 */
function ansiToHtml(text) {
  let out = '';
  let open = 0;
  const parts = text.split(/\x1b\[([0-9;]*)m/);

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) { out += esc(parts[i]); continue; }

    for (const raw of parts[i].split(';')) {
      const code = Number(raw || '0');
      if (code === 0) { out += '</span>'.repeat(open); open = 0; continue; }
      const v = SGR[code];
      if (v === 'b') { out += '<span style="font-weight:600">'; open++; }
      else if (v === 'dim') { out += '<span style="opacity:.55">'; open++; }
      else if (v) { out += `<span style="color:${v}">`; open++; }
      // Anything else: no styling, no loss — the text still lands.
    }
  }
  return out + '</span>'.repeat(open);
}

const page = (body, rows) => `<!doctype html><meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&display=swap');
  *{box-sizing:border-box;margin:0}
  body{background:#15171a;padding:26px 30px;font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;
       font-size:13.5px;line-height:1.55;color:#d8dee9;-webkit-font-smoothing:antialiased}
  .bar{display:flex;gap:7px;margin-bottom:18px}
  .bar i{width:11px;height:11px;border-radius:50%;display:block}
  pre{white-space:pre;margin:0}
</style>
<div class="bar"><i style="background:#e0574a"></i><i style="background:#d9a441"></i><i style="background:#6fbf73"></i></div>
<pre>${body}</pre>`;

const OUT = path.join(__dirname, '..', 'docs', 'images', 'terminal.png');

// Colour forced on, because a piped child process is not a TTY and would print no colour at all.
const raw = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'demo.js')], {
  encoding: 'utf8',
  env: { ...process.env, FORCE_COLOR: '1' },
  maxBuffer: 8 * 1024 * 1024,
});

const lines = raw.split('\n');
const widest = Math.max(...lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length));
const html = page(ansiToHtml(raw.trimEnd()), lines.length);

const tmp = path.join(os.tmpdir(), `term-${Date.now()}.html`);
fs.writeFileSync(tmp, html);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb',
  `--window-size=${Math.round(widest * 8.15) + 70},${Math.round(lines.length * 21) + 70}`,
  '--virtual-time-budget=4000',
  `--screenshot=${OUT}`, `file://${tmp}`,
], { stdio: 'ignore' });

fs.rmSync(tmp, { force: true });
console.log(`  docs/images/terminal.png  ${Math.round(fs.statSync(OUT).size / 1024)} kB · ${lines.length} lines, ${widest} cols`);
console.log('  The real output of the real command. Nothing retyped, nothing arranged.');
