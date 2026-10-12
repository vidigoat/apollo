import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';

/**
 * ── Why it matters ──────────────────────────────────────────────────────────
 *
 * The case, made from other people's measurements. Each figure is read from public/impact.json,
 * which carries the source's own sentence and its link — nothing here is a number this project
 * typed, the same rule every other figure on the page keeps.
 */
export default function Why() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/impact.json').then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, []);
  if (!data?.facts?.length) return null;

  return (
    <section className="wrap" id="why">
      <header className="head">
        <h2>A version number cannot tell you what changed</h2>
        <p className="lede">
          Supply-chain attacks arrive as ordinary releases of packages you already trust. Reading the
          source is a race the attacker wins; watching what the code does is not.
        </p>
      </header>

      <div className="facts facts--3">
        {data.facts.map((f) => (
          <figure className="fact" key={f.figure + f.claim}>
            <p className="fact__fig">{f.figure}</p>
            <p className="fact__claim">{f.claim}</p>
            <figcaption>
              <a href={f.url} target="_blank" rel="noreferrer" title={f.quote}>
                {f.source}
                <ArrowUpRight size={13} aria-hidden="true" />
              </a>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
