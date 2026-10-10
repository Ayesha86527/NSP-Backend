const fs = require('fs');
const path = require('path');


const privateKey = fs.readFileSync(
    path.join(process.cwd(), 'keys', 'private.key'),
    'utf8'
);

const publicKey = fs.readFileSync(
    path.join(process.cwd(), 'keys', 'public.key'),
    'utf8'
);

module.exports = {
    privateKey,
    publicKey,
    accessTokenExpiresIn: '15m'
};