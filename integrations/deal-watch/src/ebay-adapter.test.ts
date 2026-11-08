import { expect, test } from "bun:test";
import { parseEbay, discoveryIds } from "./ebay-adapter.ts";
import { UpstreamError } from "./http.ts";
import { readPolicy } from "./policy.ts";
import { qualify } from "./vendor/domain.ts";
import { message } from "./discord.ts";
const w = readPolicy(new URL("../fixtures/example-policy.json", import.meta.url).pathname)[0]!;
const b = {
  ...w.bindings[0]!,
  retailer: "ebay" as const,
  productId: "1234567890123",
  ebayGtin: "1234567890123",
};
const id = "v1|123456789012|0",
  now = Date.now();
const item = {
  itemId: id,
  gtin: b.ebayGtin,
  title: "Synthetic console",
  conditionId: "1000",
  buyingOptions: ["FIXED_PRICE"],
  price: { value: "500.00", currency: "USD" },
  seller: { username: "Synthetic seller", feedbackPercentage: "99.9", feedbackScore: 1000 },
  shippingOptions: [
    {
      type: "STANDARD",
      shippingCost: { value: "0.00", currency: "USD" },
      shipToLocationUsedForEstimate: { country: "US", postalCode: w.zip },
    },
  ],
  estimatedAvailabilities: [
    { estimatedAvailabilityStatus: "IN_STOCK", deliveryOptions: ["SHIP_TO_HOME"] },
  ],
  returnTerms: { returnsAccepted: true },
};
test("canonical eBay detail preserves unknown costs and warranty, never treating missing fees as zero", () => {
  const offer = parseEbay(item, w, b, id, now);
  expect(offer.shipping).toBe("confirmed");
  expect(offer.feesCents).toBeNull();
  expect(offer.warranty).toBeNull();
  expect(offer.seller.established).toBe(false);
  expect(qualify(w, b, offer, now).eligible).toBe(false);
});
test("identity, buying mode, condition and currency cannot be inferred from search text", () => {
  for (const patch of [
    { gtin: "9876543210123" },
    { itemId: "v1|123456789013|0" },
    { buyingOptions: ["AUCTION"] },
    { buyingOptions: ["FIXED_PRICE", "AUCTION"] },
    { conditionId: "3000" },
    { price: { value: "500", currency: "CAD" } },
  ])
    expect(() => parseEbay({ ...item, ...patch }, w, b, id, now)).toThrow("invalid-data");
});
test("destination and ended stock override apparently purchasable offers", () => {
  expect(
    parseEbay({ ...item, itemEndDate: new Date(now - 1).toISOString() }, w, b, id, now)
      .availability,
  ).toBe("out-of-stock");
  expect(
    parseEbay(
      {
        ...item,
        shippingOptions: [
          {
            ...item.shippingOptions[0],
            shipToLocationUsedForEstimate: { country: "US", postalCode: "00000" },
          },
        ],
      },
      w,
      b,
      id,
      now,
    ).shipping,
  ).toBe("unverified");
  expect(
    parseEbay(
      {
        ...item,
        estimatedAvailabilities: [
          { estimatedAvailabilityStatus: "IN_STOCK", deliveryOptions: ["IN_STORE_PICKUP"] },
        ],
      },
      w,
      b,
      id,
      now,
    ).availability,
  ).toBe("unknown");
});
test("discovery is a bounded distinct set, not qualified evidence", () => {
  expect(discoveryIds({ itemSummaries: [{ itemId: id }] })).toEqual([id]);
  expect(discoveryIds({ total: 0 })).toEqual([]);
  for (const value of [
    { itemSummaries: [{ itemId: "bad" }] },
    { itemSummaries: [{ itemId: id }, { itemId: id }] },
    { itemSummaries: Array(11).fill({ itemId: id }) },
    { errors: [{ errorId: 1100 }] },
  ])
    expect(() => discoveryIds(value)).toThrow("invalid-data");
});

test("warnings are not silently treated as complete source evidence", () => {
  for (const warnings of [[{ errorId: 1 }], "bad", {}]) {
    expect(() => discoveryIds({ itemSummaries: [{ itemId: id }], warnings })).toThrow(
      "invalid-data",
    );
    expect(() => parseEbay({ ...item, warnings }, w, b, id, now)).toThrow("invalid-data");
  }
});

