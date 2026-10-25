/**
 * Generate the RS256 key pair the API needs to sign/verify JWTs.
 *
 *   node scripts/generateJwtKeys.js                 # writes src/config/keys/{private,public}.key
 *   node scripts/generateJwtKeys.js --out /etc/nsp/keys
 *   node scripts/generateJwtKeys.js --force         # overwrite existing keys (invalidates ALL sessions)
 *
 * Works on Windows/macOS/Linux (no openssl needed). Keys are gitignored.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'src', 'config', 'keys');

function generateJwtKeys({ outDir = DEFAULT_DIR, force = false } = {}) {
    const privatePath = path.join(outDir, 'private.key');
    const publicPath = path.join(outDir, 'public.key');

    if (!force && (fs.existsSync(privatePath) || fs.existsSync(publicPath))) {
        throw new Error(
            `JWT keys already exist in ${outDir}. Re-run with --force only if you accept that every active session becomes invalid.`
        );
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
    fs.writeFileSync(publicPath, publicKey, { mode: 0o644 });

    return { privatePath, publicPath };
}

function parseArgs(argv) {
    const outIndex = argv.indexOf('--out');
    return {
        force: argv.includes('--force'),
        outDir: outIndex !== -1 && argv[outIndex + 1] ? path.resolve(argv[outIndex + 1]) : DEFAULT_DIR
    };
}

if (require.main === module) {
    try {
        const { privatePath, publicPath } = generateJwtKeys(parseArgs(process.argv.slice(2)));
        console.log(`Created ${privatePath}`);
        console.log(`Created ${publicPath}`);
        console.log('Never commit these files (they are gitignored).');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { generateJwtKeys, parseArgs, DEFAULT_DIR };