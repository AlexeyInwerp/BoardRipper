import './polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { installBrowserZoomBlock } from './store/browser-zoom-block';
import { startMcpBridgeIfEnabled } from './store/mcp-bridge';

installBrowserZoomBlock();
startMcpBridgeIfEnabled();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
