import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { candidatePairs } from "../src/candidates.js";

function company(id, name, domain = "") {
  return { id, name, domain };
}

function keys(companies) {
  return new Set(candidatePairs(companies).map(([a, b]) => [a.id, b.id].sort().join("|")));
}

describe("candidatePairs", () => {
  test("rejects unrelated companies sharing a generic first word", () => {
    const pairs = keys([
      company("1", "United Talent Agency", "unitedtalent.com"),
      company("2", "United Airlines", "united.com"),
      company("3", "United Way Bay Area", "uwba.org"),
      company("4", "United Way of Delaware", "uwde.org"),
    ]);

    assert.equal(pairs.size, 0);
  });

  test("rejects weak shared-name prefixes seen in production logs", () => {
    const pairs = keys([
      company("1", "Best Buy Health", "bestbuyhealth.com"),
      company("2", "Best Buy Metals", "bestbuymetals.com"),
      company("3", "Brand Love", "brandlove.example"),
      company("4", "Brand Central", "brandcentral.example"),
      company("5", "Legacy Settlement Services", "legacysettlement.com"),
      company("6", "Legacy Utility Group", "legacyutility.com"),
    ]);

    assert.equal(pairs.size, 0);
  });

  test("keeps exact and strongly similar company names", () => {
    const pairs = keys([
      company("1", "Hover Inc.", "hover-one.example"),
      company("2", "Hover", "hover-two.example"),
      company("3", "Thomson Reuters", "thomsonreuters.com"),
      company("4", "Thomson Reuters Canada", "tr-canada.example"),
    ]);

    assert.ok(pairs.has("1|2"));
    assert.ok(pairs.has("3|4"));
  });

  test("keeps whitespace variants and identical domain SLDs", () => {
    const pairs = keys([
      company("1", "FreshBooks", "freshbooks-one.example"),
      company("2", "Fresh Books", "freshbooks-two.example"),
      company("3", "Completely Different", "acme.com"),
      company("4", "Unrelated Name", "acme.ca"),
    ]);

    assert.ok(pairs.has("1|2"));
    assert.ok(pairs.has("3|4"));
  });

  test("does not emit the same pair from multiple buckets", () => {
    const pairs = candidatePairs([
      company("1", "Acme Group", "acme.com"),
      company("2", "Acme Company", "acme.ca"),
    ]);

    assert.equal(pairs.length, 1);
  });
});
