import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
// Side-effect import: instantiating the theme store sets <html data-theme=...>
// before the first React render, so themed CSS overrides apply on the first paint.
import './theme/theme-store';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
