# Migrate OmGithub from Firebase to self-hosted Supabase on a2

Status: proposal only. Keep Firebase active until the data export succeeds.

## Goal

Run Supabase on a2 with Docker Compose. Keep OmGithub catalog data, ratings,
comments, and play history on a2. Do not use Supabase Cloud.

Keep GitHub sign-in, public URLs, Actions builds, upload callbacks, and game
files unchanged.

Prefer a simple setup that is easy to understand and repair. Accept that a
single-server installation can lose data if a2 and its local backups fail
together.

## Deploy Supabase

1. Create `/home/ubuntu/projects/omgithub-supabase` on a2.
2. Use the official Supabase Docker Compose files and ARM64-compatible images.
3. Keep the Compose file, `.env`, database volume, and backup directory in the
   same project structure.
4. Expose only the Supabase API required by OmGithub. Protect Supabase Studio
   with one password if it is exposed.
5. Connect OmGithub to PostgreSQL with a normal connection string.
6. Record the directory, ports, version, start command, stop command, and
   restore command in the deployment documentation.

## Replace Firebase access

1. Add SQL migrations for projects, social totals, ratings, comments, and play
   records.
2. Preserve Firestore IDs, timestamps, status, catalog metadata, and JSON
   fields. Store flexible project metadata as JSONB.
3. Add indexes for fields used by catalog, project, comment, rating, and play
   queries.
4. Replace Firestore calls with parameterized PostgreSQL queries. Keep the
   existing API responses and local JSON storage for development.
5. Preserve partial project updates, catalog ordering, rating seeds,
   moderation state, social identities, and the 24-hour play-count rule.
6. Use database transactions where a rating, comment, or play update changes
   more than one row.
7. Update catalog import and star-backfill commands to use PostgreSQL.

## Export and import data

1. Export every Firebase document from `omgithub_projects`, `project_social`,
   `project_ratings`, `project_comments`, and `project_plays`.
2. Save the export and collection counts under
   `/home/ubuntu/backups/omgithub-supabase/firebase-export`.
3. Import records with their original IDs and timestamps.
4. Compare collection counts and check representative projects, ratings,
   comments, and play records.
5. Stop the migration if Firebase quota errors prevent a complete export.

## Cut over

1. Start a short maintenance window and block new writes.
2. Wait for active publication jobs and upload callbacks.
3. Run the final Firebase export and import it into Supabase.
4. Compare record counts and test catalog routes and social summaries.
5. Deploy OmGithub with the PostgreSQL connection.
6. Test the public catalog, existing game subdomains, GitHub sign-in, and one
   complete Actions publication with its upload callback.
7. Reopen writes after the checks pass.

## Back up

1. Run one daily PostgreSQL dump with cron.
2. Store the latest seven dumps under
   `/home/ubuntu/backups/omgithub-supabase` on a2.
3. Include the Compose file, `.env`, and SQL migrations in the backup.
4. Take an extra database dump before an application, schema, or Supabase
   update.
5. Test the restore command once during the migration and after a backup script
   change.

## Monitor and update

1. Add Docker restart policies to the OmGithub and Supabase containers.
2. Use the existing `/health` endpoint to confirm that OmGithub can reach the
   database.
3. Add one daily cron check for container state, free disk space, and the newest
   backup date. Write failures to a local log.
4. Check Supabase releases manually when maintenance is planned. Read the
   release notes, take a database dump, update the Compose image versions, and
   restart the stack.
5. Keep the previous Compose file and database dump until the updated stack has
   worked correctly.

## Roll back

1. Keep Firebase credentials, the Firebase export, the previous OmGithub image,
   and the a1 migration backup for seven days.
2. Restart the Firebase version if Supabase fails before it accepts new writes.
3. If Supabase accepts new writes, stop writes and export the changed PostgreSQL
   records before returning to Firebase.
4. Restore the pre-update database dump and previous Compose file if a Supabase
   update fails.
5. Do not delete Firebase data during this migration.

## Deliver

1. Run `npm test`, `npm run build`, and `git diff --check`.
2. Commit and push the code, scripts, migrations, and documentation with the
   migration reason, validation results, and current task ID.
