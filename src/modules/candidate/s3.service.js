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

const UPLOAD_URL_EXPIRY_SECONDS = 300;

// Only these image types may be uploaded. The key is the (normalised)
// MIME type the frontend sends, the value is the S3 object extension.
const ALLOWED_IMAGE_TYPES = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png'
};

/**
 * Validate the MIME type requested by the frontend.
 * Defaults to image/jpeg so older clients keep working.
 *
 * The presigned URL is signed for exactly this Content-Type, so the
 * browser MUST send the same value in its PUT request header.
 */
const resolveImageType = (contentType) => {
    const normalised =
        typeof contentType === 'string' && contentType.trim()
            ? contentType.trim().toLowerCase()
            : 'image/jpeg';

    const extension = ALLOWED_IMAGE_TYPES[normalised];

    if (!extension) {
        const error = new Error(
            'Unsupported image type. Only JPEG and PNG images are allowed'
        );
        error.statusCode = 400;
        throw error;
    }

    return {
        // Store a single canonical value for JPEG.
        contentType: normalised === 'image/jpg' ? 'image/jpeg' : normalised,
        extension
    };
};

const buildUploadUrl = async ({ bucket, key, contentType }) => {
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType
    });

    const uploadUrl = await getSignedUrl(
        s3Client,
        command,
        {
            expiresIn: UPLOAD_URL_EXPIRY_SECONDS
        }
    );

    return {
        uploadUrl,
        key,
        s3Uri: `s3://${bucket}/${key}`,
        // The frontend must send this exact value as the Content-Type
        // header when it PUTs the file to uploadUrl.
        contentType,
        expiresIn: UPLOAD_URL_EXPIRY_SECONDS
    };
};

const createPhotoUploadUrl = async ({ userId, contentType }) => {
    const bucket = process.env.AWS_S3_BUCKET;

    if (!bucket) {
        throw new Error('AWS_S3_BUCKET is not configured');
    }

    const image = resolveImageType(contentType);
    const randomId = crypto.randomUUID();

    return buildUploadUrl({
        bucket,
        key: `candidate-photos/${userId}/${randomId}.${image.extension}`,
        contentType: image.contentType
    });
};

const createAssessmentPhotoUploadUrl = async ({
    assessmentId,
    userId,
    contentType
}) => {
    const bucket = process.env.AWS_S3_BUCKET;

    if (!bucket) {
        throw new Error('AWS_S3_BUCKET is not configured');
    }

    const image = resolveImageType(contentType);
    const randomId = crypto.randomUUID();

    return buildUploadUrl({
        bucket,
        key:
            `assessment-media/${userId}/${assessmentId}/` +
            `${randomId}.${image.extension}`,
        contentType: image.contentType
    });
};

module.exports = {
    createPhotoUploadUrl,
    createAssessmentPhotoUploadUrl,
    resolveImageType,
    ALLOWED_IMAGE_TYPES
};