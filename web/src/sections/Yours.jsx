import { useRef, useState } from 'react';
import { num } from '../lib/api.js';

/**
 * Your own packages — the part of the site that is not a demonstration.
 *
 * Everything above this is the bundled corpus, planted and labelled as planted. These two are real:
 * a lockfile (pasted, dropped, or named as a GitHub repository) resolved against the published
 * index, which runs nothing; and one upgrade of any npm package, watched in two Nebius Token Factory
 * Sandboxes forked from one checkpoint, right now.
 */

const CHANNEL_LABEL = {
  env: 'read environment variables',
  net: 'opened network connections',
  dns: 'looked up hostnames',
  proc: 'started processes',
  exec: 'built code at runtime',
  fs: 'wrote files',
};

/** One observed thing, as a person reads it — the same rule the server uses (yours.js). */
const describe = (x) => (typeof x === 'string' ? x
  : x.host ? `${x.host}${x.port ? `:${x.port}` : ''}`
    : Array.isArray(x.argv) ? x.argv.join(' ')
      : x.path ? `${x.op || ''} ${x.path}`.trim()
        : x.how ? String(x.how)
          : JSON.stringify(x));

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({ error: `The server answered ${res.status}.` }));
  if (!res.ok) throw new Error(json.error || `The server answered ${res.status}.`);
  return json;
}

function Lockfile() {
  const [repo, setRepo] = useState('');
  const [state, setState] = useState({ status: 'idle' });
  const file = useRef(null);

  const run = async (body) => {
    setState({ status: 'running' });
    try {
      setState({ status: 'done', data: await post('/api/lockfile', body) });
    } catch (e) {
      setState({ status: 'failed', why: e.message });
    }
  };
  const fromFile = async (f) => {
    if (!f) return;
    if (f.size > 30 * 1024 * 1024) return setState({ status: 'failed', why: 'That lockfile is over 30 MB.' });
    run({ lockfile: await f.text() });
  };

  const d = state.data;
  const pct = d ? d.pct : 0;

  return (
    <div className="yours__panel">
      <form
        className="yours__form"
        onSubmit={(e) => { e.preventDefault(); if (repo.trim()) run({ repo }); }}
      >
        <label className="yours__label" htmlFor="yours-repo">A public GitHub repository with a package-lock.json</label>
        <div className="yours__row">
          <input
            id="yours-repo"
            className="yours__input"
            placeholder="owner/name — cheeriojs/cheerio"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            autoComplete="off"
            spellCheck="false"
          />
          <button className="btn" type="submit" disabled={state.status === 'running' || !repo.trim()}>Check it</button>
        </div>
      </form>

      <div
        className="yours__drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); fromFile(e.dataTransfer.files?.[0]); }}
      >
        or drop a <code>package-lock.json</code> here —{' '}
        <button className="yours__link" type="button" onClick={() => file.current?.click()}>choose one</button>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => fromFile(e.target.files?.[0])} />
        <span className="yours__quiet"> · read here, nothing is uploaded anywhere else, nothing is installed</span>
      </div>

      <div className="yours__try">
        {['cheeriojs/cheerio', 'nodejs/undici', 'axios/axios'].map((r) => (
          <button key={r} type="button" className="yours__chip" onClick={() => { setRepo(r); run({ repo: r }); }}>{r}</button>
        ))}
      </div>

      <output className="status" aria-live="polite">
        {state.status === 'running' && 'reading the tree and asking the index…'}
        {state.status === 'failed' && state.why}
      </output>

      {d && state.status === 'done' && (
        <div className="yours__result">
          <p className="yours__headline">
            <b>{d.from}</b> · {num(d.total)} dependency-versions
          </p>
          <dl className="yours__nums">
            <div><dt>already watched</dt><dd>{num(d.known)}</dd></div>
            <div><dt>never watched by anybody</dt><dd className="yours__blind">{num(d.unknown)}</dd></div>
            <div><dt>answered</dt><dd>{pct}%</dd></div>
          </dl>
          <div className="yours__bar" role="img" aria-label={`${pct}% of the tree answered from the index`}>
            <i style={{ width: `${pct}%` }} />
          </div>

          {d.attention?.length > 0 ? (
            <div className="yours__attention">
              <h3 className="yours__h3">Worth reading first — {d.attention.length} {d.attention.length === 1 ? 'package reads' : 'packages read'} something that looks like a credential, or {d.attention.length === 1 ? 'starts' : 'start'} a shell</h3>
              {d.attention.map((a) => (
                <div key={a.package} className="channel">
                  <span className="channel__name">{a.reads.length ? 'env' : 'proc'}</span>
                  <span><b>{a.package}</b> <span className="channel__gained">{[...a.reads, ...a.starts].join(' · ')}</span></span>
                </div>
              ))}
              <p className="yours__quiet">Not an accusation — plenty of tools read GITHUB_TOKEN on purpose. It is what to look at before anything else.</p>
            </div>
          ) : (
            <p className="yours__quiet">None of the known part reads anything that looks like a credential, or starts a shell.</p>
          )}

          <h3 className="yours__h3">What the known part does when it is installed and imported</h3>
          <div className="yours__does">
            {Object.entries(d.does).filter(([, v]) => v.packages).map(([c, v]) => (
              <div key={c} className="channel">
                <span className="channel__name">{c}</span>
                <span>
                  <b>{num(v.packages)}</b> {v.packages === 1 ? 'package' : 'packages'} {CHANNEL_LABEL[c] || c}
                  {Object.keys(v.byName).length > 0 ? (
                    <span className="yours__names">
                      {Object.entries(v.byName).slice(0, 12).map(([n, k]) => (
                        <span key={n} className="yours__name">{n} <i>{k}</i></span>
                      ))}
                    </span>
                  ) : (
                    <span className="yours__names">
                      {v.examples.slice(0, 6).map((e) => (
                        <span key={e.package} className="yours__name">{e.package} <i>{e.what.join(', ').slice(0, 60)}</i></span>
                      ))}
                    </span>
                  )}
                </span>
              </div>
            ))}
            {Object.values(d.does).every((v) => !v.packages) && <p className="yours__quiet">Nothing the index holds for this tree does anything it can see.</p>}
          </div>

          {d.unknown > 0 && (
            <details className="yours__unknown">
              <summary>{num(d.unknown)} never watched — listed by name, never counted as clean</summary>
              <p>{d.unknownSample.join(' · ')}{d.unknown > d.unknownSample.length ? ` · and ${num(d.unknown - d.unknownSample.length)} more` : ''}</p>
              {d.otherPlatform > 0 && (
                <p className="yours__quiet">
                  {num(d.otherPlatform)} of these {d.otherPlatform === 1 ? 'is a binary' : 'are binaries'} built only for another
                  platform — macOS, Windows or musl — like {d.otherPlatformSample.slice(0, 3).join(', ')}. They cannot be
                  installed in the Linux sandboxes the index is observed in, so they stay unknown.
                </p>
              )}
            </details>
          )}
          <p className="yours__quiet">{d.note} Index: {num(d.index.versions)} observations, revision {d.index.revision}.</p>
        </div>
      )}
    </div>
  );
}

