/**
 * Run one scheduled job now, from a terminal, and print what it wrote.
 *
 *   npm run job                    the morning brief
 *   npm run job -- morning-brief   any job in ~/.emrys/schedules.json
 *
 * The same code the scheduler runs, so this is the honest way to check a
 * procedure you have just edited: what you see here is what arrives at seven.
 * The result is filed exactly as a scheduled run would be — saved under
 * ~/.emrys/briefings, logged in the journal, waiting unread for "brief me".
 */

import { readFileSync } from 'node:fs'
import { ensureHome } from '../bridge/home.mjs'
import { readSchedules, runJob } from '../bridge/scheduler.mjs'

ensureHome()

const name = process.argv[2] ?? 'morning-brief'
const jobs = readSchedules()
const job = jobs.find((j) => j.name === name)

if (!job) {
  console.error(
    `No job named "${name}" in ~/.emrys/schedules.json.` +
      (jobs.length ? ` Jobs: ${jobs.map((j) => j.name).join(', ')}.` : ''),
  )
  process.exit(1)
}

const outcome = await runJob(job, { reason: 'from the terminal' })

if (!outcome.ok) {
  console.error(`\n${job.title} failed: ${outcome.error}`)
  process.exit(1)
}

console.log(`\n${'─'.repeat(72)}\n${readFileSync(outcome.record.file, 'utf8')}`)
