const crypto = require('crypto');

const {
    PutObjectCommand
} = require('@aws-sdk/client-s3');

const {
    getSignedUrl
} = require('@aws-sdk/s3-request-presigner');

const {
    s3Client
} = require('../../config/aws');

const generatePhotoKey = ({ userId }) => {
    const randomId = crypto.randomUUID();

    return `candidate-photos/${userId}/${randomId}.jpg`;
};

const createPhotoUploadUrl = async ({ userId }) => {
    const bucket = process.env.AWS_S3_BUCKET;

    if (!bucket) {
        throw new Error('AWS_S3_BUCKET is not configured');
    }

    const key = generatePhotoKey({
        userId
    });

    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: 'image/jpeg'
    });

    const uploadUrl = await getSignedUrl(
        s3Client,
        command,
        {
            expiresIn: 300
        }
    );

    return {
        uploadUrl,
        key,
        s3Uri: `s3://${bucket}/${key}`,
        expiresIn: 300
    };
};

const createAssessmentPhotoUploadUrl = async ({
    assessmentId,
    userId
}) => {
    const bucket = process.env.AWS_S3_BUCKET;

    if (!bucket) {
        throw new Error('AWS_S3_BUCKET is not configured');
    }

    const randomId = crypto.randomUUID();

    const key =
        `assessment-media/${userId}/${assessmentId}/${randomId}.jpg`;

    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: 'image/jpeg'
    });

    const uploadUrl = await getSignedUrl(
        s3Client,
        command,
        {
            expiresIn: 300
        }
    );

    return {
        uploadUrl,
        key,
        s3Uri: `s3://${bucket}/${key}`,
        expiresIn: 300
    };
};

module.exports = {
    createPhotoUploadUrl,
    createAssessmentPhotoUploadUrl
};