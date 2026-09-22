import { useEffect, useRef } from 'react';

/**
 * The whole dependency tree, one mark per package.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The page kept saying "1,214 packages, 15 of them moved" and expecting the reader to feel the
 * ratio. Nobody feels a ratio. They feel a field of twelve hundred marks with fifteen lit in it,
 * and that picture is the argument: almost nothing changes, which is exactly why the thing that
 * did is worth looking at.
 *
 * It is also the honest shape of the economics. The expensive design re-runs everything; this one
 * re-runs the lit marks and leaves the rest alone, and you can see how much "the rest" is.
 *
 * Canvas rather than 1,214 DOM nodes, because 1,214 DOM nodes to draw 1,214 three-pixel squares is
 * how a page becomes slow for no reason anybody can see.
 */
export default function Tree({ total, moved, alarming = 1 }) {
  const canvas = useRef(null);

  useEffect(() => {
    if (!total) return;
    const el = canvas.current;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      if (!w) return;

      const css = getComputedStyle(document.documentElement);
      const rule = css.getPropertyValue('--rule').trim();
      const watched = css.getPropertyValue('--watched').trim();
      const drift = css.getPropertyValue('--drift').trim();

      /*
       * A fixed pitch, and the columns fall out of the width.
       *
       * Deriving the cell size from the count made a coarse grid of nine-pixel tiles, which reads
       * as a chart OF something. A fine grain reads as a lot of things — which is what twelve
       * hundred packages are — so the mark is small and constant and the field is simply as wide
       * as the column. Same measurement either way; only one of them looks like twelve hundred.
       */
      const pitch = w < 520 ? 6 : 7;
      const gap = 2;
      const cell = pitch - gap;
      const cols = Math.max(24, Math.floor((w + gap) / pitch));
      const rows = Math.ceil(total / cols);
      const h = rows * pitch - gap;

      el.width = w * dpr;
      el.height = h * dpr;
      el.style.height = `${h}px`;

      const g = el.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      /*
       * Which marks are lit is deterministic, not random — and not evenly spaced either.
       *
       * Random would redraw differently on every refresh, and a picture of a measurement that
       * changes when you reload is not a picture of a measurement.
       *
       * But a fixed stride is worse. Fifteen marks spread every 81st cell, in a grid 78 columns
       * wide, land three columns further right on each successive row — a flawless diagonal across
       * the field. It looked like a designed flourish and implied a pattern in the data that does
       * not exist, which is the one thing a picture of evidence must never do.
       *
       * The golden ratio fixes it for the reason it always does: its fractional multiples never
       * settle into a cycle, so they cannot align with a column count that changes with the width
       * of somebody's window. Same marks on every screen, arranged like nothing in particular.
       */
      const PHI = 0.618033988749895;
      const lit = new Set();
      for (let k = 0; lit.size < moved && k < moved * 8; k++) {
        let at = Math.floor(total * ((k * PHI) % 1));
        while (lit.has(at)) at = (at + 1) % total;
        lit.add(at);
      }

      // The one that matters, and it has to be the same one every time: the lit mark nearest the
      // middle of the field, so it is never hiding in a corner or off the end of a ragged last row.
      const ordered = [...lit].sort((a, b) => Math.abs(a - total / 2) - Math.abs(b - total / 2));
      const loud = ordered.slice(0, alarming);

      for (let i = 0; i < total; i++) {
        const x = (i % cols) * pitch;
        const y = Math.floor(i / cols) * pitch;

        if (loud.includes(i)) {
          g.fillStyle = drift;
          g.globalAlpha = 1;
        } else if (lit.has(i)) {
          g.fillStyle = watched;
          g.globalAlpha = 1;
        } else {
          // The quiet majority. Present, drawn, and deliberately almost nothing to look at.
          g.fillStyle = rule;
          g.globalAlpha = 0.85;
        }
        g.fillRect(x, y, cell, cell);
      }
      g.globalAlpha = 1;
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [total, moved, alarming]);

  if (!total) return null;

  return (
    <canvas
      className="tree"
      ref={canvas}
      role="img"
      aria-label={`${total} packages in the tree; ${moved} of them changed version and were re-run`}
    />
  );
}
