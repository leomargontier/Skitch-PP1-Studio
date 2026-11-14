# Brother SKITCH PP1 protocol notes

These notes come from Brother Artspira 2.9.10 (`com.brother.ph.mobile.craftsewing`, versioncode 1150). The sources are the decompiled .NET assemblies (`Asura.Core`, `Asura.android`, `MobileEmb`) and `libPP1_PESX_SharedLib.so` (`ConvertPesx`, disassembled with Ghidra).

## Bluetooth LE

| Item | UUID |
|---|---|
| Service | `a76eb9e0-f3ac-4990-84cf-3a94d2426b2b` |
| Write characteristic (write with response) | `a76eb9e2-f3ac-4990-84cf-3a94d2426b2b` |
| Read characteristic (read) | `a76eb9e1-f3ac-4990-84cf-3a94d2426b2b` |

Artspira scans with a service-UUID filter and requests an MTU of 512. Each write carries at most `min(500, MTU-12)` data bytes.

To send a request, write `[cmd u16 big-endian][payload]`. To get the response, read the read characteristic. The response is `[cmd u16 BE][status u8][...]`. Artspira serializes all requests: one write, then one read.

## Commands

| Cmd | Name | Payload → response |
|---|---|---|
| `0x0000` | Machine info | → info block (see below) |
| `0x0001` | Machine state | → `[2]` status, `[4]` error code (238 = none) |
| `0x0100` | Service counters | → stitches since service (u32 LE), total stitches (u32 LE) |
| `0x0103` | Maintenance check | → `[2]==1` means maintenance is due |
| `0x0702` | Get current job UUID | → 16 bytes |
| `0x0704` | Mask trace (when the "jump cut" setting is on) | `[0]` |
| `0x0705` | Layout | 24 bytes, see below |
| `0x0706` | Design info | → left, top, right, bottom, total time, total stitches (u16), speed (i16 LE) |
| `0x0707` | Sewing monitor | → current stitch (u16), time, stop time, x, y (i16 LE) |
| `0x0708` | Delete design on machine | |
| `0x0709` | Set start stitch | `u16 LE` |
| `0x070A` | Set job UUID | 16 bytes → `[2]==0` OK |
| `0x070B` | Resume flag | → `[2]==1` means an interrupted job can be resumed |
| `0x070C` | Resume | → `[2]==0` OK. Artspira offers it only when the `0x0702` job UUID matches the job it sent. |
| `0x070E` | Start sewing | |
| `0x070F` | Hoop avoidance (move hoop away) | |
| `0x0710` | Mask trace with box | TL, BR, centre as i16 LE pairs, 0.1 mm from hoop centre |
| `0x0800` | Embroidery origin | |
| `0x0B00` | Firmware update start | Firmware list: `https://download.brother.com/pub/com/phc_pcs_oneclickupdate/frm/pp1/SewingMachine_upf.json` (public, no login) |
| `0x0C00` | Settings reset | → `[2]==0` OK |
| `0x0C01` | Settings set | `[autoCut u8][jumpCut u8][buzzer u8 = 1][foot height u8: 1 standard, 2 high][speed u16 LE = 400]` → `[2]==0` OK. Artspira refuses while sewing. |
| `0x0C02` | Settings get | → same layout as set |
| `0x1200` | Data info | `[3][len u32 LE][sum of all bytes u16 LE]` → `[2]==0` OK |
| `0x1201` | Data chunk (no read) | `[offset u32 LE][bytes][sum of chunk u8]` |
| `0x1300` | Clear error | `[error code u8]` |
| `0x1301` | Error log | → raw bytes. Artspira only uploads them to Brother. |

After the last chunk, keep reading until the machine answers `[2]==0`. A value of `2` means it is still busy, so wait 1 s and read again. A value of `1` means the transfer failed.

### Transfer sequence (Artspira)

1. `0x0708` deletes the old design.
2. `0x1200` sends the data info, then `0x1201` sends the chunks. Poll for completion.
3. `0x0705` sends the layout: `MoveX, MoveY, SizeX=100, SizeY=100, Rotate=0` as i16 LE, then `Flip u8` and `Frame u8` (0 = 70 mm, 1 = 100 mm). Then come the design box TL, BR and centre, relative to the hoop centre, in 0.1 mm.
4. `0x070A` sends a random 16-byte job UUID.
5. Optional: `0x0710` traces the outline. Then `0x070E` starts sewing (machine status 17 = ready to sew).

### Status codes

0 initial · 1 lower thread · 16 ready (no data) · 17 ready to sew · 18 receiving · 32/33/34 mask trace (lock wait / tracing / done) · 48 sewing · 49 finished · 50 interrupted · 64 thread change · 65 paused · 66 stopped · 80/81 hoop avoidance · 96/97 receiving/received.

### Info block (`0x0000` response, after the 2-byte echo)

The firmware version is the BE i16 at offset 0, divided by 100, plus the BE i16 at offset 35 as the minor version. The serial number is ASCII at offsets 2–10. The product number is at byte 11. The Bluetooth version is the BE i16 at offset 24, and the model is at byte 26. The maximum width and height are LE i16 values at offsets 29 and 31. The model code is ASCII at offsets 39–49.

## PEN stitch data

The PEN stream has no header. Each needle position is one 4-byte record:

```
u16le  (x << 3) | xflag      xflag: 3 = last stitch of a colour, 5 = last record
u16le  (y << 3) | yflag      yflag: bit0 FEED (move without sewing), bit1 CUT thread before the move
```

`x` and `y` are signed, in 0.1 mm, and relative to the design centre, with y pointing down.

Artspira's converter also does the following:

- It starts each colour with a FEED record, then two tie-in stitches. A tie-in stitch goes 0.8 mm toward the next stitch and comes back. The offset is truncated, not rounded.
- It cuts (`FEED|CUT` on the target, with a tie-off first) before any hop of 5.1 mm or more. It does this even when the source file asked for a trim, and it ignores trims on shorter hops.
- On a short hop, it sets FEED on both the last stitch and the target.
- It ties off before a colour change and sets the colour flag on the last stitch of that colour. It does not tie off at the end of the design.

## Firmware update (Artspira `BLESoftwareUpdateManager`)

1. Read the firmware list from `SewingMachine_upf.json`. Pick the newest entry where `type` equals the info block's model (byte 26, 0 means 2) and `oem` equals byte 27 (0 means 1).
2. Download `dl_url` and check it against `filemd5`.
3. Send `0x1200` with `[4][len u32 LE][sum u16 LE]`, then the file in `0x1201` chunks, the same way as stitch data.
4. Read until `[2]==0` and the u32 LE at `[3..6]` equals the file length. A value of `[2]==1` means the data was rejected.
5. Send `0x0B00` with the chip byte. The `.upf` header is `[count]` followed by 9-byte entries whose first byte is the chip (1 main, 2 Bluetooth). Send 3 when the file updates both. The machine reboots.

## Snip cutting machine

The Snip uses its own command set (`SnipBLEDeviceManager`). Artspira does not send FCM cut files directly. It posts them to a Brother AWS Lambda, which converts them to a compressed FCN format, and the app has no offline converter. Without FCN samples captured from a real machine, the Snip cannot be supported offline.
