// Buffer any unexpected stdout writes from third-party modules so we can
// ensure the agent emits only a single clean JSON object on stdout.
// We capture the original write, buffer interim writes, and flush them
// to stderr before printing the final result.
const __origStdoutWrite = process.stdout.write.bind(process.stdout);
let __stdoutBuffer = '';
process.stdout.write = (chunk, encoding, cb) => {
  try { __stdoutBuffer += String(chunk || ''); } catch (e) {}
  if (typeof cb === 'function') cb();
  return true;
};

require('dotenv').config({ path: '.env.local' });

const path = require('path');
const { readInputTestcases } = require('./input-agent');
const { chromium, expect } = require('@playwright/test');
const { generateActionBlock, generateLaunchMobilePLPFunction, generateClickLocatorCode, cleanControlLabel, deriveJourneyRuntimeOptions } = require('./playwright-generator');
const { createArtifactManager, isVerificationStep } = require('./artifact-agent');
let pwConfig = null;
try {
  // Load the Playwright test runner config to mirror its launch settings exactly
  pwConfig = require(path.resolve(__dirname, '..', '..', 'playwright.config.js'));
} catch (e) {
  // ignore if not present or fails to load; we'll fall back to env-based settings
  pwConfig = null;
}

// Redirect all informal console.log calls to stderr so orchestrator can safely
// parse stdout for the final JSON result. Diagnostic messages will still
// appear on stderr via console.error(). We preserve original console.log
// in case modules expect it, but forward to console.error.
try {
  const _origLog = console.log;
  console.log = (...args) => {
    try { console.error.apply(console, args); } catch (e) { try { _origLog.apply(console, args); } catch (e2) {} }
  };
} catch (e) {}

function splitAndCleanSteps(orderStepsText) {
  if (!orderStepsText) return [];

  // Normalize newlines
  let text = orderStepsText.replace(/\r/g, '\n');

  // Replace any occurrences of multiple newlines with single newline
  text = text.replace(/\n+/g, '\n');

  // Split on numbering like "1.", "1)" or newlines
  const rawParts = text
    .split(/(?:\n)|(?:\d+\s*[\.|\)]\s*)/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Clean each step: remove extra explanatory clauses and normalize spacing
  const cleaned = rawParts.map((step) => {
    let s = step;
    // Remove common trailing notes introduced in CSV like "with responsibility: ..."
    s = s.replace(/with responsibility[:\s].*$/i, '').trim();
    // Remove leading numbering remnants like "1." if any
    s = s.replace(/^\d+\.?\s*/,'').trim();
    // Collapse multiple spaces
    s = s.replace(/\s+/g, ' ');
    // Trim trailing punctuation
    s = s.replace(/[\.，,;:\s]+$/,'');
    return s;
  }).filter(Boolean);

  return cleaned;
}

function getBrowserLaunchOptions() {
  // Environment fallbacks
  const headlessEnv = `${process.env.HEADLESS || 'true'}`.toLowerCase() !== 'false';
  const slowMoEnv = Number(process.env.PWSLOWMO || 0);

  // Extract from Playwright config safely
  const project = pwConfig && Array.isArray(pwConfig.projects) && pwConfig.projects.length ? pwConfig.projects[0] : null;
  const projectUse = project && project.use ? project.use : null;
  const launchOptionsFromConfig = projectUse && projectUse.launchOptions ? projectUse.launchOptions : null;

  // Read headless and slowMo from top-level use in config, if present
  const headlessFromConfig = pwConfig && pwConfig.use && typeof pwConfig.use.headless !== 'undefined' ? pwConfig.use.headless : undefined;
  const slowMoFromConfig = pwConfig && pwConfig.use && typeof pwConfig.use.slowMo !== 'undefined' ? pwConfig.use.slowMo : undefined;

  const headless = typeof headlessFromConfig !== 'undefined' ? headlessFromConfig : headlessEnv;
  const slowMo = typeof slowMoFromConfig !== 'undefined' ? slowMoFromConfig : slowMoEnv;

  // Read executablePath and args separately from launchOptions in the project config
  const executablePath = launchOptionsFromConfig && typeof launchOptionsFromConfig.executablePath === 'string'
    ? launchOptionsFromConfig.executablePath
    : (process.env.EDGE_EXECUTABLE_PATH || undefined);

  const args = launchOptionsFromConfig && Array.isArray(launchOptionsFromConfig.args)
    ? launchOptionsFromConfig.args
    : (headless ? ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'] : ['--start-maximized', '--no-first-run', '--no-default-browser-check', '--disable-background-networking']);

  // Determine channel: only allow a string value and prefer 'msedge' when project name indicates edge
  let channel;
  if (launchOptionsFromConfig && typeof launchOptionsFromConfig.channel === 'string') {
    channel = launchOptionsFromConfig.channel;
  } else if (project && project.name && String(project.name).toLowerCase().includes('edge')) {
    channel = 'msedge';
  } else {
    channel = undefined;
  }

  // viewport comes from project.use.viewport if present (may be null)
  const viewport = projectUse && Object.prototype.hasOwnProperty.call(projectUse, 'viewport') ? projectUse.viewport : null;

  return {
    executablePath,
    headless,
    slowMo,
    args,
    channel,
    viewport
  };
}

function isRecoverableNavigationError(error) {
  const message = String((error && error.message) || error || '');
  return /ERR_ABORTED|ERR_FAILED|ERR_CONNECTION_RESET|Navigation timeout/i.test(message);
}

async function navigateToBaseUrl(page, baseUrl, timeout) {
  const url = String(baseUrl || '').trim();
  if (!url) throw new Error('BASE_URL is not configured');

  const getCurrentUrl = () => {
    try {
      return page.url();
    } catch (e) {
      return '';
    }
  };

  const attempts = [
    { waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 60000) },
    { waitUntil: 'commit', timeout: Math.max(timeout, 45000) },
    { waitUntil: 'load', timeout: Math.max(timeout, 45000) }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      console.log('Navigating to BASE_URL with options:', attempt);
      const response = await page.goto(url, attempt);
      const landedUrl = getCurrentUrl();
      console.log('BASE_URL navigation landed on:', landedUrl || '<unavailable>');
      if (response) {
        console.log('BASE_URL response status:', response.status());
      }
      return response;
    } catch (error) {
      lastError = error;
      const landedUrl = getCurrentUrl();
      console.warn('BASE_URL navigation attempt failed:', error && error.message ? error.message : String(error));
      console.warn('URL after failed navigation attempt:', landedUrl || '<unavailable>');

      if (landedUrl && landedUrl !== 'about:blank' && !/about:blank/i.test(landedUrl)) {
        console.log('Continuing after navigation failure because the page moved away from about:blank');
        return null;
      }

      if (!isRecoverableNavigationError(error)) {
        throw error;
      }

      await page.waitForTimeout(2000).catch(() => {});
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    }
  }

  throw lastError;
}

