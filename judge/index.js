/**
 * From "something changed" to "wake someone up".
 *
 *   rules (differ/)          →  severity. Arithmetic. Reproducible. Never overridden by a model.
 *   Nemotron Nano            →  triage. Is this worth a bigger model's time?
 *   Nemotron Ultra           →  meaning. What does this change appear to be doing?
 *   a second, different model →  veto. Nothing is accused unless two models independently agree.
 *
 * The ordering matters and the direction matters. A model here can EXPLAIN a finding, and it can
 * TALK ONE DOWN — "the changelog documents this endpoint, it is fine". It can never talk one up.
 * Escalation stays with rules you can read in thirty lines, because the day this tool wrongly
 * accuses a real maintainer of shipping malware is the day it stops being installed.
 */

const { buildPrompt } = require('./prompt');
const { complete, MODELS } = require('./nemotron');

const SHAPE = ['meaning', 'explained', 'worthWaking', 'confidence'];

/**
 * A model's reply is untrusted too — it read attacker-controlled text.
 * Anything that is not exactly the shape we asked for is discarded, not salvaged.
 */
function parseVerdict(text) {
  let v;
  try {
    v = JSON.parse(String(text).trim().replace(/^```(?:json)?|```$/g, ''));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (!SHAPE.every((k) => k in v)) return null;
  if (typeof v.meaning !== 'string' || !v.meaning.trim()) return null;
  if (typeof v.explained !== 'boolean' || typeof v.worthWaking !== 'boolean') return null;
  if (!['high', 'medium', 'low'].includes(v.confidence)) return null;

  return {
    meaning: v.meaning.slice(0, 400),
    explained: v.explained,
    worthWaking: v.worthWaking,
    confidence: v.confidence,
    note: typeof v.note === 'string' ? v.note.slice(0, 300) : '',
  };
}

/** Rules-only severities that always earn a real look, whatever triage thinks. */
const ALWAYS_JUDGE = new Set(['alarming', 'notable']);

/**
 * Judge one package.
 *
 * @param {object} d        diff from differ/diff.js
 * @param {object} record   what the open web says (Tavily, or the recorded stand-in)
 * @param {object} [deps]   { complete } — injectable so tests never touch a network
 */
async function judgeOne(d, record, deps = {}) {
  const call = deps.complete || complete;
  const spend = [];
  const track = (r) => { spend.push({ model: r.model, costUsd: r.costUsd, simulated: r.simulated }); return r; };

  // Nothing changed. There is no evidence to reason about, and paying a model to say so is theatre.
  if (!d.changed) {
    return { pkg: d.pkg, severity: d.severity, judged: false, reason: 'no behavioural change', spend, costUsd: 0 };
  }

  const { system, user } = buildPrompt(d, record);

  // 1. Triage — cheap, runs on everything that moved.
  const triage = parseVerdict((track(await call({ model: MODELS.triage, system, user, maxTokens: 220 }))).text);

  const worthIt = ALWAYS_JUDGE.has(d.severity) || triage?.worthWaking === true;
  if (!worthIt) {
    return {
      pkg: d.pkg, severity: d.severity, judged: true, tier: 'triage',
      verdict: triage, accused: false,
      reason: triage ? 'triage saw nothing that needs a human tonight' : 'triage returned nothing usable',
      spend, costUsd: total(spend),
    };
  }

  // 2. Judgement — the expensive model, on the handful that earned it.
  const verdict = parseVerdict((track(await call({ model: MODELS.judge, system, user, maxTokens: 400 }))).text);
  if (!verdict) {
    return {
      pkg: d.pkg, severity: d.severity, judged: true, tier: 'judge', verdict: null, accused: false,
      reason: 'the model returned something that was not a verdict; falling back to the rules',
      spend, costUsd: total(spend),
    };
  }

  // 3. Veto — an accusation needs two independent models. One model is an opinion.
  let accused = false;
  let second = null;
  if (d.severity === 'alarming' && verdict.worthWaking && !verdict.explained) {
    second = parseVerdict((track(await call({ model: MODELS.second, system, user, maxTokens: 300 }))).text);
    accused = second?.worthWaking === true && second?.explained === false;
  }

  return {
    pkg: d.pkg,
    severity: d.severity,          // still the rules'. The model never moved it.
    judged: true,
    tier: 'judge',
    verdict,
    second,
    accused,
    reason: accused
      ? 'two models, independently, read this as credential exfiltration'
      : second
        ? 'the second model did not agree — this needs a human, not an alert'
        : verdict.explained
          ? 'the public record accounts for this behaviour'
          : 'flagged for a human; not accused',
    spend,
    costUsd: total(spend),
  };
}

const total = (spend) => Number(spend.reduce((s, x) => s + (x.costUsd || 0), 0).toFixed(6));

/** Judge a whole run. Quiet packages cost nothing and are answered without a model. */
async function judgeRun(pairs, deps = {}) {
  const results = [];
  for (const p of pairs) results.push(await judgeOne(p.diff, p.record, deps));
  return {
    results,
    costUsd: Number(results.reduce((s, r) => s + r.costUsd, 0).toFixed(6)),
    modelCalls: results.reduce((s, r) => s + r.spend.length, 0),
    accused: results.filter((r) => r.accused).map((r) => r.pkg),
    simulated: results.some((r) => r.spend.some((s) => s.simulated)),
  };
}

module.exports = { judgeOne, judgeRun, parseVerdict };
