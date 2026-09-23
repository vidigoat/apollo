/**
 * What the open web says about a version.
 *
 * Behaviour alone cannot tell you whether a new network destination is an attack or a feature. A
 * telemetry endpoint and an exfiltration endpoint look identical in a syscall trace. The thing
 * that separates them is whether anyone announced it.
 *
 * So: a changelog entry, an advisory, a maintainer's post — or nothing at all. All four are useful
 * and the fourth is the interesting one. A package that quietly started calling a host nobody has
 * ever written about is not proven malicious, but it has earned a human's attention in a way that
 * "adds opt-in telemetry, see CHANGELOG" has not.
 *
 * Two honesty rules, both load-bearing:
 *
 *   ABSENCE IS WEAK.   Most small packages ship without release notes. Silence raises priority; it
 *                      never proves intent, and nothing downstream is allowed to treat it as proof.
 *
 *   RESULTS ARE DATA.  Search results are attacker-reachable — anyone can publish a page. They are
 *                      passed to the model inside the same untrusted fence as the transcript, and
 *                      never as instructions.
 */

const ENDPOINT = process.env.TAVILY_URL || 'https://api.tavily.com/search';

const hasKey = () => Boolean(process.env.TAVILY_API_KEY);

/** Pages that are just the registry echoing the package back at us. Not evidence of anything. */
const NOT_EVIDENCE = /^(https?:\/\/)?(www\.)?(npmjs\.com\/package|npmjs\.org|libraries\.io|snyk\.io\/advisor)/i;

const ADVISORY = /(CVE-\d{4}-\d+|GHSA-[\w-]+|advisory|malicious|compromis|supply.chain)/i;
const RELEASE = /(changelog|release|CHANGELOG\.md|releases\/tag)/i;

function verdictFor({ changelog, advisory, mentions }) {
  if (advisory) return 'A security advisory names this version.';
  if (changelog) return 'The maintainer documented this release.';
  if (mentions > 0) return `Mentioned in ${mentions} place${mentions === 1 ? '' : 's'}, none of which is a release note.`;
  return 'Nothing on the open web mentions this version. That raises priority; on its own it proves nothing.';
}

/**
 * Look up one package version.
 *
 * @param {string} pkg
 * @param {string} version
 * @param {object} [opts] { recorded, fetchImpl } — recorded is the offline stand-in map
 * @returns {Promise<{changelog:?string, advisory:?string, mentions:number, verdict:string,
 *                    sources:string[], simulated:boolean}>}
 */
async function lookUp(pkg, version, opts = {}) {
  const key = `${pkg}@${version}`;

  if (!hasKey() || opts.recorded) {
    const hit = opts.recorded?.[key];
    return {
      changelog: hit?.changelog ?? null,
      advisory: hit?.advisory ?? null,
      mentions: hit?.mentions ?? 0,
      verdict: hit?.verdict ?? verdictFor({ changelog: null, advisory: null, mentions: 0 }),
      sources: hit?.sources ?? [],
      simulated: true,
    };
  }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const attempts = opts.attempts ?? 3;

  /*
   * An empty answer is asked again before it is believed.
   *
   * "Nothing on the open web mentions this" is EVIDENCE here — about a brand-new host, it is the
   * finding. So a search that comes back with no results at all has to be told apart from one that
   * came back with results, none of which mention this version. Measured against the live API: the
   * same query for a widely-released version returned zero results in one run of three and three
   * mentions in the other two. A flaky empty answer read as evidence is evidence manufactured
   * against an innocent package.
   *
   * So a completely empty answer is retried, and if it is still empty the lookup says the SEARCH
   * failed — which is no evidence either way — rather than that the web is silent.
   */
  /*
   * And an answer where no result NAMES the version is asked again too. With the query fixed, one
   * live run in four for express 4.18.2 still came back with six results and none mentioning
   * 4.18.2 — and "nothing mentions this version" is the one reading that counts against a package.
   * So silence has to be heard more than once; the answer that names the version most is kept.
   */
  const naming = (j) => (j?.results || []).filter((r) => r.url && !NOT_EVIDENCE.test(r.url) && `${r.title} ${r.content}`.includes(version)).length;
  let json = null;
  let best = null;
  let tried = 0;
  for (; tried < attempts; tried++) {
    if (tried) await sleep(400 * tried);
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({
        query: queryFor(pkg, version),
        search_depth: 'basic',
        max_results: 6,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`tavily ${res.status}: ${body.slice(0, 200)}`);
    }
    json = await res.json();
    if ((json.results || []).length && (!best || naming(json) > naming(best))) best = json;
    if (best && naming(best) > 0) break;
  }
  json = best || json;

  if (!(json?.results || []).length) {
    return {
      changelog: null,
      advisory: null,
      mentions: 0,
      sources: [],
      simulated: false,
      searchFailed: true,
      attempts: tried,
      verdict: `The search returned no results at all, ${tried} time${tried === 1 ? '' : 's'}. ` +
        'That is a search that did not work, not a web that is silent — it is no evidence either way.',
    };
  }

  return summarise(json, version);
}

/*
 * The query is about the PACKAGE, not about changelogs.
 *
 * It was `${pkg} ${version} changelog release notes OR security advisory`, and the generic words
 * won: for express 4.18.2 all six results were other products' changelog pages — n8n, Instacart,
 * keepachangelog.com — and not one mentioned the version. So the lookup reported the web silent
 * about one of the most-downloaded releases on npm, and silence about a version is evidence against
 * it here. Measured on three packages, `npm <pkg> <version>` returned results naming the version
 * every time (4 of 6, 4 of 6, 1 of 6 for left-pad) and advisory pages where they exist. Whether a
 * result is a changelog or an advisory is decided from the results, not asked for in the query.
 */
const queryFor = (pkg, version) => `npm ${pkg} ${version}`;

/** Turn a pile of search results into the four facts the judgement layer actually uses. */
function summarise(json, version) {
  const results = (json.results || []).filter((r) => r.url && !NOT_EVIDENCE.test(r.url));

  // A result only counts as being about THIS version if it says so. "react 18 is great" is not a
  // changelog for 18.3.1, and treating it as one would silently excuse a real finding.
  const aboutThis = results.filter((r) => `${r.title} ${r.content}`.includes(version));

  const adv = aboutThis.find((r) => ADVISORY.test(`${r.title} ${r.url} ${r.content}`));
  const rel = aboutThis.find((r) => RELEASE.test(`${r.title} ${r.url}`));

  const facts = {
    changelog: rel ? trim(rel.content) : null,
    advisory: adv ? trim(adv.content) : null,
    mentions: aboutThis.length,
    sources: aboutThis.slice(0, 4).map((r) => r.url),
    simulated: false,
    searchFailed: false,
  };
  return { ...facts, verdict: verdictFor(facts) };
}

const trim = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);

module.exports = { lookUp, summarise, verdictFor, hasKey, NOT_EVIDENCE, queryFor };
