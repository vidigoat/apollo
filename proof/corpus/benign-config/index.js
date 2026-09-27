// BENIGN. Reads a lot of ordinary configuration from the environment — NODE_ENV, PORT, HOME, TZ, LANG
// — always, and never sends anything. Reading env is not theft; sending a secret is. Must not flag.
const cfg = { env: process.env.NODE_ENV, port: process.env.PORT, home: process.env.HOME, tz: process.env.TZ, lang: process.env.LANG };
module.exports = cfg;
