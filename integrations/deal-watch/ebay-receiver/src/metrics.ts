// Prometheus text exposition for the internal port only. Every label value comes from a fixed
// list below; nothing from a request, a header, a body or an exception ever reaches a label or a
// value, so a scrape cannot carry an identifier.
export const NOTIFICATION_OUTCOMES = [
  "stored",
  "duplicate",
  "bad_signature",
  "unknown_key",
  "key_unavailable",
  "rejected_other",
  "storage_failed",
] as const;
export type NotificationOutcome = (typeof NOTIFICATION_OUTCOMES)[number];

export const KEY_LOOKUP_OUTCOMES = ["ok", "invalid", "failed", "budget"] as const;
export type KeyLookupOutcome = (typeof KEY_LOOKUP_OUTCOMES)[number];

export const CHALLENGE_OUTCOMES = ["ok", "rejected"] as const;
export type ChallengeOutcome = (typeof CHALLENGE_OUTCOMES)[number];

export const STATE_REASONS = [
  "clear",
  "volume-reset",
  "db-unreadable",
  "unprocessed",
  "key-unavailable",
  "selftest-failed",
] as const;
export type StateReason = (typeof STATE_REASONS)[number];

function counters<T extends readonly string[]>(names: T): Record<T[number], number> {
  return Object.fromEntries(names.map((n) => [n, 0])) as Record<T[number], number>;
}

export interface Gauges {
  stateReason: StateReason;
  selfTestEnabled: boolean;
  storageDesignVersion: string;
}

export class Metrics {
  readonly notifications = counters(NOTIFICATION_OUTCOMES);
  readonly keyLookups = counters(KEY_LOOKUP_OUTCOMES);
  readonly challenges = counters(CHALLENGE_OUTCOMES);
  oddAccepted = 0;
  overloaded = 0;
  selfTestConsecutiveFailures = 0;
  /** Unix seconds of the last successful self-test; 0 if none yet. */
  selfTestLastSuccess = 0;

  constructor(private readonly startedAtSeconds: number) {}

  noteSelfTest(ok: boolean, nowSeconds: number): void {
    if (ok) {
      this.selfTestConsecutiveFailures = 0;
      this.selfTestLastSuccess = nowSeconds;
    } else this.selfTestConsecutiveFailures++;
  }

  render(g: Gauges): string {
    const out: string[] = [];
    const metric = (name: string, type: "gauge" | "counter", help: string, samples: [string, number][]) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) out.push(`${name}${labels} ${value}`);
    };
    metric("ebay_receiver_info", "gauge", "Constant 1; the storage design version this build declares.", [
      [`{storage_design_version="${g.storageDesignVersion}"}`, 1],
    ]);
    metric("ebay_receiver_start_time_seconds", "gauge", "Process start time, Unix seconds.", [["", this.startedAtSeconds]]);
    metric(
      "ebay_receiver_state",
      "gauge",
      "1 for the current state reason (clear means CLEAR), 0 for the others.",
      STATE_REASONS.map((r): [string, number] => [`{reason="${r}"}`, r === g.stateReason ? 1 : 0]),
    );
    metric("ebay_receiver_blocked", "gauge", "1 when /state reports BLOCKED, else 0.", [["", g.stateReason === "clear" ? 0 : 1]]);
    metric("ebay_receiver_selftest_enabled", "gauge", "1 when the five-minute self-test loop is on.", [["", g.selfTestEnabled ? 1 : 0]]);
    metric("ebay_receiver_selftest_consecutive_failures", "gauge", "Self-test failures in a row (0 after a success).", [
      ["", this.selfTestConsecutiveFailures],
    ]);
    metric("ebay_receiver_selftest_last_success_timestamp_seconds", "gauge", "Unix time of the last successful self-test; 0 if none.", [
      ["", this.selfTestLastSuccess],
    ]);
    metric(
      "ebay_receiver_notifications_total",
      "counter",
      "Notification POSTs by fixed outcome. stored and duplicate were acknowledged with 200.",
      NOTIFICATION_OUTCOMES.map((o): [string, number] => [`{outcome="${o}"}`, this.notifications[o]]),
    );
    metric("ebay_receiver_notifications_odd_total", "counter", "Verified notifications acknowledged although the topic or shape was unexpected.", [
      ["", this.oddAccepted],
    ]);
    metric(
      "ebay_receiver_key_lookups_total",
      "counter",
      "Public key lookups by fixed outcome (failed counts network, token and 5xx failures).",
      KEY_LOOKUP_OUTCOMES.map((o): [string, number] => [`{outcome="${o}"}`, this.keyLookups[o]]),
    );
    metric(
      "ebay_receiver_key_lookup_failures_total",
      "counter",
      "Public key lookups that failed (an outage, not an unknown key id).",
      [["", this.keyLookups.failed]],
    );
    metric(
      "ebay_receiver_challenges_total",
      "counter",
      "Challenge GETs by fixed outcome.",
      CHALLENGE_OUTCOMES.map((o): [string, number] => [`{outcome="${o}"}`, this.challenges[o]]),
    );
    metric("ebay_receiver_overloaded_total", "counter", "Requests refused with 429.", [["", this.overloaded]]);
    return out.join("\n") + "\n";
  }
}
