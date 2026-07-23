import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ENRICHMENT_CACHE_TTL_MS,
  hydrateEnrichmentCache,
  serializeEnrichmentCache,
} from "../src/enrichment-cache.js";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

function rawProps(overrides = {}) {
  return {
    domain: "acme.com",
    num_associated_contacts: "2",
    hs_num_open_deals: "1",
    notes_last_activity: "2026-07-22T00:00:00.000Z",
    num_notes: "3",
    num_contacted_notes: "2",
    hs_analytics_num_visits: "10",
    dedup_settled_pairs: "1|2|dismissed",
    ...overrides,
  };
}

function enrichedCompany() {
  return {
    id: "1",
    contactIds: new Set(["10", "11"]),
    openDealIds: ["20"],
    engagementByContact: new Map([["10", 4], ["11", 0]]),
    engagedContactDomains: new Map([["acme.com", 4]]),
    engagementScore: 4,
    finalDomain: "acme.com",
  };
}

describe("enrichment cache", () => {
  test("round-trips the signals needed by classification", () => {
    const props = rawProps();
    const serialized = serializeEnrichmentCache(enrichedCompany(), props, NOW);
    const hydrated = hydrateEnrichmentCache(
      { id: "1", name: "Acme" },
      props,
      serialized,
      { now: NOW + 1_000 }
    );

    assert.deepEqual([...hydrated.contactIds], ["10", "11"]);
    assert.deepEqual(hydrated.openDealIds, ["20"]);
    assert.equal(hydrated.engagementByContact.get("10"), 4);
    assert.equal(hydrated.engagementByContact.has("11"), false);
    assert.equal(hydrated.engagedContactDomains.get("acme.com"), 4);
    assert.equal(hydrated.engagementScore, 4);
    assert.equal(hydrated.finalDomain, "acme.com");
    assert.ok(hydrated.settledPairs.has("1|2|dismissed"));
  });

  test("invalidates when a source association counter changes", () => {
    const serialized = serializeEnrichmentCache(enrichedCompany(), rawProps(), NOW);
    const hydrated = hydrateEnrichmentCache(
      { id: "1" },
      rawProps({ num_associated_contacts: "3" }),
      serialized,
      { now: NOW + 1_000 }
    );

    assert.equal(hydrated, null);
  });

  test("expires after 24 hours", () => {
    const props = rawProps();
    const serialized = serializeEnrichmentCache(enrichedCompany(), props, NOW);
    const hydrated = hydrateEnrichmentCache(
      { id: "1" },
      props,
      serialized,
      { now: NOW + ENRICHMENT_CACHE_TTL_MS + 1 }
    );

    assert.equal(hydrated, null);
  });

  test("ignores dedup writes and HubSpot modified timestamps", () => {
    const serialized = serializeEnrichmentCache(
      enrichedCompany(),
      rawProps({ hs_lastmodifieddate: "2026-07-20T00:00:00.000Z" }),
      NOW
    );
    const hydrated = hydrateEnrichmentCache(
      { id: "1" },
      rawProps({
        hs_lastmodifieddate: "2026-07-23T12:01:00.000Z",
        dedup_last_scanned_at: "2026-07-23T12:01:00.000Z",
        dedup_settled_pairs: "3|4|dismissed",
      }),
      serialized,
      { now: NOW + 1_000 }
    );

    assert.ok(hydrated);
    assert.ok(hydrated.settledPairs.has("3|4|dismissed"));
  });

  test("treats malformed checkpoints as cache misses", () => {
    assert.equal(
      hydrateEnrichmentCache({ id: "1" }, rawProps(), "{not-json", { now: NOW }),
      null
    );
  });
});
