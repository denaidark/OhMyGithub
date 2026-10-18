# Preserve preview port ownership

Reproduce Mood-Period-Tracker- issue 1: the main agent started Vite on port 3000, the managed static server failed with EADDRINUSE, and readiness accepted the old Vite server locally while the public tunnel returned HTTP 403 for its hostname. Reclaim only same-user project listeners before starting the managed server. Verify the tmux server exists before accepting local HTTP success. Preserve public response diagnostics for bounded setup repair. Keep unrelated listeners untouched. Install lsof in Linux worker prerequisites.
