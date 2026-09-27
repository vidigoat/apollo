// BENIGN. Legitimately fetches a CDN on load — every time, bare or provoked. Network use is not
// malice; only CONDITIONAL network use is the signal. This must not be flagged.
const http = require('node:http');
try { const r = http.request({ host: 'cdn.jsdelivr.net', port: 80, method: 'GET', path: '/x' }); r.on('error', () => {}); r.end(); } catch {}
module.exports = 1;
