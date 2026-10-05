/**
 * The watcher's state, kept somewhere that outlives the machine it runs on.
 *
 * On a laptop the state directory is enough. On Nebius Serverless Jobs it is not: a job lives at
 * most seven days and its disk goes with it, so a watch that has to run until the deadline is a
 * chain of jobs, and each one has to start where the last one stopped. So the state directory is
 * mirrored to S3-compatible object storage (Nebius Object Storage in practice): restored before the
 * first poll when the directory is empty, pushed after that at most once a minute.
 *
 *   APOLLO_STATE_S3=s3://bucket/prefix        where the mirror lives; unset means no mirror
 *   APOLLO_S3_ENDPOINT                        default https://storage.eu-north1.nebius.cloud
 *   APOLLO_S3_REGION                          default eu-north1
 *   APOLLO_S3_KEY_ID / APOLLO_S3_SECRET     an access key for that bucket only
 *
 * Pushing is best-effort and says so: a failed push is logged and tried again next minute, and it
 * never stops the watch — losing a minute of mirror is recoverable, a watcher that stops on a
 * storage hiccup is not. Restoring is not best-effort: a mirror that is configured and unreadable
 * stops the start, because starting fresh over a watch that exists would forget where it was.
 *
 * Signing is SigV4 with nothing installed, the same algorithm as the sibling project's
 * agent/sigv4.js (checked there and here against AWS's published `get-vanilla` vector). S3 is the
 * one service whose canonical URI is encoded once, and whose payload hash travels as a header.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** SigV4. Returns the headers to send, and the intermediate strings so a test can check them. */
function sign({ method = 'GET', url, headers = {}, body = '' }, creds, { region, service }, now = new Date()) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body || '');
  const all = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: u.host,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((k) => `${k}:${all[k].replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalUri = service === 's3'
    ? u.pathname.split('/').map((seg) => rfc3986(decodeURIComponent(seg))).join('/') || '/'
    : u.pathname.split('/').map((seg) => rfc3986(rfc3986(decodeURIComponent(seg)))).join('/') || '/';
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    headers: { ...headers, 'x-amz-date': amzDate, authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/** The files that make up a watch. Everything else in the directory is ignored. */
const FILES = ['state.json', 'results.jsonl', 'lookalikes.jsonl', 'hours.jsonl', 'heartbeat.json'];

class Mirror {
  /** From the environment; null when no mirror is configured. */
  static fromEnv(env = process.env, deps = {}) {
    if (!env.APOLLO_STATE_S3) return null;
    const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(env.APOLLO_STATE_S3);
    if (!m) throw new Error(`APOLLO_STATE_S3 must look like s3://bucket/prefix, not ${env.APOLLO_STATE_S3}`);
    if (!env.APOLLO_S3_KEY_ID || !env.APOLLO_S3_SECRET) throw new Error('APOLLO_STATE_S3 is set but APOLLO_S3_KEY_ID / APOLLO_S3_SECRET are not');
    return new Mirror({
      bucket: m[1],
      prefix: m[2].replace(/\/+$/, ''),
      endpoint: (env.APOLLO_S3_ENDPOINT || 'https://storage.eu-north1.nebius.cloud').replace(/\/+$/, ''),
      region: env.APOLLO_S3_REGION || 'eu-north1',
      creds: { accessKeyId: env.APOLLO_S3_KEY_ID, secretAccessKey: env.APOLLO_S3_SECRET },
      ...deps,
    });
  }

  constructor({ bucket, prefix = '', endpoint, region, creds, fetchImpl = globalThis.fetch, now = () => new Date() }) {
    Object.assign(this, { bucket, prefix, endpoint, region, creds, fetchImpl, now });
    this.pushed = new Map();
    this.lastPush = 0;
  }

  url(name) {
    const key = [this.prefix, name].filter(Boolean).join('/');
    return `${this.endpoint}/${this.bucket}/${key.split('/').map(rfc3986).join('/')}`;
  }

  async request(method, name, body = '') {
    const url = this.url(name);
    const { headers } = sign({ method, url, headers: { 'x-amz-content-sha256': sha256(body) }, body }, this.creds, { region: this.region, service: 's3' }, this.now());
    return this.fetchImpl(url, { method, headers, body: method === 'PUT' ? body : undefined });
  }

  /** Bring the watch back into an empty directory. Returns how many files came back. */
  async restore(dir) {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(path.join(dir, 'state.json'))) return 0; // a local watch is never overwritten
    let got = 0;
    for (const name of FILES) {
      const res = await this.request('GET', name);
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`the state mirror answered ${res.status} for ${name}; not starting over a watch that may exist`);
      const text = await res.text();
      fs.writeFileSync(path.join(dir, name), text);
      this.pushed.set(name, sha256(text));
      got++;
    }
    return got;
  }

  /**
   * Push what changed, at most once a minute unless forced. Never throws: returns what happened,
   * so the watcher can log it and carry on.
   */
  async push(dir, { force = false } = {}) {
    const at = this.now().getTime();
    if (!force && at - this.lastPush < 60000) return { skipped: true };
    this.lastPush = at;
    const done = [];
    const failed = [];
    for (const name of FILES) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      const body = fs.readFileSync(file, 'utf8');
      const hash = sha256(body);
      if (this.pushed.get(name) === hash) continue;
      try {
        const res = await this.request('PUT', name, body);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.pushed.set(name, hash);
        done.push(name);
      } catch (e) {
        failed.push(`${name}: ${e.message}`);
      }
    }
    return { pushed: done, failed };
  }
}

module.exports = { Mirror, sign, FILES };
