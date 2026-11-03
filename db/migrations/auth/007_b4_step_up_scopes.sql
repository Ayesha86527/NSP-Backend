BEGIN;

ALTER TABLE auth.step_up_tokens
DROP CONSTRAINT step_up_tokens_scope_check;

ALTER TABLE auth.step_up_tokens
ADD CONSTRAINT step_up_tokens_scope_check
CHECK (
    scope::text = ANY (
        ARRAY[
            'APPROVE_ASSESSMENT',
            'REVOKE_CREDENTIAL',
            'REGISTER_HUB_KEY',
            'CHANGE_ROLE',
            'RESET_MFA',
            'REASSIGN_HUB',
            'MANAGE_ACCOUNT_STATUS',
            'ADMIN_PASSWORD_RESET'
        ]::text[]
    )
);

COMMIT;