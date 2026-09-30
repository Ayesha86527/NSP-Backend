const {
    S3Client
} = require('@aws-sdk/client-s3');

const region = process.env.AWS_REGION || 'us-east-1' ;

if (!region) {
    throw new Error('AWS_REGION is not configured');
}

const s3Client = new S3Client({
    region
});

module.exports = {
    s3Client
};