// Owner decision 14/15 (option B): extra fees are assumed 0 only for new, US, fixed-price, USD, ZIP-proven listings.
const us = { ...item, itemLocation: { country: "US" } };
const option = item.shippingOptions[0]!;
const fees = (v: unknown) => parseEbay(v, w, b, id, now).feesCents;
test("a US fixed-price USD listing with a ZIP-matched priced shipping option assumes no fee and alerts with the label", () => {
  const offer = parseEbay(us, w, b, id, now);
  expect(offer.feesCents).toBe(0);
  expect(offer.warranty).toBeNull();
  expect(qualify(w, b, offer, now).eligible).toBe(true);
  expect(message(w, b, offer, crypto.randomUUID(), now)).toContain("fee assumed, not verified");
});
test("fees stay unknown without full proof", () => {
  const amount = { value: "5.00", currency: "USD" };
  for (const patch of [
    { itemLocation: { country: "CA" } },
    { itemLocation: undefined },
    { ecoParticipationFee: amount },
    { shippingOptions: [{ ...option, importCharges: amount }] },
    { shippingOptions: [option, { ...option, importCharges: amount }] },
    { shippingOptions: [{ ...option, shipToLocationUsedForEstimate: undefined }] },
    { shippingOptions: [{ ...option, shipToLocationUsedForEstimate: { country: "US", postalCode: "00000" } }] },
    { shippingOptions: [{ ...option, shippingCost: undefined }] },
    { shippingOptions: [{ ...option, shippingCost: { value: "5.00", currency: "CAD" } }] },
    { shippingOptions: [] },
  ]) {
    const offer = parseEbay({ ...us, ...patch }, w, b, id, now);
    expect(offer.feesCents).toBeNull();
    expect(qualify(w, b, offer, now).eligible).toBe(false);
  }
  for (const patch of [{ price: { value: "500", currency: "CAD" } }, { buyingOptions: ["BEST_OFFER"] }])
    expect(() => fees({ ...us, ...patch })).toThrow("invalid-data");
});
test("open-box and refurbished listings never qualify, even with the fee assumption", () => {
  for (const conditionId of ["1500", "2000", "2010", "2020", "2030", "2500"]) {
    const offer = parseEbay({ ...us, conditionId }, w, b, id, now);
    expect(offer.feesCents).toBe(0);
    expect(offer.warranty).toBeNull();
    expect(qualify(w, b, offer, now).reasons).toContain("Returns or warranty evidence missing");
  }
});

const reasonOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof UpstreamError ? error.reason : "not-an-upstream-error";
  }
  return "accepted";
};
const detail = (patch: Record<string, unknown>) =>
  reasonOf(() => parseEbay({ ...item, ...patch }, w, b, id, now));
test("each eBay detail rejection site reports its own fixed reason", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ itemId: "v1|123456789013|0" }, "item-id"],
    [{ gtin: "9876543210123" }, "gtin-mismatch"],
    [{ gtin: undefined }, "gtin-missing"],
    [{ buyingOptions: ["AUCTION"] }, "buying-option"],
    [{ buyingOptions: ["BEST_OFFER"] }, "buying-option"],
    [{ errors: [{ errorId: 1100, message: "x" }] }, "errors"],
    [{ conditionId: "3000" }, "condition"],
    [{ price: { value: "500", currency: "CAD" } }, "currency"],
    [{ price: { value: "abc", currency: "USD" } }, "price"],
    [{ title: "" }, "title"],
    [{ warnings: "bad" }, "warnings"],
  ];
  for (const [patch, reason] of cases) expect(detail(patch)).toBe(reason);
  expect(reasonOf(() => parseEbay("nope", w, b, id, now))).toBe("schema");
  expect(reasonOf(() => parseEbay(item, w, { ...b, ebayGtin: undefined }, id, now))).toBe(
    "binding",
  );
});
test("a warning response is rejected with only eBay's numeric codes", () => {
  const warnings = [
    { errorId: 11510, message: "Synthetic shipping text", parameters: [{ value: "secret" }] },
    { errorId: 11502 },
    { message: "no code" },
  ];
  expect(detail({ warnings })).toBe("warnings:11510,11502");
  expect(reasonOf(() => discoveryIds({ itemSummaries: [{ itemId: id }], warnings }))).toBe(
    "warnings:11510,11502",
  );
  expect(detail({ warnings: [{ message: "no code" }] })).toBe("warnings");
  expect(detail({ warnings: Array.from({ length: 8 }, (_, i) => ({ errorId: 100 + i })) })).toBe(
    "warnings:100,101,102,103,104",
  );
});
test("discovery rejections report their reason", () => {
  expect(reasonOf(() => discoveryIds({ errors: [{ errorId: 1100 }] }))).toBe("errors");
  expect(reasonOf(() => discoveryIds({ itemSummaries: [{ itemId: "bad" }] }))).toBe("schema");
  expect(reasonOf(() => discoveryIds(null))).toBe("schema");
});
test("GTIN identity: item gtin decides; product.gtins only when the item gtin is absent", () => {
  const { gtin: _omit, ...noGtin } = item;
  const other = "9876543210123";
  const check = (v: unknown) => reasonOf(() => parseEbay(v, w, b, id, now));
  expect(check({ ...noGtin, product: { gtins: [other, b.ebayGtin] } })).toBe("accepted");
  expect(check({ ...noGtin, product: { gtins: [other] } })).toBe("gtin-mismatch");
  expect(check({ ...noGtin, product: { gtins: [` ${b.ebayGtin}`] } })).toBe("gtin-mismatch");
  expect(check({ ...noGtin, product: { gtins: [] } })).toBe("gtin-missing");
  expect(check({ ...noGtin, product: {} })).toBe("gtin-missing");
  expect(check({ ...noGtin, product: { gtins: b.ebayGtin } })).toBe("gtin-missing");
  // A differing item gtin is final, even when the product list matches.
  expect(check({ ...item, gtin: other, product: { gtins: [b.ebayGtin] } })).toBe("gtin-mismatch");
  // Other checks stay in force when the identity comes from product.gtins.
  expect(check({ ...noGtin, product: { gtins: [b.ebayGtin] }, buyingOptions: ["AUCTION"] })).toBe(
    "buying-option",
  );
  expect(check({ ...noGtin, product: { gtins: [b.ebayGtin] }, warnings: [{ errorId: 1 }] })).toBe(
    "warnings:1",
  );
});
