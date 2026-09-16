#!/usr/bin/env node
/**
 * Generate the README's screenshots from a real run.
 *
 *   npm run capture
 *
 * Headless Chrome, the actual server, the actual corpus. The rule in docs/images/README.md is that
 * no number in a screenshot may be retouched — the simplest way to keep that rule is to never
 * touch one, so these are produced by the same code path a visitor sees.
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME =
  process.env.CHROME ||
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
   '/Applications/Chromium.app/Contents/MacOS/Chromium',
   '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('No Chrome found. Set CHROME=/path/to/chrome, or capture by hand — recipes are in docs/images/README.md');
  process.exit(1);
}

const OUT = path.join(__dirname, '..', 'docs', 'images');
const PORT = 8792; // not 8791, so this never fights a server you already have open
const BASE = `http://localhost:${PORT}`;

/** the section to frame, and how tall a window to frame it in */
const SHOTS = [
  { file: 'hero-wall.png', only: 'wall-section', size: '1440,1500' },
  { file: 'wall-silence.png', only: 'wall-section', size: '1440,620' },
  { file: 'catch-panel.png', only: 'catch-section', size: '1440,860' },
  { file: 'blind-spot.png', only: 'blind-section', size: '1440,640' },
  { file: 'fork-strip.png', only: 'run-section', size: '1440,520' },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  process.on('exit', () => server.kill());

  // Wait for it rather than guessing at a sleep.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/tree`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  for (const shot of SHOTS) {
    const url = `${BASE}/?run=1&only=${shot.only}`;
    const dest = path.join(OUT, shot.file);
    execFileSync(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      `--window-size=${shot.size}`,
      '--virtual-time-budget=6000', // let the run finish and the fonts land
      `--screenshot=${dest}`,
      url,
    ], { stdio: 'ignore' });

    const kb = Math.round(fs.statSync(dest).size / 1024);
    console.log(`  ${shot.file.padEnd(20)} ${shot.size.padEnd(10)} ${kb} kB${kb < 12 ? '   ← suspiciously small, check it' : ''}`);
  }

  server.kill();
  console.log(`\n${SHOTS.length} screenshots in docs/images/ — from a real run, with nothing retouched.`);
})();
