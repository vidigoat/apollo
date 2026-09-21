#!/usr/bin/env node
/**
 * A fleet scan with somebody's directory tree taken out of it.
 *
 *   node scripts/fleet-scan.js ~ --out local/fleet.json
 *   node scripts/fleet-redact.js local/fleet.json public/fleet-sample.json
 *
 * The scan is the honest artefact and it names every project on the machine that produced it,
 * which is why `local/` is gitignored. But the *numbers* in it are the argument — twenty thousand
 * dependency-versions collapsing to eight thousand distinct ones is a thing you have to see on a
 * real fleet, and a fabricated fleet would prove nothing at all.
 *
 * So: keep every number, drop every path, and keep a project's name only when it is a public
 * open-source checkout whose name reveals nothing. Everything else keeps its real counts under a
 * numbered label.
 *
 * This is the same distinction the rest of the project keeps making. A withheld name is a name we
 * chose not to print. It is not a missing project, and the totals still add up.
 */

const fs = require('node:fs');
const path = require('node:path');

/*
 * Checkouts of public projects. Their names are already on npm and GitHub, so printing them costs
 * nothing and makes the sample verifiable — a reader can go and count the lockfile themselves.
 */
const PUBLIC_PROJECTS =
  /^(turborepo|examples|fixtures|managed-agents|docs|create-turbo|with-|next|cassandra|second-set-of-hands|faultgraph)/i;

function redact(fleet) {
  let n = 0;
  const repos = fleet.repos.map((r) => {
    const openSource = PUBLIC_PROJECTS.test(r.name);
    return {
      name: openSource ? r.name : `project ${++n}`,
      named: openSource,
      deps: r.deps,
      known: r.known,
      unknown: r.unknown,
      state: r.state,
      drift: r.drift || [],
      ...(r.error ? { error: 'unreadable' } : {}),
    };
  });

  return {
    root: '(withheld)',
    scannedAt: fleet.scannedAt,
    withheldNames: n,
    note:
      'A real scan of a real machine. Every count is the measured one; only paths and project ' +
      'names are withheld. Run scripts/fleet-scan.js against your own tree to reproduce it.',
    repos,
    totals: fleet.totals,
  };
}

module.exports = { redact };

if (require.main === module) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error('usage: node scripts/fleet-redact.js <fleet.json> <out.json>');
    process.exit(3);
  }
  const out = redact(JSON.parse(fs.readFileSync(from, 'utf8')));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, JSON.stringify(out, null, 2));
  console.log(`\n  ${out.repos.length} projects, ${out.withheldNames} names withheld -> ${to}\n`);
}
