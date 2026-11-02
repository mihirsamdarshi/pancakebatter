import { UpstreamError } from "./http.ts";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) =>
  typeof v === "string"
    ? v.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 250)
    : null;
const amount = (v: unknown) =>
  object(v) &&
  typeof v.value === "string" &&
  /^\d+(\.\d{1,2})?$/.test(v.value) &&
  typeof v.currency === "string" &&
  /^[A-Z]{3}$/.test(v.currency)
    ? { value: v.value, currency: v.currency }
    : null;
function summary(item: unknown) {
  if (!object(item)) throw new UpstreamError("invalid-data");
  const legacy = text(item.legacyItemId);
  const restId = text(item.itemId);
  if (
    !restId ||
    !/^v1\|\d{9,20}\|\d{1,20}$/.test(restId) ||
    (legacy !== null && !/^\d{9,20}$/.test(legacy))
  )
    throw new UpstreamError("invalid-data");
  const seller = object(item.seller) ? item.seller : {};
  return {
    itemId: restId,
    legacyItemId: legacy,
    title: text(item.title),
    condition: text(item.condition),
    conditionId: text(item.conditionId),
    gtin: text(item.gtin),
    epid: text(item.epid),
    brand: text(item.brand),
    itemEndDate: text(item.itemEndDate),
    buyingOptions: Array.isArray(item.buyingOptions)
      ? item.buyingOptions.slice(0, 10).map(text)
      : [],
    localizedAspects: Array.isArray(item.localizedAspects)
      ? item.localizedAspects
          .slice(0, 50)
          .filter(object)
          .map((a) => ({ name: text(a.name), value: text(a.value) }))
      : [],
    ecoParticipationFee: amount(item.ecoParticipationFee),
    price: amount(item.price),
    seller: {
      username: text(seller.username),
      feedbackPercentage: text(seller.feedbackPercentage),
      feedbackScore:
        typeof seller.feedbackScore === "number" ? seller.feedbackScore : null,
    },
    shippingOptions: Array.isArray(item.shippingOptions)
      ? item.shippingOptions
          .slice(0, 10)
          .filter(object)
          .map((s) => ({
            type: text(s.type),
            shippingCost: amount(s.shippingCost),
            importCharges: amount(s.importCharges),
            destination: object(s.shipToLocationUsedForEstimate)
              ? {
                  country: text(s.shipToLocationUsedForEstimate.country),
                  postalCode: text(s.shipToLocationUsedForEstimate.postalCode),
                }
              : null,
          }))
      : [],
    availability: Array.isArray(item.estimatedAvailabilities)
      ? item.estimatedAvailabilities
          .slice(0, 10)
          .filter(object)
          .map((s) => ({
            status: text(s.estimatedAvailabilityStatus),
            deliveryOptions: Array.isArray(s.deliveryOptions)
              ? s.deliveryOptions
                  .slice(0, 10)
                  .filter((v) => typeof v === "string")
                  .map(text)
              : [],
          }))
      : [],
    returns: object(item.returnTerms)
      ? {
          accepted:
            typeof item.returnTerms.returnsAccepted === "boolean"
              ? item.returnTerms.returnsAccepted
              : null,
          period: object(item.returnTerms.returnPeriod)
            ? {
                unit: text(item.returnTerms.returnPeriod.unit),
                value:
                  typeof item.returnTerms.returnPeriod.value === "number"
                    ? item.returnTerms.returnPeriod.value
                    : null,
              }
            : null,
        }
      : null,
  };
}
export function ebayEvidence(mode: "search" | "item", response: unknown) {
  if (!object(response)) throw new UpstreamError("invalid-data");
  if (
    response.errors !== undefined &&
    (!Array.isArray(response.errors) || response.errors.length)
  )
    throw new UpstreamError("invalid-data");
  if (response.warnings !== undefined && !Array.isArray(response.warnings))
    throw new UpstreamError("invalid-data");
  if (
    mode === "search" &&
    ((!Array.isArray(response.itemSummaries) &&
      !(response.total === 0 && response.itemSummaries === undefined)) ||
      (Array.isArray(response.itemSummaries) &&
        response.itemSummaries.length > 10))
  )
    throw new UpstreamError("invalid-data");
  const warnings = Array.isArray(response.warnings) ? response.warnings : [];
  return {
    warningCount: warnings.length,
    warningIds: warnings
      .slice(0, 50)
      .filter(object)
      .map((w) => w.errorId)
      .filter((v) => typeof v === "number" && Number.isSafeInteger(v)),
    items:
      mode === "search"
        ? Array.isArray(response.itemSummaries)
          ? response.itemSummaries.map(summary)
          : []
        : [summary(response)],
  };
}
