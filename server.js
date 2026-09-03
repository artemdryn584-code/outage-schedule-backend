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
