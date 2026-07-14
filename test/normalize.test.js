import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  registrableDomain,
  sld,
  domainRelationship,
  nameSimilarity,
} from "../src/normalize.js";

describe("normalizeName", () => {
  test("strips industry suffixes", () => {
    const { normalized } = normalizeName("Silich Construction LLC");
    assert.equal(normalized, "silich");
  });

  test("flags generic names", () => {
    assert.ok(normalizeName("Summit Builders").isGeneric);
    // Single-token core (after suffix stripping) is also generic per spec
    assert.ok(normalizeName("Silich Construction").isGeneric); // core=["silich"], len=1
    // Multi-token non-generic core
    assert.ok(!normalizeName("Silich Ironworks").isGeneric); // core=["silich","ironworks"]
  });

  test("handles null/empty", () => {
    assert.ok(normalizeName("").isGeneric);
    assert.ok(normalizeName(null).isGeneric);
  });
});

describe("registrableDomain", () => {
  test("strips www and path", () => {
    assert.equal(registrableDomain("https://www.silich.com/about"), "silich.com");
  });

  test("handles co.uk TLD", () => {
    assert.equal(registrableDomain("company.co.uk"), "company.co.uk");
  });

  test("returns empty for falsy", () => {
    assert.equal(registrableDomain(""), "");
    assert.equal(registrableDomain(null), "");
  });
});

describe("sld", () => {
  test("extracts second-level label", () => {
    assert.equal(sld("silich.com"), "silich");
    assert.equal(sld("silichcompanies.com"), "silichcompanies");
  });
});

describe("domainRelationship", () => {
  test("identical domains", () => {
    assert.equal(domainRelationship("silich.com", "silich.com"), "IDENTICAL");
  });

  test("TLD swap", () => {
    assert.equal(domainRelationship("silich.com", "silich.ca"), "TLD_SWAP");
  });

  test("SLD substring", () => {
    assert.equal(domainRelationship("silich.com", "silichconstruction.com"), "SLD_SUBSTRING");
  });

  test("unrelated domains", () => {
    assert.equal(domainRelationship("acme.com", "globex.com"), "NONE");
  });
});

describe("nameSimilarity", () => {
  test("identical", () => {
    assert.equal(nameSimilarity("silich", "silich"), 1);
  });

  test("high similarity on normalized cores", () => {
    // nameSimilarity operates on already-normalized cores (suffixes already stripped)
    assert.ok(nameSimilarity("silich ironworks", "silich ironwork") > 0.5);
  });

  test("low similarity", () => {
    assert.ok(nameSimilarity("acme", "globex") < 0.3);
  });
});
