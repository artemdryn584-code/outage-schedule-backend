// Outage schedule backend — proxies the unofficial Yasno API and serves
// a clean, cached JSON endpoint for the frontend.
//
// IMPORTANT: relies on an UNOFFICIAL, undocumented Yasno endpoint that
// changed once already (the old api.yasno.com.ua endpoint stopped
// working; this now points at the newer app.yasno.ua one). It can
// change again without notice. Don't build anything safety-critical on
// top of this.

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

// Yasno's current (as of testing) blackout-service API.
// We only have one confirmed working region/dso pair — Yasno doesn't
// publish a directory of these, so more regions would need to be
// discovered by inspecting network requests on yasno.ua directly.
const YASNO_BASE = "https://app.yasno.ua/api/blackout-service/public/shutdowns";
const KNOWN_REGIONS = {
  kiev: { regionId: 25, dsoId: 902 },
  dnipro: { regionId: 3, dsoId: 301 },
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — be gentle with an unofficial source
const cache = {}; // keyed by region -> { data, fetchedAt }

// alerts.energy — a Ukrainian aggregator covering all 27 regions in one
// place (unlike Yasno, which only covers Kyiv/Dnipro). Also unofficial/
// undocumented — discovered via browser devtools, same caveats apply.
const ALERTS_ENERGY_BASE = "https://alerts.energy/api/v1/source-registry/areas";
// Slugs match exactly what alerts.energy uses in its own page URLs.
const ALERTS_ENERGY_REGIONS = [
  "avtonomna-respublika-krym", "vinnytska-oblast", "volynska-oblast",
  "dnipropetrovska-oblast", "donetska-oblast", "zhytomyrska-oblast",
  "zakarpatska-oblast", "zaporizka-oblast", "ivano-frankivska-oblast",
  "kyivska-oblast", "kirovogradska-oblast", "luganska-oblast",
  "lvivska-oblast", "mikolayivska-oblast", "odeska-oblast",
  "poltavska-oblast", "rivnenska-oblast", "sumska-oblast",
  "ternopilska-oblast", "kharkivska-oblast", "khersonska-oblast",
  "khmelnytska-oblast", "cherkaska-oblast", "chernivecka-oblast",
  "chernigivska-oblast", "sevastopol", "kyiv",
];
const alertsEnergyCache = {}; // keyed by region slug -> { data, fetchedAt }

async function fetchAlertsEnergy(regionSlug) {
  const now = Date.now();
  const cached = alertsEnergyCache[regionSlug];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  if (!ALERTS_ENERGY_REGIONS.includes(regionSlug)) {
    throw new Error(`Unknown alerts.energy region slug "${regionSlug}"`);
  }
  const url = `${ALERTS_ENERGY_BASE}/${regionSlug}/shutdowns`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; outage-schedule-proxy/1.0)",
      "Accept": "application/json",
      "Referer": "https://alerts.energy/",
    },
  });
  if (!res.ok) {
    throw new Error(`alerts.energy API responded with ${res.status}`);
  }
  const json = await res.json();
  alertsEnergyCache[regionSlug] = { data: json, fetchedAt: now };
  return json;
}

// alerts.energy's "today"/"tomorrow" arrays can be 24 (hourly) or 48
// (half-hourly) long. This samples evenly into a 24-slot on/off grid
// regardless of the source resolution. 0 = no outage (assumed based on
// an all-clear day observed while building this — unconfirmed against
// an actual outage example).
function alertsEnergyArrayToHours(arr) {
  const hours = Array(24).fill(true);
  if (!Array.isArray(arr) || arr.length === 0) return hours;
  for (let h = 0; h < 24; h++) {
    const idx = Math.floor((h * arr.length) / 24);
    hours[h] = Number(arr[idx]) === 0;
  }
  return hours;
}

// GET /api/alerts-energy/regions — list of supported region slugs
app.get("/api/alerts-energy/regions", (req, res) => {
  res.json({ regions: ALERTS_ENERGY_REGIONS });
});

// GET /api/alerts-energy/raw?region=lvivska-oblast
app.get("/api/alerts-energy/raw", async (req, res) => {
  const region = req.query.region;
  if (!region) return res.status(400).json({ error: "Pass ?region=lvivska-oblast (see /api/alerts-energy/regions for the full list)." });
  try {
    const raw = await fetchAlertsEnergy(region);
    res.json(raw);
  } catch (err) {
    res.status(502).json({ error: "Could not reach the upstream schedule source.", detail: err.message });
  }
});

// GET /api/alerts-energy/schedule?region=lvivska-oblast
// Returns every queue for the region, each converted to a 24-slot grid.
app.get("/api/alerts-energy/schedule", async (req, res) => {
  const region = req.query.region;
  if (!region) return res.status(400).json({ error: "Pass ?region=lvivska-oblast." });
  try {
    const raw = await fetchAlertsEnergy(region);
    const entries = Array.isArray(raw) ? raw : [];
    const queues = entries.map(e => ({
      queue: e.queue,
      initiator: e.initiator || null,
      today: alertsEnergyArrayToHours(e.today),
      tomorrow: e.tomorrow ? alertsEnergyArrayToHours(e.tomorrow) : null,
      updated: e.updated || null,
    }));
    res.json({
      region, queues,
      cachedAt: new Date((alertsEnergyCache[region] || {}).fetchedAt || Date.now()).toISOString(),
      source: "unofficial alerts.energy API — not an official feed, verify against alerts.energy for anything important",
    });
  } catch (err) {
    res.status(502).json({ error: "Could not reach the upstream schedule source.", detail: err.message });
  }
});

