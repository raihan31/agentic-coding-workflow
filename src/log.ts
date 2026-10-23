import { trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

/** JSON logs on stderr (stdout carries the run result), pretty on a TTY unless LOG_FORMAT=json. Lines carry the active trace id. */
export function createLogger(): Logger {
  const pretty = process.stderr.isTTY && process.env.LOG_FORMAT !== 'json';
  const options = {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'agentic-orchestrator' },
    mixin() {
      const ctx = trace.getActiveSpan()?.spanContext();
      return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
    },
  };
  return pretty
    ? pino({ ...options, transport: { target: 'pino-pretty', options: { destination: 2, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service,trace_id,span_id' } } })
    : pino(options, pino.destination(2));
}

export const silentLogger: Logger = pino({ level: 'silent' });
