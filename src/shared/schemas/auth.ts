import { z } from 'zod';

/**
 * Public authenticated user object returned to client.
 * Strictly limited to non-sensitive identification fields.
 * Never includes googleSub, tokens, hashes, or ciphertext.
 */
export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  displayName: z.string().min(1),
});

export type AuthUser = z.infer<typeof authUserSchema>;

/**
 * Response schema for GET /api/auth/me
 */
export const authMeResponseSchema = z.object({
  user: authUserSchema,
});

export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;

/**
 * Response schema for POST /api/auth/logout
 */
export const authLogoutResponseSchema = z.object({
  ok: z.literal(true),
});

export type AuthLogoutResponse = z.infer<typeof authLogoutResponseSchema>;

/**
 * Query parameters received at GET /api/auth/callback
 */
export const authCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export type AuthCallbackQuery = z.infer<typeof authCallbackQuerySchema>;

export const inviteTokenRegex = /^[A-Za-z0-9_-]{43}$/;

/**
 * Request schema for POST /api/auth/login
 */
export const authLoginRequestBodySchema = z
  .object({
    inviteToken: z.string().regex(inviteTokenRegex),
  })
  .strict();

export type AuthLoginRequestBody = z.infer<typeof authLoginRequestBodySchema>;

/**
 * Response schema for POST /api/auth/login
 */
export const authLoginResponseSchema = z
  .object({
    authorizationUrl: z.string().url(),
  })
  .strict();

export type AuthLoginResponse = z.infer<typeof authLoginResponseSchema>;

/**
 * Decrypted OAuth login flow payload stored in oauth_states.
 */
export const oauthLoginPayloadSchema = z
  .object({
    purpose: z.literal('login').optional(),
    codeVerifier: z.string().min(1),
    nonce: z.string().min(1),
    inviteToken: z.string().regex(inviteTokenRegex).optional(),
  })
  .strict();

export type OAuthLoginPayload = z.infer<typeof oauthLoginPayloadSchema>;

/**
 * Decrypted OAuth incremental family-acl flow payload stored in oauth_states.
 */
export const oauthFamilyAclPayloadSchema = z
  .object({
    purpose: z.literal('family-acl'),
    codeVerifier: z.string().min(1),
    nonce: z.string().min(1),
    userId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    familyId: z.string().min(1).max(128),
  })
  .strict();

export type OAuthFamilyAclPayload = z.infer<typeof oauthFamilyAclPayloadSchema>;

export const oauthPersonalEventsPayloadSchema = z
  .object({
    purpose: z.literal('personal-events'),
    codeVerifier: z.string().min(1),
    nonce: z.string().min(1),
    userId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    familyId: z.string().min(1).max(128),
    memberId: z.string().min(1).max(128),
  })
  .strict();
export type OAuthPersonalEventsPayload = z.infer<typeof oauthPersonalEventsPayloadSchema>;

/**
 * Decrypted OAuth flow payload stored in oauth_states.
 * Retains backward-compatibility for legacy login payload {codeVerifier, nonce}.
 */
export const oauthPayloadSchema = z.union([
  oauthPersonalEventsPayloadSchema,
  oauthFamilyAclPayloadSchema,
  oauthLoginPayloadSchema,
]);

export type OAuthPayload = z.infer<typeof oauthPayloadSchema>;

/**
 * Google OAuth 2.0 token endpoint response schema.
 */
export const googleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().regex(/^Bearer$/i),
  scope: z.string().optional(),
  id_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
});

export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

/**
 * Google OAuth error response schema for boundary validation.
 */
export const googleErrorResponseSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export type GoogleErrorResponse = z.infer<typeof googleErrorResponseSchema>;

/**
 * Validated claims from Google ID Token JWT payload.
 * sub, exp, iat, and nonce are required per OIDC and review specification.
 * Email verification is normalized strictly: literal true or string 'true' becomes true.
 * 'false' or false becomes false, and must be verified before proceeding.
 */
export const googleIdTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  nonce: z.string().min(1),
  email: z.string().email(),
  email_verified: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform((val) => val === true || val === 'true'),
  name: z.string().optional(),
  azp: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  iss: z.string().optional(),
});

export type GoogleIdTokenClaims = z.infer<typeof googleIdTokenClaimsSchema>;
