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
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({
      query: `${pkg} ${version} changelog release notes OR security advisory`,
      search_depth: 'basic',
      max_results: 6,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`tavily ${res.status}: ${body.slice(0, 200)}`);
  }

  return summarise(await res.json(), version);
}

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
  };
  return { ...facts, verdict: verdictFor(facts) };
}

const trim = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);

module.exports = { lookUp, summarise, verdictFor, hasKey, NOT_EVIDENCE };
