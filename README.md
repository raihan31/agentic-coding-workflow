# Claude Planner + Codex Developer + Codex Reviewer

A runnable **Node.js/TypeScript** multi-agent orchestrator. Every role is a fresh process in its **own sandbox container**, working on a detached Git worktree: Claude plans (worktree mounted read-only), Codex implements (worktree read-write), deterministic checks run in a **network-less container**, and a fresh Codex reviewer (read-only mount) returns schema-validated JSON. Failures feed a bounded repair loop; success stops at a human approval gate. Runs are traced and metered with OpenTelemetry.

```
            orchestrator (host)  ──OTLP──►  otel-collector ─► Jaeger (traces) · Prometheus ─► Grafana
                 │ docker run, per agent call                 ▲
   ┌─────────────▼──────────── agentic-sandbox (internal, no route out) ─────────┐
   │  planner / developer / reviewer containers ── agent OTel ───────────────────┘│
   │     read-only root · tmpfs HOME · cap-drop ALL · explicit mounts only       │
   │        │ HTTPS_PROXY                     │ (gateway mode)                    │
   │        ▼                                 ▼                                   │
   │  agentic-egress (Squid allowlist) ──►  agentic-litellm (virtual keys, budgets)
   └──────────┼──────────────────────────────────┼───────────────────────────────┘
              ▼ internet (allowlisted domains)   ▼ provider APIs
```

## Prerequisites
- Node.js 22+ and npm, Git, Docker (or Podman)
- Claude Code CLI and Codex CLI logged in (`claude auth login`, `codex login`)
- A clean, **committed** target Git repository

```bash
npm install
npm run verify          # typecheck + lint + tests (container tests skip without Docker)
npm run sandbox:build   # agent image: agentic-agent:local (pinned Claude Code + Codex CLIs)
npm run stack:up        # egress proxy, Temporal, Postgres, OTel collector, Jaeger, Prometheus, Grafana
```

### Credentials

Agents in containers cannot use your Mac keychain, so pick a mode (`credentials` in the config):

- **`subscription`** (default): your existing plans.
  - Claude: run `claude setup-token` once and `export CLAUDE_CODE_OAUTH_TOKEN=...` (or set `ANTHROPIC_API_KEY`).
  - Codex: `~/.codex/auth.json` is copied into a throwaway per-run `CODEX_HOME` (mode 600, deleted after the run); your real file is never touched.
  - Cost: Claude's reported cost plus `plannerBudgetUsd` (`--max-budget-usd`); Codex reports tokens only.
- **`gateway`**: production path through LiteLLM. `cp deploy/.env.example deploy/.env`, fill provider keys and `LITELLM_MASTER_KEY`, then `npm run stack:up:gateway` and `export LITELLM_MASTER_KEY=...`. Each run gets a virtual key (`max_budget = budgetUsd`, alias `agentic-<runId>`) that is revoked afterwards; agents never see provider keys. When gateway spend reaches the budget the run stops with `budget_exceeded`, and the reported cost is the gateway's measured spend.

Secrets reach containers via the engine's environment (`-e NAME`), never via argv.

### Telemetry

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` to enable it. The orchestrator exports traces (`agentic.run` → `agentic.attempt` → `agent.*`, `agentic.checks`) and delta metrics; Claude Code and Codex export their own telemetry from inside the sandbox to the collector. Logs are JSON on stderr (pretty on a TTY; `LOG_FORMAT=json` to force), each line carrying `run_id` and `trace_id`; the trace id is also in `metadata.json`.

- Grafana: http://localhost:3000 (dashboard *Agentic orchestrator*), Jaeger: http://localhost:16686, Prometheus: http://localhost:9090
- Egress audit log: `docker exec agentic-egress tail -f /var/log/squid/access.log`

## Run

```bash
# Optional plan-approval gate: plan first, review runs/run-*/plan.md, then implement with it.
npm start -- run --repo /abs/path/to/repo --requirement ./examples/requirement.md --config ./examples/workflow.json --plan-only
npm start -- run --repo /abs/path/to/repo --requirement ./examples/requirement.md --config ./examples/workflow.json --plan runs/run-XXXX/plan.md

# Or plan and implement in one go:
npm start -- run --repo /abs/path/to/repo --requirement ./examples/requirement.md --config ./examples/workflow.json

