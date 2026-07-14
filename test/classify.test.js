import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPair, chooseSurvivor, unionFind, pairKey,
  AUTO_MERGE, REVIEW, IGNORE, CONFIRMED_DISTINCT,
  isStub, blockers,
} from "../src/classify.js";

function makeCompany(overrides = {}) {
  return {
    id: "1",
    name: "Acme Inc",
    domain: "acme.com",
    country: "US",
    state: "CA",
    city: "Los Angeles",
    zip: "90001",
    ownerId: "owner1",
    openDealIds: [],
    parentId: null,
    childIds: [],
    contactIds: new Set(),
    engagedContactDomains: new Map(),
    engagementByContact: new Map(),
    lastActivityAt: "2025-01-01T00:00:00Z",
    createdAt: "2024-01-01T00:00:00Z",
    propertyFillCount: 10,
    engagementScore: 5,
    settledPairs: new Set(),
    ...overrides,
  };
}

describe("pairKey", () => {
  test("order-independent", () => {
    assert.equal(pairKey("123", "456"), pairKey("456", "123"));
  });

  test("uses min|max ordering", () => {
    assert.equal(pairKey("123", "456"), "123|456");
    assert.equal(pairKey("456", "123"), "123|456");
  });
});

describe("isStub", () => {
  test("flags empty record as stub", () => {
    const stub = makeCompany({
      openDealIds: [],
      engagementScore: 0,
      contactIds: new Set(),
      propertyFillCount: 2,
    });
    assert.ok(isStub(stub));
  });

  test("non-stub with contacts", () => {
    const real = makeCompany({ contactIds: new Set(["c1", "c2", "c3"]) });
    assert.ok(!isStub(real));
  });
});

describe("blockers", () => {
  test("different_country blocker", () => {
    const a = makeCompany({ country: "US" });
    const b = makeCompany({ country: "CA" });
    assert.ok(blockers(a, b).includes("different_country"));
  });

  test("both_open_deals blocker", () => {
    const a = makeCompany({ openDealIds: ["d1"] });
    const b = makeCompany({ openDealIds: ["d2"] });
    assert.ok(blockers(a, b).includes("both_open_deals"));
  });

  test("no blockers for clean pair", () => {
    const a = makeCompany({ id: "1" });
    const b = makeCompany({ id: "2" });
    assert.equal(blockers(a, b).length, 0);
  });
});

describe("classifyPair", () => {
  test("returns CONFIRMED_DISTINCT for previously dismissed pair", () => {
    const a = makeCompany({ id: "100" });
    const b = makeCompany({ id: "200" });
    const settled = new Set(["100|200|dismissed"]);
    const result = classifyPair(a, b, settled);
    assert.equal(result.decision, CONFIRMED_DISTINCT);
  });

  test("returns IGNORE for totally unrelated companies", () => {
    const a = makeCompany({ id: "1", name: "Acme Inc", domain: "acme.com" });
    const b = makeCompany({ id: "2", name: "Globex Corp", domain: "globex.com" });
    const result = classifyPair(a, b);
    assert.equal(result.decision, IGNORE);
  });

  test("REVIEW for blocked pair (both_open_deals)", () => {
    const a = makeCompany({ id: "1", openDealIds: ["d1"] });
    const b = makeCompany({ id: "2", openDealIds: ["d2"] });
    const result = classifyPair(a, b);
    assert.equal(result.decision, REVIEW);
  });

  test("AUTO_MERGE for stub absorption with matching domain + name", () => {
    const real = makeCompany({
      id: "1",
      name: "Silich Construction",
      domain: "silich.com",
      propertyFillCount: 15,
      engagementScore: 10,
    });
    const stub = makeCompany({
      id: "2",
      name: "Silich LLC",
      domain: "silich.com",
      openDealIds: [],
      engagementScore: 0,
      contactIds: new Set(),
      propertyFillCount: 2,
    });
    const result = classifyPair(real, stub);
    assert.equal(result.decision, AUTO_MERGE);
    assert.equal(result.survivorId, "1");
  });
});

describe("chooseSurvivor", () => {
  test("prefers record with open deal", () => {
    const a = makeCompany({ id: "1", openDealIds: ["d1"] });
    const b = makeCompany({ id: "2", openDealIds: [] });
    assert.equal(chooseSurvivor(a, b), "1");
  });

  test("prefers more recently active", () => {
    const a = makeCompany({ id: "1", openDealIds: [], lastActivityAt: "2025-06-01T00:00:00Z" });
    const b = makeCompany({ id: "2", openDealIds: [], lastActivityAt: "2024-01-01T00:00:00Z" });
    assert.equal(chooseSurvivor(a, b), "1");
  });
});

describe("unionFind", () => {
  test("clusters 3 connected records into one cluster", () => {
    const a = makeCompany({ id: "1" });
    const b = makeCompany({ id: "2" });
    const c = makeCompany({ id: "3" });
    const clusters = unionFind([[a, b], [b, c]]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].length, 3);
  });

  test("two disconnected pairs = two clusters", () => {
    const a = makeCompany({ id: "1" });
    const b = makeCompany({ id: "2" });
    const c = makeCompany({ id: "3" });
    const d = makeCompany({ id: "4" });
    const clusters = unionFind([[a, b], [c, d]]);
    assert.equal(clusters.length, 2);
  });
});
