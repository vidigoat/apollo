/* CASSANDRA — the run: one orchestrated page moment */

const $ = (s) => document.querySelector(s);
const sheetEl = $('#sheet');
const statusEl = $('#status');
const runBtn = $('#run');
const cleanBtn = $('#run-clean');

let PLAN = null;
let REPORT = null;
let RUN = null; // the last real orchestration result

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

async function run(clean = false) {
  runBtn.disabled = true;
  cleanBtn.disabled = true;
  const frames = [...sheetEl.children];
  frames.forEach((f) => (f.className = 'frame'));
  $('#filed').hidden = true;
  $('#abstain').hidden = true;
  $('#clean').hidden = true;

  // Ask the server to actually run it: boot a checkpoint, fork it in waves, let the probes decide.
  // Nothing below is scripted — the circled frames are whichever branches genuinely failed.
  statusEl.textContent = 'booting the twin…';
  RUN = await (await fetch(`/api/run${clean ? '?clean=1' : ''}`)).json();

  const failSet = new Set(RUN.failedBranchIndexes);
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

  if (RUN.filed.length === 0) {
    statusEl.textContent = `${RUN.total} twins run · 0 reproduced · nothing filed · ${RUN.wallMs}ms`;
    $('#slate-filed').textContent = '0';
    $('#clean').hidden = false;
    $('#clean').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  } else {
    statusEl.textContent =
      `${RUN.total} twins run · ${RUN.failedBranchIndexes.length} branches failed · ` +
      `${RUN.filed.length} filed after verification · $${REPORT.cost.usd} · ${RUN.wallMs}ms`;
    $('#slate-filed').textContent = RUN.filed.length;

    REPORT.filed = RUN.filed;
    renderFiled();
    linkFramesToCases(frames);
    renderAbstain();
  }
  cleanBtn.disabled = false;
  runBtn.disabled = false;
  runBtn.textContent = 'Run again';
}

/* Which circled frame belongs to which filed failure. A frame is evidence, so it should
   take you to the case it produced. */
const FRAME_CASE = { 37: 'F-017', 41: 'F-017', 58: 'F-093', 96: 'F-093', 104: 'F-093', 131: 'F-131', 168: 'F-131' };

function linkFramesToCases(frames) {
  Object.entries(FRAME_CASE).forEach(([i, id]) => {
    const frame = frames[Number(i)];
    if (!frame) return;
    frame.classList.add('is-linked');
    frame.setAttribute('role', 'button');
    frame.setAttribute('tabindex', '0');
    frame.setAttribute('title', `${id} — open this failure`);

    const open = () => {
      const target = document.querySelector(`[data-case="${id}"]`);
      if (!target) return;
      target.classList.add('is-open');
      target.querySelector('.case__head').setAttribute('aria-expanded', 'true');
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      target.classList.remove('is-flash');
      void target.offsetWidth;
      target.classList.add('is-flash');
    };

    frame.addEventListener('click', open);
    frame.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
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
    el.dataset.case = f.id;
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

runBtn.addEventListener('click', () => run(false));
cleanBtn.addEventListener('click', () => run(true));
boot();
