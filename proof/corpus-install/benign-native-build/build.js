// SYNTHETIC, benign. What a native addon's install step looks like from outside: it writes a build
// output next to itself and reads how it was asked to build.
const fs = require('node:fs');
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/addon.node', `built for ${process.platform}-${process.arch} ${process.env.npm_config_build_from_source || ''}`);
