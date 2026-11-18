/**
 * Host half of @local/codex-bridge.
 *
 * The bundle's real work happens in two other places: cordis.patch.yml inserts
 * the MCP client row that gives the agent the bridge_* tools, and lib/client.js
 * registers the "桥" conversation view. This entry exists only so the package
 * is an active Loader entry — the client module system only composes browser
 * bundles for packages the host roster actually loaded.
 */
export const name = 'codex-bridge';

export function apply() {
  // nothing to do on the host side
}