function Watch() {
  const [f, setF] = useState({ pkg: '', from: '', to: '' });
  const [state, setState] = useState({ status: 'idle' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const run = async (body = f) => {
    setState({ status: 'running' });
    try {
      setState({ status: 'done', data: await post('/api/watch', body) });
    } catch (e) {
      setState({ status: 'failed', why: e.message });
    }
  };

  const d = state.data;
  return (
    <div className="yours__panel">
      <form className="yours__form" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <label className="yours__label" htmlFor="yours-pkg">Any npm package, and two of its published versions</label>
        <div className="yours__row yours__row--three">
          <input id="yours-pkg" className="yours__input" placeholder="package" value={f.pkg} onChange={set('pkg')} autoComplete="off" spellCheck="false" />
          <input className="yours__input" placeholder="from 1.2.0" value={f.from} onChange={set('from')} autoComplete="off" spellCheck="false" aria-label="from version" />
          <input className="yours__input" placeholder="to 1.3.0" value={f.to} onChange={set('to')} autoComplete="off" spellCheck="false" aria-label="to version" />
          <button className="btn" type="submit" disabled={state.status === 'running' || !f.pkg || !f.from || !f.to}>Watch it on Nebius</button>
        </div>
      </form>

      <div className="yours__try">
        {[['picocolors', '1.0.0', '1.1.1'], ['debug', '4.3.4', '4.4.0'], ['kleur', '4.1.4', '4.1.5']].map(([pkg, from, to]) => (
          <button key={pkg} type="button" className="yours__chip" onClick={() => { const b = { pkg, from, to }; setF(b); run(b); }}>{pkg} {from} → {to}</button>
        ))}
      </div>

      <output className="status" aria-live="polite">
        {state.status === 'running' && 'forking two sandboxes on Nebius from one checkpoint, installing both, importing both… usually 30–70 s'}
        {state.status === 'failed' && state.why}
      </output>

      {d && state.status === 'done' && (
        <div className="finding yours__finding" data-severity={d.severity} data-open="true">
          <div className="finding__head">
            <span className="finding__pkg">{d.pkg}</span>
            <span className="finding__move">{d.versions?.[0]} → {d.versions?.[1]}</span>
            <span className="finding__sev">{d.severity}</span>
          </div>
          <p className="yours__quiet">{d.summary} — {d.from}{d.seconds ? `, ${d.seconds}s` : ''}.</p>
          <div className="finding__body">
            {Object.keys(CHANNEL_LABEL).map((c) => {
              const before = (d.before?.[c] || []).map(describe);
              const after = (d.after?.[c] || []).map(describe);
              if (!before.length && !after.length) return null;
              const gained = after.filter((x) => !before.includes(x));
              const lost = before.filter((x) => !after.includes(x));
              const kept = after.filter((x) => before.includes(x));
              return (
                <div key={c} className="channel">
                  <span className="channel__name">{c}</span>
                  <span>
                    {gained.map((x) => <span key={`g${x}`} className="channel__gained">+ {x}<br /></span>)}
                    {lost.map((x) => <span key={`l${x}`} className="channel__lost">{x}<br /></span>)}
                    {kept.map((x) => <span key={`k${x}`}>{x}<br /></span>)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Yours() {
  const [which, setWhich] = useState('lockfile');
  return (
    <section className="wrap" id="yours">
      <p className="eyebrow">yours</p>
      <h2>Try it on your own packages</h2>
      <p className="lede">
        Everything above is the planted corpus. These two are not: your real tree, answered from the
        published index without running anything — and any real upgrade, watched in two{' '}
        <b>Nebius Token Factory Sandboxes</b> forked from one checkpoint, while you wait.
      </p>

      <div className="tabs" role="tablist" aria-label="what to try">
        {[['lockfile', 'check a lockfile'], ['watch', 'watch an upgrade on Nebius']].map(([k, label]) => (
          <button key={k} className="tab" role="tab" aria-selected={which === k} data-state={which === k ? 'active' : 'idle'} onClick={() => setWhich(k)}>
            {label}
          </button>
        ))}
      </div>

      {which === 'lockfile' ? <Lockfile /> : <Watch />}
    </section>
  );
}
