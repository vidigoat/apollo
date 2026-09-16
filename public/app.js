/* STAKEOUT — the run, and the wall of silence it produces.
 *
 * Nothing here decides anything. Every severity, every delta, every verdict came back from the
 * server, which got it from a pure function over two transcripts.
 */

const $ = (s) => document.querySelector(s);
const stripEl = $('#strip');
const statusEl = $('#status');
const runBtn = $('#run');
const realBtn = $('#run-real');

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

let TREE = null;

async function boot() {
  TREE = await (await fetch('/api/tree')).json();
  $('#s-total').textContent = `${TREE.total.toLocaleString()} packages`;
  $('#s-moved').textContent = `${TREE.moved} moved`;
  $('#s-twins').textContent = '—';
  $('#s-cost').textContent = '—';
  statusEl.textContent = `${TREE.moved} versions moved · ${TREE.unchanged.toLocaleString()} unchanged and not re-run`;

  // The live run is only offered when the server was started with it enabled.
  const note = $('#realnote');
  if (TREE.realAllowed) {
    realBtn.hidden = false;
    note.textContent =
      `Live runs are on. "Run against the real registry" installs ${TREE.realJobs.map((j) => j.pkg).join(', ')} ` +
      'from npm and runs them here — really, not from a fixture. It takes about a minute.';
  } else {
    note.textContent =
      'This run is a fixture, so it is deterministic and anyone can check it. To watch real ' +
      'packages instead, start the server with STAKEOUT_ALLOW_LOCAL=1 — read adapters/local.js first.';
  }
  note.hidden = false;

  stripEl.innerHTML = '';
  for (let i = 0; i < TREE.moved * 2; i++) {
    const mark = document.createElement('i');
    mark.className = 'mark';
    stripEl.appendChild(mark);
  }
}

/* ── the transcript, as two columns ───────────────────────────────── */

function lines(t, d, side) {
  const out = [];
  const add = (field, render) => {
    const items = t[field] || [];
    const changedKeys = new Set(
      (side === 'after' ? d[field].added : d[field].removed).map((x) => render(x))
    );
    items.forEach((x) => {
      const text = render(x);
      out.push(`<li class="${changedKeys.has(text) ? 'is-delta' : ''}">${esc(text)}</li>`);
    });
  };

  add('net', (n) => `→ ${n.host}:${n.port}`);
  add('dns', (x) => `dns ${x}`);
  add('env', (e) => `env ${e}`);
  add('proc', (p) => `spawn ${p.argv.join(' ')}`);
  add('fs', (f) => `${f.op} ${f.path}`);

  if (out.length === 0) return '<li class="is-nothing">nothing observed</li>';
  return out.join('');
}

function row(p) {
  const d = p.diff;
  const quiet = !d.changed;
  // Only the two severities that actually get a colour are marked. A class that styles nothing is
  // indistinguishable from a typo six months from now.
  const sev = d.severity === 'alarming' || d.severity === 'notable' ? `sev-${d.severity}` : '';
  return `
    <article class="pair ${quiet ? 'is-quiet' : ''} ${sev}">
      <header class="pair__head">
        <span class="pair__name">${esc(p.pkg)}</span>
        <span class="pair__ver">${esc(p.from)} → ${esc(p.to)}</span>
        ${quiet ? '<span class="pair__verdict">no behavioural change</span>'
                : `<span class="pair__verdict is-changed">${esc(p.judgement?.verdict?.meaning || d.reasons[0] || 'changed')}</span>`}
      </header>
      ${quiet ? '' : `
      <div class="pair__cols">
        <div class="col"><span class="col__v">${esc(p.from)}</span><ul>${lines(p.before, d, 'before')}</ul></div>
        <div class="col"><span class="col__v">${esc(p.to)}</span><ul>${lines(p.after, d, 'after')}</ul></div>
      </div>`}
    </article>`;
}

/* ── what the models made of it ───────────────────────────────────── */

/**
 * Nemotron reads the diff, never the package. It is allowed to explain a finding and to talk one
 * down; it is never allowed to talk one up. So this panel shows the reading and the agreement —
 * and says plainly when nothing was accused.
 */
function judgementPanel(j) {
  if (!j?.verdict) return '';
  return `
    <div class="judge">
      <span class="record__k">what the models made of it${j.spend.some((s) => s.simulated) ? ' · simulated, no key set' : ''}</span>
      <p class="judge__read">${esc(j.verdict.meaning)}</p>
      <ul class="judge__chain">
        ${j.spend.map((s) => `<li><code>${esc(shortModel(s.model))}</code></li>`).join('')}
      </ul>
      <p class="judge__call ${j.accused ? 'is-accused' : ''}">${esc(j.reason)}</p>
    </div>`;
}

const shortModel = (m) => String(m).split('/').pop();

/* ── the catch ────────────────────────────────────────────────────── */

function catchPanel(p) {
  const d = p.diff;
  return `
    <article class="catch">
      <header>
        <span class="catch__sev">${esc(d.severity)}</span>
        <span class="catch__name">${esc(p.pkg)} ${esc(p.from)} → ${esc(p.to)}</span>
      </header>
      <ul class="catch__reasons">${d.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <pre class="catch__transcript">${[
        ...d.env.added.map((e) => `env      ${e}`),
        ...d.dns.added.map((x) => `dns      ${x}`),
        ...d.net.added.map((n) => `connect  ${n.host}:${n.port}`),
        ...d.proc.added.map((x) => `spawn    ${x.argv.join(' ')}`),
        ...d.fs.added.map((f) => `${f.op.padEnd(8)} ${f.path}`),
      ].map(esc).join('\n')}</pre>
      ${p.record ? `
      <div class="record">
        <span class="record__k">what the open web says</span>
        <p class="record__v ${p.record.changelog ? '' : 'is-absent'}">${esc(p.record.verdict)}</p>
        ${p.record.changelog ? `<p class="record__note">${esc(p.record.changelog)}</p>` : ''}
      </div>` : ''}
      ${judgementPanel(p.judgement)}
    </article>`;
}

