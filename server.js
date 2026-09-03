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
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — be gentle with an unofficial source
const cache = {}; // keyed by region -> { data, fetchedAt }

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
// Returns Yasno's response completely unprocessed. Use this first to see
// the actual current shape of their data — the "type" field names,
// group/queue naming, whether it's start/end or startTime/endTime, etc.
// Once we know the real shape from this, /api/schedule/group's parsing
// can be corrected to match it exactly instead of guessing.
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
// Best-effort parsed version. Tries a few common field-name shapes since
// we haven't confirmed the exact schema yet (use /api/schedule/raw to check).
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
    const windows = groups[group];
    if (!windows) {
      return res.status(404).json({
        error: `No group "${group}" found for region "${region}".`,
        availableGroups: Object.keys(groups),
      });
    }
    res.json({
      region, group, windows,
      cachedAt: new Date((cache[region] || {}).fetchedAt || Date.now()).toISOString(),
      source: "unofficial Yasno API — not an official feed, verify against yasno.ua for anything important",
    });
  } catch (err) {
    res.status(502).json({ error: "Could not reach the upstream schedule source.", detail: err.message });
  }
});

// Defensive parser: tries several plausible shapes for the outage list,
// since we haven't locked down the exact current schema. Falls back to
// an empty object (frontend treats that as "no live data available")
// rather than throwing, so one shape mismatch doesn't break the endpoint.
function extractGroups(raw) {
  try {
    // shape guess 1: raw is an array of { queue/group, start/end or startTime/endTime }
    const list = Array.isArray(raw) ? raw : raw.data || raw.outages || raw.events || null;
    if (!Array.isArray(list)) return {};

    const groups = {};
    for (const item of list) {
      const groupKey = String(item.group ?? item.queue ?? item.groupId ?? item.subQueue ?? "unknown");
      const start = item.start ?? item.startTime ?? item.from;
      const end = item.end ?? item.endTime ?? item.to;
      if (start == null || end == null) continue;
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push({ start: toHourFraction(start), end: toHourFraction(end), type: item.type || "OUTAGE" });
    }
    return groups;
  } catch {
    return {};
  }
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
