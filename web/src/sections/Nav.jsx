import { useEffect, useState } from 'react';
import { Logo } from '../lib/logos.jsx';

/**
 * ── The menu ────────────────────────────────────────────────────────────────
 *
 * The mark on the left, the sections in the middle, the source and one button on the right — the
 * shape every reference page uses. The section in view is marked, so the bar also says where the
 * reader is on a page that is long by design.
 */

export const SECTIONS = [
  ['live', 'Live watch'],
  ['yours', 'Check yours'],
  ['check', 'Pull requests'],
  ['run', 'The run'],
  ['how', 'How it works'],
  ['limits', 'Limits'],
];

/** Apollo's mark: the sun, and the ring it is watched from. */
export function Mark({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect className="mark__tile" width="64" height="64" rx="15" />
      <circle className="mark__sun" cx="32" cy="32" r="9" />
      <circle className="mark__ring" cx="32" cy="32" r="18" fill="none" strokeWidth="3" />
    </svg>
  );
}

export default function Nav() {
  const [here, setHere] = useState('');
  const [open, setOpen] = useState(false);

  // The last section whose top has passed the upper third of the window. Asked on scroll, because
  // sections that load their data first mount after the menu does.
  useEffect(() => {
    let frame = 0;
    const look = () => {
      frame = 0;
      const line = window.innerHeight * 0.35;
      let at = '';
      for (const [id] of SECTIONS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) at = id;
      }
      setHere(at);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(look); };
    window.addEventListener('scroll', onScroll, { passive: true });
    look();
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, []);

  return (
    <header className="nav">
      <div className="nav__bar">
        <a className="nav__brand" href="#top" onClick={() => setOpen(false)}>
          <Mark />
          <span>Apollo</span>
        </a>

        <nav className="nav__links" aria-label="Sections">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} aria-current={here === id ? 'true' : undefined}>
              {label}
            </a>
          ))}
        </nav>

        <div className="nav__end">
          <a className="nav__quiet" href="https://github.com/vidigoat/apollo" aria-label="Source on GitHub">
            <Logo name="github" height={18} title={false} />
          </a>
          <a className="nav__cta" href="#yours">Check a lockfile</a>
          <button type="button" className="nav__toggle" aria-expanded={open} aria-controls="nav-sheet" onClick={() => setOpen((o) => !o)}>
            {open ? 'Close' : 'Menu'}
          </button>
        </div>
      </div>

      <nav id="nav-sheet" className="nav__sheet" hidden={!open} aria-label="Sections">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={() => setOpen(false)}>{label}</a>
        ))}
        <a href="https://github.com/vidigoat/apollo">Source on GitHub</a>
      </nav>
    </header>
  );
}
