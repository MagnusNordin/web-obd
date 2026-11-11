# Web OBD

A browser OBD-II reader for ELM327-compatible adapters, made for a vLinker FD+
in a Volvo C30. No app to install: open the page, pair the adapter, read the car.

- **Fault codes**: stored, pending and permanent, per control unit (engine,
  gearbox), with descriptions for common generic codes. Clear them after a
  confirmation.
- **Check-engine light and readiness monitors**: what an emissions inspection
  looks at. Diesel cars get the diesel monitor list (DPF and so on).
- **Vehicle info**: VIN, protocol, adapter version, battery voltage.
- **Live data**: RPM, speed, temperatures, load, throttle, boost, MAF, fuel
  trims and more, whatever the car supports. Record to CSV.
- **Adapter console**: send raw ELM327/OBD commands and see all traffic.
- **Demo mode**: add `?demo` to the URL for a simulated car.

## Browsers

Uses Web Bluetooth (and Web Serial for USB or paired serial ports), so it needs
Chrome or Edge on Android, Windows, macOS or ChromeOS, over HTTPS or
localhost. On iPhone use the Bluefy browser; Safari has no Web Bluetooth.

Only standard OBD-II is supported (engine and gearbox). Volvo-specific modules
(SRS, ABS, CEM, DIM) use Volvo's own protocol on the medium-speed CAN bus and
need a tool such as vDash.

## Run it locally

```bash
npm run serve   # http://localhost:4173/  (demo: http://localhost:4173/?demo)
npm test
```

The app in `site/` is plain HTML, CSS and ES modules with no build step and no
dependencies.

| File | Does |
|---|---|
| `site/obd.js` | Decodes ELM327 replies: ISO-TP reassembly, DTCs, PIDs, VIN, readiness |
| `site/elm.js` | Bluetooth/serial transports, command queue, OBD client |
| `site/sim.js` | Simulated car for the demo and the tests |
| `site/dtc-codes.js` | Fault code descriptions |
| `site/app.js` | The UI |

## Deploy

Pushing to `main` runs the tests and publishes `site/` to GitHub Pages
(Settings → Pages → Source: GitHub Actions).
