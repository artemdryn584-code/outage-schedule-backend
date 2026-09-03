// Outage schedule backend — proxies the unofficial Yasno API and serves
// a clean, cached JSON endpoint for the frontend.
//
// This exists because browsers can't call api.yasno.com.ua directly
// (CORS), and because we don't want to hammer an undocumented endpoint
// on every page load — the cache does that job.
//
// IMPORTANT: this relies on an UNOFFICIAL, undocumented Yasno endpoint.
// It is not provided or supported by Yasno/DTEK for third-party use.
// It can change or disappear without notice. Don't build anything
// safety-critical on top of this — always point users to official
// sources for real decisions.

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

const YASNO_URL = "https://api.yasno.com.ua/api/v1/pages/home/schedule-turn-off-electricity";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — be gentle with an unofficial source

let cache = { data: null, fetchedAt: 0 };

async function fetchYasnoSchedule() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const res = await fetch(YASNO_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; outage-schedule-proxy/1.0)",
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Yasno API responded with ${res.status}`);
  }

  const json = await res.json();
  cache = { data: json, fetchedAt: now };
  return json;
}

// Pulls the daily-schedule component out of Yasno's page-component
// response shape and normalizes it to { region, groups: { "1.1": [...] } }.
function extractDailySchedule(raw, region) {
  const component = raw?.components?.find(
    c => c.template_name === "electricity-outages-daily-schedule"
  );
  if (!component) return null;

  const regionSchedule = component.dailySchedule?.[region];
  if (!regionSchedule) return null;

  return {
    region,
    title: regionSchedule.today?.title || null,
    lastUpdated: component.lastRegistryUpdateTime || null,
    groups: regionSchedule.today?.groups || {},
  };
}

// GET /api/schedule?region=kiev
// Returns the full daily schedule (all groups) for a region.
app.get("/api/schedule", async (req, res) => {
  const region = (req.query.region || "kiev").toLowerCase();

  try {
    const raw = await fetchYasnoSchedule();
    const schedule = extractDailySchedule(raw, region);

    if (!schedule) {
      return res.status(404).json({
        error: `No schedule found for region "${region}". Available regions depend on what Yasno currently publishes (commonly "kiev", "dnipro").`,
      });
    }

    res.json({
      ...schedule,
      cachedAt: new Date(cache.fetchedAt).toISOString(),
      source: "unofficial Yasno API — not an official feed, verify against yasno.com.ua for anything important",
    });
  } catch (err) {
    res.status(502).json({
      error: "Could not reach the upstream schedule source.",
      detail: err.message,
    });
  }
});

// GET /api/schedule/group?region=kiev&group=1.1
// Returns just one group's outage windows, as { start, end, type }[]
// with start/end in fractional hours (e.g. 12.5 = 12:30).
app.get("/api/schedule/group", async (req, res) => {
  const region = (req.query.region || "kiev").toLowerCase();
  const group = req.query.group;

  if (!group) {
    return res.status(400).json({ error: "Pass ?group=1.1 (or whichever queue number you need)." });
  }

  try {
    const raw = await fetchYasnoSchedule();
    const schedule = extractDailySchedule(raw, region);

    if (!schedule) {
      return res.status(404).json({ error: `No schedule found for region "${region}".` });
    }

    const windows = schedule.groups[group];
    if (!windows) {
      return res.status(404).json({
        error: `No group "${group}" found for region "${region}".`,
        availableGroups: Object.keys(schedule.groups),
      });
    }

    res.json({
      region,
      group,
      title: schedule.title,
      windows,
      cachedAt: new Date(cache.fetchedAt).toISOString(),
      source: "unofficial Yasno API — not an official feed, verify against yasno.com.ua for anything important",
    });
  } catch (err) {
    res.status(502).json({
      error: "Could not reach the upstream schedule source.",
      detail: err.message,
    });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Outage schedule backend listening on port ${PORT}`);
});
