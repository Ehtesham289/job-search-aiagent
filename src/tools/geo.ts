/**
 * Whether a posting is actually available to someone who wants to work in a
 * given place.
 *
 * "Remote" is not "anywhere", and treating it that way is how a search for
 * Bengaluru returns Tokyo, San Francisco and "Remote - United Kingdom,
 * Germany". Almost every remote posting is region-locked, usually to where the
 * employer can legally payroll someone, and the restriction is stated right
 * there in the location string.
 */

/** Cities to the country that would hire for them. Deliberately small: enough
 *  to cover the markets this is used in, and honest about the rest. */
const CITY_COUNTRY: Record<string, string> = {
  bengaluru: "india", bangalore: "india", kolkata: "india", howrah: "india",
  mumbai: "india", pune: "india", delhi: "india", "new delhi": "india",
  gurgaon: "india", gurugram: "india", noida: "india", hyderabad: "india",
  chennai: "india", ahmedabad: "india", jaipur: "india", kochi: "india",
  indore: "india", chandigarh: "india", coimbatore: "india", nagpur: "india",

  london: "united kingdom", manchester: "united kingdom", dublin: "ireland",
  berlin: "germany", munich: "germany", hamburg: "germany",
  paris: "france", amsterdam: "netherlands", madrid: "spain", barcelona: "spain",
  warsaw: "poland", lisbon: "portugal", stockholm: "sweden",

  "san francisco": "united states", "new york": "united states", seattle: "united states",
  austin: "united states", boston: "united states", chicago: "united states",
  denver: "united states", portland: "united states", "salt lake city": "united states",
  toronto: "canada", vancouver: "canada", montreal: "canada",

  singapore: "singapore", tokyo: "japan", sydney: "australia", melbourne: "australia",
  "sao paulo": "brazil", "mexico city": "mexico", "tel aviv": "israel", dubai: "uae",
};

/**
 * Country names and the abbreviations postings actually use.
 *
 * Note what is NOT here: `in` for India. "Indianapolis, IN" and "Austin, TX,
 * ... IN" made every US posting look India-eligible, which is exactly how a
 * Bengaluru search filled up with Charlotte and Atlanta. Two-letter tokens are
 * matched as whole segments only (see SHORT_ALIASES).
 */
const COUNTRY_ALIASES: Record<string, string> = {
  india: "india", bharat: "india",
  "united states": "united states", usa: "united states",
  "u.s.": "united states", "u.s.a.": "united states", america: "united states",
  "united kingdom": "united kingdom", "u.k.": "united kingdom",
  britain: "united kingdom", england: "united kingdom", scotland: "united kingdom",
  canada: "canada", germany: "germany", france: "france", netherlands: "netherlands",
  ireland: "ireland", spain: "spain", poland: "poland", portugal: "portugal",
  sweden: "sweden", singapore: "singapore", japan: "japan", australia: "australia",
  brazil: "brazil", mexico: "mexico", israel: "israel", uae: "uae",
  switzerland: "switzerland", austria: "austria", belgium: "belgium", denmark: "denmark",
  norway: "norway", finland: "finland", italy: "italy", greece: "greece",
  "czech republic": "czechia", czechia: "czechia", romania: "romania", hungary: "hungary",
  bulgaria: "bulgaria", croatia: "croatia", serbia: "serbia", ukraine: "ukraine",
  turkey: "turkey", egypt: "egypt", "south africa": "south africa", kenya: "kenya",
  nigeria: "nigeria", argentina: "argentina", chile: "chile", colombia: "colombia",
  peru: "peru", "costa rica": "costa rica", "new zealand": "new zealand",
  philippines: "philippines", indonesia: "indonesia", malaysia: "malaysia",
  thailand: "thailand", vietnam: "vietnam", china: "china", "hong kong": "hong kong",
  "south korea": "south korea", korea: "south korea", taiwan: "taiwan",
  pakistan: "pakistan", bangladesh: "bangladesh", "sri lanka": "sri lanka",
  "saudi arabia": "saudi arabia", qatar: "qatar", nepal: "nepal",
};

