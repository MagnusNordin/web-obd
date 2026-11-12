# Web OBD

A browser OBD-II reader for ELM327-compatible adapters such as the vLinker FD+.
Works with any car that has OBD-II/EOBD (in the EU: petrol from 2001, diesel
from about 2004). No app to install: open the page, pair the adapter, read the car.

- **Fault codes**: stored, pending and permanent, per control unit (engine,
  gearbox), with descriptions for common generic codes. Clear them after a
  confirmation.
- **Check-engine light and readiness monitors**: what an emissions inspection
  looks at. Diesel cars get the diesel monitor list (DPF and so on).
- **Vehicle info**: VIN (with the make read from it), protocol, adapter version,
  battery voltage. Fault-code search links include the make.
- **Dials**: engine speed and vehicle speed as large round dials, temperatures
  (coolant, oil, intake air, outside air, exhaust) as smaller ones, each with a
  needle, a warning zone and the digital value. The rev counter's scale follows
  the engine type (5000 rpm diesel, 7000 rpm petrol).
- **Live data**: RPM, speed, temperatures, load, throttle, boost, MAF, fuel
  trims and more, whatever the car supports. Diesels also get boost pressure,
  DPF pressure difference (rises as the filter fills with soot), exhaust
  temperature, AdBlue level, fuel rate, rail pressure, torque and EGR. Record
  to CSV.
- **Graphs**: every value has a trend line for the last minute; tap one for a
  larger graph (1, 5 or 15 minutes) with min/max/average and a crosshair that
  shows the reading at any moment.
- **Adapter console**: send raw ELM327/OBD commands and see all traffic.
- **Demo mode**: `?demo` for a simulated petrol car, `?demo=diesel` for a diesel.

## Browsers

Uses Web Bluetooth (and Web Serial for USB or paired serial ports), so it needs
Chrome or Edge on Android, Windows, macOS or ChromeOS, over HTTPS or
localhost. On iPhone use the Bluefy browser; Safari has no Web Bluetooth.

Only standard OBD-II is supported (engine and gearbox). Make-specific modules
(airbag, ABS, body electronics, instrument cluster), service resets, battery
registration and forced DPF regeneration use each maker's own protocol and need
a tool for that make, such as vDash for older Volvos or BimmerLink for BMW.

## Run it locally

```bash
npm run serve   # http://localhost:4173/  (demo: http://localhost:4173/?demo)
npm test
```

The app in `site/` is plain HTML, CSS and ES modules with no build step and no
dependencies.

| File | Does |
|---|---|
| `site/obd.js` | Decodes ELM327 replies: ISO-TP reassembly, DTCs, PIDs, VIN and make, readiness |
| `site/elm.js` | Bluetooth/serial transports, command queue, OBD client |
| `site/sim.js` | Simulated petrol and diesel cars for the demo and the tests |
| `site/dtc-codes.js` | Fault code descriptions |
| `site/dials.js` | Round dials: scales, geometry, needle and arc |
| `site/chart.js` | Graph history, axes, sparklines and the crosshair |
| `site/app.js` | The UI |

## Deploy

Pushing to `main` runs the tests and publishes `site/` to GitHub Pages
(Settings → Pages → Source: GitHub Actions).
