/**
 * Strict startup environment validator (Roadmap Phase 2, Days 6-7).
 *
 * Fail-fast: the process must refuse to boot when configuration is missing
 * or malformed, rather than crash later on the first request that needs it.
 * All problems are collected and reported together so an operator can fix
 * the whole environment in one pass.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const KEYS_DIRECTORY = path.join(__dirname, 'keys');
const JWT_KEY_FILES = ['private.key', 'public.key'];

// Variables the running server cannot work without.
const REQUIRED_VARIABLES = [
    'DB_HOST',
    'DB_NAME',
    'DB_USER',
    'DB_PASSWORD',
    'MFA_ENCRYPTION_KEY',
    'CNIC_DEDUP_SECRET',
    'CORS_ALLOWED_ORIGINS',
    'AWS_REGION',
    'AWS_S3_BUCKET',
    'REDIS_URL',
    'POLYGON_AMOY_RPC_URL',
    'RELAYER_PRIVATE_KEY',
    'CERTIFICATE_LOGIC_CONTRACT_ADDRESS'
];

const isBlank = (value) => typeof value !== 'string' || value.trim() === '';

const isIntegerInRange = (value, min, max) => {
    if (!/^\d+$/.test(String(value).trim())) {
        return false;
    }
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max;
};

function validateUrl(value, allowedProtocols) {
    try {
        return allowedProtocols.includes(new URL(value).protocol);
    } catch {
        return false;
    }
}

/**
 * Validate the environment.
 *
 * @param {object} [env=process.env] Environment to validate (injectable for tests).
 * @param {object} [options]
 * @param {string} [options.keysDirectory] Directory holding the RS256 JWT keys.
 * @throws {Error} One error listing every problem found.
 */
