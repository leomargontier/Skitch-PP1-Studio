# Skitch Studio

Skitch Studio is an offline desktop app for the **Brother SKITCH PP1** single-needle embroidery machine. It runs on Windows, macOS and Debian/Ubuntu. You need no account, no login and no cloud.

It does the Skitch part of Brother Artspira. It opens a design, places it in the hoop, sends it over Bluetooth LE and monitors the sewing.

## Features

- Opens `.pes`, `.pec`, `.dst`, `.jef` and `.exp` designs (drag and drop works too).
- Shows a preview in a 100 × 100 mm or 70 × 70 mm hoop. You can move, rotate 90° and mirror the design.
- Connects to the machine over Bluetooth LE and shows its model, serial number and firmware.
- Sends the design in the same stitch format and transfer sequence as Artspira.
- Traces the outline, starts sewing and moves the hoop for a thread change.
- Shows the machine status, errors and progress live, and tells you which thread colour comes next.
- Rotates by any angle and resizes from 80 to 120 %.
- Resumes an interrupted job, and starts sewing from any stitch (for example after a thread break).
- Changes the machine settings: auto thread cut, jump stitch cut and presser foot height. It can also reset them.
- Shows the stitch counters, warns when maintenance is due and reads the error log.
- Turns a picture (`.png`, `.jpg`, `.bmp`, `.gif`, `.webp`) into embroidery. It reduces the picture to the thread colours you choose and fills each area with tatami fill stitches.
- Saves any design as a `.dst` file.
- Makes lettering from any installed font, and adds text, pictures or other designs under the current one.

## Install

Download a build from the GitHub Actions artifacts or from Releases:

| OS | File |
|---|---|
| Debian / Ubuntu | `skitch-studio_<ver>_amd64.deb`: run `sudo apt install ./skitch-studio_*.deb` |
| Linux (other) | `.AppImage` |
| Windows 10/11 | `Skitch Studio Setup <ver>.exe` (installer) or the portable `.exe` |
| macOS | `.dmg` (x64 and Apple Silicon) |

The builds are unsigned. On Windows, click "More info", then "Run anyway". On macOS, right-click the app, then click Open.

On Linux, Bluetooth must be on (`bluetoothctl power on`). Your user must be allowed to use BlueZ, which is the default on desktop distributions.

## Build from source

```sh
cd app
npm install
npm test             # unit tests, including checks against Artspira's own encoder output
npm start            # run the app
npm run dist:linux   # .deb + AppImage   (dist:win / dist:mac on those systems)
```

Windows and macOS installers are built by `.github/workflows/build.yml` on GitHub runners. Push to `main` or push a `v*` tag; a tag also creates a release.

## How it works

The protocol and file format were recovered from Brother Artspira 2.9.10 for Android, a .NET MAUI app with native C++ helpers. `docs/PROTOCOL.md` has the details. In short:

- **BLE:** the service is `a76eb9e0-f3ac-4990-84cf-3a94d2426b2b`. The app writes `[cmd u16 BE][payload]` to characteristic `…e2`, then reads the reply from `…e1`.
- **Transfer:** `0x0708` deletes the old design and `0x1200` sends the length and checksum. `0x1201` sends the data in chunks with offsets and checksums. `0x0705` sends the layout and `0x070A` sends the job ID.
- **Stitch data ("PEN"):** each needle position takes 4 bytes. X and Y are absolute, in 0.1 mm, centred on the design, and stored as `(v << 3) | flags` (int16 LE). The flags mark feed, cut, colour change and end. The encoder also adds Artspira's 0.8 mm tie-in and tie-off stitches and its rule to cut before any hop of 5.1 mm or more.

`app/test/fixtures/*.pen` was produced by Brother's own converter library, which was run on Linux through a bionic-to-glibc shim. The tests check this app's encoder against it.

## Limits

- The protocol was recovered by reverse engineering. It has not been tested on a physical PP1 yet. Run a scrap-fabric test first.
- Artspira also supports Wi-Fi machines and Brother's cutting machines. Wi-Fi machines need Brother's cloud account, so they are not supported. The cutting machines use a different cut-data format (FCM), so they are not supported yet.
- Lettering uses the fonts installed on your computer and is sewn as fill, so thin or small letters (under about 8 mm) come out rough.
- The picture converter makes fill stitches only, with no satin borders or underlay. It works best with logos and flat colours.
- The app has no stitch-by-stitch editor, and combined designs move as one piece. Firmware updates are not supported.

Skitch Studio is not affiliated with Brother Industries. "Brother", "SKITCH" and "Artspira" are trademarks of their owners.
