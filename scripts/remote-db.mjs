#!/usr/bin/env node
/**
 * Run any local command against a deployed environment's database.
 *
 * Opens an SSM port-forwarding tunnel through that environment's bastion, resolves
 * its secrets into the child process's environment, runs the command, and tears the
 * tunnel down again — including on Ctrl-C and on a failure part-way through.
 *
 *   yarn remote-db --env blueprint-2-quote-demo -- yarn mercato rfq_intake seed-process --force
 *   yarn remote-db --env blueprint-2-quote-demo -- psql "$DATABASE_URL" -c '\dt'
 *
 * Nothing about one environment is hardcoded: the bastion, the database and every
 * secret are derived from `--env` by the naming convention the infrastructure uses.
 * Override any of them with the flags below when an environment departs from it.
 *
 * Secrets are read into memory and passed to the child process. They are never
 * written to disk, never printed, and never placed on a command line, where they
 * would be visible to every other process on the machine.
 *
 * Read-only by nature: this script grants database ACCESS. Whether the command you
 * hand it reads or writes is your decision, so treat a write against a shared
 * environment as exactly that.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import net from 'node:net'

const USAGE = `Usage: yarn remote-db --env <environment> [options] -- <command...>

Options:
  --env <name>        Environment prefix, e.g. blueprint-2-quote-demo. Required.
  --bastion <id>      EC2 instance id of the bastion. Default: discovered by tag.
  --db <endpoint>     RDS endpoint. Default: <env>-postgres.
  --port <number>     Local port to bind. Default: the first free port from 15432.
  --region <name>     AWS region. Default: the CLI's configured region.
  --print-env         List the variable names injected (never their values) and exit.
  -h, --help          Show this message.`

function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const flags = separator === -1 ? argv : argv.slice(0, separator)
  const command = separator === -1 ? [] : argv.slice(separator + 1)
  const options = {}
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    if (flag === '-h' || flag === '--help') options.help = true
    else if (flag === '--print-env') options.printEnv = true
    else if (flag.startsWith('--')) {
      const key = flag.slice(2)
      const next = flags[i + 1]
      if (next && !next.startsWith('--')) {
        options[key] = next
        i++
      }
    }
  }
  return { options, command }
}

function fail(message) {
  console.error(`remote-db: ${message}`)
  process.exit(1)
}

function aws(args, { allowFailure = false } = {}) {
  const result = spawnSync('aws', args, { encoding: 'utf8' })
  if (result.error) fail(`could not run the AWS CLI — ${result.error.message}`)
  if (result.status !== 0) {
    if (allowFailure) return null
    // stderr carries the actionable part (expired SSO token, missing permission).
    fail(`aws ${args.slice(0, 2).join(' ')} failed:\n${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

/**
 * The bastion is found by tag rather than by a stored id so a replaced instance needs
 * no change here. Only RUNNING instances qualify; a stopped one would resolve and then
 * fail at the tunnel with a far less obvious error.
 */
function discoverBastion(env, region) {
  const out = aws([
    ...region,
    'ec2', 'describe-instances',
    '--filters',
    `Name=tag:Name,Values=${env}-bastion`,
    'Name=instance-state-name,Values=running',
    '--query', 'Reservations[].Instances[].InstanceId',
    '--output', 'text',
  ])
  const ids = (out ?? '').split(/\s+/).filter(Boolean)
  if (ids.length === 0) {
    fail(`no running instance tagged "${env}-bastion". Pass --bastion <instance-id>.`)
  }
  if (ids.length > 1) {
    fail(`several instances tagged "${env}-bastion" (${ids.join(', ')}). Pass --bastion.`)
  }
  return ids[0]
}

function discoverDatabase(env, region) {
  const out = aws([
    ...region,
    'rds', 'describe-db-instances',
    '--db-instance-identifier', `${env}-postgres`,
    '--query', 'DBInstances[0].Endpoint.Address',
    '--output', 'text',
  ], { allowFailure: true })
  if (!out || out === 'None') {
    fail(`no RDS instance named "${env}-postgres". Pass --db <endpoint>.`)
  }
  return out
}

function readSecret(secretId, region) {
  const out = aws([
    ...region,
    'secretsmanager', 'get-secret-value',
    '--secret-id', secretId,
    '--query', 'SecretString',
    '--output', 'text',
  ], { allowFailure: true })
  return out && out !== 'None' ? out : null
}

/**
 * Secrets this app needs to boot far enough to touch the database. Only
 * `DATABASE_URL` is required — the rest let commands that decrypt tenant data or
 * hash lookups behave the way the deployed app does, and a missing one is reported
 * rather than silently substituted, because a wrong key writes unreadable rows.
 */