function validateEnv(env = process.env, options = {}) {
    const keysDirectory = options.keysDirectory || env.JWT_KEYS_DIR || KEYS_DIRECTORY;
    const problems = [];

    // ---- 1. Presence -------------------------------------------------------
    const missing = REQUIRED_VARIABLES.filter((name) => isBlank(env[name]));

    if (missing.length > 0) {
        problems.push(`Missing required environment variables: ${missing.join(', ')}`);
    }

    // ---- 2. Format ---------------------------------------------------------
    const present = (name) => !isBlank(env[name]);

    // AES-256 key for MFA secrets: 32 bytes as 64 hex characters.
    if (present('MFA_ENCRYPTION_KEY') && !/^[0-9a-fA-F]{64}$/.test(env.MFA_ENCRYPTION_KEY.trim())) {
        problems.push('MFA_ENCRYPTION_KEY must be 32 bytes represented as 64 hex characters');
    }

    if (present('CNIC_DEDUP_SECRET') && env.CNIC_DEDUP_SECRET.trim().length < 32) {
        problems.push('CNIC_DEDUP_SECRET must be at least 32 characters long');
    }

    if (present('DB_PORT') && !isIntegerInRange(env.DB_PORT, 1, 65535)) {
        problems.push('DB_PORT must be an integer between 1 and 65535');
    }

    if (present('PORT') && !isIntegerInRange(env.PORT, 1, 65535)) {
        problems.push('PORT must be an integer between 1 and 65535');
    }

    if (present('DB_SSL') && !['true', 'false'].includes(env.DB_SSL.trim())) {
        problems.push('DB_SSL must be "true" or "false"');
    }

    if (present('DB_SSL_REJECT_UNAUTHORIZED') &&
        !['true', 'false'].includes(env.DB_SSL_REJECT_UNAUTHORIZED.trim())) {
        problems.push('DB_SSL_REJECT_UNAUTHORIZED must be "true" or "false"');
    }

    if (present('DB_SSL_CA') && !fs.existsSync(env.DB_SSL_CA)) {
        problems.push(`DB_SSL_CA file does not exist: ${env.DB_SSL_CA}`);
    }

    if (present('DB_POOL_MAX') && !isIntegerInRange(env.DB_POOL_MAX, 1, 500)) {
        problems.push('DB_POOL_MAX must be an integer between 1 and 500');
    }

    if (present('DB_POOL_IDLE_TIMEOUT_MS') && !isIntegerInRange(env.DB_POOL_IDLE_TIMEOUT_MS, 1, 3600000)) {
        problems.push('DB_POOL_IDLE_TIMEOUT_MS must be a positive integer (milliseconds)');
    }

    if (present('RATE_LIMIT_PER_MINUTE') && !isIntegerInRange(env.RATE_LIMIT_PER_MINUTE, 1, 100000)) {
        problems.push('RATE_LIMIT_PER_MINUTE must be a positive integer');
    }

    if (present('TRUST_PROXY') && !/^(true|false|\d+)$/.test(env.TRUST_PROXY.trim())) {
        problems.push('TRUST_PROXY must be "true", "false", or the number of proxy hops');
    }

    if (present('REDIS_URL') && !validateUrl(env.REDIS_URL.trim(), ['redis:', 'rediss:'])) {
        problems.push('REDIS_URL must be a valid redis:// or rediss:// URL');
    }

    if (present('POLYGON_AMOY_RPC_URL')) {
        const rpcUrl = env.POLYGON_AMOY_RPC_URL.trim();
        if (!validateUrl(rpcUrl, ['https:', 'http:'])) {
            problems.push('POLYGON_AMOY_RPC_URL must be a valid URL');
        } else {
            // Mirrors the rule enforced by blockchain/contract.js at runtime.
            const parsed = new URL(rpcUrl);
            const isLocalHttp = parsed.protocol === 'http:' &&
                ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
            if (parsed.protocol !== 'https:' && !isLocalHttp) {
                problems.push('POLYGON_AMOY_RPC_URL must use HTTPS except for local development');
            }
        }
    }

    if (present('RELAYER_PRIVATE_KEY') && !/^(0x)?[0-9a-fA-F]{64}$/.test(env.RELAYER_PRIVATE_KEY.trim())) {
        problems.push('RELAYER_PRIVATE_KEY must be a 32-byte hex private key');
    }

    if (present('CERTIFICATE_LOGIC_CONTRACT_ADDRESS') &&
        !ethers.isAddress(env.CERTIFICATE_LOGIC_CONTRACT_ADDRESS.trim())) {
        problems.push('CERTIFICATE_LOGIC_CONTRACT_ADDRESS must be a valid EVM address');
    }

    if (present('MIN_GAS_THRESHOLD')) {
        const threshold = Number(env.MIN_GAS_THRESHOLD);
        if (!Number.isFinite(threshold) || threshold < 0) {
            problems.push('MIN_GAS_THRESHOLD must be a non-negative number (POL)');
        }
    }

    // CORS: a list of bare origins, never a path and never a wildcard.
    if (present('CORS_ALLOWED_ORIGINS')) {
        const origins = env.CORS_ALLOWED_ORIGINS
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean);

        if (origins.length === 0) {
            problems.push('CORS_ALLOWED_ORIGINS must list at least one origin');
        }

        for (const origin of origins) {
            let parsed;

            try {
                parsed = new URL(origin);
            } catch {
                problems.push(`CORS_ALLOWED_ORIGINS contains an invalid origin: "${origin}"`);
                continue;
            }

            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
                problems.push(
                    `CORS origin "${origin}" must be an origin only (scheme://host[:port], no path or trailing slash)`
                );
            }

            if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
                problems.push(`CORS origin "${origin}" must use HTTPS in production`);
            }
        }
    }

    // ---- 3. JWT key files (RS256) -----------------------------------------
    for (const filename of JWT_KEY_FILES) {
        const keyPath = path.join(keysDirectory, filename);

        if (!fs.existsSync(keyPath)) {
            problems.push(`Required JWT key file is missing: ${keyPath}`);
        } else if (!fs.readFileSync(keyPath, 'utf8').trim()) {
            problems.push(`Required JWT key file is empty: ${keyPath}`);
        }
    }

    // ---- 4. Production-only guarantees ------------------------------------
    if (env.NODE_ENV === 'production') {
        if (env.DB_SSL !== 'true') {
            problems.push('DB_SSL must be "true" in production');
        }

        if (env.DB_SSL_REJECT_UNAUTHORIZED === 'false') {
            problems.push('DB_SSL_REJECT_UNAUTHORIZED must not be "false" in production');
        }
    }

    if (problems.length > 0) {
        throw new Error(
            `Invalid environment configuration:\n - ${problems.join('\n - ')}`
        );
    }
}

module.exports = validateEnv;
module.exports.validateEnv = validateEnv;
module.exports.REQUIRED_VARIABLES = REQUIRED_VARIABLES;
