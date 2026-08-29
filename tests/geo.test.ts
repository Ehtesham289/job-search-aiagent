import { describe, expect, it } from "vitest";
import { countriesAllowed, countryOf, locationCompatible } from "../src/tools/geo.js";

/**
 * "Remote" is not "anywhere". Almost every remote posting is region-locked to
 * where the employer can payroll someone, and treating remote as global is how
 * a search for Bengaluru returned Tokyo and San Francisco.
 */
describe("remote is not global", () => {
  const wanted = ["Bengaluru"];

  it("accepts a posting in the city that was asked for", () => {
    expect(locationCompatible("Bengaluru, India", false, wanted, true).compatible).toBe(true);
    expect(locationCompatible("Bengaluru", false, wanted, false).compatible).toBe(true);
  });

  it("rejects an on-site posting elsewhere", () => {
    const v = locationCompatible("Tokyo, Japan", false, wanted, true);
    expect(v.compatible).toBe(false);
    expect(v.reason).toMatch(/on-site/);
  });

  it("rejects a remote posting locked to another region", () => {
    for (const loc of [
      "Remote - United Kingdom, Germany",
      "San Francisco, CA, New York, NY, Portland, OR, or Remote within United States",
      "Remote, EMEA",
      "Remote (US only)",
    ]) {
      const v = locationCompatible(loc, true, wanted, true);
      expect(v.compatible, `${loc} should be rejected for Bengaluru`).toBe(false);
      expect(v.reason).toMatch(/restricted to/);
    }
  });

  it("accepts a remote posting open to the candidate's country", () => {
    expect(locationCompatible("Remote (India)", true, wanted, true).compatible).toBe(true);
    expect(locationCompatible("Remote - APAC", true, wanted, true).compatible).toBe(true);
    expect(locationCompatible("Remote, Anywhere", true, wanted, true).compatible).toBe(true);
    expect(locationCompatible("Remote", true, wanted, true).compatible).toBe(true);
  });

  it("rejects any remote posting when the candidate wants on-site", () => {
    const v = locationCompatible("Remote (India)", true, wanted, false);
    expect(v.compatible).toBe(false);
    expect(v.reason).toMatch(/asked for on-site/);
  });

  it("passes everything through when no location was stated", () => {
    expect(locationCompatible("Tokyo, Japan", false, [], true).compatible).toBe(true);
  });

  it("does not guess when the region is not machine-readable", () => {
    // Better to show a posting than to silently drop it on a bad guess.
    const v = locationCompatible("Remote - HQ satellite office", true, wanted, true);
    expect(v.compatible).toBe(true);
  });
});

describe("place resolution", () => {
  it("maps cities to their country", () => {
    expect(countryOf("Bengaluru")).toBe("india");
    expect(countryOf("Bengaluru, India")).toBe("india");
    expect(countryOf("Howrah")).toBe("india");
    expect(countryOf("San Francisco")).toBe("united states");
    expect(countryOf("Nowhereville")).toBeNull();
  });

  it("expands the regions postings actually name", () => {
    expect(countriesAllowed("Remote, EMEA")).toContain("germany");
    expect(countriesAllowed("Remote, APAC")).toContain("india");
    expect(countriesAllowed("Remote within United States")).toContain("united states");
    expect(countriesAllowed("Remote, EMEA")).not.toContain("india");
  });
});

describe("place-name traps that actually bit", () => {
  const bengaluru = ["Bengaluru"];

  it("does not read the US state code IN as India", () => {
    // "Indianapolis, IN" made every US posting look India-eligible.
    expect(locationCompatible("Indianapolis, IN", false, bengaluru, true).compatible).toBe(false);
    expect(countriesAllowed("Indianapolis, IN")).toContain("united states");
    expect(countriesAllowed("Indianapolis, IN")).not.toContain("india");
  });

  it("does not match a state code hiding inside a city name", () => {
    // "GA" is a substring of "benGAluru".
    expect(locationCompatible("Atlanta, GA; Tempe, AZ", false, bengaluru, true).compatible).toBe(false);
  });

  it("treats Bangalore and Bengaluru as one city", () => {
    expect(locationCompatible("Bangalore", false, bengaluru, true).compatible).toBe(true);
    expect(locationCompatible("Bengaluru-VTP, India", false, bengaluru, true).compatible).toBe(true);
    expect(locationCompatible("Bengaluru", false, ["Bangalore"], true).compatible).toBe(true);
  });

  it("resolves full US state names, not just codes", () => {
    expect(locationCompatible("Remote - North Carolina", true, bengaluru, true).compatible).toBe(false);
  });

  it("resolves countries outside the headline set", () => {
    expect(locationCompatible("Switzerland (Remote)", true, bengaluru, true).compatible).toBe(false);
  });
});
