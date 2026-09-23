const verifyIdentity = async ({
    cnic,
    fullName,
    fatherName,
    dob
}) => {
    /*
     * Development adapter.
     *
     * Real NADRA integration will be implemented here
     * when official API credentials/specification are provided.
     *
     * We intentionally do not claim that this is real NADRA
     * verification.
     */

    if (!cnic || !fullName || !fatherName || !dob) {
        return {
            verified: false,
            reason: 'Missing identity information'
        };
    }

    return {
        verified: true,
        provider: 'DEVELOPMENT'
    };
};

module.exports = {
    verifyIdentity
};