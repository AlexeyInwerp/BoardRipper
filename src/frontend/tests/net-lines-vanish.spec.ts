/**
 * Net (connection) lines vanishing on zoom / pan, mostly after a mode switch
 * (field report 2026-10-13, iPad Safari). Chromium run; the same body runs
 * under WebKit in net-lines-vanish.webkit.spec.ts. See
 * helpers/net-lines-vanish-body.ts for the recorder and the checks.
 */
import { test } from '@playwright/test';
import { defineScenarios } from './helpers/net-lines-vanish-body';

test.use({ hasTouch: true, viewport: { width: 1200, height: 900 } });
defineScenarios('chromium');
