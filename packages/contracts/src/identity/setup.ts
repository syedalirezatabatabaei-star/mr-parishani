import * as z from 'zod';

/**
 * A center user's one-time link (owner 1405/08/10; migration 0110): valid 24 hours, kept only
 * as a hash, used once. The user sets their own password; the authenticator app is set up at
 * the first sign-in, as for every staff and center user (rule 25).
 */
export const SETUP_TOKEN_HOURS = 24;

const token = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);

export const setupTokenCheckSchema = z.object({ token });

/** What the page may show before the password is set: whose account, until when. */
export const setupTokenViewSchema = z.object({
  username: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type SetupTokenView = z.infer<typeof setupTokenViewSchema>;

export const setupPasswordSchema = z.object({
  token,
  password: z.string().min(1).max(200),
});
