# Screenshots

Five images the README references. All of them exist in the running app today — these are capture
recipes, not mockups to be drawn.

```bash
npm start     # http://localhost:8791
```

Capture at **1440×900**, in a window with no browser chrome if possible (Chrome: ⌘⇧P →
"Capture screenshot" in DevTools, or ⌘⇧4 then Space on macOS). Dark theme is the only theme.

| File | What to capture |
|---|---|
| `hero-wall.png` | Press **Run the stakeout**, let it finish, then scroll to *What changed* so the frame is mostly grey identical rows with one red-bordered row entering at the bottom. This is the whole argument in one frame: the emptiness is the subject, the finding is the intrusion. |
| `wall-silence.png` | Same section, scrolled so **nothing but quiet rows** is visible — no colour at all. It should look almost like a mistake. That is the point. |
| `catch-panel.png` | The *The one that matters* section, full panel: severity pill, the two reasons, the red transcript block, what the open web says, and the model chain ending in "two models, independently, read this as credential exfiltration". |
| `fork-strip.png` | Press **Run** and capture **mid-run**, while hairlines are still amber and filling left to right. Shoot the strip plus the status line underneath. |
| `blind-spot.png` | The *What watching behaviour cannot see* section — the dashed panel with the `money-fmt` invariant probe output and the note admitting the miss. |

Two rules for these captures:

1. **Never retouch a number.** If the screenshot says 28 twins and $0.41, the demo has to say 28
   twins and $0.41. The README already promises the run is reproducible.
2. **Keep the quiet rows in frame.** Cropping to only the findings inverts the argument — the
   project's claim is that almost nothing changed, and a screenshot of nothing but findings says
   the opposite.
