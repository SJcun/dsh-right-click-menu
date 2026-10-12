/**
 * Right-click context menu, node half.
 *
 * Pure UI plugin: the empty apply exists so the package appears in the Host
 * Loader tree (a `dsh.client` declaration alone cannot be loaded), while every
 * behavior lives in the browser half shipped through `exports["./client"]`.
 *
 * Nothing here reaches a model request, so the plugin has no Model Experience
 * and no KV-cache effect.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
function apply() {}

export { apply };
