// SYNTHETIC, benign. A prebuilt-binary downloader: reaches a release host at install, reads no
// credential, sends nothing. The network attempt is real behaviour and should be reported as such —
// and should not, on its own, be called malicious.
const https = require('node:https');
try { const r = https.get({ host: 'github.com', path: '/acme/tool/releases/download/v1.0.0/tool-linux-x64' }); r.on('error', () => {}); } catch {}
