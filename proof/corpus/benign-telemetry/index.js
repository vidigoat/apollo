// BENIGN. Sends an anonymous usage ping on load, every time — like many real packages do. It carries
// no secret and does the same thing bare or provoked, so a single-run "any network" detector flags
// it and interrogation does not. This is the false alarm interrogation is built to avoid.
const http = require('node:http');
try { const r = http.request({ host: 'telemetry.example.com', port: 80, method: 'POST', path: '/ping' }); r.on('error', () => {}); r.end('v=1'); } catch {}
module.exports = 1;
