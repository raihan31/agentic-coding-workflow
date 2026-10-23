# Graph Report - game-studio  (2026-10-23)

## Corpus Check
- 95 files · ~59,334 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 8 file(s) not represented in the graph (top: (none) 2, .Dockerfile 2, .example 1)

## Summary
- 859 nodes · 2308 edges · 47 communities (31 shown, 16 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 48 edges (avg confidence: 0.89)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Project Backlog & Orchestrator Core
- Evaluation Cases & Testing Fixtures
- Web Dashboard & React Client
- Database & Postgres Storage
- Agent Adapters & LLM Roles
- Core Node.js System Utilities
- Kubernetes & Helm Infrastructure
- Container Sandbox & Agent Runtime
- Security Scanning & Policy Enforcement
- HTTP Notification & Webhook Dispatch
- Temporal Activity & Worker Execution
- Fastify REST API & Static Serving
- Temporal Client & Workflow Control
- Core Production Package Dependencies
- Build Scripts & CI Automation
- Development Dependencies & Tooling
- Process Management & Signal Cancellation
- Package Manifest & Project Metadata
- Automated Checks & Verification Runners
- Configuration Schema & CLI Parsing
- Web Frontend TypeScript Configuration
- Custom Eval Provider & Harness
- Root TypeScript Configuration
- OpenTelemetry Node SDK & Exporters
- Workflow Integration Tests
- Document Ingestion & File Parsing
- Temporal Workflow Orchestration Engine
- OpenTelemetry Metrics Exporter
- Docker Compose Local Stack Services
- Text Toolkit PRD & Specifications
- Document Extraction & Conversion Helpers
- ESLint Linting Configuration
- Logging & Observability Logging
- Node Engine Requirements
- Kubernetes Egress Proxy Pod
- LiteLLM Virtual Key Service

## God Nodes (most connected - your core abstractions)
1. `analyzeProject()` - 34 edges
2. `execute()` - 31 edges
3. `runProject()` - 31 edges
4. `createActivities()` - 27 edges
5. `buildServer()` - 24 edges
6. `openSession()` - 23 edges
7. `readProject()` - 22 edges
8. `attemptTask()` - 20 edges
9. `parseConfig()` - 19 edges
10. `scripts` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Claude Planner Role` --implements--> `runClaude()`  [INFERRED]
  README.md → src/adapters.ts
- `Codex Reviewer Role` --references--> `reviewJsonSchema()`  [INFERRED]
  README.md → src/config.ts
- `Document-Driven PRD/BRD Backlog Engine` --implements--> `runProject()`  [INFERRED]
  README.md → src/project.ts
- `Temporal Durable Workflow Engine` --implements--> `runWorker()`  [INFERRED]
  README.md → src/temporal/worker.ts
- `Agentic Multi-Agent Orchestrator` --implements--> `runWorkflow()`  [INFERRED]
  README.md → src/workflow.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Agentic Roles (Planner, Developer, Reviewer)** — readme_claude_planner, readme_codex_developer, readme_codex_reviewer [EXTRACTED 1.00]
- **Sandbox Isolation Stack** — readme_sandbox_container, readme_egress_proxy, deploy_compose_squid_service [INFERRED 0.95]

## Communities (47 total, 16 thin omitted)

### Community 0 - "Project Backlog & Orchestrator Core"
Cohesion: 0.05
Nodes (86): manage(), Document-Driven PRD/BRD Backlog Engine, zod, Agent, ClaudeStructured, Backlog, BacklogError, backlogJsonSchema() (+78 more)

### Community 1 - "Evaluation Cases & Testing Fixtures"
Cohesion: 0.05
Nodes (67): cases, config, Fixture, review(), ROOT, session(), USERS_BASE, Promptfoo Evaluation Suite (+59 more)

### Community 2 - "Web Dashboard & React Client"
Cohesion: 0.07
Nodes (71): react, @tanstack/react-query, api, ApiError, Backlog, FileInfo, getToken(), Guidance (+63 more)

### Community 3 - "Database & Postgres Storage"
Cohesion: 0.05
Nodes (38): pg, RateLimitedError, ApiOptions, ProjectRow, api(), clean(), main(), printRun() (+30 more)

### Community 4 - "Agent Adapters & LLM Roles"
Cohesion: 0.08
Nodes (35): Claude Planner Role, Codex Developer Role, AgentError, AgentOptions, AgentResult, ClaudeJson, ClaudeOptions, ClaudePlanner (+27 more)

### Community 5 - "Core Node.js System Utilities"
Cohesion: 0.10
Nodes (19): HostCheckRunner, parseConfig(), podManifest(), silentLogger, withAbortSignal(), auth, gitRepo(), seedProject() (+11 more)

### Community 6 - "Kubernetes & Helm Infrastructure"
Cohesion: 0.10
Nodes (20): Agentic Orchestrator Helm Chart, Kubernetes Orchestrator API Service, Kubernetes Sandbox Network Policy, Kubernetes Orchestrator Worker, CheckResult, KubernetesConfig, Mount, AgentCredentials (+12 more)

### Community 7 - "Container Sandbox & Agent Runtime"
Cohesion: 0.11
Nodes (21): Agent Sandbox Container, AgentRuntimeConfig, AgentRuntimeSchema, ContainerRunnerSchema, containerArgs(), ContainerSpec, Engine, ENGINE_ENV (+13 more)

### Community 8 - "Security Scanning & Policy Enforcement"
Cohesion: 0.13
Nodes (17): SecurityConfig, atLeast(), ContainerSecurityScanner, createSecurityScanner(), LOCKFILES, NO_SCANNER, parseGitleaks(), parseOsv() (+9 more)

### Community 9 - "HTTP Notification & Webhook Dispatch"
Cohesion: 0.12
Nodes (13): DEFAULT_TYPES, NOTABLE_STATUSES, notifierFromEnv(), redact(), sign(), SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature() (+5 more)

### Community 10 - "Temporal Activity & Worker Execution"
Cohesion: 0.10
Nodes (14): @temporalio/activity, @temporalio/testing, @temporalio/worker, TASK_QUEUE, bundlerOptions, runWorker(), workflowsPath, Activities (+6 more)

### Community 11 - "Fastify REST API & Static Serving"
Cohesion: 0.12
Nodes (20): fastify, @fastify/multipart, @fastify/static, @temporalio/client, buildServer(), eventBus(), EventRow, LiveCost (+12 more)

### Community 12 - "Temporal Client & Workflow Control"
Cohesion: 0.14
Nodes (21): Human Approval Gate, @temporalio/workflow, connectClient(), temporalAddress(), temporalNamespace(), ApproveInput, FailureType, GuideInput (+13 more)

### Community 13 - "Core Production Package Dependencies"
Cohesion: 0.09
Nodes (23): dependencies, fastify, @fastify/multipart, @fastify/static, mammoth, @opentelemetry/api, @opentelemetry/exporter-metrics-otlp-http, @opentelemetry/exporter-trace-otlp-http (+15 more)

### Community 14 - "Build Scripts & CI Automation"
Cohesion: 0.11
Nodes (19): GitHub Actions Continuous Integration, scripts, api, eval, eval:view, gen:schema, lint, sandbox:build (+11 more)

### Community 15 - "Development Dependencies & Tooling"
Cohesion: 0.11
Nodes (19): devDependencies, eslint, @eslint/js, jszip, react, react-dom, tailwindcss, @tailwindcss/vite (+11 more)

### Community 16 - "Process Management & Signal Cancellation"
Cohesion: 0.16
Nodes (11): abortAll(), AbortedError, abortHooks, abortScope, active, BASE_ENV, execute(), killTree() (+3 more)

### Community 17 - "Package Manifest & Project Metadata"
Cohesion: 0.12
Nodes (16): name, private, type, version, eslint, jszip, pino-pretty, react-dom (+8 more)

### Community 18 - "Automated Checks & Verification Runners"
Cohesion: 0.21
Nodes (6): capture(), ContainerCheckRunner, ContainerConfig, createCheckRunner(), CheckRunnerConfig, runner()

### Community 19 - "Configuration Schema & CLI Parsing"
Cohesion: 0.17
Nodes (11): argv, CheckRunnerSchema, ConfigSchema, envName, Finding, FindingSchema, HostRunnerSchema, KubernetesRunnerSchema (+3 more)

### Community 20 - "Web Frontend TypeScript Configuration"
Cohesion: 0.17
Nodes (11): compilerOptions, jsx, lib, module, moduleResolution, noEmit, skipLibCheck, strict (+3 more)

### Community 21 - "Custom Eval Provider & Harness"
Cohesion: 0.18
Nodes (5): AgenticCaseProvider, here, @tailwindcss/vite, vite, @vitejs/plugin-react

### Community 22 - "Root TypeScript Configuration"
Cohesion: 0.18
Nodes (10): compilerOptions, esModuleInterop, module, moduleResolution, noEmit, skipLibCheck, strict, target (+2 more)

### Community 23 - "OpenTelemetry Node SDK & Exporters"
Cohesion: 0.20
Nodes (3): createInstruments(), telemetryEnabled(), tracer

### Community 24 - "Workflow Integration Tests"
Cohesion: 0.33
Nodes (7): agent(), Calls, git(), makeRepo(), PASS, setup(), writeOut()

### Community 25 - "Document Ingestion & File Parsing"
Cohesion: 0.29
Nodes (3): documentFormat, FORMATS, LoadedDocument

### Community 26 - "Temporal Workflow Orchestration Engine"
Cohesion: 0.43
Nodes (7): Temporal Durable Workflow Engine, resumeProjectRun(), submitProject(), describe(), failureType(), projectWorkflow(), taskWorkflow()

### Community 27 - "OpenTelemetry Metrics Exporter"
Cohesion: 0.29
Nodes (7): @opentelemetry/exporter-metrics-otlp-http, @opentelemetry/exporter-trace-otlp-http, @opentelemetry/resources, @opentelemetry/sdk-metrics, @opentelemetry/sdk-node, @opentelemetry/semantic-conventions, initTelemetry()

### Community 28 - "Docker Compose Local Stack Services"
Cohesion: 0.33
Nodes (6): Docker Compose Local Infrastructure, OpenTelemetry Collector Container, Squid Egress Allowlist Container, Temporal Dev Service Container, Squid Egress Allowlist Proxy, OpenTelemetry Tracing & Metrics

### Community 29 - "Text Toolkit PRD & Specifications"
Cohesion: 0.40
Nodes (5): Slugify Task Specification, Slugify Function Requirement, Text Toolkit PRD Specification, Truncate Function Requirement, Word Count Function Requirement

### Community 30 - "Document Extraction & Conversion Helpers"
Cohesion: 0.50
Nodes (4): mammoth, turndown, unpdf, loadDocument()

## Knowledge Gaps
- **25 isolated node(s):** `@types/node`, `@types/pg`, `@types/react`, `@types/react-dom`, `@types/turndown` (+20 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 319 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `zod` connect `Project Backlog & Orchestrator Core` to `Package Manifest & Project Metadata`, `Configuration Schema & CLI Parsing`, `Agent Adapters & LLM Roles`?**
  _High betweenness centrality (0.112) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `analyzeProject()` (e.g. with `.callAgent()` and `.saveBacklog()`) actually correct?**
  _`analyzeProject()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `@types/node`, `@types/pg`, `@types/react` to the rest of the system?**
  _25 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Project Backlog & Orchestrator Core` be split into smaller, more focused modules?**
  _Cohesion score 0.05369946605644546 - nodes in this community are weakly interconnected._
- **Why does `react` connect `Web Dashboard & React Client` to `Package Manifest & Project Metadata`?**
  _High betweenness centrality (0.082) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `runProject()` (e.g. with `Document-Driven PRD/BRD Backlog Engine` and `.close()`) actually correct?**
  _`runProject()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Should `Evaluation Cases & Testing Fixtures` be split into smaller, more focused modules?**
  _Cohesion score 0.05132317562149158 - nodes in this community are weakly interconnected._