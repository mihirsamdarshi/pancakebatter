import { expect, test } from "bun:test";
import { parseEbay, discoveryIds } from "./ebay-adapter.ts";
import { readPolicy } from "./policy.ts";
import { qualify } from "./vendor/domain.ts";
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
