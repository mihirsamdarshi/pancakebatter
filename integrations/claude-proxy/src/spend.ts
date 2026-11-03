import { readFileSync, renameSync, writeFileSync } from "node:fs";

export interface SpendState {
  day: string; // UTC date, YYYY-MM-DD
  spentUsd: number;
  requests: number;
}

export type Logger = (entry: Record<string, unknown>) => void;

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isSpendState(value: unknown): value is SpendState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v.day) &&
    typeof v.spentUsd === "number" &&
    Number.isFinite(v.spentUsd) &&
    v.spentUsd >= 0 &&
    typeof v.requests === "number" &&
    Number.isInteger(v.requests) &&
    v.requests >= 0
  );
}

// Today's estimated spend. Kept in memory and written to a small JSON file
// after every charge, so a container restart inside the same pod (the file
// lives on the pod's emptyDir) keeps the count. A new pod starts from zero.
//
// Requests in flight also hold a reservation: their estimated maximum cost,
// counted against the cap until they finish. Reservations are memory only;
// a restart ends the requests that held them.
export class SpendLedger {
  private state: SpendState;
  private reservedUsd = 0;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
    private readonly now: () => Date,
  ) {
    this.state = this.load();
  }

  current(): SpendState {
    const day = utcDay(this.now());
    if (this.state.day !== day) this.state = { day, spentUsd: 0, requests: 0 };
    return { ...this.state };
  }

  charge(costUsd: number): SpendState {
    this.current();
    this.state.spentUsd += costUsd;
    this.state.requests += 1;
    this.persist();
    return { ...this.state };
  }

  reserved(): number {
    return this.reservedUsd;
  }

  reserve(usd: number): void {
    this.reservedUsd += usd;
  }

  release(usd: number): void {
    this.reservedUsd -= usd;
    // Floating-point leftovers once every reservation is released.
    if (this.reservedUsd < 1e-9) this.reservedUsd = 0;
  }

  private load(): SpendState {
    const empty = { day: utcDay(this.now()), spentUsd: 0, requests: 0 };
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.log({
          time: this.now().toISOString(),
          event: "spend-file-ignored",
          reason: "unreadable",
        });
      return empty;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isSpendState(parsed))
        return { day: parsed.day, spentUsd: parsed.spentUsd, requests: parsed.requests };
    } catch {
      // Reported below.
    }
    this.log({ time: this.now().toISOString(), event: "spend-file-ignored", reason: "corrupt" });
    return empty;
  }

  private persist(): void {
    const temporary = `${this.file}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.state));
      renameSync(temporary, this.file);
    } catch {
      this.log({ time: this.now().toISOString(), event: "spend-file-write-failed" });
    }
  }
}
