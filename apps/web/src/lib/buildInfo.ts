/**
 * This page's build: the hashed name of the bundle it was loaded from
 * (e.g. "index-Dn0z4sBw"). Sent when joining, so the server can tell a page
 * running an old cached copy of the app to reload. Null in dev mode.
 */
export const BUILD_ID: string | null = /\/assets\/(index-[\w-]+)\.js/.exec(import.meta.url)?.[1] ?? null;
