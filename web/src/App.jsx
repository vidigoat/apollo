import { useEffect, useState } from 'react';
import Nav from './sections/Nav.jsx';
import Hero from './sections/Hero.jsx';
import Stack from './sections/Stack.jsx';
import Footer from './sections/Footer.jsx';
import Run from './sections/Run.jsx';
import Fleet from './sections/Fleet.jsx';
import How from './sections/How.jsx';
import Check from './sections/Check.jsx';
import Yours from './sections/Yours.jsx';
import Releases from './sections/Releases.jsx';
import Live from './sections/Live.jsx';
import Limits from './sections/Limits.jsx';
import { tree, fleet, published, run } from './lib/api.js';

export default function App() {
  const [meta, setMeta] = useState(null);
  const [calls, setCalls] = useState(null);
  const [scan, setScan] = useState(null);
  const [index, setIndex] = useState(null);

  useEffect(() => {
    // All optional. If the server cannot answer, the elements that would have held those numbers
    // are not rendered — a page that prints a fallback figure lies quietly on the day the API breaks.
    tree().then(setMeta).catch(() => {});
    // The default run's model-call count, served from the committed verdicts, so loading the page
    // spends nothing.
    run().then((r) => setCalls(r.modelCalls)).catch(() => {});
    fleet().then(setScan).catch(() => {});
    published().then(setIndex).catch(() => {});
  }, []);

  return (
    <>
      <Nav />

      <main>
        <Hero />

        {/* The real registry first: what was watched as it published, before anything a visitor does. */}
        <Live />
        <Stack published={index} />
        <Yours />
        <Releases />
        <Run strategies={meta?.strategies || []} tree={meta} />
        <Check />
        {scan && <Fleet data={scan} published={index} />}
        <How tree={meta} calls={calls} />
        <Limits />
      </main>

      <Footer />
    </>
  );
}
