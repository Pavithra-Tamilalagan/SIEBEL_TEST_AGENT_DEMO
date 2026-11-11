const fs = require('fs/promises');
const path = require('path');

function normalizeTestCaseId(testCaseId = 'TOM_01') {
    return String(testCaseId || 'TOM_01').trim().replace(/[^a-z0-9_-]/gi, '_');
}

function isVerificationStep(step) {
    return /\bverify\b|\bensure\b|\bconfirm\b|\bcheck\b/i.test(String(step || ''));
}

function getWorkspaceRoot() {
    return path.resolve(__dirname, '..', '..');
}

function getArtifactPaths(testCaseId = 'TOM_01') {
    const safeId = normalizeTestCaseId(testCaseId);
    const root = getWorkspaceRoot();

    return {
        workspaceRoot: root,
        screenshotDir: path.resolve(root, 'screenshots'),
        traceDir: path.resolve(root, 'test-results', safeId),
        videoDir: path.resolve(root, 'test-results', safeId, 'video'),
        primaryScreenshot: path.resolve(root, 'screenshots', `${safeId}.png`),
        tracePath: path.resolve(root, 'test-results', safeId, 'trace.zip'),
        videoPath: path.resolve(root, 'test-results', safeId, 'video.webm'),
        failureScreenshot: path.resolve(root, 'screenshots', `${safeId}-failure.png`)
    };
}

async function ensureArtifactDirectories(paths) {
    await fs.mkdir(paths.screenshotDir, { recursive: true });
    await fs.mkdir(paths.traceDir, { recursive: true });
    await fs.mkdir(paths.videoDir, { recursive: true });
}

/**
 * Screenshot of the whole application content. Siebel scrolls inside inner panels,
 * so page.fullPage alone only shows the viewport. Temporarily un-clip scrollable
 * containers, enlarge the viewport to the content height, shoot, then restore.
 */
async function fullContentScreenshot(page, filePath) {
    const original = page.viewportSize();
    let height = 0;
    try {
        height = await page.evaluate(() => {
            const changed = [];
            for (const el of Array.from(document.querySelectorAll('body *'))) {
                const cs = getComputedStyle(el);
                if (/(auto|scroll|hidden)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 150) {
                    changed.push([el, el.getAttribute('style')]);
                    el.style.setProperty('overflow', 'visible', 'important');
                    el.style.setProperty('height', 'auto', 'important');
                    el.style.setProperty('max-height', 'none', 'important');
                }
            }
            for (const el of [document.documentElement, document.body]) {
                changed.push([el, el.getAttribute('style')]);
                el.style.setProperty('overflow', 'visible', 'important');
                el.style.setProperty('height', 'auto', 'important');
            }
            window.__srRestore = changed;
            return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        });
        if (original && height > original.height) {
            await page.setViewportSize({ width: original.width, height: Math.min(height, 12000) });
        }
        await page.screenshot({ path: filePath, fullPage: true });
    } finally {
        await page.evaluate(() => {
            for (const [el, style] of (window.__srRestore || [])) {
                if (style === null) el.removeAttribute('style'); else el.setAttribute('style', style);
            }
            window.__srRestore = null;
        }).catch(() => {});
        if (original) await page.setViewportSize(original).catch(() => {});
    }
    return filePath;
}

function slug(text, max = 50) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'step';
}

async function createArtifactManager(testCaseId = 'TOM_01') {
    const paths = getArtifactPaths(testCaseId);
    await ensureArtifactDirectories(paths);

    let verificationCount = 0;
    let stepCounter = 0;
    const evidence = [];

    return {
        paths,
        evidence,
        async captureStepScreenshot(page, stepNo, stepText) {
            const filePath = path.resolve(paths.screenshotDir, `${normalizeTestCaseId(testCaseId)}-step-${String(stepNo).padStart(2, '0')}-${slug(stepText)}.png`);
            await fullContentScreenshot(page, filePath);
            evidence.push({ step: stepNo, action: String(stepText || ''), screenshot: filePath });
            return filePath;
        },
        async captureVerificationScreenshot(page) {
            verificationCount += 1;
            const filePath = verificationCount === 1
                ? paths.primaryScreenshot
                : path.resolve(paths.screenshotDir, `${normalizeTestCaseId(testCaseId)}-verify-${String(verificationCount).padStart(2, '0')}.png`);

            await fullContentScreenshot(page, filePath);
            return filePath;
        },
        async captureFailureScreenshot(page) {
            stepCounter += 1;
            const filePath = path.resolve(paths.screenshotDir, `${normalizeTestCaseId(testCaseId)}-failure-${String(stepCounter).padStart(2, '0')}.png`);
            await fullContentScreenshot(page, filePath);
            return filePath;
        },
        async collectVideoPath(page) {
            const video = page.video ? page.video() : null;
            if (!video) {
                return null;
            }

            const recordedPath = await video.path().catch(() => null);
            if (!recordedPath) {
                return null;
            }

            await fs.mkdir(path.dirname(paths.videoPath), { recursive: true });
            await fs.copyFile(recordedPath, paths.videoPath).catch(async () => {
                await fs.rename(recordedPath, paths.videoPath);
            });
            return paths.videoPath;
        },
        async stopTrace(context) {
            await context.tracing.stop({ path: paths.tracePath });
            return paths.tracePath;
        },
        async captureFinalScreenshot(page, status = 'PASS') {
            const safe = normalizeTestCaseId(testCaseId);
            const fileName = `${safe}-${String(status || 'PASS').toUpperCase()}-${Date.now()}.png`;
            const filePath = path.resolve(paths.screenshotDir, fileName);
            await fullContentScreenshot(page, filePath);
            return filePath;
        },
        async getArtifactSummary(page, context) {
            const videoPath = await this.collectVideoPath(page);
            const tracePath = paths.tracePath;
            return {
                screenshot: paths.primaryScreenshot,
                trace: tracePath,
                video: videoPath || paths.videoPath
            };
        }
    };
}

async function getScreenshotArtifact(testCaseId = 'TOM_01') {
    const paths = getArtifactPaths(testCaseId);
    const screenshotPath = paths.primaryScreenshot;
    try {
        await fs.access(screenshotPath);
    } catch {
        throw new Error(`Screenshot file not found: ${screenshotPath}`);
    }

    return {
        screenshot: path.relative(getWorkspaceRoot(), screenshotPath).replace(/\\/g, '/')
    };
}

module.exports = {
    normalizeTestCaseId,
    isVerificationStep,
    getArtifactPaths,
    createArtifactManager,
    getScreenshotArtifact
};

if (require.main === module) {
    const id = process.argv[2] || process.env.TESTCASE_ID;
    if (!id) {
        process.stderr.write('Usage: node .github/skills/artifact-agent.js <TESTCASE_ID>\nProvide TESTCASE_ID as first argument or set TESTCASE_ID env var.\n');
        process.exitCode = 2;
    } else {
        getScreenshotArtifact(id)
            .then((summary) => {
                process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
            })
            .catch((error) => {
                process.stderr.write(`Artifact Agent failed: ${error.message}\n`);
                process.exitCode = 1;
            });
    }
}
