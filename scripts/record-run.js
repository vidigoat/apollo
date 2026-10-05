#!/usr/bin/env node
/**
 * A screen recording of Apollo running on the site — real footage for the video.
 *
 *   node scripts/record-run.js [https://apollo-watch.vercel.app]
 *
 * Presses the same buttons a person would: runs the watch with ebpf, opens the finding,
 * then switches what was watching to nodert — the shot where the same tree is re-judged by a
 * strategy that sees a string become a function, which a kernel tracer never does. Nothing is
 * retaken. The run on the site is the bundled corpus, labelled as planted on the page itself.
 * Writes docs/media/run.webm. Needs Playwright (not a dependency).
 */
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Needs Playwright (not a dependency of this project): npm i -g playwright, or set NODE_PATH.');
  process.exit(1);
}
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'https://apollo-watch.vercel.app';
const OUT = path.join(__dirname, '..', 'docs', 'media');

(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } } });
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(3500); // the hero, long enough to read
  const run = p.getByRole('button', { name: /Run the watch/i });
  await run.scrollIntoViewIfNeeded();
  await p.evaluate(() => window.scrollBy(0, -120));
  await p.waitForTimeout(1500);
  await p.getByRole('tab', { name: 'ebpf' }).click();
  await run.click();
  await p.waitForFunction(() => /twins/.test(document.querySelector('.status')?.textContent || ''), null, { timeout: 60000 });
  await p.waitForTimeout(2500);
  await p.mouse.wheel(0, 420);
  await p.waitForTimeout(4500); // the finding: env, net, proc — and what Nemotron made of it
  await p.mouse.wheel(0, -420);
  await p.waitForTimeout(1200);
  await p.getByRole('tab', { name: 'nodert' }).click();
  await p.waitForFunction(() => /twins/.test(document.querySelector('.status')?.textContent || ''), null, { timeout: 60000 });
  await p.waitForTimeout(2500);
  await p.mouse.wheel(0, 420);
  await p.waitForTimeout(5000);
  const video = p.video();
  await ctx.close();
  const file = path.join(OUT, 'run.webm');
  fs.renameSync(await video.path(), file);
  console.log(file);
  await b.close();
})();
