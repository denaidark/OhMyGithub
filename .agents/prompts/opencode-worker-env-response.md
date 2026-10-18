# Workflow: ask OpenCode for worker environment

1. Find the active run for the issue:

   ```sh
   gh run list --repo AgentsLoop/OhMyGithub --workflow opencode.yml --status in_progress
   ```

2. Discover the worker SSH host and port:

   ```sh
   bash scripts/ssh-run-log.sh <run-id> --repo AgentsLoop/OhMyGithub
   ```

3. Connect using the host, port, and key printed by the helper:

   ```sh
   ssh -tt -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
     -i ~/.ssh/aiplay-agentsweb -p <port> runner@<host>
   ```

4. Find the OpenCode root session:

   ```sh
   curl -s http://127.0.0.1:4096/session | jq -r '.[] | [.id, (.title // "")] | @tsv'
   ```

5. Ask OpenCode to list environment variables, requiring sensitive values to
   be redacted. Read the response from the session messages.
