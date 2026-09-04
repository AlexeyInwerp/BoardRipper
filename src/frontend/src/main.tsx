import './polyfills';
// Must precede any renderer creation: swaps PixiJS's `new Function` uniform
// parsers for eval-free ones. Lets the hosted lite build's CSP drop
// 'unsafe-eval' (deploy/boardripper-web.htaccess) — the only reason it was there.
import 'pixi.js/unsafe-eval';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { installBrowserZoomBlock } from './store/browser-zoom-block';
import { startMcpBridgeIfEnabled } from './store/mcp-bridge';
import { initSessionStore } from './store/session-store';

installBrowserZoomBlock();
startMcpBridgeIfEnabled();
initSessionStore();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
