const errorHandler = (err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    const statusCode =
        Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
            ? err.statusCode
            : 500;

    if (statusCode >= 500) {
        console.error(err.stack || err);
    }

    // Never leak internal error details to clients in production.
    const message =
        statusCode >= 500 && process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : err.message || 'Internal server error';

    return res.status(statusCode).json({
        success: false,
        message
    });
};

module.exports = errorHandler;
