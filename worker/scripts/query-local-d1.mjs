#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

async function main() {
  const sql = process.argv[2]?.trim()

  if (!sql) {
    throw new Error('Usage: node ./scripts/query-local-d1.mjs "<sql>"')
  }

  const databasePath = await findLocalD1Path()
  const db = new DatabaseSync(databasePath)
  const rows = db.prepare(sql).all()

  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
}

async function findLocalD1Path() {
  const directory = resolve('./.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
  const entries = await readdir(directory, { withFileTypes: true })
  const sqliteFile = entries.find(
    (entry) => entry.isFile() && entry.name.endsWith('.sqlite') && entry.name !== 'metadata.sqlite',
  )

  if (!sqliteFile) {
    throw new Error('Could not find local D1 sqlite file. Run the worker locally or apply migrations first.')
  }

  return resolve(directory, sqliteFile.name)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
