import * as Accordion from '@radix-ui/react-accordion';

/**
 * What this cannot do.
 *
 * Stated, rather than discovered by whoever adopts it. A security tool that only advertises its
 * catches is teaching its users to trust a silence it has not earned — and every item below is a
 * silence this tool produces that means nothing at all.
 *
 * It is an accordion because the list is long and a wall of caveats reads as an apology; each one
 * open on its own reads as a specification.
 */

const LIMITS = [
  {
    q: 'A package that was already malicious in the version you had',
    a: `This compares you to your previous version, not to "good". Something that has been exfiltrating since before you installed it looks, to a differential tool, perfectly well behaved. It catches the moment a package turns — which is how most supply-chain compromises arrive — not a clean-room audit.`,
  },
  {
    q: 'A payload that waits',
    a: 'A time bomb, or something gated on a CI variable, does not appear in the transcript at all. A package that did nothing because it was waiting looks exactly like one that did nothing because it is honest.',
  },
  {
    q: 'A change in what the code computes',
    a: 'One package in the demo corpus changes no observable behaviour whatsoever — it touches nothing new and calls nobody, and its arithmetic is different. A tool that watches behaviour misses it completely. What a team needs there is not a better scanner; it is one claim about their own domain that they check after an upgrade. Order totals do not move.',
  },
  {
    q: 'A package that notices it is being watched',
    a: 'Each twin is its own microVM rather than a container, which raises the cost of detection considerably. It does not eliminate it.',
  },
  {
    q: 'And one thing it now does see',
    a: `2026's attacks ship a decoder rather than a payload, and a string becoming a function never becomes a syscall — so a kernel tracer watches the process and misses the thought. The nodert strategy watches Node's own API surface and catches the construction. It is weaker than eBPF nearly everywhere and stronger in exactly that one place, which is why a transcript always records which strategy watched it.`,
  },
];

export default function Limits() {
  return (
    <section className="wrap" id="limits">
      <h2>The silences that mean nothing</h2>
      <p className="lede">
        Every item here produces a clean result for a reason that has nothing to do with safety. A
        tool that lists only its catches is training you to trust a quiet it has not earned.
      </p>

      <Accordion.Root className="limits" type="single" collapsible>
        {LIMITS.map((l) => (
          <Accordion.Item value={l.q} key={l.q}>
            <Accordion.Header>
              <Accordion.Trigger className="limit__trigger">
                {l.q}
                <span className="limit__sign" aria-hidden="true">
                  +
                </span>
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className="finding__body limit__body">
              <p>{l.a}</p>
            </Accordion.Content>
          </Accordion.Item>
        ))}
      </Accordion.Root>
    </section>
  );
}
