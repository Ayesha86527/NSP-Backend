const { tradeTester } = require('./auth.model');

const login = (email, password) => {
    if (email !== tradeTester.email || password !== tradeTester.password) {
        return {
            success: false,
            message: 'Invalid email or password'
        };
    }

    if (tradeTester.role !== 'TRADE_TESTER') {
        return {
            success: false,
            message: 'Access denied'
        };
    }

    return {
        success: true,
        message: 'Password verified. MFA verification required.',
        mfaRequired: true,
        user: {
            id: tradeTester.id,
            name: tradeTester.name,
            email: tradeTester.email,
            role: tradeTester.role
        }
    };
};

const verifyMfa = (email, mfaCode) => {
    if (email !== tradeTester.email) {
        return {
            success: false,
            message: 'Invalid user'
        };
    }

    if (mfaCode !== '123456') {
        return {
            success: false,
            message: 'Invalid MFA code'
        };
    }

    return {
        success: true,
        message: 'Login successful',
        user: {
            id: tradeTester.id,
            name: tradeTester.name,
            email: tradeTester.email,
            role: tradeTester.role
        }
    };
};

module.exports = {
    login,
    verifyMfa
};