async function fetchYasnoPlannedOutages(region) {
  const now = Date.now();
  const cached = cache[region];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const regionInfo = KNOWN_REGIONS[region];
  if (!regionInfo) {
    throw new Error(`No known regionId/dsoId for region "${region}"`);
  }

  const url = `${YASNO_BASE}/regions/${regionInfo.regionId}/dsos/${regionInfo.dsoId}/planned-outages`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; outage-schedule-proxy/1.0)",
      "Accept": "application/json",
      "Referer": "https://yasno.ua/",
    },
  });

  if (!res.ok) {
    throw new Error(`Yasno API responded with ${res.status}`);
  }

  const json = await res.json();
  cache[region] = { data: json, fetchedAt: now };
  return json;
}

// GET /api/schedule/raw?region=kiev
app.get("/api/schedule/raw", async (req, res) => {
  const region = (req.query.region || "kiev").toLowerCase();
  try {
    const raw = await fetchYasnoPlannedOutages(region);
    res.json(raw);
  } catch (err) {
    res.status(502).json({ error: "Could not reach the upstream schedule source.", detail: err.message });
  }
});

// GET /api/schedule?region=kiev
app.get("/api/schedule", async (req, res) => {
  const region = (req.query.region || "kiev").toLowerCase();
  try {
    const raw = await fetchYasnoPlannedOutages(region);
    const groups = extractGroups(raw);
    res.json({
      region,
      groups,
      cachedAt: new Date((cache[region] || {}).fetchedAt || Date.now()).toISOString(),
      source: "unofficial Yasno API — not an official feed, verify against yasno.ua for anything important",
    });
  } catch (err) {
    res.status(502).json({ error: "Could not reach the upstream schedule source.", detail: err.message });
  }
});

// GET /api/schedule/group?region=kiev&group=1.1
app.get("/api/schedule/group", async (req, res) => {
  const region = (req.query.region || "kiev").toLowerCase();
  const group = req.query.group;
  if (!group) {
    return res.status(400).json({ error: "Pass ?group=1.1 (or whichever queue number you need)." });
  }
  try {
    const raw = await fetchYasnoPlannedOutages(region);
    const groups = extractGroups(raw);
    const statuses = extractGroupStatuses(raw);
    if (!(group in groups)) {
      return res.status(404).json({
        error: `No group "${group}" found for region "${region}".`,
        availableGroups: Object.keys(groups),
      });
    }
    res.json({
      region, group,
      windows: groups[group],
      status: statuses[group]?.status || null,
      date: statuses[group]?.date || null,
      cachedAt: new Date((cache[region] || {}).fetchedAt || Date.now()).toISOString(),
      source: "unofficial Yasno API — not an official feed, verify against yasno.ua for anything important",
    });
  } catch (err) {
    res.status(502).json({ error: "Could not reach the upstream schedule source.", detail: err.message });
  }
});

// Confirmed real shape (checked 2026-09-03) — raw is an object keyed
// directly by group, e.g. { "1.1": { today: { slots: [...], status,
// date }, tomorrow: {...}, updatedOn }, "2.1": {...}, ... }.
function extractGroups(raw) {
  try {
    const groups = {};
    for (const [groupKey, groupData] of Object.entries(raw || {})) {
      const slots = groupData?.today?.slots || [];
      groups[groupKey] = slots
        .map(slot => ({
          start: toHourFraction(slot.start ?? slot.startTime ?? slot.from),
          end: toHourFraction(slot.end ?? slot.endTime ?? slot.to),
          type: slot.type || "OUTAGE",
        }))
        .filter(w => !isNaN(w.start) && !isNaN(w.end));
    }
    return groups;
  } catch {
    return {};
  }
}

// Pulls each group's status/date info alongside the parsed windows, so
// the frontend can show "no outages scheduled today" instead of an
// ambiguous empty grid.
function extractGroupStatuses(raw) {
  const statuses = {};
  for (const [groupKey, groupData] of Object.entries(raw || {})) {
    statuses[groupKey] = {
      status: groupData?.today?.status || null,
      date: groupData?.today?.date || null,
      updatedOn: groupData?.updatedOn || null,
    };
  }
  return statuses;
}

// Normalizes either a fractional-hour number (12.5) or an ISO/time string
// into a fractional-hour number for the frontend's 24-slot grid.
function toHourFraction(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date.getHours() + date.getMinutes() / 60;
    }
    const parts = value.split(":");
    if (parts.length >= 2) {
      return Number(parts[0]) + Number(parts[1]) / 60;
    }
  }
  return NaN;
}

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Outage schedule backend listening on port ${PORT}`);
});
