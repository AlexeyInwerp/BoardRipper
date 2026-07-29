import base from './playwright.config';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  ...base,
  timeout: 90000,
  use: {
    ...base.use,
    launchOptions: {
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
});
