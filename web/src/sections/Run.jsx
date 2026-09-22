import { useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as Accordion from '@radix-ui/react-accordion';
import { motion, useReducedMotion } from 'motion/react';
import Tree from '../components/Tree.jsx';
import { run as runApi, usd, num, CHANNELS, describe } from '../lib/api.js';

/**
 * The run, live.
 *
 * One mark per forked twin, and almost all of them stay quiet. That is not a loading state to be
 * got through — the silence is the product. A tool that finds something in every package is a tool
 * that has found nothing, and the only way to show that honestly is to draw the quiet ones too.
 *
 * The strategy tabs are not a settings panel. Each one can see a different set of channels, and
 * switching re-reads the same corpus through those eyes: fewer channels, fewer findings, and the
 * blind spots travel with every claim rather than being a footnote.
 */

const SEVERITY_ORDER = { alarming: 0, notable: 1, minor: 2, none: 3 };

export default function Run({ strategies = [], tree = null }) {
  const [state, setState] = useState({ status: 'idle' });
  const [strategy, setStrategy] = useState('');
  const still = useReducedMotion();

  async function go(which) {
    setState({ status: 'running' });
    try {
      const data = await runApi(which || undefined);
      setState({ status: 'done', data });
    } catch (e) {
      setState({ status: 'failed', why: e.message });
    }
  }

  const data = state.data;
  const findings = data
    ? data.pairs
        .filter((p) => p.diff.changed)
        .sort((a, b) => SEVERITY_ORDER[a.diff.severity] - SEVERITY_ORDER[b.diff.severity])
    : [];

  return (
    <section className="wrap" id="run">
      <p className="eyebrow">the run</p>
      <h2>Two twins per package, forked from one checkpoint at the same instant</h2>
      {/*
        The count comes from the tree, and if the tree has not answered yet the sentence simply does
        not claim one. It used to fall back to the literal "1,214" — correct on the day it was
        typed, and a number nobody would ever check again.
      */}
      <p className="lede">
        So anything that differs is the package, not the machine.{' '}
        {tree ? `Of ${num(tree.total)} packages in this tree, only` : 'Only'} the ones whose version
        actually moved are re-run — re-running the rest would be theatre.
      </p>

      {/*
        The tree, drawn, and drawn BEFORE anything is pressed.
        
        One mark per package, with the fifteen that moved lit inside twelve hundred that did not.
        The ratio stated as a number reads as a boast; drawn, it reads as the reason the arithmetic
        works. It hung off the run at first, which left this section — the one the whole page is
        built around — as a heading, a paragraph and a button above two hundred pixels of nothing
        until somebody clicked. The tree is known before any of that; it is the tree.
      */}
      {tree && (
        <div className="field">
          <div>
            <Tree total={tree.total} moved={tree.moved} />
            <div className="legend" style={{ marginTop: 14 }}>
              <span>
                <i style={{ background: 'var(--rule)' }} />
                {num(tree.total - tree.moved)} never moved, and are not re-run
              </span>
              <span>
                <i style={{ background: 'var(--watched)' }} />
                {num(tree.moved)} moved, and are
              </span>
            </div>
          </div>
          <p className="field__note">
            Every mark is a package. The fifteen that are lit are the ones whose version actually
            moved, and the red one is the only thing in this tree that behaves differently than it
            used to. Running the other {num(tree.total - tree.moved)} would cost real money to
            learn nothing.
          </p>
        </div>
      )}

      {strategies.length > 1 && (
        <Tabs.Root
          className="tabs"
          value={strategy || strategies[strategies.length - 1]}
          onValueChange={(v) => {
            setStrategy(v);
            if (state.status === 'done') go(v);
          }}
        >
          <Tabs.List aria-label="what was watching">
            {strategies.map((s) => (
              <Tabs.Trigger className="tab" key={s} value={s}>
                {s}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>
      )}

      <div className="controls">
        <button className="btn" onClick={() => go(strategy)} disabled={state.status === 'running'}>
          {state.status === 'done' ? 'Run it again' : 'Run the stakeout'}
        </button>
        <output className="status">
          {state.status === 'idle' && 'idle'}
          {state.status === 'running' && 'forking twins…'}
          {state.status === 'failed' && `the server said: ${state.why}`}
          {state.status === 'done' &&
            `${num(data.twinsForked)} twins · ${data.wallMs} ms · ${usd(data.costUsd)}`}
        </output>
      </div>

      {data && (
        <>
          {/*
            Two marks per package, touching, with air between the packages — because the claim is
            that each package was run twice from one checkpoint, and a flat row of identical ticks
            does not say that. The pairing is the evidence of the method.
          */}
          <div
            className="twins"
            role="img"
            aria-label={`${data.twinsForked} forked twins, ${findings.length} of them behaving differently`}
          >
            {data.pairs.map((p, i) => {
              const mark =
                p.diff.severity === 'alarming' ? 'drift' : p.diff.changed ? 'moved' : 'quiet';
              return (
                <span className="pair" key={p.pkg} title={`${p.pkg} ${p.from} → ${p.to}`}>
                  {[0, 1].map((half) => (
                    <motion.span
                      className="twin"
                      key={half}
                      data-state={mark}
                      initial={{ opacity: 0, scaleY: still ? 1 : 0.3 }}
                      animate={{ opacity: 1, scaleY: 1 }}
                      transition={{ duration: 0.28, delay: still ? 0 : (i * 2 + half) * 0.024 }}
                    />
                  ))}
                </span>
              );
            })}
          </div>

          <div className="legend">
            <span><i style={{ background: 'color-mix(in oklab, var(--watched) 45%, var(--rule))' }} />behaved exactly as before</span>
            <span><i style={{ background: 'var(--watched)' }} />something changed</span>
            <span><i style={{ background: 'var(--drift)' }} />worth waking somebody</span>
          </div>

          {/*
            `=== true`, not truthy. A channel can be watched in PART — nodert records filesystem
            writes and no reads — and printing that as "can see fs" is how a page ends up telling
            somebody the filesystem was watched when half of it was. A partial channel is named
            with the half it saw and counted as a blind spot, because silence in it proves nothing.
          */}
          <p className="lede lede--small" style={{ marginTop: 18 }}>
            Watched with <b>{data.strategy}</b>, which can see{' '}
            {CHANNELS.filter((c) => data.canSee[c] === true).join(', ')}
            {CHANNELS.some((c) => data.canSee[c] !== true) && (
              <>
                {' '}and is blind to{' '}
                <b>
                  {CHANNELS.filter((c) => data.canSee[c] !== true)
                    .map((c) => (data.canSee[c] ? `${c} (${data.canSee[c]} only)` : c))
                    .join(', ')}
                </b>{' '}
                — so nothing here claims anything about what happened there
              </>
            )}
            . {num(data.modelCalls)} model calls for a {num(data.tree.total)}-package tree.
          </p>

          <Findings findings={findings} />
        </>
      )}
    </section>
  );
}

function Findings({ findings }) {
  return (
    <Accordion.Root className="findings" type="single" collapsible defaultValue={findings[0]?.pkg}>
      {findings.map((p) => {
        const moved = CHANNELS.filter((c) => p.diff[c].added.length || p.diff[c].removed.length);
        return (
          <Accordion.Item value={p.pkg} key={p.pkg}>
            <Accordion.Header>
              <Accordion.Trigger asChild>
                <button className="finding" data-severity={p.diff.severity}>
                  <span className="finding__head">
                    <span className="finding__pkg">{p.pkg}</span>
                    <span className="finding__move">
                      {p.from} → {p.to}
                    </span>
                    <span className="finding__sev">{p.diff.severity}</span>
                  </span>
                  <span className="finding__move">{moved.join(' · ')}</span>
                </button>
              </Accordion.Trigger>
            </Accordion.Header>

            {/*
              Radix measures the panel and publishes its height as a CSS variable, so the open and
              shut transition is two keyframes in the stylesheet rather than a spring fighting a
              library that is already doing the measuring. Motion earns its place on the strip and
              the first screen; here it would only be in the way.
            */}
            <Accordion.Content className="finding__body">
              <div style={{ paddingLeft: 18 }}>
                {moved.map((c) => (
                  <div className="channel" key={c}>
                    <span className="channel__name">{c}</span>
                    <span>
                      {p.diff[c].added.map((x) => (
                        <span className="channel__gained" key={describe(x)}>
                          {describe(x)}
                          <br />
                        </span>
                      ))}
                      {p.diff[c].removed.map((x) => (
                        <span className="channel__lost" key={describe(x)}>
                          {describe(x)}
                          <br />
                        </span>
                      ))}
                    </span>
                  </div>
                ))}

                {p.judgement?.verdict && (
                  <div className="verdicts">
                    <div className={`verdict${p.judgement.spend?.[0]?.simulated ? ' verdict--simulated' : ''}`}>
                      <span className="verdict__who">
                        {(p.judgement.spend?.[0]?.model || 'nemotron').split('/').pop()}
                      </span>
                      <span>
                        {p.judgement.verdict.meaning}
                        {p.judgement.spend?.[0] && (
                          <>
                            {' '}
                            <span className="mono" style={{ color: 'var(--dimmer)' }}>
                              {usd(p.judgement.spend[0].costUsd)}
                              {p.judgement.spend[0].simulated ? ' · simulated, no key' : ''}
                            </span>
                          </>
                        )}
                      </span>
                    </div>

                    {p.record && (
                      <div className={`verdict${p.record.simulated ? ' verdict--simulated' : ''}`}>
                        <span className="verdict__who">the open web</span>
                        <span>
                          {p.record.verdict}
                          {p.record.simulated && (
                            <span className="mono" style={{ color: 'var(--dimmer)' }}> · simulated, no key</span>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Accordion.Content>
          </Accordion.Item>
        );
      })}
    </Accordion.Root>
  );
}
