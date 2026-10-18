# Temporary Mac SSH access

The workflow authorizes the Mac public key stored in the
`AGENTSWEB_SSH_PUBLIC_KEY` repository secret. Keep the matching private key
only on the Mac at:

```text
~/.ssh/aiplay-agentsweb
```

This SSH path is optional. If the repository secret is missing, or tunnel setup
fails, the workflow skips AgentsWeb SSH setup/verification while keeping the
OpenCode Web session available through its browser URL.

When a run is active, the workflow posts a command like this to the triggering
issue:

```sh
ssh -i ~/.ssh/aiplay-agentsweb -p <port> runner@<run-name>.agentsweb.space
```

The command is valid only while that Actions job is running. When setup
succeeds, the workflow verifies the same tunnel and removes the runner SSH
authorization and tunnel during cleanup. The issue access comment includes the
SSH URL together with the OpenCode Web URL. If tunnel setup fails, the comment
reports `SSH URL: not registered`.

If the command stops working, check the Actions run first. A completed or
cancelled run has already closed the tunnel.

## Mac runner DNS

Run `bash "$RUNTIME_DIR/scripts/setup-mac-dns.sh"` before starting Cloudflare tunnels on GitHub-hosted Macs. Set Ethernet DNS to `1.1.1.1` and `8.8.8.8`; flush the macOS DNS cache. Keep public HTTP readiness checks enabled.

Compare the default resolver with `dig @1.1.1.1 HOST` when a tunnel hostname fails. Check for the issue #42 failure pattern: VM resolver `192.168.64.1` returns NXDOMAIN while public resolvers return addresses. Verify both curl and Node fetch after repair, then confirm that the issue API reports `live`. Apply this setup only to disposable hosted runners.

Run the `Mac tunnel DNS regression` workflow after DNS, readiness, or worker-workflow changes. Require a newly allocated Quick Tunnel to serve the exact local-origin response through ordinary Node fetch and curl within five minutes. Keep its automatic main-branch path trigger enabled. Allow propagation retries without weakening the readiness predicate or pinning edge addresses.

Recover stale macOS cache entries only on disposable Actions Macs: require an ENOTFOUND/EAI_AGAIN for a Quick Tunnel hostname and a successful public DNS A-record query before flushing caches. Retry ordinary HTTPS once; keep the URL unavailable if that request fails. Retry unpublished names on later readiness polls rather than treating DNS records alone as readiness.
