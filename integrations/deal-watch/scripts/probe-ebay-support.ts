import { UpstreamError } from "../src/http.ts";

export interface ProbeOptions {
  mode: "search" | "item";
  id: string;
  zip: string;
  probe: boolean;
  technicalOnly: boolean;
}

export function parseProbeOptions(args: string[]): ProbeOptions | null {
  const values = new Map<string, string>(), switches = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (["--probe", "--technical-only"].includes(flag)) {
      if (switches.has(flag)) return null;
      switches.add(flag);
    } else if (["--mode", "--id", "--zip"].includes(flag)) {
      const value = args[++index];
      if (values.has(flag) || !value || value.startsWith("--")) return null;
      values.set(flag, value);
    } else return null;
  }
  const mode = values.get("--mode"), id = values.get("--id"), zip = values.get("--zip");
  if (
    (mode !== "search" && mode !== "item") || !id || !zip || !/^\d{5}$/.test(zip) ||
    !(mode === "search" ? /^\d{8,14}$/ : /^(?:\d{9,20}|v1\|\d{9,20}\|\d{1,20})$/).test(id)
  ) return null;
  return { mode, id, zip, probe: switches.has("--probe"), technicalOnly: switches.has("--technical-only") };
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Return fixed technical predicates only; never copy listing values into output. */
export function technicalEbayEvidence(mode: "search" | "item", value: unknown) {
  if (!object(value)) throw new UpstreamError("invalid-data");
  for (const key of ["errors", "warnings"])
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length !== 0))
      throw new UpstreamError("invalid-data");
  let items: unknown[];
  if (mode === "search") {
    if (value.total !== undefined && (!Number.isSafeInteger(value.total) || Number(value.total) < 0))
      throw new UpstreamError("invalid-data");
    if (value.total === 0 && value.itemSummaries === undefined) items = [];
    else if (Array.isArray(value.itemSummaries) && value.itemSummaries.length <= 10)
      items = value.itemSummaries;
    else throw new UpstreamError("invalid-data");
    if (value.total === 0 && items.length !== 0) throw new UpstreamError("invalid-data");
  } else items = [value];
  for (const item of items)
    if (
      !object(item) || typeof item.itemId !== "string" || !/^v1\|\d{9,20}\|\d{1,20}$/.test(item.itemId) ||
      (item.legacyItemId !== undefined && (typeof item.legacyItemId !== "string" || !/^\d{9,20}$/.test(item.legacyItemId)))
    ) throw new UpstreamError("invalid-data");
  return {
    responseContainerRecognized: true,
    itemIdentitySchemaObserved: items.length > 0,
    qualificationEstablished: false,
  };
}
