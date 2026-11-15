# Hoopbridge

Hoopbridge is an offline desktop app that works with the **Brother SKITCH PP1** single-needle embroidery machine. It runs on Windows, macOS and Debian/Ubuntu. You need no account, no login and no cloud.

It does the Skitch part of Brother Artspira. It opens a design, places it in the hoop, sends it over Bluetooth LE and monitors the sewing.

## Features

- Opens 39 embroidery formats (drag and drop works too): `.pes`, `.pec`, `.dst`, `.jef`, `.exp`, `.vp3`, `.hus`, `.xxx`, `.u01`, `.tbf`, `.shv`, `.sew`, `.ksm`, `.dsz`, `.dsb`, `.fxy`, `.gt`, `.exy`, `.tap`, `.10o`, `.100`, `.inb`, `.new`, `.zxy`, `.stc`, `.emd`, `.jpx`, `.bro`, `.mit`, `.max`, `.zhs`, `.pcd`, `.pcq`, `.pcs`, `.pcm`, `.phb`, `.phc`, `.stx` and `.gcode`. The readers are ported from pyembroidery and checked against it.
- Splits an opened design into shapes (one per run of stitches between jumps, trims and colour changes). Each shape can be recoloured, hidden, moved earlier or later, deleted, or given tie-on, tie-off and trim-after; its stitches keep their exact positions. Lock stitches already in the file are recognised and become the tie switches. "Group by colour" sews each colour in one go.
- Shows a preview in a 100 × 100 mm or 70 × 70 mm hoop. You can move, rotate 90° and mirror the design.
- Connects to the machine over Bluetooth LE and shows its model, serial number and firmware.
- Sends the design in the same stitch format and transfer sequence as Artspira.
- Traces the outline, starts sewing and moves the hoop for a thread change.
- Shows the machine status, errors and progress live, and tells you which thread colour comes next.
- Rotates by any angle and resizes from 80 to 120 %. Undo and redo with Ctrl+Z and Ctrl+Y.
- Shows an estimated sewing time, and the preview draws stitches as shaded thread.
- Resumes an interrupted job, and starts sewing from any stitch (for example after a thread break).
- Changes the machine settings: auto thread cut, jump stitch cut and presser foot height. It can also reset them.
- Shows the stitch counters, warns when maintenance is due and reads the error log.
- Turns a picture (`.png`, `.jpg`, `.bmp`, `.gif`, `.webp`) into embroidery:
  - It reduces the picture to the thread colours you choose, comparing colours the way the eye does (CIE Lab).
  - Thin parts such as lines and letters become satin columns that follow the stroke's centreline, so every stitch crosses the stroke at a right angle, around curves and through forks. A centre-run underlay goes under wider strokes.
  - Wide parts become tatami fill at the angle you choose, over an underlay, with an outline along each edge.
  - It adds pull compensation, travels only inside the shape (never over bare fabric) and drops stitches too short to sew.
  - It removes the background even when it is off-white, shaded or noisy (JPEG), including the holes inside letters and rings. A tolerance slider sets how much counts as background.
- Edits converted pictures and lettering shape by shape, re-stitching each shape when its settings change. Click a shape on the design or in the Objects list, then:
  - change its stitch type (satin, tatami fill or outline only), fill angle, row spacing, stitch length, pull compensation, underlay, edge outline and thread colour;
  - move it earlier or later in the sewing order, or delete it (Delete key). Tab steps through the shapes;
  - convert the picture again with other colours or background settings.
- A stitch player shows the sewing order stitch by stitch.
- Saves as Brother `.pes` (version 1, with thumbnails) in one click, or exports to `.dst`, `.pec`, `.jef`, `.exp`, `.vp3`, `.u01`, `.xxx`, `.tbf` or `.gcode` with a summary of stitches, shapes, colour changes, size and sewing time.
- Updates the machine firmware from Brother's public download server, after checking the file's checksum, model and version.
- Makes lettering from any installed font, and adds text, pictures or other designs under the current one.

## Install

Download the file for your computer from the [latest release](https://github.com/leomargontier/hoopbridge/releases/latest):

| OS | File |
|---|---|
| Debian / Ubuntu | `hoopbridge_<ver>_amd64.deb`: run `sudo apt install ./hoopbridge_*.deb` |
| Linux (other) | `.AppImage` |
| Windows 10/11 | `Hoopbridge Setup <ver>.exe` (installer) or the portable `.exe` |
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
- Artspira also supports Wi-Fi machines and Brother's cutting machines. Wi-Fi machines need Brother's cloud account, so they are not supported. The Snip cutting machine is not supported either: Artspira converts every cut file on a Brother cloud server, and that conversion has no offline equivalent.
- Lettering uses the fonts installed on your computer. Letters smaller than about 5 mm come out rough.
- The picture converter works best with logos and flat colours; photos come out posterised.
- The app has no stitch-by-stitch editor or drawing tools. Combined designs move as one piece; after "Add design…" a converted picture's shapes become fixed-stitch shapes (colour, order, visibility, ties and trims stay editable).
- The firmware updater copies Artspira's steps but has not been run on a real machine. Interrupting an update can leave the machine unusable.

Hoopbridge is not affiliated with Brother Industries. "Brother", "SKITCH" and "Artspira" are trademarks of their owners.
