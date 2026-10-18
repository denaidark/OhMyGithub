# Keep live source browsing separate from final preview

Serve live source files through a dedicated Vite tunnel. Keep OpenCode on its own origin. Preserve the existing app tunnel for final preview.

List directories before Vite handles HTML. Process explicit index.html requests and root-relative modules through Vite. Keep the project HTML unchanged. Use serve-index middleware rather than a directory plugin that requires an index.html template.

Keep the managed Vite runtime independent of project build scripts so browsing starts before generation. Install project dependencies before resolving package imports. Add explicit support and tests before loading framework plugins or project-specific aliases. Keep dist execution in final preview.

Test actual module responses and HMR messages. Reject the assumption that a successful HTML response proves the app runs; OpenCode can return its HTML fallback with HTTP 200 for a misrouted JavaScript request.
