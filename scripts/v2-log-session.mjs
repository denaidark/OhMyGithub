import { readFileSync } from 'node:fs'

try {
  for (const line of readFileSync(process.argv[2], 'utf8').split('\n')) {
    try {
      const row = JSON.parse(line)
      if (/^ses_[A-Za-z0-9]+$/.test(row.sessionID || '')) { process.stdout.write(row.sessionID); break }
    } catch {}
  }
} catch {}
