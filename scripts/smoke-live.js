#!/usr/bin/env node
/**
 * Every route the deployed site serves, asked once, after a deploy.
 *
 *   npm run smoke:live                       # https://apollo-watch.vercel.app
 *   npm run smoke:live -- https://preview-url
 *
 * The hosted functions are a compiled bundle, and a bundle can break what every local test passes:
 * on 23 September /api/tree answered 500 on the page every judge opens first — the list it returns
 * came through a module with side effects, and in the bundle it arrived undefined — while the suite
 * was green. So this asks the real URL, the way a visitor's browser does, and fails on anything that
 * is not the answer a visitor should get. Runs nothing in a sandbox; /api/watch is left out because
 * it spends one.
 */

const BASE = (process.argv[2] || 'https://apollo-watch.vercel.app').replace(/\/$/, '');

const CHECKS = [
  ['GET', '/', 200, (t) => /<div id="root"|<html/i.test(t)],
  ['GET', '/api/tree', 200, (t) => JSON.parse(t).realJobs.length > 0],
  ['GET', '/api/fleet', 200, (t) => JSON.parse(t).totals.depVersions > 0],
  ['GET', '/api/run', 200, (t) => t.length > 100],
  ['GET', '/index.json', 200, (t) => Object.keys(JSON.parse(t).packages).length > 1000],
  ['GET', '/release-watch.json', 200, (t) => Object.keys(JSON.parse(t).results).length > 0],
  ['GET', '/probe.source.txt', 200, (t) => t.includes('APOLLO_INSTALL_DIR')],
  ['POST', '/api/lockfile', 200, (t) => JSON.parse(t).total === 1, { lockfile: JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/ms': { version: '2.1.3' } } }) }],
  ['POST', '/api/lockfile', 400, (t) => /lockfile/i.test(JSON.parse(t).error), { lockfile: 'not json' }],
  ['POST', '/api/watch', 400, (t) => Boolean(JSON.parse(t).error), { pkg: '../etc', from: '1.0.0', to: '1.0.1' }],
];

(async () => {
  let bad = 0;
  for (const [method, route, want, ok, body] of CHECKS) {
    const started = Date.now();
    let line;
    try {
      const res = await fetch(`${BASE}${route}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let good = res.status === want;
      try { good = good && ok(text); } catch { good = false; }
      if (!good) bad++;
      line = `${good ? 'ok  ' : 'FAIL'} ${res.status} ${method.padEnd(4)} ${route}${good ? '' : `  ${text.slice(0, 120).replace(/\s+/g, ' ')}`}`;
    } catch (e) {
      bad++;
      line = `FAIL ---  ${method.padEnd(4)} ${route}  ${e.message}`;
    }
    console.log(`  ${line}  ${Date.now() - started}ms`);
  }
  console.log(bad ? `\n  ${bad} route(s) wrong on ${BASE}\n` : `\n  every route answered as it should on ${BASE}\n`);
  process.exitCode = bad ? 1 : 0;
})();
