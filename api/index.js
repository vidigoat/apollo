/**
 * The hosted entry point.
 *
 * Nebius requires a working demo URL. This is the same `handler` that `npm start` serves — not a
 * second, subtly different copy, because a demo URL showing something the repository does not do is
 * worse than no demo URL.
 *
 * What a hosted deployment deliberately cannot do: run real packages. `/api/real` stays behind
 * STAKEOUT_ALLOW_LOCAL, which is never set here, and returns a 403 explaining why. Executing
 * strangers' npm packages on shared infrastructure would be the exact thing this project warns
 * about, performed by this project.
 */
module.exports = require('../server');
