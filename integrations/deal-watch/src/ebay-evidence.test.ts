import { expect, test } from "bun:test";
import { ebayEvidence } from "./ebay-evidence.ts";
const item = {
  itemId: "v1|123456789012|987654321",
  title: "Console",
  price: { value: "500.00", currency: "USD" },
};
test("evidence preserves REST variation identity and unknown returns", () => {
  const result = ebayEvidence("item", {
    ...item,
    returnTerms: {},
    secret: "do-not-output",
    warnings: [{ errorId: 123, message: "do-not-output" }],
  });
  expect(result.items[0]?.itemId).toBe(item.itemId);
  expect(result.items[0]?.legacyItemId).toBeNull();
  expect(result.items[0]?.returns?.accepted).toBeNull();
  expect(result.warningIds).toEqual([123]);
  expect(JSON.stringify(result)).not.toContain("do-not-output");
});
test("evidence rejects errors, malformed IDs and excessive search results", () => {
  for (const response of [
    null,
    {},
    { errors: [{ errorId: 1 }] },
    { itemSummaries: [{ itemId: "invalid" }] },
    { itemSummaries: Array(11).fill(item) },
  ])
    expect(() => ebayEvidence("search", response)).toThrow("invalid-data");
  expect(ebayEvidence("search", { total: 0 }).items).toEqual([]);
});
test("evidence bounds output and strips control characters", () => {
  const result = ebayEvidence("item", {
    ...item,
    title: "abc\n" + "x".repeat(500),
    shippingOptions: Array(30).fill({
      shippingCost: { value: "0.00", currency: "USD" },
      shipToLocationUsedForEstimate: { country: "US", postalCode: "10001" },
    }),
    warnings: Array(100).fill({ errorId: 7 }),
  });
  expect(result.items[0]?.title?.length).toBe(250);
  expect(result.items[0]?.title).not.toContain("\n");
  expect(result.items[0]?.shippingOptions.length).toBe(10);
  expect(result.warningCount).toBe(100);
  expect(result.warningIds.length).toBe(50);
});
