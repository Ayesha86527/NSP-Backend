/**
 * Validate .env (and JWT keys) WITHOUT starting the server.
 *   npm run check:env
 * Prints every problem at once; exit code 1 on failure. Secrets are never printed.
 */
require('dotenv').config();

const validateEnv = require('../src/config/validateEnv');

try {
    validateEnv();
    console.log('Environment OK: all required variables and JWT keys are valid.');
} catch (error) {
    console.error(error.message);

    // Typos are the most common cause of "missing variable" errors.
    const required = validateEnv.REQUIRED_VARIABLES;
    const suspicious = Object.keys(process.env).filter((name) =>
        required.some((req) => req !== name && !process.env[req] && isClose(name, req))
    );
    if (suspicious.length) {
        console.error(`\nPossible typo(s) in your .env: ${suspicious.join(', ')}`);
    }
    process.exitCode = 1;
}

// Levenshtein distance <= 2 between two variable names.
function isClose(a, b) {
    if (Math.abs(a.length - b.length) > 2) return false;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
    }
    return dp[a.length][b.length] <= 2;
}