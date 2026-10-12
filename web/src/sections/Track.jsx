import { Check, ArrowRight } from 'lucide-react';

/**
 * ── What the track asks for, and where it is ────────────────────────────────
 *
 * The Coding and Agentic Engineering track asks for agents that write, run and test code in Token
 * Factory Sandboxes, and the judging asks how well Nebius and Nemotron are used. This is that list,
 * item by item, each pointing at the part of the product that does it.
 */
const ASKED = [
  ['Code run in Token Factory Sandboxes', 'Every release pair is installed and run in two Nebius Sandboxes forked from one checkpoint — code nobody has read, contained.', '#how'],
  ['NVIDIA open models, used for what they are good at', 'Nemotron Nano triages, Ultra explains, Super must agree before anything is accused. Severity stays rules, in code.', '#stack'],
  ['Agentic, running on its own', 'The watcher follows npm’s change feed day and night, and posts its verdict minutes after a release is published.', '#live'],
  ['Testing code, in the developer’s flow', 'One step in GitHub Actions checks every dependency a pull request bumps — on a real pull request, today.', '#check'],
  ['A working demo, nothing to install', 'Check any public repository’s lockfile from this page, or watch an upgrade run on Nebius while you wait.', '#yours'],
];

export default function Track() {
  return (
    <section className="wrap" id="track">
      <header className="head">
        <h2>What the Coding and Agentic Engineering track asks for</h2>
        <p className="lede">The track’s brief and the judging criteria, item by item, and where each one is.</p>
      </header>
      <ul className="asked">
        {ASKED.map(([what, how, href]) => (
          <li key={what}>
            <span className="asked__tick" aria-hidden="true"><Check size={14} strokeWidth={2.6} /></span>
            <div>
              <p className="asked__what">{what}</p>
              <p className="asked__how">{how}</p>
            </div>
            <a className="asked__go" href={href} aria-label={`See ${what.toLowerCase()}`}><ArrowRight size={16} /></a>
          </li>
        ))}
      </ul>
    </section>
  );
}
