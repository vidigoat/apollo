import { Mark } from './Nav.jsx';
import { Logo, NebiusLogo } from '../lib/logos.jsx';

/** Every way into this project, grouped by what a visitor came for. */
const COLUMNS = [
  ['On this page', [['#live', 'Live watch'], ['#yours', 'Check your lockfile'], ['#check', 'On a pull request'], ['#limits', 'Limits']]],
  ['Use it', [['https://github.com/apps/apollo-behaviour', 'The GitHub App'], ['https://github.com/vidigoat/apollo#readme', 'The apollo CLI'], ['/index.json', 'The published index']]],
  ['The project', [['https://github.com/vidigoat/apollo', 'Source on GitHub'], ['https://github.com/vidigoat/apollo/blob/main/docs/DEEP-DIVE.md', 'The deep dive'], ['https://github.com/vidigoat/apollo/blob/main/LICENSE', 'MIT licence']]],
];

export default function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot__grid">
        <div className="foot__brand">
          <a href="#top" className="nav__brand">
            <Mark size={28} />
            <span>Apollo</span>
          </a>
          <p>A behavioural lockfile for npm. Built for the Nebius × NVIDIA Global AI Hackathon, Coding and Agentic Engineering track.</p>
        </div>
        {COLUMNS.map(([head, links]) => (
          <nav key={head} aria-label={head}>
            <h3>{head}</h3>
            <ul>
              {links.map(([href, label]) => <li key={href}><a href={href}>{label}</a></li>)}
            </ul>
          </nav>
        ))}
      </div>
      <div className="wrap foot__base">
        <span>Runs on</span>
        <ul>
          <li><NebiusLogo height={12} title={false} />Sandboxes and Token Factory</li>
          <li><Logo name="nvidia" height={12} title={false} />Nemotron</li>
          <li><Logo name="npm" height={10} title={false} />the npm change feed</li>
          <li><Logo name="githubactions" height={14} title={false} />GitHub Actions</li>
        </ul>
      </div>
    </footer>
  );
}
