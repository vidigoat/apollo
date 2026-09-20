/**
 * Nemotron, via Nebius Token Factory (OpenAI-compatible).
 *
 * Two sizes, used for two different jobs, because they cost two different amounts:
 *
 *   Nano   every changed package, ~14 calls a run   — "is this worth a bigger model's time?"
 *   Ultra  only what Nano or the rules flagged      — "what is this actually doing?"
 *
 * Running Ultra on all 1,214 packages would be the obvious thing and the wrong thing. The tree is
 * mostly boring, and paying frontier prices to be told so is how a tool like this dies in
 * procurement. Triage is the design.
 *
 * With no NEBIUS_API_KEY set, this falls back to a deterministic local judge so the project runs
 * and its tests pass offline. The fallback announces itself in every result — a simulated verdict
 * that looks like a real one is the most dishonest thing this repo could contain.
 */

const { Budget } = require('./budget');

const ENDPOINT = process.env.NEBIUS_BASE_URL || 'https://api.studio.nebius.com/v1/chat/completions';

/**
 * Model ids as published by Nebius. CONFIRM against the live model list before the submission run
 * — these are cheap to get wrong and expensive to discover wrong on stage.
 */
/*
 * The three model ids, as the registry actually spells them.
 *
 * All three of these were wrong until 2026-09-20, and wrong in the way that is hardest to notice:
 * they were plausible. `nvidia/NVIDIA-Nemotron-3-Ultra-550B` reads like a real identifier, matches
 * how the model is named in prose, and does not exist. The project had never called the API, so
 * nothing contradicted them — every run fell back to the offline judge, labelled itself
 * `simulated`, and looked like a deliberate no-key mode rather than three broken strings.
 *
 * The first real request returned `404 The model ... does not exist`, which is the API being good
 * at its job. `npm run preflight` now checks all three against GET /v1/models, so a typo or a
 * renamed model fails loudly instead of degrading into a simulation that looks intentional.
 */
const MODELS = {
  triage: process.env.NEMOTRON_NANO || 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
  judge: process.env.NEMOTRON_ULTRA || 'nvidia/Nemotron-3-Ultra-550b-a55b',
  second: process.env.SECOND_OPINION || 'nvidia/nemotron-3-super-120b-a12b',
};

/** Published blended rates, $ per million tokens. Used for the cost line, not for billing. */
/*
 * Published per-million rates. UNVERIFIED against a Nebius price list — they are the right order of
 * magnitude and the ranking between them is right, which is what the triage design depends on, but
 * no invoice has confirmed the absolute numbers. Treated the same way as the sandbox estimate in
 * pricing.js: usable for a ceiling, not quotable as a measured cost.
 */
const RATES = {
  [MODELS.triage]: { in: 0.08, out: 0.08 },
  [MODELS.judge]: { in: 1.0, out: 3.0 },
  [MODELS.second]: { in: 0.3, out: 0.9 },
};

const hasKey = () => Boolean(process.env.NEBIUS_API_KEY);

function costOf(model, usage) {
  const r = RATES[model] || { in: 0, out: 0 };
  const cost = ((usage?.prompt_tokens || 0) * r.in + (usage?.completion_tokens || 0) * r.out) / 1e6;
  return Number(cost.toFixed(6));
}

/**
 * One chat completion.
 * @returns {Promise<{text:string, model:string, costUsd:number, simulated:boolean}>}
 */
async function complete({ model, system, user, maxTokens = 400, temperature = 0, budget }) {
  if (!hasKey()) return simulate({ model, user });

  // Every paid call passes through here, so the ceiling lives here. Checked BEFORE the request:
  // a budget that only notices afterwards is a receipt, not a limit.
  const guard = budget || new Budget();
  guard.check({
    rate: RATES[model] || { in: 1, out: 3 },   // an unpriced model is assumed expensive
    maxTokens,
    promptChars: (system || '').length + (user || '').length,
    label: model,
  });

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.NEBIUS_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`nemotron ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  const costUsd = costOf(model, json.usage);

  // Recorded before the caller is told anything. A spend that happened and was not written down is
  // the one state this must never leave behind.
  guard.record(costUsd, { model });

  /*
   * Nemotron 3 is a REASONING model, and that changes the shape of this response.
   *
   * The working-out arrives in `message.reasoning`, separately from `message.content`, and it is
   * charged as completion tokens either way. So a `max_tokens` sized for the answer alone gets
   * spent on the thinking and `content` comes back EMPTY with `finish_reason: "stop"` — a
   * successful call, a real bill, and nothing to parse. The first live call here did exactly that
   * at max_tokens 60 and looked like a model that had declined to answer.
   *
   * The reasoning is kept rather than dropped. This project's whole posture is that the rules
   * decide and the model only explains, so the explanation showing its working is the more
   * honest artefact — and it is the thing a reader can actually argue with.
   */
  const message = json.choices?.[0]?.message ?? {};
  return {
    text: message.content ?? '',
    reasoning: typeof message.reasoning === 'string' ? message.reasoning : '',
    finishReason: json.choices?.[0]?.finish_reason ?? null,
    model,
    costUsd,
    simulated: false,
  };
}

/**
 * The offline stand-in.
 *
 * It reads the same evidence lines the model would, using the same vocabulary the prompt asks for.
 * It is not pretending to be clever: it exists so the pipeline around it can be built and tested
 * before the account is funded, and so a demo without a network still runs.
 */
function simulate({ model, user }) {
  const builds = /NOW BUILDS CODE\s+(\S+)/.exec(user);
  const reads = /NOW READS ENV\s+(\S+)/.exec(user);
  const conn = /NOW CONNECTS TO\s+(\S+)/.exec(user);
  const spawns = /NOW SPAWNS\s+(.+)/.exec(user);
  const unknown = /says nothing about this version/.test(user);

  let meaning = 'No difference in observable behaviour.';
  let worthWaking = false;

  if (builds && conn) {
    meaning = `Builds executable code at runtime (${builds[1].replace(/:$/, '')}) and then contacts ${conn[1]} — the payload was not in the source.`;
    worthWaking = true;
  } else if (builds) {
    meaning = `Turns a string into executable code at runtime (${builds[1].replace(/:$/, '')}), which the previous version never did.`;
    worthWaking = true;
  } else if (reads && conn) {
    meaning = `Reads ${reads[1]} and then opens a connection to ${conn[1]} — the shape of moving a secret off the machine.`;
    worthWaking = true;
  } else if (spawns) {
    meaning = `Starts a process it never started before: ${spawns[1].trim()}.`;
    worthWaking = true;
  } else if (conn) {
    meaning = `Contacts ${conn[1]}, which the previous version never contacted.`;
    worthWaking = unknown;
  } else if (/NOW TOUCHES FILE/.test(user)) {
    meaning = 'Writes to a path the previous version left alone.';
  } else if (reads) {
    // Env-only. Usually a feature flag — NO_COLOR, CI, FORCE_COLOR — and worth naming rather than
    // reporting as "no difference", which is what this said before picocolors@1.1.1 proved it wrong.
    const all = [...user.matchAll(/NOW READS ENV\s+(\S+)/g)].map((m) => m[1]);
    meaning = `Reads ${all.join(', ')}, which the previous version never read.`;
  }

  return Promise.resolve({
    text: JSON.stringify({
      meaning,
      explained: !unknown,
      worthWaking,
      confidence: reads && conn ? 'high' : 'medium',
      note: '',
    }),
    model,
    costUsd: 0,
    simulated: true,
  });
}

module.exports = { complete, MODELS, RATES, costOf, hasKey, Budget };
