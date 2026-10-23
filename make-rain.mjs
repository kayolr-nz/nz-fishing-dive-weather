// Fish & Dive Nz — rain forecast pictures from DWD's ICON global model (13 km, free, credit "DWD/ICON").
// Run by .github/workflows/rain.yml every 6 hours; the result goes on GitHub Pages:
//   out/rain.json                       which run, the times, the grid of each region
//   out/r/<run>/<region>/<step>.gz      one gzipped picture per hour: rows × cols bytes of rain, then rows × cols bytes of snow share
// Rain byte = round(40 × √(mm/h)) (0 = dry, 255 ≈ 40 mm/h); snow byte = 255 × (snow ÷ all precipitation).
// Needs Node 18+ and the `bzip2` command. Usage: node make-rain.mjs [YYYYMMDDHH] [--steps 6]

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { spawnSync } from "child_process";
import { readGrib } from "./grib.mjs";

const BASE = "https://opendata.dwd.de/weather/nwp/icon/grib";
const OUT = path.resolve("out");
// hourly to 78 h, then every 3 h (ICON's own steps) — enough for 72 h ahead even from a run ~12 h old
const ALL_STEPS = [...Array.from({ length: 78 }, (_, i) => i + 1), 81, 84];
// wrap: the world grid joins round at the date line. Rows go south → north, columns west → east.
// The app uses the finest region that covers the screen (NZ ~30 KB an hour, Pacific ~90 KB, world ~85 KB).
const REGIONS = {
  nz: { lat0: -60, lng0: 150, d: 0.1, rows: 401, cols: 451 }, // 150°E – 195°E (= 165°W), 60°S – 20°S
  pacific: { lat0: -75, lng0: 90, d: 0.25, rows: 381, cols: 641 }, // 90°E – 250°E (= 110°W), 75°S – 20°N
  world: { lat0: -80, lng0: -180, d: 0.5, rows: 321, cols: 720, wrap: true },
};

const args = process.argv.slice(2);
const maxSteps = args.includes("--steps") ? Number(args[args.indexOf("--steps") + 1]) : ALL_STEPS.length;
const STEPS = ALL_STEPS.slice(0, maxSteps);

