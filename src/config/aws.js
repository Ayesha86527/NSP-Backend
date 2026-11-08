const {
    S3Client
} = require('@aws-sdk/client-s3');

const region = process.env.AWS_REGION || 'us-east-1';

/*
 * IMPORTANT: since @aws-sdk v3.729 the SDK adds a CRC32 checksum to every
 * request by default. For a presigned PUT URL that checksum is computed over
 * an EMPTY body (x-amz-checksum-crc32=AAAAAA==) and baked into the URL, so
 * when the browser uploads the real image S3 rejects it with a checksum
 * mismatch. WHEN_REQUIRED turns that default off for presigned uploads.
 */
const s3Client = new S3Client({
    region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
});

module.exports = {
    s3Client
};