const SECRET_SUFFIXES = [
  { env: 'TENANT_DATA_ENCRYPTION_KEY', suffix: 'tenant-data-encryption-key' },
  { env: 'TENANT_DATA_ENCRYPTION_FALLBACK_KEY', suffix: 'tenant-data-encryption-fallback-key' },
  { env: 'LOOKUP_HASH_PEPPER', suffix: 'lookup-hash-pepper' },
]

function buildDatabaseUrl(secretJson, host, port) {
  let raw = secretJson
  try {
    const parsed = JSON.parse(secretJson)
    raw = parsed.database_url ?? parsed.DATABASE_URL ?? parsed.url
  } catch {
    // A plain-string secret is fine; fall through with the raw value.
  }
  if (typeof raw !== 'string' || !raw.startsWith('postgres')) {
    fail('the postgres secret holds no usable database_url')
  }
  // Swap only the host:port authority, keeping credentials, database and any query.
  return raw.replace(/@[^/]+\//, `@127.0.0.1:${port}/`)
}

async function firstFreePort(start) {
  for (let port = start; port < start + 50; port++) {
    const free = await new Promise((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  fail(`no free local port in ${start}..${start + 49}`)
}

function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`the tunnel never opened on port ${port}`))
        else setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

async function main() {
  const { options, command } = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const env = options.env
  if (!env) {
    console.error(USAGE)
    fail('--env is required')
  }
  if (command.length === 0 && !options.printEnv) {
    console.error(USAGE)
    fail('nothing to run — put the command after `--`')
  }

  const region = options.region ? ['--region', options.region] : []

  console.error(`remote-db: resolving ${env}...`)
  const bastion = options.bastion ?? discoverBastion(env, region)
  const database = options.db ?? discoverDatabase(env, region)
  const port = options.port ? Number(options.port) : await firstFreePort(15432)

  const postgresSecret = readSecret(`${env}-postgres`, region)
  if (!postgresSecret) fail(`no secret named "${env}-postgres"`)

  const childEnv = {
    ...process.env,
    DATABASE_URL: buildDatabaseUrl(postgresSecret, database, port),
    // RDS refuses an unencrypted connection; through the tunnel the certificate
    // names the RDS host while the client sees 127.0.0.1, so verification has to be
    // off. The traffic is still encrypted, and the tunnel itself is authenticated.
    DB_SSL: 'true',
    DB_SSL_REJECT_UNAUTHORIZED: 'false',
  }
  const injected = ['DATABASE_URL', 'DB_SSL', 'DB_SSL_REJECT_UNAUTHORIZED']
  for (const { env: name, suffix } of SECRET_SUFFIXES) {
    const value = readSecret(`${env}-${suffix}`, region)
    if (value) {
      childEnv[name] = value
      injected.push(name)
    } else {
      console.error(`remote-db: no secret "${env}-${suffix}" — leaving ${name} unset`)
    }
  }

  if (options.printEnv) {
    console.log(injected.join('\n'))
    return 0
  }

  console.error(`remote-db: tunnelling ${database}:5432 -> 127.0.0.1:${port} via ${bastion}`)
  const tunnel = spawn('aws', [
    ...region,
    'ssm', 'start-session',
    '--target', bastion,
    '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
    '--parameters',
    JSON.stringify({ host: [database], portNumber: ['5432'], localPortNumber: [String(port)] }),
  ], { stdio: ['ignore', 'ignore', 'inherit'] })

  let closed = false
  const closeTunnel = () => {
    if (closed) return
    closed = true
    tunnel.kill('SIGTERM')
  }
  // Tear down on every exit path. A leaked session holds the port and silently
  // re-serves the next run against a database it was never pointed at.
  process.on('exit', closeTunnel)
  process.on('SIGINT', () => { closeTunnel(); process.exit(130) })
  process.on('SIGTERM', () => { closeTunnel(); process.exit(143) })

  tunnel.on('exit', (code) => {
    if (!closed) fail(`the tunnel exited early (code ${code}). Is the SSM plugin installed and your AWS session valid?`)
  })

  try {
    await waitForPort(port)
  } catch (error) {
    closeTunnel()
    fail(error.message)
  }

  console.error(`remote-db: running ${command.join(' ')}\n`)
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: childEnv })
  const code = await new Promise((resolve) => {
    child.on('exit', (status, signal) => resolve(signal ? 1 : (status ?? 1)))
    child.on('error', (error) => {
      console.error(`remote-db: could not run "${command[0]}" — ${error.message}`)
      resolve(127)
    })
  })

  closeTunnel()
  return code
}

main().then((code) => process.exit(code))