async function get(url, tries = 4) {
  for (let t = 1; ; t++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (t >= tries || /\b404\b/.test(e.message)) throw e;
      await new Promise((ok) => setTimeout(ok, 3000 * t));
    }
  }
}
const bunzip = (b) => {
  const r = spawnSync("bzip2", ["-dc"], { input: b, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error("bzip2 failed: " + r.stderr);
  return r.stdout;
};
const fileUrl = (run, v, step) =>
  `${BASE}/${run.slice(8)}/${v.toLowerCase()}/icon_global_icosahedral_single-level_${run}_${String(step).padStart(3, "0")}_${v}.grib2.bz2`;
const field = async (run, v, step) => readGrib(bunzip(await get(fileUrl(run, v, step))));

// The newest run whose last step is on the server for every variable we need
async function latestRun() {
  const now = Date.now();
  for (let back = 0; back < 6; back++) {
    const t = new Date(Math.floor(now / 21600000) * 21600000 - back * 21600000);
    const run = t.toISOString().slice(0, 13).replace(/[-T]/g, "");
    const last = STEPS[STEPS.length - 1];
    const ok = await Promise.all(["TOT_PREC", "SNOW_GSP", "SNOW_CON"].map((v) => fetch(fileUrl(run, v, last), { method: "HEAD" }).then((r) => r.ok, () => false)));
    if (ok.every(Boolean)) return run;
  }
  throw new Error("no complete ICON run found");
}

// For each region: which ICON cells fall in each grid square (to average them), and for squares with none,
// the nearest cell. Returns { idx: Int32Array cell → square or -1, near: Int32Array square → cell or -1 }
function mapping(lat, lon, R) {
  const n = lat.length;
  const size = R.rows * R.cols;
  const idx = new Int32Array(n).fill(-1);
  const count = new Uint16Array(size);
  for (let i = 0; i < n; i++) {
    const r = Math.round((lat[i] - R.lat0) / R.d);
    if (r < 0 || r >= R.rows) continue;
    let c = Math.round((((lon[i] - R.lng0) % 360) + 360) % 360 / R.d);
    if (R.wrap) c %= R.cols;
    else if (c >= R.cols) continue;
    idx[i] = r * R.cols + c;
    count[r * R.cols + c]++;
  }
  // empty squares → the nearest cell, found through 0.5° buckets of the cells near the region
  const near = new Int32Array(size).fill(-1);
  const B = 0.5;
  const bucket = new Map();
  const key = (br, bc) => br * 100000 + bc;
  const margin = 1;
  for (let i = 0; i < n; i++) {
    const y = lat[i] - R.lat0;
    if (y < -margin || y > (R.rows - 1) * R.d + margin) continue;
    const x = ((((lon[i] - R.lng0) % 360) + 360) % 360);
    if (!R.wrap && x > (R.cols - 1) * R.d + margin && x < 360 - margin) continue;
    const k = key(Math.floor(y / B), Math.floor(x / B));
    let l = bucket.get(k);
    if (!l) bucket.set(k, (l = []));
    l.push(i);
  }
  for (let s = 0; s < size; s++) {
    if (count[s]) continue;
    const r = Math.floor(s / R.cols), c = s % R.cols;
    const y = r * R.d, x = c * R.d;
    const coslat = Math.cos(((R.lat0 + y) * Math.PI) / 180);
    let best = -1, bd = Infinity;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -2; dc <= 2; dc++) {
        let bc = Math.floor(x / B) + dc;
        const l = bucket.get(key(Math.floor(y / B) + dr, bc)) || (R.wrap || bc < 0 ? bucket.get(key(Math.floor(y / B) + dr, (bc + 720) % 720)) : null);
        if (!l) continue;
        for (const i of l) {
          const dy = lat[i] - R.lat0 - y;
          let dx = ((((lon[i] - R.lng0) % 360) + 360) % 360) - x;
          if (dx > 180) dx -= 360;
          if (dx < -180) dx += 360;
          const dd = dy * dy + dx * dx * coslat * coslat;
          if (dd < bd) (bd = dd), (best = i);
        }
      }
    near[s] = best;
  }
  return { idx, near, count };
}

function regrid(values, m, size) {
  const sum = new Float64Array(size);
  for (let i = 0; i < values.length; i++) if (m.idx[i] >= 0) sum[m.idx[i]] += values[i];
  const out = new Float32Array(size);
  for (let s = 0; s < size; s++) out[s] = m.count[s] ? sum[s] / m.count[s] : m.near[s] >= 0 ? values[m.near[s]] : 0;
  return out;
}

async function main() {
  const run = /^\d{10}$/.test(args[0] || "") ? args[0] : await latestRun();
  console.log("ICON run", run, "steps", STEPS.length);
  const runTime = Date.UTC(+run.slice(0, 4), +run.slice(4, 6) - 1, +run.slice(6, 8), +run.slice(8, 10)) / 1000;
  const [lat, lon] = await Promise.all(["CLAT", "CLON"].map(async (v) =>
    readGrib(bunzip(await get(`${BASE}/${run.slice(8)}/${v.toLowerCase()}/icon_global_icosahedral_time-invariant_${run}_${v}.grib2.bz2`)))
  ));
  const maps = Object.fromEntries(Object.entries(REGIONS).map(([k, R]) => [k, mapping(lat, lon, R)]));
  console.log("mapping ready");
  const dir = path.join(OUT, "r", run);
  for (const k of Object.keys(REGIONS)) fs.mkdirSync(path.join(dir, k), { recursive: true });

  // download a few steps ahead while working on the current one
  const load = (step) => Promise.all(["TOT_PREC", "SNOW_GSP", "SNOW_CON"].map((v) => field(run, v, step)));
  const queue = new Map();
  const want = (i) => i < STEPS.length && !queue.has(i) && queue.set(i, load(STEPS[i]));
  let prev = null, prevStep = 0;
  const times = [];
  let bytes = 0;
  for (let i = 0; i < STEPS.length; i++) {
    for (let a = 0; a < 6; a++) want(i + a);
    const [tot, sg, sc] = await queue.get(i);
    queue.delete(i);
    const step = STEPS[i];
    const hours = step - prevStep;
    const n = tot.length;
    const rate = new Float32Array(n), snow = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const dt = tot[j] - (prev ? prev[0][j] : 0);
      const ds = sg[j] + sc[j] - (prev ? prev[1][j] + prev[2][j] : 0);
      rate[j] = Math.max(0, dt) / hours;
      snow[j] = dt > 0.001 ? Math.min(1, Math.max(0, ds / dt)) : 0;
    }
    for (const [k, R] of Object.entries(REGIONS)) {
      const size = R.rows * R.cols;
      const rr = regrid(rate, maps[k], size), ss = regrid(snow, maps[k], size);
      const buf = new Uint8Array(size * 2);
      for (let s = 0; s < size; s++) {
        buf[s] = rr[s] < 0.02 ? 0 : Math.min(255, Math.round(40 * Math.sqrt(rr[s])));
        buf[size + s] = buf[s] ? Math.round(255 * ss[s]) : 0;
      }
      const gz = zlib.gzipSync(buf, { level: 9 });
      bytes += gz.length;
      fs.writeFileSync(path.join(dir, k, `${String(step).padStart(3, "0")}.gz`), gz);
    }
    times.push(runTime + step * 3600);
    prev = [tot, sg, sc];
    prevStep = step;
    if (i % 12 === 0) console.log("step", step, "done");
  }
  const manifest = {
    run,
    made: new Date().toISOString(),
    credit: "DWD/ICON",
    steps: STEPS,
    times, // unix seconds: the end of the hour (or 3 h) the rain falls in
    path: `r/${run}/`,
    regions: REGIONS,
    rain: "mm/h = (byte / 40)²",
    snow: "share = byte / 255",
  };
  fs.writeFileSync(path.join(OUT, "rain.json"), JSON.stringify(manifest));
  console.log("done:", STEPS.length, "steps,", (bytes / 1e6).toFixed(1), "MB");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
