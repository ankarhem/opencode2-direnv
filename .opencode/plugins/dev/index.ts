/**
 * Local-development plugin: dogfood the working tree instead of the published
 * `opencode2-direnv` npm package.
 *
 * Loaded automatically from `.opencode/plugins/`. Two details matter:
 *
 * - Distinct plugin id (`opencode2-direnv-dev`): the project-level
 *   `-opencode2-direnv` disable (see ../opencode.json) would otherwise be
 *   re-enabled by this instance's own id (a later id re-enables a disabled
 *   plugin), and the two would collide as duplicates.
 *
 * - Cache-busted dynamic import of the real plugin: the server cache-busts
 *   only the entrypoint file (`index.ts?mtime=…`). A static import of
 *   `src/index.js` would be served from the module cache for the whole
 *   server lifetime, so edits to `src/` would silently keep running stale
 *   code until a service restart. The per-evaluation query makes every
 *   wrapper reload re-import the current working tree.
 */
const plugin = (await import(`../../../src/index.js?dev=${Date.now()}`)).default

export default { ...plugin, id: "opencode2-direnv-dev" }
