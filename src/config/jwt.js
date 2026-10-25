const fs = require('fs');
const path = require('path');

// Keys live in src/config/keys by default. In production mount them as
// secrets and point JWT_KEYS_DIR at the mount (e.g. /etc/nsp/keys).
const keysDirectory = process.env.JWT_KEYS_DIR || path.join(__dirname, 'keys');

const privateKey = fs.readFileSync(
    path.join(keysDirectory, 'private.key'),
    'utf8'
);

const publicKey = fs.readFileSync(
    path.join(keysDirectory, 'public.key'),
    'utf8'
);

module.exports = {
    privateKey,
    publicKey,
    accessTokenExpiresIn: '15m'
};
