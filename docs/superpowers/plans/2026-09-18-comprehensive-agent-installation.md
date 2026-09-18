# Comprehensive Agent Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a reproducible Agent Orchestrator and OpenCode installation with generated file agents, operator documentation, ACL synchronization instructions, and verified container wiring.

**Architecture:** Keep enterprise module activation environment-driven through the existing `src/modules.ts` gates. Commit generator-owned OpenCode agent and skill artifacts because OpenCode consumes them from bind mounts or the production image, while keeping secrets and tenant ACL rows outside Git. Reuse the existing Compose `agents` profile and MCP key provisioning instead of introducing parallel configuration.

**Tech Stack:** Open Mercato 0.8.0, Node.js 24, Yarn 4, TypeScript, Docker Compose, OpenCode, MCP, PostgreSQL ACL storage.

**Spec:** `node_modules/@open-mercato/enterprise/src/modules/agent_orchestrator/AGENTS.md`

## Global Constraints

- Keep agents propose-only and preserve the generated OpenCode tool allowlists.
- Keep provider credentials, MCP API keys, `.env`, and tenant ACL rows outside Git.
- Run `yarn generate` after file-agent source changes and commit `docker/opencode/agents/**` plus `docker/opencode/skills/**`.
- Existing tenants require `yarn mercato auth sync-role-acls --tenant <tenant-id>` after activation.
- Apply database migrations only with explicit operator approval; never generate or edit shipped module migrations.

---

### Task 1: Reproducible Agent Artifacts and TypeScript Configuration

**Files:**
- Modify: `.gitignore`
- Modify: `tsconfig.json`
- Modify: `src/modules.ts`
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.fullapp.yml`
- Modify: `docker-compose.fullapp.dev.yml`
- Create: `docker/opencode/agents/deals_activity_scan.md`
- Create: `docker/opencode/agents/deals_company_researcher.md`
- Create: `docker/opencode/agents/deals_health_check_file.md`
- Create: `docker/opencode/agents/deals_revenue_estimator.md`
- Create: `docker/opencode/agents/deals_web_researcher.md`
- Create: `docker/opencode/agents/support_resolution_advisor.md`
- Create: `docker/opencode/skills/deal-qualification/SKILL.md`
- Create: `docker/opencode/skills/resolution-playbook/SKILL.md`
- Create: `docker/opencode/skills/stage-playbook/SKILL.md`

**Interfaces:**
- Consumes: `src/modules/agent_examples/agents/**` and the Open Mercato agent-files generator.
- Produces: OpenCode-native agent and skill files mounted by the existing Compose `agents` profile.

- [x] **Step 1: Keep `.pi/` local**

Add `.pi/` to `.gitignore`; verify with `git check-ignore -v .pi`.

- [x] **Step 2: Enable required modules and wire consistent build/runtime configuration**

Enable the core `api_keys` module required by MCP authentication. Forward both enterprise flags into production image generation and the full-stack app/MCP services. Map the shared project `OPENCODE_PASSWORD` to OpenCode's `OPENCODE_SERVER_PASSWORD`. Exclude `src/modules/**/agents/**/scripts/**`, `src/modules/**/agents/**/tools/**`, and `.mercato/generated/file-agents.generated.ts`; retain the orchestrator source root needed by generated types.

- [x] **Step 3: Regenerate the OpenCode artifacts**

Run with Node.js 24 and both enterprise flags enabled:

```bash
OM_ENABLE_ENTERPRISE_MODULES=true OM_ENABLE_ENTERPRISE_MODULES_AGENTS=true yarn generate
```

Expected: six files under `docker/opencode/agents/` and three skill directories under `docker/opencode/skills/`.

- [x] **Step 4: Validate generated registrations and Compose wiring**

Run:

```bash
OM_ENABLE_ENTERPRISE_MODULES=true OM_ENABLE_ENTERPRISE_MODULES_AGENTS=true yarn typecheck
docker compose --profile agents config --services
```

Expected: typecheck succeeds; Compose includes `opencode` and the infrastructure services without exposing secrets in rendered configuration output.

### Task 2: Operator Documentation and Deployment State

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: environment gates and `api_keys` registration in `src/modules.ts`, Compose `agents` profiles, `yarn generate`, shipped database migrations, and `auth sync-role-acls`.
- Produces: an English runbook for local hybrid development and full-container deployment.

- [x] **Step 1: Document prerequisites and activation**

Document Node.js 24, Docker Compose, enterprise licensing, provider credentials, the required modules and migrations, the two enterprise flags, generation, and the local `docker compose --profile agents up -d opencode` command.

- [x] **Step 2: Document production and security behavior**

Document the full-stack `agents` profile, MCP key auto-provisioning, `OPENCODE_PASSWORD` for exposed endpoints, disabled file tools by default, and restart requirements after regeneration.

- [x] **Step 3: Document ACL persistence explicitly**

State that `role_acls` rows and `.env` do not propagate through Git. Document per-tenant ACL synchronization for existing tenants and automatic defaults for newly initialized tenants.

- [x] **Step 4: Exercise the installed surfaces**

Regenerate, validate Compose, start the OpenCode profile when credentials and Docker runtime are available, and check `/global/health`; otherwise report the exact unavailable prerequisite.

- [x] **Step 5: Commit the focused installation**

Stage only `.gitignore`, `src/modules.ts`, `tsconfig.json`, `Dockerfile`, the three Compose files, `README.md`, this plan, and generator-owned OpenCode artifacts. Commit with an English subject and body covering module and environment activation, generated artifacts, database migrations, ACL persistence, tenant synchronization, OpenCode authentication, and operations.
