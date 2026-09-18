import 'dotenv/config'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'

const agentsEnabled = /^(1|true|yes|on)$/i.test(
  process.env.OM_ENABLE_ENTERPRISE_MODULES_AGENTS?.trim() || '',
)
if (agentsEnabled) {
  const required = ['/usr/bin/pdfinfo', '/usr/bin/pdftotext', '/usr/bin/pdftoppm']
  const missing = []
  for (const executable of required) {
    try {
      await access(executable, constants.X_OK)
    } catch {
      missing.push(executable)
    }
  }
  if (missing.length > 0) {
    console.error(
      `PDF intake agent requires poppler-utils; missing executable(s): ${missing.join(', ')}`,
    )
    process.exit(1)
  }
}
