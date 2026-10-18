# Pass OpenCode OAuth credentials through the worker environment

OpenCode supports `OPENCODE_AUTH_CONTENT` as an environment-only auth path. It
parses the complete auth JSON from that variable before falling back to
`~/.local/share/opencode/auth.json`.

For the GitHub Actions worker, map the encrypted repository secret into
`OPENCODE_AUTH_CONTENT` and remove the startup step that writes `auth.json`:

```yaml
OPENCODE_AUTH_CONTENT: ${{ secrets.OPENCODE_AUTH_JSON }}
```

Reference: `../opencode/packages/opencode/src/auth/index.ts`.
