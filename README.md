# Fish & Dive Nz — weather data

Rain forecast pictures for the Fish & Dive Nz app (https://nz-fishing-dive.vercel.app), served by GitHub Pages at
https://kayolr-nz.github.io/nz-fishing-dive-weather/rain.json.

- `make-rain.mjs` downloads DWD's free ICON global model (13 km; total precipitation + snow) for the newest run, turns each
  forecast hour into small gzipped grids for three areas (NZ 0.1°, Pacific 0.25°, world 0.5°) and writes `out/`.
- `grib.mjs` reads the GRIB2 files (CCSDS/AEC compression) in plain JavaScript — no installs, just Node and `bzip2`.
- `.github/workflows/rain.yml` runs it every 6 hours and publishes `out/` to GitHub Pages (nothing is committed except a
  keep-alive date every ~3 weeks, so the schedule isn't switched off).

Run it yourself: `node make-rain.mjs` (or `node make-rain.mjs 2026102218 --steps 6` for a quick test).

Data: Deutscher Wetterdienst (DWD) open data, free to use with credit ("Source: DWD", GeoNutzV / CC BY 4.0).
