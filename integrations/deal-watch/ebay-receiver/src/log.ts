// The only way this service writes a log line. The type admits fixed event names, fixed reason
// codes, numbers and a verified notification id. It never takes a string from a request, an
// exception message, a header, a body, a parsed identifier or a challenge code.
export type LogEvent =
  | "start"
  | "stopped"
  | "challenge"
  | "challenge-rejected"
  | "notification-stored"
  | "notification-duplicate"
  | "notification-rejected"
  | "notification-accepted-odd"
  | "key-fetch"
  | "key-fetch-failed"
  | "storage-failed"
  | "selftest-ok"
  | "selftest-failed"
  | "overloaded"
  | "internal-error"
  | "init";

export type LogReason =
  | "bad-method"
  | "bad-content-type"
  | "too-large"
  | "body-timeout"
  | "no-signature"
  | "bad-signature-header"
  | "unknown-key"
  | "key-unavailable"
  | "key-budget"
  | "bad-signature"
  | "bad-json"
  | "bad-schema"
  | "wrong-topic"
  | "bad-challenge"
  | "volume-reset"
  | "db-unreadable"
  | "mint-failed"
  | "created"
  | "resumed"
  | "existing";

export interface LogFields {
  status?: number;
  bytes?: number;
  ms?: number;
  reason?: LogReason;
  /** Only a notification id that passed signature verification and the id pattern. */
  id?: string;
}

export type LogSink = (line: string) => void;
export type Logger = (event: LogEvent, fields?: LogFields) => void;

export const NOTIFICATION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export function createLogger(
  sink: LogSink = (line) => void process.stdout.write(line + "\n"),
  now: () => number = Date.now,
): Logger {
  return (event, fields = {}) => {
    const out: Record<string, unknown> = { t: new Date(now()).toISOString(), event };
    for (const key of ["status", "bytes", "ms"] as const) {
      const value = fields[key];
      if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(value);
    }
    if (typeof fields.reason === "string" && /^[a-z-]{1,24}$/.test(fields.reason)) out.reason = fields.reason;
    if (typeof fields.id === "string" && NOTIFICATION_ID.test(fields.id)) out.id = fields.id;
    sink(JSON.stringify(out));
  };
}
