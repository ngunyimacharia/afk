/**
 * Running version of the AFK CLI.
 *
 * The compiled executable receives the package.json version at build time via
 * the `process.env.AFK_VERSION` define. When running from source the
 * environment variable is unset, so we fall back to the development placeholder.
 */
export const VERSION = process.env.AFK_VERSION || '0.0.0';
