/**
 * Which provocations are worth trying, and why — chosen by Nemotron, on Token Factory.
 *
 * Interrogation can run all of them, but which one a package is likely to bite on is a judgement:
 * a package that read `process.env.CI` and pulled in a crypto library in its bare run is worth the
 * wallet and CI provocations before the clock one. Nemotron is given the package name and what the
 * bare run already saw, and orders the catalogue with a one-line reason each. It chooses from a
 * FIXED list of ids — it never invents a provocation, and nothing it returns is executed. An id it
 * makes up is dropped; any it omits are appended, so every provocation is still run, just in the
 * order the model argued for. Without a key it falls back to the catalogue order, said plainly.
 *
 * This is the Coding & Agentic use of the model that the track asks for: an agent reasoning about
 * how to probe code, over a safe, closed action space.
 */

const { complete, MODELS } = require('../judge/nemotron');
const { PROVOCATIONS } = require('./provocations');

const SYSTEM =
  'You choose how to interrogate an npm package for hidden malicious behaviour. You are given the ' +
  'package name and what it did in a plain sandbox. Order the provided provocation ids by how likely ' +
  'each is to draw out hidden behaviour in THIS package, most promising first, each with a short ' +
  'reason. Only use ids from the list. Return JSON: {"order":[{"id":"...","why":"..."}]}. Nothing else.';

function baselineSummary(baseline) {
  const ch = baseline?.channels || {};
  const parts = Object.entries(ch).filter(([, n]) => n > 0).map(([c, n]) => `${c}:${n}`);
  return parts.length ? parts.join(', ') : 'nothing observable';
}

/** Parse the model's ordering, keeping only real ids, appending any it left out. */
function applyOrder(text, ids) {
  let order = [];
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    order = Array.isArray(j.order) ? j.order : [];
  } catch { order = []; }
  const seen = new Set();
  const ranked = [];
  for (const o of order) {
    const id = o && typeof o === 'object' ? o.id : o;
    if (ids.includes(id) && !seen.has(id)) { seen.add(id); ranked.push({ id, why: String(o.why || '').slice(0, 200) }); }
  }
  for (const id of ids) if (!seen.has(id)) ranked.push({ id, why: 'not ranked by the model; run anyway' });
  return ranked;
}

async function rankProvocations({ pkg, baseline, provocations = PROVOCATIONS, budget, complete: completeImpl = complete } = {}) {
  // 'bare' is the baseline, always first, never a choice.
  const choosable = provocations.filter((p) => p.id !== 'bare');
  const ids = choosable.map((p) => p.id);
  const user =
    `Package: ${pkg}\nIn a plain sandbox it touched: ${baselineSummary(baseline)}\n\n` +
    `Provocations to order (id — what it simulates):\n${choosable.map((p) => `- ${p.id}: ${p.why}`).join('\n')}`;
  let res;
  try {
    res = await completeImpl({ model: MODELS.triage, system: SYSTEM, user, maxTokens: 400, temperature: 0, budget });
  } catch (e) {
    return { order: ids.map((id) => ({ id, why: 'model unavailable; catalogue order' })), model: null, simulated: true, error: String(e.message).slice(0, 160) };
  }
  return { order: applyOrder(res.text, ids), model: res.model, simulated: Boolean(res.simulated), costUsd: res.costUsd ?? null };
}

module.exports = { rankProvocations, applyOrder, baselineSummary, SYSTEM };
