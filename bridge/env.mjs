/**
 * Old names, still honoured.
 *
 * He has been JARVIS, then Emrys, and is now Jett, and each rename left
 * settings behind in places this code does not own: a launchd plist written by
 * an earlier install, a line in someone's shell profile. So every JARVIS_* and
 * EMRYS_* variable is read as the JETT_* variable of the same name, unless
 * that one is already set. Imported first by anything that reads process.env,
 * so the rest of the code only ever asks for JETT_*.
 */
for (const [key, value] of Object.entries(process.env)) {
  const m = /^(?:EMRYS|JARVIS)_(.+)$/.exec(key)
  if (m && value !== undefined && process.env[`JETT_${m[1]}`] === undefined) {
    process.env[`JETT_${m[1]}`] = value
  }
}
