// @ts-check
require('dotenv').config({ path: '.env.local' });
const { defineConfig } = require('@playwright/test');

const HEADLESS = `${process.env.HEADLESS || 'true'}`.toLowerCase() !== 'false';
const SLOW_MO = Number(process.env.PWSLOWMO || 0);
const ENABLE_HTML_REPORT = `${process.env.PW_HTML_REPORT || 'true'}`.toLowerCase() !== 'false';
const TRACE_MODE = process.env.PW_TRACE || 'retain-on-failure';
const SCREENSHOT_MODE = process.env.PW_SCREENSHOT || 'only-on-failure';
const VIDEO_MODE = process.env.PW_VIDEO || 'retain-on-failure';
const EDGE_EXECUTABLE_PATH = process.env.EDGE_EXECUTABLE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROJECT_VIEWPORT = HEADLESS ? { width: 1920, height: 1080 } : null;
const PROJECT_ARGS = HEADLESS
  ? ['--no-first-run', '--no-default-browser-check', '--disable-background-networking']
  : ['--start-maximized', '--no-first-run', '--no-default-browser-check', '--disable-background-networking'];

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  retries: 1,
  workers: 1,
  timeout: Number(process.env.TEST_TIMEOUT_MS || 600000), // Increased to 10 min for slow Siebel
  reporter: ENABLE_HTML_REPORT
    ? [
      ['list'],
      ['html', { outputFolder: 'output/playwright-report', open: 'never' }]
    ]
    : [['list']],
  use: {
    browserName: 'chromium',
    headless: HEADLESS,
    slowMo: SLOW_MO,
    trace: /** @type {any} */ (TRACE_MODE),
    screenshot: /** @type {any} */ (SCREENSHOT_MODE),
    video: /** @type {any} */ (VIDEO_MODE),
    ignoreHTTPSErrors: true
  },
  projects: [
    {
      name: 'edge',
      use: {
        viewport: PROJECT_VIEWPORT,
        launchOptions: {
          args: PROJECT_ARGS,
          executablePath: EDGE_EXECUTABLE_PATH
        }
      }
    }
  ]
});