/* ── the run ──────────────────────────────────────────────────────── */

/** Draw a finished run. Identical for the fixture and the live registry — same shapes, same code. */
function present(result) {
  $('#s-twins').textContent = `${result.twinsForked} twins`;
  $('#s-cost').textContent = `$${result.costUsd}`;
  statusEl.textContent =
    `${result.twinsForked} twins · ${result.quiet} packages behaved identically · ` +
    `${result.pairs.filter((p) => p.diff.changed).length} changed · ` +
    `${result.modelCalls} model calls · $${result.costUsd}` +
    (result.live ? ` · live, in ${(result.wallMs / 1000).toFixed(1)}s` : '');

  const cansee = $('#cansee');
  const missing = Object.entries(result.canSee || {}).filter(([, v]) => !v).map(([k]) => k);
  cansee.textContent = missing.length
    ? `Watched with "${result.strategy}", which cannot see: ${missing.join(', ')}. Silence in those columns is not evidence of quiet behaviour.`
    : `Watched with "${result.strategy}" — every channel, through Node's own API surface. A native addon goes underneath it.`;
  cansee.hidden = false;

  $('#wall').innerHTML = result.pairs.map(row).join('');
  $('#wall-section').hidden = false;

  const alarming = result.pairs.filter((p) => p.diff.severity === 'alarming');
  $('#catch').innerHTML = alarming.map(catchPanel).join('');
  $('#catch-section').hidden = alarming.length === 0;

  const invisible = result.pairs.filter((p) => p.invariant);
  $('#blind').innerHTML = invisible.map(blindPanel).join('');
  $('#blind-section').hidden = invisible.length === 0;
}

/** The live run: really installing, really importing, really slow. */
async function runReal() {
  realBtn.disabled = true;
  runBtn.disabled = true;
  [...stripEl.children].forEach((m) => (m.className = 'mark is-live'));
  statusEl.textContent = 'installing from npm and importing, for real — about a minute…';

  try {
    const payload = await (await fetch('/api/real')).json();
    if (payload.error) throw new Error(payload.error);
    stripEl.innerHTML = '';
    payload.pairs.forEach((p) => {
      for (let i = 0; i < 2; i++) {
        const mark = document.createElement('i');
        mark.className = `mark ${p.diff.changed ? `is-${p.diff.severity}` : 'is-quiet'}`;
        mark.title = `${p.pkg} ${p.from} → ${p.to}`;
        stripEl.appendChild(mark);
      }
    });
    present(payload);
  } catch (e) {
    statusEl.textContent = `live run failed: ${e.message}`;
  } finally {
    realBtn.disabled = false;
    runBtn.disabled = false;
  }
}

async function run() {
  runBtn.disabled = true;
  $('#wall-section').hidden = true;
  $('#catch-section').hidden = true;
  $('#blind-section').hidden = true;
  const marks = [...stripEl.children];
  marks.forEach((m) => (m.className = 'mark'));

  statusEl.textContent = 'booting one healthy machine…';
  await sleep(500);

  const result = await (await fetch('/api/run')).json();

  // One mark per twin, lighting up as the waves go.
  for (let i = 0; i < marks.length; i++) {
    marks[i].classList.add('is-live');
    if (i % 4 === 0) {
      statusEl.textContent = `forking twins… ${i + 1} of ${marks.length}`;
      await sleep(18);
    }
  }
  await sleep(200);

  // Then settle: the pairs that changed light differently.
  result.pairs.forEach((p, i) => {
    const a = marks[i * 2];
    const b = marks[i * 2 + 1];
    [a, b].forEach((m) => {
      if (!m) return;
      m.classList.remove('is-live');
      m.classList.add(p.diff.changed ? `is-${p.diff.severity}` : 'is-quiet');
      m.title = `${p.pkg} ${p.from} → ${p.to}`;
    });
  });

  present(result);

  runBtn.disabled = false;
  runBtn.textContent = 'Run again';
}

function blindPanel(p) {
  return `
    <article class="blind">
      <span class="blind__name">${esc(p.pkg)} ${esc(p.from)} → ${esc(p.to)}</span>
      <pre class="blind__probe">$ ${esc(p.invariant.probe)}\n${esc(p.invariant.output)}</pre>
      <p class="blind__note">${esc(p.invariant.note)}</p>
      ${p.record ? `<p class="record__note">Changelog: ${esc(p.record.changelog || 'nothing')}</p>` : ''}
    </article>`;
}

runBtn.addEventListener('click', run);
realBtn.addEventListener('click', runReal);

/**
 * Capture hook, for generating the README's screenshots from a real run rather than drawing them.
 *
 *   ?run=1              start a run without a click
 *   &only=<section-id>  show just that section, at the top of the window
 *
 * `only` rather than scrolling to an anchor: a scroll position depends on fonts, wrapping and when
 * the run finished, so it framed two of the five sections at empty space. Hiding the rest is
 * deterministic. It changes nothing a visitor sees — see docs/images/README.md.
 */
boot().then(() => {
  const q = new URLSearchParams(location.search);
  if (q.get('run') !== '1') return;
  return run().then(() => {
    const only = q.get('only');
    if (only) {
      document.querySelectorAll('.masthead, main > section, footer').forEach((el) => { el.hidden = true; });
      const target = document.getElementById(only);
      if (target) target.hidden = false;
    }
    document.body.dataset.ready = '1'; // what the capture script waits for
  });
});
