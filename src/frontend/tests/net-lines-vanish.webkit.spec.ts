/**
 * WebKit (iPad Pro 11 descriptor) run of net-lines-vanish.spec.ts — the
 * report came from iPad Safari. Pinches are synthetic touch PointerEvents
 * here (Playwright's WebKit has no multi-touch injection).
 * `WEBKIT=1 npx playwright test --project=webkit-ipad tests/net-lines-vanish.webkit.spec.ts`
 */
import { defineScenarios } from './helpers/net-lines-vanish-body';

defineScenarios('webkit');
