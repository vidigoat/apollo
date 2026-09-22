/**
 * The hosted entry point, for every path under /api.
 *
 * A catch-all rather than a rewrite. `{"source": "/(.*)", "destination": "/api"}` does reach this
 * function, but it reaches it having replaced the path with `/api` — so every route inside the
 * server saw the same pathname and fell through to "not found", on a deployment that otherwise
 * looked perfectly healthy. Vercel serves `public/` from the filesystem before rewrites are
 * considered, so the pages were fine and only the data was missing, which is the hardest version
 * of that bug to notice.
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
