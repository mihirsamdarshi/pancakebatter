import { readFileSync } from "node:fs";
import { POLICY_VERSION, validateWatch, type Watch } from "./vendor/domain.ts";
export function readPolicy(path: string): Watch[] {
  try {
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw) > 65536) throw new Error();
    const value = JSON.parse(raw);
    if (
      value.policyVersion !== POLICY_VERSION ||
      !Array.isArray(value.watches) ||
      !value.watches.length ||
      value.watches.length > 32
    )
      throw new Error();
    const ids = new Set<string>();
    for (const w of value.watches) {
      validateWatch(w);
      if (ids.has(w.id)) throw new Error();
      ids.add(w.id);
    }
    return value.watches;
  } catch {
    throw new Error("Invalid or missing mounted watch policy");
  }
}
