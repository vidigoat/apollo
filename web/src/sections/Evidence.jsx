import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';

/**
 * ── Measured, not claimed ───────────────────────────────────────────────────
 *
 * Each figure is computed by scripts/evidence.js from a report a measurement wrote, with the report
 * and the date. A test fails if this file and those reports ever disagree.
 */
export default function Evidence() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/evidence.json').then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, []);
  if (!data?.items?.length) return null;

  return (
    <section className="wrap" id="evidence">
      <header className="head">
        <h2>Measured, not claimed</h2>
        <p className="lede">
          Every figure here was produced by a command in the repository, and each names the report it
          came from and the day it was measured.
        </p>
      </header>
      <div className="evidence-grid">
        {data.items.map((e) => (
          <figure className="measure" key={e.label}>
            <p className="measure__fig">{e.figure}</p>
            <p className="measure__label">{e.label}</p>
            <p className="measure__detail">{e.detail}</p>
            <figcaption><Gauge size={12} aria-hidden="true" /><code>{e.source}</code> · {e.measured}</figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
