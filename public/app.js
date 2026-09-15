/* CASSANDRA — the run: one orchestrated page moment */

const $ = (s) => document.querySelector(s);
const sheetEl = $('#sheet');
const statusEl = $('#status');
const runBtn = $('#run');

let PLAN = null;
let REPORT = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

async function boot() {
  PLAN = await (await fetch('/api/plan')).json();
  REPORT = await (await fetch('/api/report')).json();

  $('#slate-total').textContent = PLAN.total;
  $('#slate-ckpt').textContent = PLAN.checkpoint;

  sheetEl.innerHTML = '';
  for (let i = 0; i < PLAN.total; i++) {
    const f = document.createElement('div');
    f.className = 'frame';
    f.dataset.i = i;
    sheetEl.appendChild(f);
  }
  statusEl.textContent = `idle — ${PLAN.total} scenarios queued`;
}

async function run() {
  runBtn.disabled = true;
  const frames = [...sheetEl.children];
  frames.forEach((f) => (f.className = 'frame'));
  $('#filed').hidden = true;
  $('#abstain').hidden = true;

  const failSet = new Set(PLAN.failedBranchIndexes);
  const step = reduced ? 0 : 1;

  for (let w = 0; w < PLAN.waves; w++) {
    const start = w * PLAN.wave;
    const end = Math.min(start + PLAN.wave, PLAN.total);
    statusEl.textContent = `wave ${w + 1}/${PLAN.waves} — forking ${end - start} twins from ${PLAN.checkpoint}`;

    for (let i = start; i < end; i++) frames[i].classList.add('is-live');
    await sleep(reduced ? 0 : 420);

    for (let i = start; i < end; i++) {
      frames[i].classList.remove('is-live');
      frames[i].classList.add(failSet.has(i) ? 'is-fail' : 'is-pass');
      if (step) await sleep(9);
    }
  }

  statusEl.textContent =
    `${PLAN.total} twins run · ${PLAN.failedBranchIndexes.length} branches failed · ` +
    `${REPORT.filed.length} filed after verification · $${REPORT.cost.usd} · ${REPORT.wall.seconds}s`;
  $('#slate-filed').textContent = REPORT.filed.length;

  renderFiled();
  renderAbstain();
  runBtn.disabled = false;
  runBtn.textContent = 'Run again';
}

function colourLog(lines) {
  return lines
    .map((l) => {
      const e = l.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      if (/VIOLATED|DELTA|✗|charged twice|RECOVERY LAG|still 503/.test(e)) return `<span class="hit">${e}</span>`;
      if (/✓|healthy at|passing/.test(e)) return `<span class="ok">${e}</span>`;
      return e;
    })
    .join('\n');
}

function colourDiff(lines) {
  return lines
    .map((l) => {
      const e = l.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      if (e.startsWith('-')) return `<span class="minus">${e}</span>`;
      if (e.startsWith('+')) return `<span class="plus">${e}</span>`;
      return e;
    })
    .join('\n');
}

function renderFiled() {
  const list = $('#filed-list');
  list.innerHTML = '';

  REPORT.filed.forEach((f, idx) => {
    const el = document.createElement('article');
    el.className = 'case' + (idx === 0 ? ' is-open' : '');
    el.innerHTML = `
      <div class="case__head" role="button" tabindex="0" aria-expanded="${idx === 0}">
        <span class="case__id">${f.id}</span>
        <span class="case__title">${f.title}</span>
        <span class="case__rate">${f.branchesFailed}/${f.branchesRun} twins</span>
      </div>
      <div class="case__body">
        <div class="case__row">
          <p class="case__k">what it did to the twin</p>
          <p class="case__v">${f.scenario}</p>
        </div>
        <div class="case__row">
          <p class="case__k">why it tried this</p>
          <p class="case__v">${f.seededBy}<br /><span style="color:var(--silver-dim)">${f.mirrors}</span></p>
        </div>
        <div class="case__row">
          <p class="case__k">what it costs you</p>
          <p class="case__v">${f.blast}</p>
        </div>
        <div class="case__row">
          <p class="case__k">reproduction</p>
          <div class="log">${colourLog(f.repro)}</div>
        </div>
        <div class="case__row">
          <p class="case__k">root cause</p>
          <p class="case__v">${f.rootCause}</p>
        </div>
        <div class="case__row">
          <p class="case__k">fix — ${f.fix.summary}</p>
          <div class="diff">${colourDiff(f.fix.diff)}</div>
          <div class="proof">
            <b>${f.proof.green}/${f.proof.reforks} green</b>
            <span>re-forked under the same scenario. Not called fixed until every one came back clean.</span>
          </div>
          <p class="pin">Pinned so it can't come back quietly: <code>${f.pinnedTest}</code></p>
        </div>
      </div>`;

    const head = el.querySelector('.case__head');
    const toggle = () => {
      el.classList.toggle('is-open');
      head.setAttribute('aria-expanded', el.classList.contains('is-open'));
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    list.appendChild(el);
  });

  $('#filed').hidden = false;
}

function renderAbstain() {
  const a = REPORT.abstained;
  $('#ab-title').textContent = `${a.id} — ${a.title}`;
  $('#ab-why').textContent = a.why;
  $('#ab-verdict').textContent = a.verdict;
  $('#abstain').hidden = false;
}

runBtn.addEventListener('click', run);
boot();
