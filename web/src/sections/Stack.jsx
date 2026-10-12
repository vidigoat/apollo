import { Boxes, Cpu, Scale } from 'lucide-react';
import { Logo, NebiusLogo } from '../lib/logos.jsx';
import { num } from '../lib/api.js';

/**
 * ── Built on Nebius and NVIDIA ──────────────────────────────────────────────
 *
 * What each part of the platform does here, in one card each, with the figures read from the
 * published index rather than typed. The model ids are the ones `judge/nemotron.js` calls.
 */
export default function Stack({ published }) {
  const c = published?.counts;
  return (
    <section className="wrap" id="stack">
      <header className="head">
        <h2>Built on Nebius and NVIDIA</h2>
        <p className="lede">
          Sandboxes run the code nobody has read. Three Nemotron models decide which differences a
          person needs to see, smallest first, so the large model only reads what earned its time.
        </p>
      </header>

      <div className="cards">
        <article className="card">
          <div className="card__top">
            <span className="tile" aria-hidden="true"><Boxes size={18} /></span>
            <NebiusLogo height={14} />
          </div>
          <h3>Nebius Sandboxes</h3>
          <p>
            Two microVMs fork from one checkpoint for every release pair, so the old and new versions
            start from the identical machine. Nothing they do can reach yours.
          </p>
          {c && (
            <p className="card__fig">
              <b>{num(c.versions)}</b> versions of <b>{num(c.packages)}</b> packages observed
            </p>
          )}
        </article>

        <article className="card">
          <div className="card__top">
            <span className="tile" aria-hidden="true"><Cpu size={18} /></span>
            <NebiusLogo height={14} />
          </div>
          <h3>Nebius Token Factory</h3>
          <p>
            Every judgement is a real chat-completions call to Token Factory, costed per call and
            recorded beside the verdict it produced.
          </p>
          <p className="card__fig">Preflight verifies each model with a parsed verdict and a real cost.</p>
        </article>

        <article className="card">
          <div className="card__top">
            <span className="tile" aria-hidden="true"><Scale size={18} /></span>
            <Logo name="nvidia" height={18} />
          </div>
          <h3>NVIDIA Nemotron, three sizes</h3>
          <ul className="models">
            <li><span>Triage</span><code>Nemotron 3 Nano 30B</code></li>
            <li><span>Judge</span><code>Nemotron 3 Ultra 550B</code></li>
            <li><span>Veto</span><code>Nemotron 3 Super 120B</code></li>
          </ul>
        </article>
      </div>
    </section>
  );
}