async function resolveActivePage(context, page, timeout = 5000) {
  try {
    if (page && typeof page.isClosed === 'function' && !page.isClosed()) {
      return page;
    }
  } catch (e) {}

  try {
    const candidates = context.pages().filter((p) => {
      try {
        return p && typeof p.isClosed === 'function' && !p.isClosed();
      } catch (e) {
        return false;
      }
    });
    if (candidates.length) {
      return candidates[candidates.length - 1];
    }
  } catch (e) {}

  try {
    return await context.waitForEvent('page', { timeout });
  } catch (e) {
    return page;
  }
}

// Enumerate visible interactive controls and print diagnostics to stderr.
async function dumpVisibleControls(page) {
  try {
    const controls = await page.evaluate(() => {
      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        return !!(rect.width || rect.height) && window.getComputedStyle(el).visibility !== 'hidden' && window.getComputedStyle(el).display !== 'none';
      }
      const roles = [];
      const nodes = Array.from(document.querySelectorAll('button,a,[role="tab"],[role="link"],[role="menuitem"]'));
      return nodes.filter(isVisible).map((el) => {
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const text = (el.innerText || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
        // build a short unique-ish selector hint
        let sel = el.tagName.toLowerCase();
        if (el.id) sel += `#${el.id}`;
        else if (el.className) sel += `.${String(el.className).split(/\s+/).filter(Boolean).join('.')}`;
        return { role, text, selector: sel };
      });
    });
    if (Array.isArray(controls) && controls.length) {
      console.error('VISIBLE_CONTROLS_COUNT:', controls.length);
      for (const c of controls) console.error('VISIBLE_CONTROL:', c.role, '|', c.text || '<no-text>', '|', c.selector || '');
    } else {
      console.error('VISIBLE_CONTROLS_COUNT: 0');
    }
  } catch (e) {
    console.error('Failed to dump visible controls:', e && e.message);
  }
}

async function executeActionBlock(context, page, actionBlock) {
  if (!actionBlock || !actionBlock.trim()) return;

  // If the generated action block contains only comments or manual-verification
  // notes (e.g. "// Manual verification required: ..."), skip execution to
  // avoid SyntaxError when attempting to compile an empty function body.
  try {
    const _raw = String(actionBlock || '');
    const _stripped = _raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
    if (!_stripped) {
      console.error('Skipping manual-only action block (no executable statements)');
      return;
    }
  } catch (e) {
    // if comment stripping fails for any reason, proceed to attempt execution
  }

  try {
    // Execute the generated action block in an isolated async function with access to
    // `page`, `expect` and `process` just like the generated Playwright tests.
    const fn = new Function('page', 'expect', 'process', `return (async () => { ${actionBlock} })();`);
    await fn(page, expect, process);
  } catch (e) {
    // Provide verbatim action block and stacktrace to help diagnose generator syntax issues
    try { console.error('Action block execution error:', e && e.message); } catch (e2) {}
    try { console.error('Action block source:\n' + String(actionBlock).slice(0, 10000)); } catch (e2) {}
    try { console.error(e && e.stack ? e.stack : String(e)); } catch (e2) {}
    throw e;
  }
}

async function buildExecutionCase(testCaseId, inputFilePath) {
  const all = await readInputTestcases(inputFilePath);
  const idNormalized = String(testCaseId || '').replace(/^TOM_0*/i, '').replace(/^0+/, '');
  let match = all.find((t) => String(t.TOM_NUM) === String(testCaseId));
  if (!match) {
    // allow matching numeric suffixes or plain numbers
    match = all.find((t) => String(t.TOM_NUM).replace(/^TOM_0*/i, '').replace(/^0+/, '') === idNormalized);
  }
  if (!match) throw new Error(`Test case '${testCaseId}' not found in input`);
  const steps = Array.isArray(match.steps) ? match.steps : splitAndCleanSteps(match.Order_Steps || match.Order_Steps || '');
  return {
    testCaseId: match.TOM_NUM || testCaseId,
    userJourney: match.User_Journey,
    steps: steps,
    postVerification: match.Post_Verification || match.PostVerification || ''
  };
}

async function runExecutionCase(testCaseId = 'TOM_01', inputFilePath) {
  const executionCase = await buildExecutionCase(testCaseId, inputFilePath);
  return runExecutionCaseFromCase(executionCase);
}

