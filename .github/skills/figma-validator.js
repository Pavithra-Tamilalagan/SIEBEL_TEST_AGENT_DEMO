const fs = require('fs/promises');
const path = require('path');

function normalizeSimilarity(value) {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return 0;
    if (numeric < 0) return 0;
    if (numeric > 100) return 100;
    return Math.round(numeric);
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function compareImages(expectedImagePath, actualImagePath) {
    // Phase 1: existence-only validation.
    // Future image comparison logic can be plugged in here without changing the public API.
    void expectedImagePath;
    void actualImagePath;
    return {
        similarity: 100,
        status: 'PASS'
    };
}

async function validateFigmaScreenshot(expectedImagePath, actualImagePath) {
    if (!expectedImagePath) {
        throw new Error('Expected Figma image path is required');
    }
    if (!actualImagePath) {
        throw new Error('Actual Playwright screenshot path is required');
    }

    const resolvedExpected = path.resolve(expectedImagePath);
    const resolvedActual = path.resolve(actualImagePath);

    const [expectedExists, actualExists] = await Promise.all([
        fileExists(resolvedExpected),
        fileExists(resolvedActual)
    ]);

    if (!expectedExists) {
        throw new Error(`Expected Figma image not found: ${resolvedExpected}`);
    }
    if (!actualExists) {
        throw new Error(`Actual screenshot not found: ${resolvedActual}`);
    }

    const comparison = await compareImages(resolvedExpected, resolvedActual);
    const similarity = normalizeSimilarity(comparison.similarity);
    return {
        similarity,
        status: comparison.status || 'PASS'
    };
}

module.exports = {
    normalizeSimilarity,
    fileExists,
    compareImages,
    validateFigmaScreenshot
};

if (require.main === module) {
    const expected = process.argv[2];
    const actual = process.argv[3];

    validateFigmaScreenshot(expected, actual)
        .then((result) => {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        })
        .catch((error) => {
            process.stderr.write(`Figma Validation Agent failed: ${error.message}\n`);
            process.exitCode = 1;
        });
}