/** Full US state names, so "Remote - North Carolina" resolves like "NC" does. */
const US_STATE_NAMES = [
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida",
  "georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky","louisiana","maine",
  "maryland","massachusetts","michigan","minnesota","mississippi","missouri","montana","nebraska",
  "nevada","new hampshire","new jersey","new mexico","new york","north carolina","north dakota","ohio",
  "oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota","tennessee","texas",
  "utah","vermont","virginia","washington","west virginia","wisconsin","wyoming",
];

/**
 * The same city under the name a posting happens to use. Dropping a Bengaluru
 * search's Bangalore results is the filter failing on a spelling.
 */
const CITY_ALIASES: Record<string, string> = {
  bangalore: "bengaluru", bengaluru: "bengaluru",
  bombay: "mumbai", mumbai: "mumbai",
  calcutta: "kolkata", kolkata: "kolkata",
  madras: "chennai", chennai: "chennai",
  gurgaon: "gurugram", gurugram: "gurugram",
  "new delhi": "delhi", delhi: "delhi", ncr: "delhi",
  trivandrum: "thiruvananthapuram", poona: "pune", pune: "pune",
  bengaluru_vtp: "bengaluru",
};

export function canonicalCity(name: string): string {
  const n = name.toLowerCase().trim().replace(/[^a-z\s]/g, " ").replace(/\s{2,}/g, " ").trim();
  return CITY_ALIASES[n] ?? n;
}

/** Ambiguous two-letter tokens: only ever matched as a whole segment. */
const SHORT_ALIASES: Record<string, string> = {
  us: "united states", uk: "united kingdom", uae: "uae", in: "india",
};

/**
 * US state codes, so "Charlotte, NC" positively resolves to the United States
 * instead of resolving to nothing and being waved through.
 */
const US_STATES = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md",
  "ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc",
  "sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc",
]);

/** Phrases that mean genuinely unrestricted. */
const GLOBAL = /\b(anywhere|worldwide|world[- ]wide|globally|global remote|fully remote,? anywhere|any location)\b/i;

/** Multi-country regions a posting may name instead of a country. */
const REGIONS: Record<string, string[]> = {
  emea: ["united kingdom", "germany", "france", "netherlands", "ireland", "spain", "poland", "portugal", "sweden", "israel", "uae"],
  apac: ["india", "singapore", "japan", "australia"],
  amer: ["united states", "canada", "brazil", "mexico"],
  americas: ["united states", "canada", "brazil", "mexico"],
  latam: ["brazil", "mexico"],
  "north america": ["united states", "canada"],
  europe: ["united kingdom", "germany", "france", "netherlands", "ireland", "spain", "poland", "portugal", "sweden"],
};

