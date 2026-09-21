/*
 * stakeout / fleet — the page.
 *
 * Draws the fleet as it is: one segment per project, width proportional to its dependency count,
 * each one mostly void with a lit foot showing how much of it anyone has actually watched. On every
 * real tree the picture is overwhelmingly dark, and that is not a rendering failure — it is the
 * finding. A stacked bar that read "94% safe" would be a lie about the same numbers.
 *
 * No framework. The page has one screen, one canvas and one table.
 */

const $ = (id) => document.getElementById(id);
const num = (n) => Number(n).toLocaleString('en-US');

/* ── the band ─────────────────────────────────────────────────────────────── */

const COLOUR = {
  watched: '#82b4c2',
  drift: '#c2543c',
  rule: '#19212a',
  hatch: '#141c25',    // the hatching over what nobody watched — never a fill
  ceiling: '#232e3a',  // where the tree would reach if all of it were known
  void: '#06080b',
};

let segments = [];

/**
 * Draw the fleet.
 *
 * Width is proportional to dependency count, so the projects that dominate your attack surface
 * dominate the picture. Height is the watched fraction, drawn up from the baseline: a project
 * nobody has looked at is a column of hatched nothing, which is exactly how it should feel.
 */
function draw() {
  const canvas = $('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const total = segments.reduce((n, s) => n + s.deps, 0) || 1;
  // A project with three dependencies still has to be visible, or the register and the picture
  // disagree about how many projects there are.
  const MIN = 1.5;
  const GAP = 1;
  const spare = w - segments.length * (MIN + GAP);

  let x = 0;
  for (const s of segments) {
    const sw = MIN + (spare > 0 ? (s.deps / total) * spare : 0);
    const frac = s.deps ? s.known / s.deps : 0;
    const lit = Math.max(frac > 0 ? 1 : 0, Math.round(frac * h));

    /*
     * The unwatched part is not drawn. It is the page.
     *
     * The first version filled it with a dark block, which was a mistake of exactly the kind this
     * page exists to argue against: a filled rectangle reads as PRESENT, and the whole picture came
     * out looking like an ordinary coverage chart where the dark part is simply the other half of
     * the bar. Absence has to look like absence. So the unwatched region gets hatching — visible
     * enough to show the extent of what could be known, thin enough that it never reads as data —
     * and a single ceiling hairline marking the top of the tree.
     */
    g.save();
    g.beginPath();
    g.rect(x, 0, sw, h - lit);
    g.clip();
    g.strokeStyle = COLOUR.hatch;
    g.lineWidth = 1;
    for (let d = -h; d < sw + h; d += 5) {
      g.beginPath();
      g.moveTo(x + d, h);
      g.lineTo(x + d + h, 0);
      g.stroke();
    }
    g.restore();

    // The ceiling: how far this project would reach if all of it had been watched.
    g.fillStyle = COLOUR.ceiling;
    g.fillRect(x, 0, sw, 1);

    g.fillStyle = s.state === 'drift' ? COLOUR.drift : COLOUR.watched;
    g.fillRect(x, h - lit, sw, lit);

    s._x = x;
    s._w = sw;
    x += sw + GAP;
  }

  // One baseline hairline, so the lit feet sit on something rather than float.
  g.fillStyle = COLOUR.rule;
  g.fillRect(0, h - 0.5, w, 0.5);
}

/** Naming the segment under the cursor. The canvas is a picture; this makes it readable. */
function wireHover() {
  const canvas = $('canvas');
  const tip = $('hover');

  canvas.addEventListener('mousemove', (e) => {
    const box = canvas.getBoundingClientRect();
    const x = e.clientX - box.left;
    const hit = segments.find((s) => x >= s._x && x <= s._x + s._w);
    if (!hit) { tip.dataset.on = '0'; return; }

    const pct = hit.deps ? Math.round((hit.known / hit.deps) * 100) : 0;
    tip.innerHTML =
      `<b>${escape(hit.name)}</b><br>` +
      `<span>${num(hit.known)} watched of ${num(hit.deps)} — ${pct}%</span>`;
    tip.style.left = `${hit._x + hit._w / 2}px`;
    tip.style.top = `${canvas.offsetTop - 8}px`;
    tip.dataset.on = '1';
  });

  canvas.addEventListener('mouseleave', () => { tip.dataset.on = '0'; });
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── the register ─────────────────────────────────────────────────────────── */

const STANDING = {
  drift: ['drift', 'state--drift'],
  clean: ['pinned, clean', 'state--clean'],
  unpinned: ['not pinned', ''],
  'unreadable-lock': ['lock unreadable', 'state--drift'],
};

function renderRows(repos) {
  const rows = $('rows');
  rows.textContent = '';

  for (const r of repos) {
    const tr = document.createElement('tr');
    const pct = r.deps ? (r.known / r.deps) * 100 : 0;
    const [label, cls] = STANDING[r.state] || [r.state, ''];

    tr.dataset.at = r._at;
    tr.tabIndex = 0;
    tr.innerHTML =
      `<td class="name${r.named === false ? ' name--withheld' : ''}">${escape(r.name)}</td>` +
      `<td class="n n--lit">${num(r.deps)}</td>` +
      `<td class="n">${r.known ? num(r.known) : '—'}</td>` +
      `<td><div class="cov"><i style="width:${pct.toFixed(2)}%"></i></div></td>` +
      `<td class="state ${cls}">${escape(label)}</td>`;
    const open = () => showProject(r._at);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    rows.appendChild(tr);
  }
}

/* ── one project ──────────────────────────────────────────────────────────── */

const CHANNELS = ['net', 'dns', 'fs', 'env', 'proc', 'exec'];

/**
 * The six-slot strip for one package.
 *
 * `counts[c] === null` means the entry has no such channel at all, which is how the index records
 * that the strategy could not watch it — see index/schema.js, where an absent channel is preserved
 * rather than helpfully filled in as empty. That is the case this glyph exists for.
 */
function strip(pkg) {
  if (!pkg.observed) {
    return `<span class="chans" title="never observed">${CHANNELS.map(() => '<i class="ch ch--blind"></i>').join('')}</span>`;
  }
  return `<span class="chans">` + CHANNELS.map((c) => {
    const n = pkg.counts[c];
    const blind = n === null || (pkg.canSee && pkg.canSee[c] === false);
    if (blind) return `<i class="ch ch--blind" title="${c}: nothing was watching"></i>`;
    if (n > 0) return `<i class="ch ch--seen" title="${c}: ${n}"></i>`;
    return `<i class="ch ch--quiet" title="${c}: watched, nothing seen"></i>`;
  }).join('') + `</span>`;
}

/*
 * Sorted by how much a reader needs to see it. Packages that did something come first, then ones
 * watched and silent, then the never-observed majority — which is last because it is the longest
 * and the least surprising, not because it matters least.
 */
const RANK = (p) => (!p.observed ? 2 : p.quiet ? 1 : 0);
/* Within the active group, busiest first — a package touching four channels is worth more of a
 * reader's attention than the ninetieth one that read an environment variable. */
const REACH = (p) => (p.observed ? CHANNELS.filter((c) => p.counts[c] > 0).length : 0);
const CAP = 400;

async function showProject(at) {
  let data;
  try {
    data = await (await fetch(`/api/project?at=${encodeURIComponent(at)}`)).json();
  } catch {
    return;
  }
  if (data.error) return;

  $('fleet').hidden = true;
  $('project').hidden = false;
  window.scrollTo(0, 0);

  $('pName').textContent = data.name;

  const pkgs = data.packages.slice().sort(
    (a, b) => RANK(a) - RANK(b) || REACH(b) - REACH(a) || a.name.localeCompare(b.name)
  );
  const observed = pkgs.filter((p) => p.observed);
  const active = observed.filter((p) => !p.quiet);
  const trustworthy = observed.filter((p) => p.trustworthy);

  $('pSum').innerHTML =
    `<b>${num(data.deps)}</b> dependency-versions. <b>${num(observed.length)}</b> have been ` +
    `observed; <b>${num(active.length)}</b> of those did something. ` +
    `<b>${num(trustworthy.length)}</b> were quiet under a strategy with no blind spots, which is ` +
    `the only state that supports saying a package does nothing.`;

  const rows = $('pRows');
  rows.textContent = '';
  for (const p of pkgs.slice(0, CAP)) {
    const tr = document.createElement('tr');
    const standing = !p.observed ? '<span class="never">never observed</span>'
      : p.trustworthy ? '<span class="trust">quiet, and trustworthy</span>'
      : p.quiet ? '<span class="untrust">quiet, but blind spots</span>'
      : `<span class="untrust">${CHANNELS.filter((c) => p.counts[c] > 0).join(' ')}</span>`;

    tr.innerHTML =
      `<td class="name">${escape(p.name)} <span class="pkg-v">${escape(p.version)}</span></td>` +
      `<td>${strip(p)}</td>` +
      `<td class="state">${standing}</td>`;
    rows.appendChild(tr);
  }

  $('pFoot').textContent = pkgs.length > CAP
    ? `Showing the first ${num(CAP)} of ${num(pkgs.length)}, ordered by how much they need looking at.`
    : '';
}

$('back').addEventListener('click', () => {
  $('project').hidden = true;
  $('fleet').hidden = false;
  window.scrollTo(0, 0);
});

/* ── load ─────────────────────────────────────────────────────────────────── */

async function load() {
  let data;
  try {
    data = await (await fetch('/api/fleet')).json();
  } catch {
    $('empty').hidden = false;
    $('rev').textContent = 'the server is not answering';
    return;
  }

  if (!data.scanned) {
    $('empty').hidden = false;
    if (data.how) $('how').textContent = data.how;
    $('rev').textContent = 'no scan on disk';
    return;
  }

  const t = data.totals;
  const ok = data.repos.filter((r) => !r.error && r.deps);

  $('fleet').hidden = false;
  $('rev').textContent = `scanned ${new Date(data.scannedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;

  $('bandCount').textContent = num(t.depVersions);
  $('bandRepos').textContent = num(t.repos);
  $('legendKnown').textContent = num(t.known);
  $('legendUnknown').textContent = num(t.depVersions - t.known);
  if (t.drifting) {
    $('keyDrift').hidden = false;
    $('legendDrift').textContent = num(t.drifting);
  }

  $('distinct').textContent = num(t.distinct);
  $('depVersions').textContent = num(t.depVersions);

  // Both halves of the ratio come from the scan, so they are about the same instant.
  const observations = data.index ? data.index.versions : null;

  if (observations) {
    $('obs').textContent = num(observations);
    $('answered').textContent = num(t.known);
    $('reuse').textContent = `${(t.known / observations).toFixed(1)}`;
  } else {
    $('obs').closest('.claim__line').hidden = true;
  }

  // Position in the scan is how a project is addressed — the server will not take a path.
  data.repos.forEach((r, i) => { r._at = i; });
  segments = ok.slice().sort((a, b) => b.deps - a.deps);
  renderRows(segments);

  draw();
  wireHover();
  window.addEventListener('resize', draw);

  let foot =
    `Read off disk, not scanned on page load. ${num(t.depVersions - t.known)} of these ` +
    `dependency-versions have never been observed by anything — which is the normal state of a ` +
    `dependency tree, and the work, not a finding.`;

  /*
   * The index has grown since the scan. Every number above is still correct — it is what was true
   * when the scan ran — and re-reading the denominator live would silently inflate the reuse
   * figure against a numerator counted earlier. So: say it, and leave the arithmetic alone.
   */
  if (data.stale && data.indexNow) {
    foot += ` The index has moved since this scan — ${num(data.indexNow.versions)} observations now, ` +
      `against ${num(observations)} then. The figures above are as of the scan; re-run it to catch up.`;
  }
  $('foot').textContent = foot;
}

load();
