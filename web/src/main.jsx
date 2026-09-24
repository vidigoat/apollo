import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion } from 'motion/react';

const features = () => import('./motion-features.js').then((m) => m.default);
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/*
      The light Motion build: m.* components with only the DOM animation features, loaded once here.
      The full motion.* build was 39% of the page's JavaScript for fades and slides. `strict` makes a
      stray motion.* a loud error rather than a quiet return of the weight.
    */}
    <LazyMotion features={features} strict>
      <App />
    </LazyMotion>
  </StrictMode>
);