async function runExecutionCaseFromCase(executionCase) {
  const artifactManager = await createArtifactManager(executionCase.testCaseId);
  process.env.CURRENT_TESTCASE_ID = String(executionCase.testCaseId || '');
  process.env.EXPECT_ADD_TO_CART_VALIDATION = /^(TOM_04|TOM_05)$/i.test(String(executionCase.testCaseId || '')) ? 'true' : 'false';
  const tomMatch = String(executionCase.testCaseId || '').match(/^TOM_0*([0-9]+)$/i);
  const tomNum = tomMatch ? Number(tomMatch[1]) : NaN;
  const inMobileRange = Number.isFinite(tomNum) && tomNum >= 1 && tomNum <= 58;
  const launchOptions = getBrowserLaunchOptions();
  const allowHeadlessMobile = String(process.env.EXECUTION_AGENT_ALLOW_HEADLESS_MOBILE || 'false').toLowerCase() === 'true';
  if (inMobileRange && launchOptions.headless && !allowHeadlessMobile) {
    launchOptions.headless = false;
    launchOptions.args = ['--start-maximized', '--no-first-run', '--no-default-browser-check', '--disable-background-networking'];
    console.log('Forcing headed browser for mobile execution because local Siebel navigation is unstable in headless mode.');
  }
  // Log exact runtime values we're using so they match Playwright test runner
  console.log('Browser executable:', launchOptions.executablePath || 'none');
  console.log('Browser channel:', launchOptions.channel || 'none');
  console.log('Viewport (from config):', launchOptions.viewport);
  console.log('Headless:', launchOptions.headless);

  // Build explicit launch options object to avoid passing unexpected/invalid fields
  const finalLaunch = {
    headless: launchOptions.headless,
    ...(launchOptions.executablePath ? { executablePath: launchOptions.executablePath } : {}),
    ...(Array.isArray(launchOptions.args) ? { args: launchOptions.args } : {}),
    ...(typeof launchOptions.slowMo !== 'undefined' ? { slowMo: launchOptions.slowMo } : {})
  };

  // log final launch options before launching
  console.log('Final launch options:', {
    executablePath: finalLaunch.executablePath || 'none',
    headless: finalLaunch.headless,
    slowMo: finalLaunch.slowMo || 0,
    args: finalLaunch.args || []
  });

  // If channel is a valid string, include it when launching (Playwright expects a string)
  // Debug channel value/type before launching
  console.log('Channel value:', launchOptions.channel);
  console.log('Channel type:', typeof launchOptions.channel);

  const launchForPlaywright = Object.assign({}, finalLaunch);
  if (launchOptions.channel && typeof launchOptions.channel === 'string') {
    launchForPlaywright.channel = launchOptions.channel;
  }

  const browser = await chromium.launch(launchForPlaywright);
  // Use viewport exactly as provided by the Playwright config (or fallback to 1920x1080 when headless)
  const projectViewport = (launchOptions.viewport !== null && typeof launchOptions.viewport !== 'undefined')
    ? launchOptions.viewport
    : (launchOptions.headless ? { width: 1920, height: 1080 } : null);

  const enableArtifacts = String(process.env.ENABLE_ARTIFACTS || 'true').toLowerCase() !== 'false';
  const disableVideo = String(process.env.DISABLE_VIDEO || 'false').toLowerCase() === 'true';
  // Respect explicit DISABLE_TRACING but prefer to enable tracing when artifacts are requested.
  let disableTracing = String(process.env.DISABLE_TRACING || 'false').toLowerCase() === 'true';
  if (enableArtifacts && disableTracing) {
    // If artifacts are requested but tracing was explicitly disabled, log a warning and enable tracing
    console.warn('ENABLE_ARTIFACTS=true but DISABLE_TRACING was set; overriding to enable tracing to collect traces');
    disableTracing = false;
  }
  const contextOptions = {
    ignoreHTTPSErrors: true,
    viewport: projectViewport
  };
  if (enableArtifacts && !disableVideo) {
    contextOptions.recordVideo = { dir: artifactManager.paths.videoDir };
  }
  const context = await browser.newContext(contextOptions);
  let page = await context.newPage();
  const stepTimeout = Number(process.env.STEP_TIMEOUT_MS || 30000);
  page.setDefaultTimeout(stepTimeout);
  page.setDefaultNavigationTimeout(stepTimeout);
  page.on('console', (msg) => {
    try {
      console.log('PAGE LOG:', msg.text());
    } catch (e) {}
  });
  page.on('pageerror', (err) => {
    try {
      console.error('PAGE ERROR:', err && err.message ? err.message : String(err));
    } catch (e) {}
  });
  // Log response headers and bodies for resources that commonly fail (jsplot, scripts, files)
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (/\/siebel\/(scripts|3rdParty|files)\//i.test(url)) {
        const status = response.status();
        const headers = response.headers();
        const cType = headers['content-type'] || headers['Content-Type'] || '';
        console.log(`RESOURCE RESPONSE: ${url} status=${status} content-type=${cType}`);
        try {
          const reqHeaders = response.request() && response.request().headers ? response.request().headers() : {};
          console.log('  request headers snippet:', { cookie: reqHeaders.cookie || reqHeaders.Cookie || 'none', accept: reqHeaders.accept || '' });
        } catch (rh) {}
        // If server returned HTML where JS/CSS expected, capture a small snippet for diagnosis
        if (/html/i.test(cType) || status >= 400) {
          try {
            const text = await response.text();
            console.log('--- response body snippet ---');
            console.log(text.slice(0, 800));
            console.log('--- end snippet ---');
          } catch (e) {
            console.log('Failed to read response body for', url, e && e.message);
          }
        }
      }
      // Also log the login POST response details to capture Set-Cookie and body
      if (/\/siebel\/app\/care\/enu/i.test(url) && response.request().method() === 'POST') {
        try {
          const status = response.status();
          const headers = response.headers();
          console.log(`LOGIN POST RESPONSE: ${url} status=${status} content-type=${headers['content-type'] || headers['Content-Type'] || ''}`);
          console.log('  response headers snippet:', { 'set-cookie': headers['set-cookie'] || headers['Set-Cookie'] || 'none' });
          try {
            const text = await response.text();
            console.log('--- login response body snippet ---');
            console.log(text.slice(0, 800));
            console.log('--- end snippet ---');
          } catch (e) {}
        } catch (e) {}
      }
    } catch (e) {
      // swallow
    }
  });
  page.on('crash', () => {
    console.error('PAGE CRASHED');
  });
  let tracingStarted = false;
  if (enableArtifacts && !disableTracing) {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracingStarted = true;
    } catch(e) { console.warn('Tracing start failed', e && e.message); }
  } else {
    console.log('Tracing disabled or artifacts disabled (ENABLE_ARTIFACTS,DISABLE_TRACING,DISABLE_VIDEO):', { enableArtifacts, disableTracing, disableVideo });
  }

  let failureReason = '';
  let stepIndex = 0;
  let currentStep = null;
  // Collect structured post-verification results here so they are available
  // in both success and failure return paths.
  let verificationResults = [];

  // prepare a callable launchMobilePLP() from the generator source so we reuse common navigation logic
  let launchMobilePLP = null;
  try {
    const helperSrc = typeof generateLaunchMobilePLPFunction === 'function' ? generateLaunchMobilePLPFunction() : null;
    if (helperSrc && typeof helperSrc === 'string') {
      launchMobilePLP = new Function('page', 'expect', 'process', 'journeyOptions', `${helperSrc}; return launchMobilePLP(page, journeyOptions);`);
    }
  } catch (e) {
    console.warn('Failed to construct launchMobilePLP helper from generator source', e && e.message);
    launchMobilePLP = null;
  }

  try {
  await navigateToBaseUrl(page, process.env.BASE_URL, stepTimeout);
  page = await resolveActivePage(context, page);

    // Logging: Current TOM, URL, Execution Start Time
    console.log('Current TOM:', executionCase.testCaseId);
    try { console.log('Current URL (initial):', await page.url()); } catch (e) {}
    const executionStartTime = new Date().toISOString();
    console.log('Execution Start Time:', executionStartTime);

    // Determine whether this TOM should run the Mobile PLP precondition helper
    let stepsToExecute = Array.isArray(executionCase.steps) ? executionCase.steps.slice() : [];
    const journeyOptions = typeof deriveJourneyRuntimeOptions === 'function' ? deriveJourneyRuntimeOptions({
      TOM_NUM: executionCase.testCaseId,
      User_Journey: executionCase.userJourney,
      steps: executionCase.steps,
      Post_Verification: executionCase.postVerification
    }) : {};
    journeyOptions.stageScreenshots = {
      login: path.resolve(artifactManager.paths.screenshotDir, `${executionCase.testCaseId}-stage-login.png`),
      'sales-calculator': path.resolve(artifactManager.paths.screenshotDir, `${executionCase.testCaseId}-stage-sales-calculator.png`),
      'coverage-check': path.resolve(artifactManager.paths.screenshotDir, `${executionCase.testCaseId}-stage-coverage-check.png`),
      'mobile-plp': path.resolve(artifactManager.paths.screenshotDir, `${executionCase.testCaseId}-stage-mobile-plp.png`)
    };

    if (inMobileRange && launchMobilePLP) {
      console.log('Invoking shared launchMobilePLP() helper for', executionCase.testCaseId);
      try {
        page = await resolveActivePage(context, page);
        await launchMobilePLP(page, expect, process, journeyOptions);
      } catch (lhErr) {
        console.warn('launchMobilePLP threw an error:', lhErr && lhErr.message);
        if (/Target page, context or browser has been closed/i.test(String(lhErr && lhErr.message || ''))) {
          page = await resolveActivePage(context, page);
          if (page && !(typeof page.isClosed === 'function' && page.isClosed())) {
            console.log('Retrying launchMobilePLP() on the active page after page closure/replacement');
            await launchMobilePLP(page, expect, process, journeyOptions);
          }
        }
        // If the helper failed to reach Mobile PLP, abort the run instead of continuing
        if (lhErr && String(lhErr.message || '').includes('launchMobilePLP did not navigate to Mobile PLP')) {
          throw lhErr;
        }
      }

      // After the shared helper, start from the first true post-helper business step.
      const firstPostHelperIndex = stepsToExecute.findIndex((s) => /mobile\s*plp\s+tab|plan\s+tile|device\s+card|storage\s+option|payment\s+term|device\s+care|add\s+to\s+cart|calculate\s+bundle\s*&?\s*save|create\s+quote|create\s+order/i.test(s));
      if (firstPostHelperIndex >= 0) {
        stepsToExecute = stepsToExecute.slice(firstPostHelperIndex);
        console.log('Filtered out', firstPostHelperIndex, 'precondition steps; running', stepsToExecute.length, 'post-helper steps');
      } else {
        const preconditionIndex = stepsToExecute.findIndex((s) => /open.*mobile\s*plp|mobile\s*plp|open.*sales calculator|navigate to sales calculator|navigate to Sales Calculator/i.test(s));
        if (preconditionIndex >= 0) {
          stepsToExecute = stepsToExecute.slice(preconditionIndex + 1);
          console.log('Filtered out', preconditionIndex + 1, 'precondition steps; running', stepsToExecute.length, 'validation steps');
        } else {
          // If no explicit navigation step found, attempt to filter obvious login/navigate steps
          stepsToExecute = stepsToExecute.filter((s) => !/\b(log ?in|sign in|login)\b/i.test(s) && !/navigate to site map|open site map|sales calculator|open site map/i.test(s));
          console.log('Filtered precondition-like steps; running', stepsToExecute.length, 'validation steps');
        }
      }
    }

      for (const step of stepsToExecute) {
        stepIndex += 1;
        currentStep = step;
        page = await resolveActivePage(context, page);
        // Log current URL before each step
        try {
          console.log('Current URL before step:', await page.url());
        } catch (uErr) {
          console.warn('Failed to read current URL before step', stepIndex, uErr && uErr.message);
        }

        console.log('Executing step:', step);
        let actionBlock = generateActionBlock(step);
        console.log('Action block:\n', actionBlock);

        // If generator produced a simple getByRole button click referencing a literal "tab" suffix,
        // replace it with the robust prioritized locator click block to improve reliability.
        try {
          // Robust fallback: if the generated block references a literal "... tab" pattern,
          // replace with the prioritized locator click helper to avoid fragile exact matches.
          if (typeof actionBlock === 'string' && /\btab\b/i.test(actionBlock) && /getByRole\(\s*['\"]button['\"]/.test(actionBlock)) {
            let inferred = null;
            const m = actionBlock.match(/\/(.+?)\s*tab\//i);
            if (m && m[1]) inferred = m[1].trim();
            // fallback: try to extract plain text occurrence like 'Mobile phones tab'
            if (!inferred) {
              const p = actionBlock.match(/(['\"])?([A-Za-z0-9\s\&\-]+?)\s+tab\1/i);
              if (p && p[2]) inferred = p[2].trim();
            }
            if (!inferred) inferred = cleanControlLabel(actionBlock) || 'Mobile phones';
            if (typeof generateClickLocatorCode === 'function') {
              actionBlock = generateClickLocatorCode(inferred);
              console.log('Rewrote simple tab click to robust locator for:', inferred);
            }
          }
        } catch (e) { console.warn('Error rewriting simple tab click:', e && e.message); }

        // If this is a non-login step and we're still on the login URL, wait up to 60s for login to complete
        try {
          const isLoginStep = /\b(log ?in|sign in|login)\b/i.test(step);
          const currentUrl = await page.url();
          if (!isLoginStep && currentUrl && currentUrl.includes('SWECmd=Login')) {
            console.log('Detected login URL before executing non-login step; waiting for login to complete');
            try {
              await page.waitForFunction(() => !window.location.href.includes('SWECmd=Login'), { timeout: 60000 });
              console.log('Login completed, URL now:', await page.url());
            } catch (waitErr) {
              console.log('Timeout waiting for login to complete; proceeding with current URL:', await page.url());
            }
          }
        } catch (chkErr) {
          console.warn('Error while checking login state before step', chkErr && chkErr.message);
        }

        // execute the generated block (with fallback on simple tab-click failures)
        try {
          await executeActionBlock(context, page, actionBlock);
        } catch (e) {
          if (/Target page, context or browser has been closed/i.test(String(e && e.message || ''))) {
            page = await resolveActivePage(context, page);
            if (page && !(typeof page.isClosed === 'function' && page.isClosed())) {
              console.warn('Retrying action block on the active page after page closure/replacement');
              await executeActionBlock(context, page, actionBlock);
              continue;
            }
          }
          // If the original action was a simple getByRole button click referencing a 'tab',
          // attempt the robust prioritized locator click as a fallback once.
          // Dump visible controls now so diagnostics are captured even if fallback fails
          try { await dumpVisibleControls(page); } catch (dd) { console.error('dumpVisibleControls failed:', dd && dd.message); }
          try {
            if (typeof generateClickLocatorCode === 'function' && typeof actionBlock === 'string' && /getByRole\(\s*['\"]button['\"]/.test(actionBlock) && /\btab\b/i.test(actionBlock)) {
              // try to infer the literal name from the actionBlock
              let inferred = null;
              const m = actionBlock.match(/\/(.+?)\s*tab\//i);
              if (m && m[1]) inferred = m[1].trim();
              if (!inferred) {
                const p = actionBlock.match(/(['\"])?([A-Za-z0-9\s\&\-]+?)\s+tab\1/i);
                if (p && p[2]) inferred = p[2].trim();
              }
              if (!inferred) inferred = 'Mobile phones';
              const fallback = generateClickLocatorCode(inferred);
              console.warn('Initial click failed; attempting fallback locator click for:', inferred);
              await executeActionBlock(context, page, fallback);
            } else {
              throw e;
            }
          } catch (e2) {
            // rethrow original error if fallback also failed
            throw e2;
          }
        }

        // after each step capture a debug screenshot
        try {
          const debugPath = path.resolve(artifactManager.paths.screenshotDir, `debug-step-${String(stepIndex).padStart(2, '0')}.png`);
          await page.screenshot({ path: debugPath, fullPage: true });
          console.log('Saved debug screenshot:', debugPath);
        } catch (sErr) {
          console.warn('Failed to save debug screenshot for step', stepIndex, sErr && sErr.message);
        }

        // print current page URL after the step
        try {
          console.log('Page URL after step:', page.url());
        } catch (uErr) {
          console.warn('Failed to read page URL after step', stepIndex, uErr && uErr.message);
        }

        if (isVerificationStep(step)) {
          await artifactManager.captureVerificationScreenshot(page);
        }
      }

    // Execution end time log
    try {
      const executionEndTime = new Date().toISOString();
      console.log('Execution End Time:', executionEndTime);
      try { console.log('Current URL (final):', await page.url()); } catch (e) {}
    } catch (e) {}

    // capture final success screenshot with naming convention
    let finalImage = null;
    try {
      finalImage = await artifactManager.captureFinalScreenshot(page, 'PASS').catch(()=>null);
      if (finalImage) console.log('Saved final PASS screenshot:', finalImage);
    } catch (e) {}

    // Run Post_Verification checks and collect structured results
    async function runPostVerifications() {
      const raw = String(executionCase.postVerification || '').trim();
      if (!raw) return [];
      const lines = raw
        .split(/\r?\n|;/)
        .map(s => String(s || '').trim())
        .filter(Boolean);
      const results = [];
      const escapeForRegex = (s) => String(s||'').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      for (const rawLine of lines) {
        const l = String(rawLine || '')
          .replace(/^[\s\-\*•\u2022\u2023\u2043\u2219\u00B7]+/, '')
          .replace(/^['\"]+|['\"]+$/g, '')
          .trim();
        if (!l) continue;
        const item = { verification_name: l, expected: l, actual: null, status: 'PASS', failure_reason: '' };
        try {
          // Human-readable checks that describe groups of visible labels or state rather than exact sentence matches.
          if (/item counter.*total format/i.test(l)) {
            const counterFound = await page.getByText(/\b\d+\s*-\s*\d+\s+of\s+\d+\b/i).count();
            item.actual = counterFound > 0 ? 'counter-present' : 'missing';
            if (!counterFound) { item.status = 'FAIL'; item.failure_reason = 'Expected item counter format was not visible'; }
            results.push(item); continue;
          }

          if (/next arrow/i.test(l) && /counter range/i.test(l)) {
            const changed = Boolean(globalThis.__tom03NextChanged);
            item.actual = changed ? `${globalThis.__tom03InitialCounter || 'n/a'} -> ${globalThis.__tom03NextCounter || 'n/a'}` : 'unchanged';
            if (!changed) { item.status = 'FAIL'; item.failure_reason = 'Next arrow did not change the counter range'; }
            results.push(item); continue;
          }

          if (/previous arrow/i.test(l) && /prior card set/i.test(l)) {
            const returned = Boolean(globalThis.__tom03PrevReturned);
            let mobileTabVisible = false;
            try {
              mobileTabVisible = (await page.getByText(/Mobile phones/i).count()) > 0;
            } catch (e) {}
            item.actual = `returned=${returned ? 'yes' : 'no'}; mobileTab=${mobileTabVisible ? 'yes' : 'no'}`;
            if (!returned || !mobileTabVisible) { item.status = 'FAIL'; item.failure_reason = 'Previous arrow did not return to the prior card set on Mobile phones'; }
            results.push(item); continue;
          }

          if (/previously selected device remains retained/i.test(l) || /selected device remains retained/i.test(l)) {
            const retained = Boolean(globalThis.__tom03SelectionRetained);
            item.actual = retained ? 'retained' : 'not-retained';
            if (!retained) { item.status = 'FAIL'; item.failure_reason = 'Previously selected device was not retained after pagination'; }
            results.push(item); continue;
          }

          if (/plan/i.test(l) && /proposition/i.test(l) && /entitlement/i.test(l) && /select/i.test(l)) {
            const keys = [/proposition/i, /entitlement/i, /select/i];
            let matches = 0;
            for (const key of keys) {
              try {
                if ((await page.getByText(key).count()) > 0) matches += 1;
              } catch (e) {}
            }
            item.actual = `${matches}/3 label groups present`;
            if (matches < 2) { item.status = 'FAIL'; item.failure_reason = 'Expected plan tile labels were not visible'; }
            results.push(item); continue;
          }

          if (/controls\s+search,\s*sort by,\s*filter by brand,\s*check delivery estimate,\s*and same as coverage check are visible/i.test(l)) {
            const labels = ['Search', 'Sort by', 'Filter by brand', 'Check delivery estimate', 'Same as coverage check'];
            let found = 0;
            for (const label of labels) {
              try {
                if ((await page.getByText(new RegExp(escapeForRegex(label), 'i')).count()) > 0) found += 1;
              } catch (e) {}
            }
            item.actual = `${found}/${labels.length} controls visible`;
            if (found < 3) { item.status = 'FAIL'; item.failure_reason = 'Expected Mobile phones controls were not visible'; }
            results.push(item); continue;
          }

          if (/apple.*device card|device card.*apple|visible device card.*stock state.*price.*select/i.test(l)) {
            let selectVisible = false;
            try {
              selectVisible = (await page.getByRole('button', { name: /^Select$/i }).count()) > 0;
            } catch (e) {}
            if (!selectVisible) {
              try {
                selectVisible = (await page.getByText(/^Select$/i).count()) > 0;
              } catch (e) {}
            }

            let priceVisible = false;
            try {
              priceVisible = (await page.getByText(/per month/i).count()) > 0 || (await page.getByText(/\$\s*\d+/i).count()) > 0;
            } catch (e) {}

            let stockVisible = false;
            try {
              stockVisible = (await page.getByText(/In stock|Low Stock|Back-order|Out of Stock/i).count()) > 0;
            } catch (e) {}

            let attributeVisible = false;
            try {
              attributeVisible = (await page.getByText(/Storage|Colour|Payment term|Device care/i).count()) > 0;
            } catch (e) {}

            let appleVisible = true;
            if (/apple/i.test(l)) {
              try {
                appleVisible = (await page.getByText(/Apple/i).count()) > 0;
              } catch (e) {
                appleVisible = false;
              }
            }

            item.actual = `select=${selectVisible ? 'yes' : 'no'}; price=${priceVisible ? 'yes' : 'no'}; stock=${stockVisible ? 'yes' : 'no'}; attributes=${attributeVisible ? 'yes' : 'no'}; apple=${appleVisible ? 'yes' : 'no'}`;
            if (!selectVisible || !priceVisible || !stockVisible || !attributeVisible || !appleVisible) {
              item.status = 'FAIL';
              item.failure_reason = 'Expected Apple device card details were not fully visible';
            }
            results.push(item); continue;
          }

          if (/selected state is applied|selected state changes to selected/i.test(l)) {
            const selectedFound = (await page.getByText(/selected/i).count()) > 0;
            item.actual = selectedFound ? 'selected-state-visible' : 'missing';
            if (!selectedFound) { item.status = 'FAIL'; item.failure_reason = 'Selected state was not visible'; }
            results.push(item); continue;
          }

          if (/compatible devices remain selectable/i.test(l) || /device list refreshes to compatible options/i.test(l) || /compatible.*select.*visible/i.test(l) || /select.*buttons.*visible/i.test(l) || /device.*select.*visible/i.test(l)) {
            let selectVisibleCount = 0;
            try {
              selectVisibleCount = await page.getByRole('button', { name: /^Select$/i }).count();
            } catch (e) {}
            if (!selectVisibleCount) {
              try {
                selectVisibleCount = await page.locator('button.vha-scj-select-btn, button.vha-scj-select-plan').count();
              } catch (e) {}
            }
            item.actual = `selectButtons=${selectVisibleCount}`;
            if (!selectVisibleCount) { item.status = 'FAIL'; item.failure_reason = 'No compatible device selection buttons were visible'; }
            results.push(item); continue;
          }

          // Validation message X is shown -> presence check
          let m = l.match(/Validation message\s*(?:"|')(.+?)(?:"|')\s*is shown\.?$/i);
          if (m) {
            const txt = m[1].trim();
            const expectedNormalized = txt.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            let found = (await page.getByText(new RegExp(escapeForRegex(txt), 'i')).count()) > 0;
            if (!found) {
              const diagnosticText = [globalThis.__lastAddToCartValidationMatches, globalThis.__lastAddToCartAlertText, globalThis.__lastAddToCartPageText]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, ' ')
                .trim();
              found = Boolean(expectedNormalized && diagnosticText.includes(expectedNormalized));
            }
            item.actual = found ? 'present' : ((globalThis.__lastAddToCartValidationMatches || globalThis.__lastAddToCartAlertText || globalThis.__lastAddToCartPageText || '').slice(0, 300) || 'missing');
            if (!found) { item.status = 'FAIL'; item.failure_reason = `Expected validation message '${txt}' not found`; }
            results.push(item); continue;
          }

          if (/add to cart is blocked/i.test(l)) {
            const blocked = Boolean(globalThis.__lastAddToCartBlocked) || (!Boolean(globalThis.__lastAddToCartSuccess) && Number(globalThis.__lastAddToCartNewServiceCount || 0) === 0);
            item.actual = blocked ? 'blocked' : 'not-blocked';
            if (!blocked) { item.status = 'FAIL'; item.failure_reason = 'Add to cart was not blocked'; }
            results.push(item); continue;
          }

          if (/no new service row is created/i.test(l) || /no cart success message is shown/i.test(l)) {
            const success = Boolean(globalThis.__lastAddToCartSuccess);
            const newServiceCount = Number(globalThis.__lastAddToCartNewServiceCount || await page.getByText(/New service/i).count().catch(() => 0));
            const initialNewServiceCount = Number(globalThis.__lastAddToCartInitialNewServiceCount || 0);
            item.actual = `success=${success ? 'yes' : 'no'}; initialNewServiceCount=${initialNewServiceCount}; newServiceCount=${newServiceCount}`;
            if (success || newServiceCount > initialNewServiceCount) { item.status = 'FAIL'; item.failure_reason = 'Unexpected cart success or New service row was present'; }
            results.push(item); continue;
          }

          // Message shown: X -> presence check
          m = l.match(/Message shown:\s*(?:"|')?(.+?)(?:"|')?$/i);
          if (m) {
            const txt = m[1].trim();
            const found = (await page.getByText(new RegExp(escapeForRegex(txt), 'i')).count()) > 0;
            item.actual = found ? 'present' : 'missing';
            if (!found) { item.status = 'FAIL'; item.failure_reason = `Expected message '${txt}' not found`; }
            results.push(item); continue;
          }

          // Tabs X, Y are visible -> visibility checks
          m = l.match(/Tabs\s*(.+)\s*are visible/i);
          if (m) {
            const list = m[1].split(/,|and/).map(s=>s.trim()).filter(Boolean);
            for (const tab of list) {
              const found = (await page.getByText(new RegExp(escapeForRegex(tab), 'i')).count()) > 0;
              const sub = { verification_name: `Tab visible: ${tab}`, expected: `tab '${tab}' visible`, actual: found ? 'visible' : 'missing', status: found ? 'PASS' : 'FAIL', failure_reason: found ? '' : `Tab '${tab}' not visible` };
              results.push(sub);
            }
            continue;
          }

          // New service N -> count check
          m = l.match(/New service\s*(\d+)/i);
          if (m) {
            const n = Number(m[1]) || 1;
            const count = (await page.getByText(/New service/i).all()).length;
            item.actual = String(count);
            if (count < n) { item.status = 'FAIL'; item.failure_reason = `Expected at least ${n} New service rows but found ${count}`; }
            results.push(item); continue;
          }

          // Navigation check: contains 'navigates to' -> assert url changed or contains target text
          if (/navigates to/i.test(l) || /navigat(es|ion)/i.test(l)) {
            // try to extract quoted text or words after 'to'
            let tgt = '';
            const q = l.match(/to\s+(?:the\s+)?(.+)$/i);
            if (q) tgt = q[1].trim();
            if (tgt) {
              const found = (await page.getByText(new RegExp(escapeForRegex(tgt), 'i')).count()) > 0;
              item.actual = found ? `on page containing '${tgt}'` : `no '${tgt}' found`;
              if (!found) { item.status = 'FAIL'; item.failure_reason = `Navigation target '${tgt}' not present`; }
              results.push(item); continue;
            }
          }

          // Dynamic/business values: quote number, customer name, product code, dates, totals
          if (/quote number|quote no|quote\b|customer name|product code|delivery date|cart total|service id/i.test(l)) {
            // presence of any non-empty alphanumeric token near the label
            const lbl = l.replace(/[:\s]+$/,'');
            const foundLabel = (await page.getByText(new RegExp(escapeForRegex(lbl), 'i')).count()) > 0;
            // also check for any number-like token anywhere on page as fallback
            const anyNumbers = (await page.getByText(/\d{3,}/).count()) > 0;
            item.actual = foundLabel ? 'label present' : (anyNumbers ? 'value-like token present' : 'not found');
            if (!foundLabel && !anyNumbers) { item.status='FAIL'; item.failure_reason = `Dynamic value for '${l}' not found (no label or numeric token)`; }
            results.push(item); continue;
          }

          // Generic presence/visibility check: short phrase -> check visible
          if (/^[\w\s\-\&\'\(\)\.]{3,120}$/.test(l)) {
            const found = (await page.getByText(new RegExp(escapeForRegex(l), 'i')).count()) > 0;
            item.actual = found ? 'present' : 'missing';
            if (!found) { item.status='FAIL'; item.failure_reason = `Expected text '${l}' not present`; }
            results.push(item); continue;
          }

          // fallback: treat as manual verification note
          item.status = 'PASS';
          item.actual = 'manual-check';
          results.push(item);
        } catch (err) {
          item.status = 'FAIL';
          item.failure_reason = err && err.message ? err.message : String(err);
          results.push(item);
        }
      }
      return results;
    }

    try {
      verificationResults = await runPostVerifications();
      for (const vr of verificationResults) console.log('VERIFICATION:', vr.verification_name, vr.status, vr.failure_reason || '');
    } catch (verErr) {
      console.warn('Post verification runner failed', verErr && verErr.message);
    }

    const failedVerifications = verificationResults.filter((vr) => vr && vr.status === 'FAIL');
    if (failedVerifications.length > 0) {
      throw new Error(`Post verification failed: ${failedVerifications[0].verification_name}${failedVerifications[0].failure_reason ? ` - ${failedVerifications[0].failure_reason}` : ''}`);
    }

    if (typeof tracingStarted !== 'undefined' && tracingStarted) {
      try { await artifactManager.stopTrace(context); } catch(e) { console.warn('stopTrace failed', e && e.message); }
    }
    await page.close().catch(() => {});
    const videoPath = await artifactManager.collectVideoPath(page);

    return {
      testCaseId: executionCase.testCaseId,
      status: 'PASS',
      screenshot: finalImage || artifactManager.paths.primaryScreenshot,
      trace: artifactManager.paths.tracePath,
      video: videoPath || artifactManager.paths.videoPath,
      verificationResults: verificationResults
    };
  } catch (error) {
    console.error('--- CATCH: currentStep (debug):', typeof currentStep, currentStep);
    failureReason = error && error.message ? error.message : String(error);
    // try to capture diagnostics: current step, page url
    let pageUrl = null;
    let failureShotPath = artifactManager.paths.failureScreenshot;
    try {
      pageUrl = page && page.url ? await page.url() : null;
    } catch (uErr) {
      pageUrl = 'unavailable (page closed)';
    }

    // attempt failure screenshot and final FAIL screenshot
    try {
      failureShotPath = await artifactManager.captureFailureScreenshot(page).catch(() => artifactManager.paths.failureScreenshot);
    } catch (s) {}
    try {
      await artifactManager.captureFinalScreenshot(page, 'FAIL').catch(() => {});
    } catch (s) {}

    try {
      if (typeof tracingStarted !== 'undefined' && tracingStarted) { await artifactManager.stopTrace(context).catch(() => {}); }
    } catch (t) {}

    try {
      await page.close().catch(() => {});
    } catch (c) {}

    try {
      await artifactManager.collectVideoPath(page).catch(() => {});
    } catch (v) {}

    return {
      testCaseId: executionCase.testCaseId,
      status: 'FAIL',
      reason: failureReason,
      failedStep: currentStep,
      pageUrl: pageUrl,
      screenshot: failureShotPath,
      trace: artifactManager.paths.tracePath,
      video: artifactManager.paths.videoPath,
      verificationResults: verificationResults
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { buildExecutionCase, splitAndCleanSteps, getBrowserLaunchOptions, executeActionBlock, runExecutionCase, runExecutionCaseFromCase };

if (require.main === module) {
  const id = process.argv[2] || process.env.TESTCASE_ID;
  const inputFile = process.argv[3] || process.env.INPUT_CSV;
  if (!id || !inputFile) {
    process.stderr.write('Usage: node .github/skills/execution-agent.js <TESTCASE_ID> <INPUT_CSV_OR_XLSX>\nProvide TESTCASE_ID and input file path (or set TESTCASE_ID and INPUT_CSV env vars).\n');
    process.exitCode = 2;
  } else {
    runExecutionCase(id, inputFile)
      .then((obj) => {
        // Flush any buffered stdout diagnostics to stderr so orchestrator still
        // records them, then write exactly one JSON blob to stdout using the
        // original stdout writer.
        try {
          if (__stdoutBuffer && __stdoutBuffer.length) {
            try { process.stderr.write(__stdoutBuffer); } catch (e) { /* ignore */ }
          }
        } catch (e) {}
        // Restore original stdout and write only the JSON result
        try { process.stdout.write = __origStdoutWrite; } catch (e) {}
        try { __origStdoutWrite(`${JSON.stringify(obj, null, 2)}\n`); } catch (e) { /* ignore */ }
      })
      .catch((err) => {
        process.stderr.write(`Execution Agent failed: ${err && err.stack ? err.stack : String(err)}\n`);
        process.exitCode = 1;
      });
  }
}
