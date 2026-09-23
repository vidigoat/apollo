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

const { buildPrompt, PROMPT_REVISION } = require('./prompt');
const { complete, MODELS } = require('./nemotron');
const { JudgementCache } = require('./cache');

/** One per process. Built lazily so importing this module never touches the filesystem. */
let _judgeCache;
const defaultJudgeCache = () => (_judgeCache ||= new JudgementCache());

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

/**
 * The model's working-out, cut to a readable length.
 *
 * Truncated because it is evidence for a person, not a transcript for a machine — but cut at a
 * WORD boundary. A hard `slice(600)` ended the most interesting sentence on the page mid-word:
 * "Actually they used ebpf which cannot observe e". That sentence is the prompt's blind-spot
 * caveat visibly working — the model reasoning about what the strategy could not see — and it read
 * as a rendering bug.
 */
function trimReasoning(text, limit = 700) {
  if (typeof text !== 'string' || !text) return '';
  const clean = text.trim();
  if (clean.length <= limit) return clean;

  const cut = clean.slice(0, limit);
  // Prefer the last sentence end; fall back to the last space. Never mid-word.
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  const at = sentence > limit * 0.6 ? sentence + 1 : cut.lastIndexOf(' ');
  return `${cut.slice(0, at > 0 ? at : limit).trimEnd()}…`;
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

  /*
   * Ask the cache before asking a model.
   *
   * A verdict is a function of the evidence, the prompt and the models, and none of those changed
   * between two loads of the same page. Re-judging is paying to be told the same thing again —
   * which is precisely the waste this project exists to point at, so it should not be committing it.
   * Opt out with `deps.judgeCache = null`, which the test suites do so they never touch a real one.
   */
  const cache = deps.judgeCache === undefined ? defaultJudgeCache() : deps.judgeCache;
  // The prompt only differs from before when the diff has an install phase, so only then does its
  // revision join the key — every verdict already committed for the demo corpus stays valid.
  const cacheJob = { diff: d, models: MODELS, record, ...(d.install ? { prompt: PROMPT_REVISION } : {}) };
  if (cache && d.changed) {
    const hit = cache.get(cacheJob);
    if (hit) return hit;
  }
  const spend = [];
  /*
   * The spend record also carries the model's working-out.
   *
   * Nemotron 3 returns its reasoning separately from its answer, and this project's whole posture
   * is that the RULES decide severity and the model only ever explains. An explanation that shows
   * how it got there is the more honest artefact — and the only one a reader can actually argue
   * with. It is truncated because it is evidence for a person, not a transcript for a machine.
   */
  const track = (r) => {
    spend.push({
      model: r.model,
      costUsd: r.costUsd,
      simulated: r.simulated,
      reasoning: trimReasoning(r.reasoning),
    });
    return r;
  };

  // Nothing changed. There is no evidence to reason about, and paying a model to say so is theatre.
  if (!d.changed) {
    return { pkg: d.pkg, severity: d.severity, judged: false, reason: 'no behavioural change', spend, costUsd: 0 };
  }

  const { system, user } = buildPrompt(d, record);

  // 1. Triage — cheap, runs on everything that moved.
  const triage = parseVerdict((track(await call({ model: MODELS.triage, system, user, maxTokens: 700 }))).text);

  const worthIt = ALWAYS_JUDGE.has(d.severity) || triage?.worthWaking === true;
  if (!worthIt) {
    const settled = {
      pkg: d.pkg, severity: d.severity, judged: true, tier: 'triage',
      verdict: triage, accused: false,
      reason: triage ? 'triage saw nothing that needs a human tonight' : 'triage returned nothing usable',
      spend, costUsd: total(spend),
    };
    /*
     * Cache this one too.
     *
     * It was missed on the first pass because it is an early return and the cache write sat at the
     * bottom of the function — so every `minor` package that triage decided to sleep on was
     * re-triaged on every single run, for ever. Which is the more expensive half of the mistake:
     * the whole design is that triage runs on EVERYTHING that moved and the expensive models run
     * on almost nothing, so the calls that never get cached are the numerous ones.
     *
     * A triage verdict that could not be parsed is not cached — `settled.verdict` is null there,
     * and freezing "the model returned nothing usable" would make one bad response permanent.
     */
    if (cache && triage) cache.put(cacheJob, settled);
    return settled;
  }

  // 2. Judgement — the expensive model, on the handful that earned it.
  const verdict = parseVerdict((track(await call({ model: MODELS.judge, system, user, maxTokens: 1100 }))).text);
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
    second = parseVerdict((track(await call({ model: MODELS.second, system, user, maxTokens: 900 }))).text);
    accused = second?.worthWaking === true && second?.explained === false;
  }

  const judgement = {
    pkg: d.pkg,
    severity: d.severity,          // still the rules'. The model never moved it.
    judged: true,
    tier: 'judge',
    verdict,
    second,
    accused,
    reason: accused
      // Say what was actually found. This used to be the fixed phrase "credential exfiltration",
      // which was true of the only package that could reach this branch at the time — and became a
      // false accusation the moment a second kind of finding could. Accusing a maintainer of the
      // wrong thing is worse than accusing them vaguely.
      ? `two models, independently, read this as ${accusationFor(d)}`
      : second
        ? 'the second model did not agree — this needs a human, not an alert'
        : verdict.explained
          ? 'the public record accounts for this behaviour'
          : 'flagged for a human; not accused',
    spend,
    costUsd: total(spend),
  };

  if (cache) cache.put(cacheJob, judgement);
  return judgement;
}

/** What, precisely, two models agreed about. Derived from the evidence, never assumed. */
function accusationFor(d) {
  const credential = d.env.added.length > 0;
  const built = d.exec.added.some((e) => /^(Function|vm\.)/.test(e.how));
  const outbound = d.net.added.length > 0;
  const spawned = d.proc.added.length > 0;

  if (credential && outbound) return 'credential exfiltration';
  if (built && outbound) return 'a payload that was not in the source, reaching the network';
  if (built) return 'code assembled at runtime that the source does not contain';
  if (spawned && outbound) return 'a spawned process reaching the network';
  if (credential) return 'a credential read that the previous version did not make';
  return 'behaviour that needs a person to look at it';
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

module.exports = { judgeOne, judgeRun, parseVerdict, trimReasoning };
