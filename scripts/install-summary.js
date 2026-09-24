#!/usr/bin/env node
/**
 * What the index's install phases say, as numbers the documents can quote and be held to.
 *
 *   node scripts/install-summary.js        # writes docs/install-phase.json
 *
 * Entries observed from 23 September carry an `install` section: what npm launched as lifecycle
 * scripts, and what those scripts did. This counts, over the published index, how many versions
 * were watched through install, how many of those ran a script, how many reached the network while
 * installing (and where), and how many read a variable named like a credential — the questions a
 * person asks about install scripts, answered from observation rather than from package.json.
 */

const fs = require('node:fs');
const path = require('node:path');
const { readsCredential } = require('../differ/diff');

const ROOT = path.join(__dirname, '..');

function summarise(pub) {
  const out = { watchedThroughInstall: 0, ranScript: 0, network: [], credentials: [], hosts: {} };
  for (const [name, rec] of Object.entries(pub.packages)) {
    for (const [version, e] of Object.entries(rec.versions || rec)) {
      const i = e.install;
      if (!i) continue;
      out.watchedThroughInstall++;
      if ((i.proc || []).some((p) => /^sh -c /.test((p.argv || []).join(' ')))) out.ranScript++;
      const hosts = [...new Set((i.net || []).map((n) => n.host).filter((h) => h && !/^\//.test(h)))];
      if (hosts.length) {
        out.network.push({ pkg: `${name}@${version}`, hosts });
        for (const h of hosts) out.hosts[h] = (out.hosts[h] || 0) + 1;
      }
      const creds = (i.env || []).filter(readsCredential);
      if (creds.length) out.credentials.push({ pkg: `${name}@${version}`, reads: creds });
    }
  }
  return {
    measured: new Date().toISOString().slice(0, 10),
    watchedThroughInstall: out.watchedThroughInstall,
    ranScript: out.ranScript,
    reachedNetwork: out.network.length,
    readCredentialLike: out.credentials.length,
    topHosts: Object.entries(out.hosts).sort((a, b) => b[1] - a[1]).slice(0, 10),
    network: out.network.sort((a, b) => a.pkg.localeCompare(b.pkg)),
    credentials: out.credentials.sort((a, b) => a.pkg.localeCompare(b.pkg)),
  };
}

module.exports = { summarise };

if (require.main === module) {
  const pub = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'index.json'), 'utf8'));
  const s = summarise(pub);
  fs.writeFileSync(path.join(ROOT, 'docs', 'install-phase.json'), `${JSON.stringify(s, null, 2)}\n`);
  console.log(`  ${s.watchedThroughInstall} versions watched through install · ${s.ranScript} ran a script · ${s.reachedNetwork} reached the network · ${s.readCredentialLike} read a credential-named variable`);
  console.log(`  hosts: ${s.topHosts.map(([h, n]) => `${h} ${n}`).join(', ')}`);
}