# Remove worktrees of runs older than 7 days (add --purge to delete artifacts too, --all for every run):
npm start -- clean
```

Progress goes to stderr; the final `RunResult` JSON (status, attempts, tokens, cost and its source) goes to stdout. Exit code: 0 = `awaiting_human_approval` or `plan_ready`, 1 = `changes_required`, `budget_exceeded` or error, 130 = interrupted.

## Document-driven projects (BRD / PRD / SRS / handoff)

Give the orchestrator a requirements document; it turns it into a backlog, then builds the backlog task by task.

```bash
# 1. Analyze: document -> requirements, tasks, open questions (runs/proj-*/backlog.md + backlog.json)
npm start -- project analyze --repo /abs/path/to/repo --document ./examples/sample-prd.md --config ./examples/workflow.json

# 2. Review backlog.md. Edit backlog.json if needed (drop/merge tasks, fix acceptance criteria) and
#    answer blocking questions by filling their "answer" field.

# 3. Approve by running: tasks execute in dependency order on branch agentic/proj-*
npm start -- project run --project runs/proj-xxxx

npm start -- project status --project runs/proj-xxxx
```

- **Formats:** `.md`, `.txt`, `.pdf` (text extracted per page; the analyst also gets the original, so tables and scanned pages still reach Claude), `.docx` (converted to Markdown).
- **Analyst:** Claude with read-only tools reads the document and the repository and returns a backlog that Claude Code validates against a JSON schema (`--json-schema`). The orchestrator then checks it: unique IDs, resolvable links, no dependency cycles, every *must* requirement covered, every task linked to a requirement and carrying acceptance criteria, at most `project.maxTasks`. An invalid backlog gets one retry with the problems listed.
- **Per task:** the existing plan → implement → gates → review → repair loop runs with a task brief: the task, its acceptance criteria, the requirements it implements, product-owner answers, what's already done and what's planned later, plus the full document (read-only). A passing task is committed to the project branch (`T-003: title`, with `Task:` and `Requirements:` trailers). A failing task's changes are discarded, its dependents are marked `blocked`, and independent tasks continue.
- **Resume:** `project run` again retries failed and blocked tasks and skips done ones. Tasks added to `backlog.json` are picked up. One runner per project (`run.lock`).
- **Finish:** integration checks run on the whole branch, then `report.md` and `traceability.json` map each requirement to its tasks and commits (`implemented`, `partial`, `not_implemented`, `not_planned`). The project ends as `completed` (ready for your PR review), `partial`, `integration_failed`, `budget_exceeded` or `failed`.
- In gateway mode the budget covers each whole `analyze` or `run` invocation.

Project layout: `runs/proj-*/{state.json, config.json, input/, backlog.{json,md}, tasks/T-*/run-*/, integration-checks.json, traceability.json, report.md, worktree/}`.

## Service mode: durable runs + web UI

For anything longer than a quick experiment, run projects as **Temporal workflows**: they survive crashes and restarts, wait durably for your approval and for provider rate limits, and can be paused, resumed or cancelled. State is mirrored to Postgres and shown live in the web UI.

```bash
npm run stack:up                     # + Temporal (UI :8233) and Postgres (:55432)
export DATABASE_URL=postgres://agentic:agentic@localhost:55432/agentic
npm run worker                       # executes workflows; runs on the host (it launches sandbox containers)
npm run ui:build && npm run api      # http://127.0.0.1:8787
```

Open http://127.0.0.1:8787, upload a document and give a repository path. The **Backlog** tab is the approval gate: answer blocking questions there and click *Approve & start build*. **Tasks** shows each task's live timeline (agent calls with duration, tokens and cost, check results, review verdicts, repair attempts) and its artifacts (plan, diffs, check output, review JSON, logs). **Activity** is the full event feed. The same actions are available from the CLI:

```bash
npm start -- project submit --repo /abs/repo --document ./prd.pdf --config ./examples/workflow.json
npm start -- project approve --id proj-xxxx --answer Q-001="Use PostgreSQL 16"
npm start -- project pause|resume|cancel --id proj-xxxx
npm start -- project guide --id proj-xxxx --task T-003 --guidance "Totals include 20% VAT"   # answer an escalation
npm start -- project rerun --id proj-xxxx      # run a stopped project again: done tasks kept, the rest retried
npm start -- project status --id proj-xxxx
```

How it behaves:
- **Workflow per project, child workflow per task.** Planning and each implement → check → review attempt are separate activities, so a crash redoes one attempt, not the task. Activities heartbeat; a dead worker is detected within two minutes and its work moves to another worker. Cancelling kills that activity's agent processes and containers.
- **Rate limits** (for example a ChatGPT/Claude plan's usage cap) set the project to `rate_limited` and the workflow sleeps durably (`rateLimitRetryMinutes`, default 30) before retrying the same step, for up to `rateLimitMaxWaitHours` (default 24). No partial work is lost or redone.
- **Budget** (gateway mode) ends the run as `budget_exceeded`; the running task's partial work is discarded and it reruns next time.
- **Pause** takes effect before the next task; the running task finishes first.
- **Run again** (UI button or `project rerun`) starts a new run of a project that ended `failed`, `partial`, `rate_limited`, `budget_exceeded`, `cancelled` or `needs_attention`: no re-analysis, committed tasks stay, the rest are retried.
- If analysis cannot even start (for example missing agent credentials on the worker), the project still appears in the UI as `failed` with the reason.
- **Workflow versioning:** changes to workflow code that affect running workflows are guarded with Temporal `patched()`; replaying recorded histories against new code before deploying is the check (see *Development*).
- The local `project analyze` / `project run` commands drive the same steps in-process, without Temporal.

API: `GET /api/projects`, `GET /api/projects/:id`, `GET /api/projects/:id/events`, `GET /api/stream?project=` (SSE), task artifacts under `/api/projects/:id/tasks/:task/files`, and `POST /api/projects` (multipart, or JSON `{repo, config?, document:{name, content, encoding?:"base64"|"utf8"}}`), `/approve`, `/pause`, `/resume`, `/cancel`, `/rerun`, `/deliver`, `/tasks/:task/guide` (`{action:"retry"|"skip", guidance?}`). The repository is validated when the project is created (it must be the root of a clean git work tree). It listens on localhost only unless `AGENTIC_API_TOKEN` is set (then every request needs `Authorization: Bearer`). Set `AGENTIC_REPO_ROOTS=/path/a:/path/b` to restrict which repositories projects may target. **The API starts agents on repositories: never expose it without a token, and prefer a reverse proxy with TLS.**

## Delivery: branch push and draft pull request

When a project completes, the orchestrator can push the project branch and open a **draft pull request** whose description is the traceability report (tasks with commits and reviewer summaries, requirement coverage, product-owner clarifications, out-of-scope items, integration result and spend). It is **off by default** because it publishes to your remote:

```json
"delivery": {
  "push": true,
  "remote": "origin",
  "pullRequest": { "enabled": true, "draft": true, "tokenEnv": "GITHUB_TOKEN" }
}
```

- The token is read from the worker's (or API's) environment and handed to git through environment-based config (`http.extraheader`), never through argv; agents never see it. SSH remotes use your SSH agent.
- `base` defaults to the repository's default branch; `repository` (`owner/name`) defaults to parsing the remote URL; `apiUrl` supports GitHub Enterprise.
- Delivering again (after more commits) pushes them and **updates** the existing PR instead of opening another.
- A delivery failure is recorded (`delivery.failed` event, shown in the UI) and never changes the project result; retry with `npm start -- project deliver --id proj-xxxx` or the UI's *Push & open PR* button.
- Merging stays a human decision on GitHub.

## When a task fails: the manager agent

When a task has used up its repair attempts, a **manager agent** (Claude, read-only tools, schema-enforced output) inspects the failed work in the worktree and the task's artifacts (plans, check output, diffs, reviews) and decides:

| Decision | What happens |
|---|---|
| `retry` | Its guidance (root cause, approach, pitfalls) is added to the task brief; the task is re-planned and rebuilt from a clean tree. |
| `split` | The task is replaced by 2–5 smaller sequential subtasks (`T-003.1`, `T-003.2`...). They inherit its requirement links and dependencies; tasks that depended on it wait for the last subtask. |
| `escalate` | The task waits for you with one specific question (UI card on the project page, `project guide`, or `POST .../tasks/:task/guide`). Your answer is added to the brief and the task restarts; or you skip it. |
| `skip` | The task fails as before (its dependents are blocked), with the manager's reason recorded. |

It is bounded: `manager.maxInterventions` decisions per task per run (default 2), an invalid decision gets one corrective retry and then falls back to `skip`, and `allowSplit` / `allowEscalate` restrict its options. Decisions are events (`manager.decision`, `task.split`, `task.escalated`, `task.guided`), artifacts (`manager-N.json`) and a metric (`agentic_manager_decisions_total`). Under the local driver there is no one to wait for, so an escalated task ends the run as `needs_attention`; answer with `project guide --project <dir> ...` and run again.

## Security scanners

Deterministic security gates run after the checks pass and before the LLM review, **only on the files the task changed**, in pinned containers:

```json
"security": { "scanners": ["gitleaks", "semgrep", "osv"], "failOn": "high" }
```

- **gitleaks** (secrets; offline; every hit is critical, secrets are redacted in reports). **semgrep** (SAST; `semgrepConfig` defaults to the `p/default` registry pack, which is downloaded; absolute paths to local rule files run fully offline). **osv** (dependencies; a changed lockfile is compared with its version at the task's base commit, so only *newly introduced* vulnerabilities count; queries osv.dev).
- Findings at or above `failOn` reject the attempt with the findings as repair feedback; lower ones are passed to the reviewer.
- The developer cannot switch scanners off: scanner configuration and ignore files it adds or changes are reported as findings and not used, inline `gitleaks:allow` / `nosemgrep` comments are ignored, and only regular files are scanned (symlinks are not followed).
- A scanner that cannot run stops the task (fail closed) instead of being blamed on the developer.

## Notifications, intake and n8n

**Outbound webhooks.** Set `AGENTIC_WEBHOOK_URLS` (comma-separated) on the worker and the orchestrator POSTs notable events: a human must act (`needs_answers`, `backlog_ready`, `needs_attention`, `task.escalated`) or a run ended (`completed`, `failed`, delivery...). `AGENTIC_WEBHOOK_EVENTS` selects other types (`*` = all), `AGENTIC_PUBLIC_URL` adds UI links. Requests carry `x-agentic-signature: sha256=HMAC(AGENTIC_WEBHOOK_SECRET, "<x-agentic-timestamp>.<body>")`; reject signatures older than five minutes. Delivery is queued, retried on 5xx/timeouts, and never blocks or fails a run.

**Intake.** Anything that can POST JSON can start a project: `POST /api/projects` with `{repo, document:{name, content, encoding:"base64"}}` and the API token.

**n8n (optional).** n8n fits at this edge (chat/email/ticket routing, approvals from Slack, document intake from Drive or forms). It is **fair-code (Sustainable Use License), not OSI open source**; check that it suits your use. Start it with `npm run stack:up:n8n` (http://localhost:5678) and import the two example workflows from `examples/n8n/`:

```bash
docker exec agentic-n8n n8n import:workflow --input=/workflows/agentic-events.json
docker exec agentic-n8n n8n import:workflow --input=/workflows/agentic-intake.json
docker exec agentic-n8n n8n publish:workflow --id=agenticEvents01 && docker exec agentic-n8n n8n publish:workflow --id=agenticIntake01
docker restart agentic-n8n
# worker: AGENTIC_WEBHOOK_URLS=http://localhost:5678/webhook/agentic-events AGENTIC_WEBHOOK_SECRET=<same as deploy/.env>
```

`agentic-events` verifies the signature (401 otherwise), classifies the event and routes "needs a human" vs "announce" to placeholder nodes you replace with Slack, Teams, email or a ticket. `agentic-intake` takes `{repo, name, content}` and creates a project through the API. Protect the intake webhook (Header Auth credential or private network) before exposing n8n.

## Evals

`npm run eval` runs the agents themselves (real CLIs, production prompts and parsers) on fixture repositories with known answers, with [promptfoo](https://promptfoo.dev) as the harness (`evals/promptfooconfig.yaml`, cases in `evals/cases.ts`): the reviewer must reject a SQL injection and pass a clean implementation, the manager must retry a diagnosable failure with the right fix and escalate an unanswerable product question, and the analyst must turn the sample PRD into a valid backlog covering every requirement. Run it when changing prompts, models or parsers (about $1–2 and three minutes per run); `npm run eval:view` opens the results. `EVAL_REVIEWER_MODEL`, `EVAL_MANAGER_MODEL` and `EVAL_ANALYST_MODEL` compare models.

## Kubernetes (Helm)

`deploy/helm/agentic-orchestrator` runs the worker, API/UI and egress proxy in a cluster, with **every agent call and check as its own pod**:

```bash
docker build -f deploy/orchestrator.Dockerfile -t <registry>/agentic-orchestrator:0.1.0 .
docker build -f deploy/agent.Dockerfile -t <registry>/agentic-agent:0.1.0 deploy
kubectl create secret generic agentic-database --from-literal=DATABASE_URL=postgres://...
kubectl create secret generic agentic-credentials --from-literal=AGENTIC_API_TOKEN=... --from-literal=CLAUDE_CODE_OAUTH_TOKEN=... --from-file=codex-auth.json=$HOME/.codex/auth.json
helm install agentic deploy/helm/agentic-orchestrator --set image.repository=<registry>/agentic-orchestrator --set agentImage=<registry>/agentic-agent:0.1.0 --set temporal.address=<temporal-frontend>:7233
```

- **Sandbox pods** (`agentRuntime` / `checkRunner` type `kubernetes`): `runtimeClassName: gvisor` by default (GKE Sandbox; or your gVisor/Kata RuntimeClass), non-root, read-only root, all capabilities dropped, seccomp `RuntimeDefault`, no service-account token. Role-based access is enforced with `subPath` mounts of a shared volume (read-only worktree for planner and reviewer, read-write for the developer). Credentials go into a per-call Secret, referenced by name and garbage-collected with the pod.
- **NetworkPolicies:** agent and setup pods may reach only DNS and the egress proxy (allowlisted domains); check pods get no network at all; the proxy accepts only sandbox pods. Many CNIs apply policy to a new pod a few seconds after it starts, so a sandbox command waits for the worker's go-ahead (`kubernetes.networkSettleMs`, default 5 s) before running; set it to 0 only with a CNI that enforces policy before containers start.
- **Shared volume:** repositories (`/data/repos`, the only place the API accepts), project runs and sandbox I/O live on one ReadWriteMany volume mounted at the same path everywhere (Filestore, EFS, Azure Files, CephFS, NFS).
- **Not included:** Temporal (use the temporalio Helm chart or Temporal Cloud) and Postgres (managed). The worker's RBAC is limited to creating pods and short-lived Secrets in its namespace.

## Configuration (`workflow.json`, validated with zod)

| Key | Default | Meaning |
|---|---|---|
| `maxRepairs` | `2` | Repair attempts after the first (0–5). |
| `checks` | `[]` | argv arrays, never a shell. Adapt to the target repo. |
| `checkRunner` | container, `node:22-bookworm-slim` | `{type:"container", image, setup, setupNetwork, memory, cpus, pidsLimit, engine}` or `{type:"host", acknowledgeUnsafe:true}`. |
| `agentRuntime` | container, `agentic-agent:local` on `agentic-sandbox` | `{type:"container", image, network, proxy, memory, cpus, pidsLimit, engine}` or `{type:"host", acknowledgeUnsafe:true}` (agents on the host, CLI sandboxes only). |
| `credentials` | `{mode:"subscription"}` | or `{mode:"gateway", url, internalUrl, masterKeyEnv, budgetUsd, keyTtl}`. |
| `telemetry` | agents on | `{agents, agentEndpoint}`: whether agent CLIs export OTel, and where (defaults to the compose collector). |
| `protectedPaths` | `[]` | Globs of existing files the developer may not modify, delete or rename (new files are allowed). |
| `models` | CLI defaults | `{analyst, planner, developer, reviewer, manager}` model pins. |
| `manager` | on, 2 decisions | `{enabled, maxInterventions, allowSplit, allowEscalate, budgetUsd}`; see *When a task fails*. |
| `security` | no scanners | `{scanners:["gitleaks","semgrep","osv"], failOn, semgrepConfig, images, engine, timeoutMs}`; see *Security scanners*. |
| `kubernetes` | `/data` on `agentic-data` | `{namespace, volume:{claimName, mountPath}, runtimeClassName, proxy, serviceAccountName, imagePullSecrets, nodeSelector, networkSettleMs}` for `kubernetes` runtimes. |
| `plannerBudgetUsd` | none | Hard cap passed to `claude --max-budget-usd`. |
| `timeouts` | 30m / 15m / 30m / 30m / 10m / 10m | `analyzeMs`, `planMs`, `developerMs`, `reviewerMs`, `checkMs`, `managerMs`. |
| `agentEnv` | `[]` | Extra host env var names forwarded to agent CLIs (never to checks). |
| `analystBudgetUsd` | none | Hard cap for the analyst call (`--max-budget-usd`). |
| `project` | 40 tasks, `agentic/` | `{maxTasks, gitAuthor:{name,email}, branchPrefix}`. |
| `delivery` | off | `{push, remote, pullRequest:{enabled, draft, base, repository, apiUrl, tokenEnv}}`; see *Delivery*. |

Container `setup` commands (e.g. `npm ci --ignore-scripts`) run with network before each attempt's checks; checks always run with `--network none`, `--cap-drop ALL`, `no-new-privileges`, PID/memory/CPU limits, as your UID. The worktree's `.git` link is not mounted, so checks cannot run git commands.

## Workflow

1. Verify the repo root (symlink-safe) is clean; fail fast if the container engine/image is unavailable.
2. `git worktree add --detach` at the recorded base SHA, with repo hooks and `core.fsmonitor` disabled.
3. Claude plans (or a provided, human-reviewed plan is used).
4. Each attempt: Codex implements → **gates in cost order**: non-empty diff → protected paths → checks (container) → security scanners (if configured) → LLM review (only when all deterministic gates pass; one retry on malformed output).
5. Any failure becomes bounded feedback (`feedback-N.md`) for the next attempt. A failing developer process is also repairable.
6. Success = `awaiting_human_approval`. Nothing is committed, pushed or merged.

Artifacts in `runs/run-*/`: `metadata.json` (config, base SHA, prompt version), `plan.md`, `planner.log`, `developer-N.{md,log}`, `status-N.txt`, `checks-N.json`, `diff-N.patch`, `review-N.{json,log}`, `review-parsed-N.json`, `feedback-N.md`, `result.json`, `error.txt`.

## Inspect and ship

```bash
git -C runs/run-XXXX/worktree status --short
git -C runs/run-XXXX/worktree diff              # new files are included (intent-to-add)
git -C runs/run-XXXX/worktree switch -c feat/agent-implementation   # then commit/push yourself
npm start -- clean --all                         # when done
```

## Security model and limits
- **Per-agent sandbox:** every agent call is a fresh container with read-only root, tmpfs `HOME`, `--cap-drop ALL`, `no-new-privileges`, PID/memory/CPU limits, running as your UID. Mounts are explicit and role-based: planner and reviewer get the worktree and git dir **read-only**; the developer gets the worktree read-write, its own worktree admin dir read-write, and the repository's git dir read-only. Run artifacts are not mounted (each phase gets a private `io/<phase>` dir).
- **Network:** the sandbox network has no route out; the only exit is the Squid proxy, which allows HTTPS `CONNECT` on port 443 to the domains in `deploy/squid/allowlist.txt` and logs every request. Checks run with `--network none`.
- Codex's own Landlock sandbox cannot nest inside a container, so in containers Codex runs with `danger-full-access` and the container is the boundary. Host mode (`agentRuntime.type: "host"`) keeps the CLI sandboxes and must be acknowledged.
- The container isolates at the kernel-namespace level, not a VM. For hostile code use the Kubernetes runtime with gVisor or Kata (`sandbox.runtimeClassName`).
- Agents and checks receive an **allowlisted environment** plus per-agent credentials; host secrets are not forwarded.
- Timeouts and Ctrl+C kill whole process trees (SIGTERM → SIGKILL) and force-remove agent and check containers.
- Untrusted text (requirement, plan, diff, feedback) is delimited and marked as data in prompts. This reduces but does not eliminate prompt-injection risk; use `--plan-only` + human review for sensitive work.
- LLM reviewers miss defects. Keep human sign-off and CI; enable the security scanners.

## Development

```bash
npm run verify            # typecheck (server + web), lint, tests (Postgres/Temporal/container tests skip when unavailable)
npm run eval              # agent evals (real LLM calls)
helm lint deploy/helm/agentic-orchestrator
```

Before deploying workflow code changes, replay the histories of running workflows against the new code (`Worker.runReplayHistory`); a nondeterminism error means the change needs a `patched()` guard.
