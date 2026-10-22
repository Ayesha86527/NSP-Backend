const fs = require('fs');
const path = require('path');

const keysDirectory = path.join(__dirname, 'keys');

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

