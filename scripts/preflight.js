#!/usr/bin/env node
/**
 * Everything that can only be checked once the keys exist.
 *
 *   npm run preflight
 *
 * The riskiest thing in this repository is not the code — it is tested. It is the handful of
 * assumptions about other people's APIs that have never been exercised: whether those model ids
 * exist, whether the endpoint takes the body we send, whether the response has the shape we read.
 * Each of those is cheap to get wrong and expensive to discover wrong on submission night.
 *
 * So this runs them, for a few thousandths of a dollar, and says exactly what is not ready.
 * It changes nothing and writes nothing.
 */

const { MODELS, RATES } = require('../judge/nemotron');
const { buildPrompt } = require('../judge/prompt');
const { parseVerdict } = require('../judge');
const { lookUp } = require('../evidence/tavily');
const { transcript } = require('../transcript/schema');
const { diff } = require('../differ/diff');

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', amber: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', amber: '', bold: '', off: '' };

const results = [];
const ok = (what, detail = '') => { results.push(true); console.log(`  ${C.green}✓${C.off} ${what}${detail ? `  ${C.dim}${detail}${C.off}` : ''}`); };
const no = (what, why) => { results.push(false); console.log(`  ${C.red}✗${C.off} ${what}\n      ${C.dim}${why}${C.off}`); };
const skip = (what, why) => { console.log(`  ${C.amber}–${C.off} ${what}\n      ${C.dim}${why}${C.off}`); };

/** A small, real diff to judge — the same shape the pipeline produces. */
const SAMPLE = diff(
  transcript({ pkg: 'preflight-sample', version: '1.0.0', strategy: 'nodert', raw: {} }),
  transcript({
    pkg: 'preflight-sample', version: '1.0.1', strategy: 'nodert',
    raw: { env: ['AWS_SECRET_ACCESS_KEY'], net: [{ host: 'example.invalid', port: 443, proto: 'tcp' }] },
  })
);

async function nebius() {
  console.log(`\n${C.bold}Nebius / Nemotron${C.off}`);
  if (!process.env.NEBIUS_API_KEY) {
    return skip('NEBIUS_API_KEY', 'not set — the judge falls back to a local stand-in, labelled as simulated');
  }

  // 1. Do the model ids exist? This is the assumption most likely to be wrong.
  let available = null;
  try {
    const base = (process.env.NEBIUS_BASE_URL || 'https://api.studio.nebius.com/v1/chat/completions')
      .replace(/\/chat\/completions$/, '');
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${process.env.NEBIUS_API_KEY}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
    available = new Set(((await res.json()).data || []).map((m) => m.id));
    ok('the key works', `${available.size} models visible`);
  } catch (e) {
    no('could not list models', e.message);
  }

  for (const [role, id] of Object.entries(MODELS)) {
    if (available && !available.has(id)) {
      const near = [...available].filter((m) => /nemotron/i.test(m)).slice(0, 4);
      no(`${role}: ${id}`, near.length
        ? `not in the model list. Nemotron models that ARE available: ${near.join(', ')}`
        : 'not in the model list, and no Nemotron model was found at all');
      continue;
    }

    // 2. Does a real call come back in the shape judge/index.js requires?
    try {
      const { system, user } = buildPrompt(SAMPLE, null);
      const { complete } = require('../judge/nemotron');
      const r = await complete({ model: id, system, user, maxTokens: 300 });
      const verdict = parseVerdict(r.text);
      if (!verdict) {
        no(`${role}: ${id}`, `replied, but not with a verdict this pipeline accepts: ${String(r.text).slice(0, 140)}`);
      } else {
        ok(`${role}: ${id}`, `$${r.costUsd.toFixed(6)} · "${verdict.meaning.slice(0, 60)}…"`);
      }
    } catch (e) {
      no(`${role}: ${id}`, e.message);
    }
  }

  const unpriced = Object.values(MODELS).filter((m) => !RATES[m]);
  if (unpriced.length) no('cost accounting', `no published rate for: ${unpriced.join(', ')} — the bill will read $0`);
  else ok('cost accounting', 'every model in use has a rate');
}

async function tavily() {
  console.log(`\n${C.bold}Tavily${C.off}`);
  if (!process.env.TAVILY_API_KEY) {
    return skip('TAVILY_API_KEY', 'not set — the public record comes from the recorded corpus, labelled as simulated');
  }
  try {
    // A real package with a real, findable release. If this comes back with nothing, the query or
    // the result shape is wrong — and "nothing found" is a load-bearing answer in this pipeline,
    // so a broken lookup would quietly manufacture findings.
    const r = await lookUp('express', '4.18.2');
    if (r.simulated) return no('live lookup', 'returned a simulated answer despite a key being set');
    if (r.mentions === 0 && !r.changelog) {
      no('live lookup', 'a widely-released version came back with no record at all — check the query or the result shape');
    } else {
      ok('live lookup', `${r.mentions} mentions${r.changelog ? ', changelog found' : ''}`);
    }
  } catch (e) {
    no('live lookup', e.message);
  }
}

async function sandboxes() {
  console.log(`\n${C.bold}Nebius Sandboxes${C.off}`);
  if (!process.env.NEBIUS_API_KEY) return skip('sandboxes', 'no key; the simulated adapter is in use');
  try {
    const { ConTreeSandboxes } = require('../adapters/contree');
    const a = new ConTreeSandboxes({ image: 'node:22' });
    const checkpoint = await a.boot();
    ok('boot + checkpoint', String(checkpoint));
    const branches = await a.fork(checkpoint, 2);
    ok('fork two twins from one checkpoint', branches.map((b) => b.id).join(', '));
    for (const b of branches) await a.discard(b);
    ok('discard', `${a.open} left open`);
  } catch (e) {
    no('sandboxes', `${e.message}\n      This is expected until access is granted. Everything runs on the simulated adapter meanwhile.`);
  }
}

(async () => {
  console.log(`${C.bold}STAKEOUT preflight${C.off}  ${C.dim}— the assumptions that only a real key can check${C.off}`);
  await nebius();
  await tavily();
  await sandboxes();

  const failed = results.filter((r) => !r).length;
  console.log(`\n${'─'.repeat(70)}`);
  if (!results.length) {
    console.log(`${C.amber}Nothing to check — no keys are set.${C.off} Everything runs on labelled stand-ins.`);
  } else if (failed) {
    console.log(`${C.red}${failed} of ${results.length} checks failed.${C.off} Fix these before a scored run.`);
    process.exitCode = 1;
  } else {
    console.log(`${C.green}All ${results.length} checks passed.${C.off} The live path works end to end.`);
  }
})();
