import { metrics, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import type { NodeSDK } from '@opentelemetry/sdk-node';

const NAME = 'agentic-orchestrator';
let sdk: NodeSDK | undefined;

/** Telemetry is opt-in through the standard OTEL_EXPORTER_OTLP_ENDPOINT variable. */
export function telemetryEnabled(): boolean {
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) && process.env.OTEL_SDK_DISABLED !== 'true';
}

export async function initTelemetry(version: string): Promise<void> {
  if (!telemetryEnabled() || sdk) return;
  const [{ NodeSDK }, { OTLPTraceExporter }, { OTLPMetricExporter, AggregationTemporalityPreference }, { PeriodicExportingMetricReader }, { resourceFromAttributes }, { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION }] = await Promise.all([
    import('@opentelemetry/sdk-node'), import('@opentelemetry/exporter-trace-otlp-http'), import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/sdk-metrics'), import('@opentelemetry/resources'), import('@opentelemetry/semantic-conventions'),
  ]);
  sdk = new NodeSDK({
    // Auto-detected process/host attributes (pid, argv with file paths) would become per-run Prometheus labels.
    autoDetectResources: false,
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? NAME, [ATTR_SERVICE_VERSION]: version }),
    traceExporter: new OTLPTraceExporter(),
    // Each CLI run is a short-lived process: export deltas and let the collector's deltatocumulative
    // processor merge runs into stable cumulative series.
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ temporalityPreference: AggregationTemporalityPreference.DELTA }), exportIntervalMillis: 10_000 }),
    instrumentations: [],
  });
  sdk.start();
}

export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown().catch(() => {});
  sdk = undefined;
}

function createInstruments() {
  const meter = metrics.getMeter(NAME);
  return {
    runs: meter.createCounter('agentic.runs', { description: 'Finished workflow runs, by status' }),
    tasks: meter.createCounter('agentic.tasks', { description: 'Finished project tasks, by status' }),
    projects: meter.createCounter('agentic.projects', { description: 'Project analyze/run invocations, by resulting status' }),
    attempts: meter.createHistogram('agentic.run.attempts', { description: 'Implementation attempts per run', advice: { explicitBucketBoundaries: [1, 2, 3, 4, 5, 6] } }),
    agentDuration: meter.createHistogram('agentic.agent.duration', { unit: 's', description: 'Agent invocation wall time, by role and outcome', advice: { explicitBucketBoundaries: [5, 15, 30, 60, 120, 300, 600, 1200, 1800] } }),
    rejections: meter.createCounter('agentic.gate.rejections', { description: 'Rejected attempts, by gate' }),
    managerDecisions: meter.createCounter('agentic.manager.decisions', { description: 'Manager agent decisions on failed tasks, by decision' }),
    cost: meter.createCounter('agentic.cost.usd', { description: 'LLM spend, by source (gateway or agent-reported)' }),
    tokens: meter.createCounter('agentic.tokens', { unit: '{token}', description: 'Tokens, by role and direction' }),
  };
}
let cached: ReturnType<typeof createInstruments> | undefined;
/** Created lazily: meters obtained before the SDK starts would stay no-ops forever. */
export function instruments(): ReturnType<typeof createInstruments> {
  return cached ??= createInstruments();
}

const tracer = trace.getTracer(NAME);
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return await tracer.startActiveSpan(name, { attributes }, async span => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Environment that makes Claude Code export its own metrics and events to the collector. */
export function claudeTelemetryEnv(endpoint: string, attributes: Record<string, string>): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_LOGS_EXPORT_INTERVAL: '5000',
    OTEL_RESOURCE_ATTRIBUTES: Object.entries(attributes).map(([k, v]) => `${k}=${v}`).join(','),
  };
}