function segments(place: string): string[] {
  return place
    .toLowerCase()
    .split(/[,;|\-–—()/]|\bor\b/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function countryOf(place: string): string | null {
  const p = place.toLowerCase().trim();
  if (COUNTRY_ALIASES[p]) return COUNTRY_ALIASES[p]!;
  if (CITY_COUNTRY[p]) return CITY_COUNTRY[p]!;
  for (const part of segments(place)) {
    if (COUNTRY_ALIASES[part]) return COUNTRY_ALIASES[part]!;
    if (CITY_COUNTRY[part]) return CITY_COUNTRY[part]!;
    if (SHORT_ALIASES[part]) return SHORT_ALIASES[part]!;
  }
  return null;
}

/** Every country a posting's location text plausibly permits. */
export function countriesAllowed(jobLocation: string): Set<string> {
  const out = new Set<string>();
  const loc = jobLocation.toLowerCase();

  for (const [region, countries] of Object.entries(REGIONS)) {
    if (new RegExp(`\\b${region}\\b`).test(loc)) countries.forEach((c) => out.add(c));
  }
  for (const [alias, country] of Object.entries(COUNTRY_ALIASES)) {
    if (new RegExp(`\\b${alias.replace(/\./g, "\\.")}\\b`).test(loc)) out.add(country);
  }
  for (const [city, country] of Object.entries(CITY_COUNTRY)) {
    if (new RegExp(`\\b${city}\\b`).test(loc)) out.add(country);
  }
  // Whole segments only, so "IN" inside "Indianapolis, IN" is read as a US
  // state and never as India.
  for (const state of US_STATE_NAMES) {
    if (new RegExp(`\\b${state}\\b`).test(loc)) out.add("united states");
  }
  // Short codes are read from the ORIGINAL casing. Postings write country and
  // state codes uppercase ("Remote (US only)", "Indianapolis, IN"); the English
  // preposition "in" is lowercase. That distinction is what keeps "in office"
  // from resolving to Indiana.
  for (const raw of jobLocation.split(/[\s,;|\-–—()/]+/)) {
    const token = raw.trim();
    if (token.length < 2 || token.length > 3) continue;
    if (token !== token.toUpperCase()) continue;
    const lowered = token.toLowerCase();
    if (US_STATES.has(lowered)) out.add("united states");
    else if (SHORT_ALIASES[lowered]) out.add(SHORT_ALIASES[lowered]!);
  }
  return out;
}

export interface LocationVerdict {
  compatible: boolean;
  /** Names the actual place, for one posting. */
  reason: string;
  /** The same verdict without the place, so drops can be counted by cause. */
  group: string;
}

/**
 * `wanted` is where the candidate said they want to work; `remoteOk` is whether
 * they will take a remote role. A remote role still has to be open to their
 * region — that is the part that was missing.
 */
export function locationCompatible(
  jobLocation: string | null,
  isRemote: boolean,
  wanted: string[],
  remoteOk: boolean,
): LocationVerdict {
  if (wanted.length === 0) return { compatible: true, reason: "no location stated", group: "no location stated" };

  const loc = (jobLocation ?? "").trim();
  const lower = loc.toLowerCase();

  // A named city the candidate asked for is the strongest signal there is,
  // compared on a canonical name so Bangalore and Bengaluru are one place.
  const jobCities = segments(loc).map(canonicalCity);
  for (const w of wanted) {
    const want = canonicalCity(w.split(",")[0]!);
    if (!want) continue;
    // Containment only between substantial names ("Bengaluru-VTP" contains
    // "Bengaluru"). Without the length floor, the state code "GA" matched
    // inside "ben-GA-luru" and every Atlanta posting passed a Bengaluru filter.
    const MIN = 4;
    if (
      jobCities.some(
        (c) => c === want || (c.length >= MIN && want.length >= MIN && (c.includes(want) || want.includes(c))),
      )
    ) {
      return { compatible: true, reason: `matches ${w}`, group: "in a place you named" };
    }
  }

  if (!isRemote) {
    return {
      compatible: false,
      reason: `on-site in '${loc || "unstated"}', outside ${wanted.join(" / ")}`,
      group: `on-site somewhere other than ${wanted.join(" / ")}`,
    };
  }
  if (!remoteOk) {
    return {
      compatible: false,
      reason: `remote, but you asked for on-site in ${wanted.join(" / ")}`,
      // The place is stable for the whole run, so naming it keeps the group
      // countable while still saying what the constraint was.
      group: `remote, but you asked for on-site in ${wanted.join(" / ")}`,
    };
  }

  // Remote and the candidate accepts remote — but is it open to their region?
  if (!loc || GLOBAL.test(lower)) {
    return { compatible: true, reason: "remote, no region restriction stated", group: "remote, unrestricted" };
  }

  const allowed = countriesAllowed(loc);
  if (allowed.size === 0) {
    return { compatible: true, reason: "remote, region not machine-readable", group: "remote, region unreadable" };
  }

  const wantedCountries = new Set(wanted.map((w) => countryOf(w)).filter((c): c is string => c !== null));
  if (wantedCountries.size === 0) {
    return { compatible: true, reason: "remote, candidate's country unknown", group: "remote, your country unknown" };
  }

  for (const c of wantedCountries) {
    if (allowed.has(c)) return { compatible: true, reason: `remote and open to ${c}`, group: "remote and open to you" };
  }
  return {
    compatible: false,
    reason: `remote but restricted to ${[...allowed].join(" / ")}, not ${[...wantedCountries].join(" / ")}`,
    // `allowed` varies per posting and would fragment the group; the
    // candidate's own countries do not.
    group: `remote, but restricted to countries other than ${[...wantedCountries].join(" / ")}`,
  };
}
