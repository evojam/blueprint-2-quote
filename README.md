# evojam-proptech

This application includes Open Mercato's enterprise Agent Orchestrator and the example file-defined agents consumed by OpenCode.

## Agent Orchestrator and OpenCode

### Prerequisites

- Node.js 24 or newer
- Yarn 4 (the version pinned in `package.json`)
- Docker with Docker Compose
- An Open Mercato enterprise license for production use
- Credentials for the selected AI provider

The default provider is OpenAI with `gpt-5-mini`. Configure a different provider and model through `OM_AI_PROVIDER` and `OM_AI_MODEL`; never commit provider credentials.

### Environment configuration

Create a local `.env` from `.env.example` and enable both enterprise gates:

```dotenv
OM_ENABLE_ENTERPRISE_MODULES=true
OM_ENABLE_ENTERPRISE_MODULES_AGENTS=true

OM_AI_PROVIDER=openai
OM_AI_MODEL=gpt-5-mini
OPENAI_API_KEY=<secret>
```

`.env` is intentionally ignored by Git. Deployment environments must provide these values through their environment or secret manager; checking out this repository does not enable the module by itself.

Optional runtime settings are documented in `.env.example`, including `OPENCODE_URL`, `OPENCODE_PASSWORD`, `OPENCODE_PORT`, MCP settings, provider-specific credentials, web-search policy, and the file workspace controls. `OPENCODE_PASSWORD` is the shared project secret: the application client reads it directly, while Compose maps it to OpenCode's required `OPENCODE_SERVER_PASSWORD`. Keep `OM_OPENCODE_FILES_ENABLED=false` unless an explicitly reviewed file agent requires the shared writable workspace.

The AI Assistant and OpenCode MCP authentication depend on the core `api_keys` module, which is enabled in `src/modules.ts`. When enabling this stack on an existing database, apply the shipped module migrations before provisioning the MCP key:

```bash
yarn mercato db migrate
```

This changes the target database only; migration state is not propagated by Git. New environments receive the same schema through their normal initialization or deployment migration step.

### Generate the agent artifacts

With the environment flags enabled, run:

```bash
yarn generate
```

The source definitions live under `src/modules/agent_examples/agents/**`. Generation emits the OpenCode-native files under:

- `docker/opencode/agents/**`
- `docker/opencode/skills/**`

These generated files are committed so file-defined agents travel with Git and can be bind-mounted in development or baked into an OpenCode image. Do not edit them manually. After changing an agent source, run `yarn generate` again and restart OpenCode because agent files are loaded when a session starts.

The current generated set contains:

- deal activity scan,
- company researcher,
- deal health check,
- revenue estimator,
- web researcher,
- support resolution advisor,
- deal qualification, resolution, and pipeline-stage skills.

### Local hybrid development

Pass the enterprise flags to the dev-runner process so its pre-server generator and the Next.js runtime resolve the same module set:

```bash
OM_ENABLE_ENTERPRISE_MODULES=true OM_ENABLE_ENTERPRISE_MODULES_AGENTS=true yarn dev
```

In another terminal, start OpenCode through the opt-in Compose profile:

```bash
docker compose --profile agents up -d opencode
```

The development script provisions an MCP API key in `.mercato/mcp-shared/`. The OpenCode container reads that key from the read-only bind mount and connects to the host MCP server at `http://host.docker.internal:3001/mcp` by default.

Check the OpenCode runtime:

```bash
curl --fail --user "opencode:${OPENCODE_PASSWORD:-}" http://localhost:4096/global/health
```

After regeneration, restart the runtime:

```bash
docker compose --profile agents restart opencode
```

The application uses `http://localhost:4096` by default. Set `OPENCODE_URL` only when OpenCode is reachable at a different address.

### Full-container deployment

The full application Compose files contain dedicated `opencode` and `mcp` services in the `agents` profile:

Compose forwards both enterprise flags into the production image build and into the `app` and `mcp` runtime services. This keeps generated routes/entities and runtime module registration consistent. The full-stack app connects to `http://opencode:4096` over the Compose network and receives the same `OPENCODE_PASSWORD` that Compose maps to the server's `OPENCODE_SERVER_PASSWORD`.

```bash
docker compose --profile agents -f docker-compose.fullapp.yml up -d --build
```

The MCP service provisions its API key into a shared volume, and OpenCode waits for MCP health before reading the key. Do not set a stale `MCP_SERVER_API_KEY`, because an environment value takes precedence over the generated file and can break MCP authentication.

The production Compose service does not publish OpenCode port `4096` to the host. If an operator intentionally exposes OpenCode, restrict network access and set `OPENCODE_PASSWORD`; Compose passes it to `opencode serve` as `OPENCODE_SERVER_PASSWORD`, and the application uses the same value for authenticated requests. Without it, OpenCode's HTTP boundary is unauthenticated.

### ACL synchronization

Agent Orchestrator permissions are stored in PostgreSQL role and role-ACL rows. They are runtime database state and are not propagated by Git.

New tenants receive the enabled modules' `defaultRoleFeatures` during tenant initialization. Existing tenants must be synchronized after Agent Orchestrator is enabled or after its default ACL features change:

```bash
yarn mercato auth sync-role-acls --tenant <tenant-id>
```

The command is idempotent and additive. Omit `--tenant` only when the intended operation is to synchronize every tenant in that environment.

Network egress is a separate capability. File agents using web search or URL retrieval require the relevant `agent_orchestrator.web_search` / `agent_orchestrator.web_fetch` grants; keep those grants limited to intended roles and tenants.

### What Git does and does not propagate

Git propagates:

- the `api_keys` module registration and Agent Orchestrator environment gates declared in `src/modules.ts`,
- TypeScript configuration required for file-agent sources,
- generated OpenCode agent and skill artifacts,
- Docker/OpenCode wiring and this runbook.

Git does not propagate:

- `.env` values or AI provider secrets,
- generated MCP API keys in `.mercato/`,
- PostgreSQL ACL assignments or tenant data,
- running containers or an already-generated local `.mercato/` registry.

Each deployed environment must therefore set the required environment values, run `yarn generate` as part of its build/start lifecycle, and synchronize ACLs for existing tenants.

### Troubleshooting

- `403` on Agent Orchestrator pages or APIs: run `auth sync-role-acls` for the affected tenant and confirm the user's role has the required feature.
- `relation "api_keys" does not exist`: enable the tracked `api_keys` module and apply the shipped database migrations before provisioning MCP.
- OpenCode cannot call MCP: inspect `docker compose logs opencode`, verify the MCP health endpoint and key file, then restart OpenCode.
- An agent or skill is missing: confirm both enterprise flags were set during `yarn generate`, regenerate, and restart OpenCode.
- Web research tools are denied: verify the dedicated web-search ACL grant and the deployment's web-search adapter policy.
