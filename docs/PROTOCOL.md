# Bookoo Themis Mini — protocol notes as implemented

Source of truth: `BooKooCode/OpenSource/bookoo_mini_scale/protocols.md` (MIT), the version at
commit 6c9f39d (2026-07-30) or later. Implementation: `src/scale/protocol.ts`, tests in
`test/scale/protocol.test.ts`.

## GATT

| Item | UUID | Notes |
|---|---|---|
| Service | `00000ffe-0000-1000-8000-00805f9b34fb` | Filter on this, not the name (fw 1.4.1 was seen advertising a truncated `OOKOO_SC …`). |
| Weight notify | `0000ff11-…` | ~10 Hz, 20-byte frames, type `0x0B`. |
| Command write | `0000ff12-…` | Also notifies undocumented `03 0D / 0C / 0E` frames. Subscribe to both; dispatch on byte 1. |
| DFU | `0000fe59-…` | Nordic Secure DFU, listed only as an optional service. |

Only one central may be connected: close the BOOKOO N app before connecting.

## Weight frame (20 bytes, 0-based)

```
[0]  0x03                header
[1]  0x0B                weight frame
[2..4]  timer ms         u24 big-endian
[5]  unit                observed 0x01 in grams; weight is g×100 regardless
[6]  weight sign         '+' 0x2B or '-' 0x2D; anything else is rejected
[7..9]  weight g×100     u24 big-endian
[10] flow sign           '+' / '-'
[11..12] flow g/s×100    u16 big-endian (EMA-smoothed by the scale; display only)
[13] battery %
[14..15] standby min×10  u16 big-endian; the configured auto-off, not a countdown
[16] buzzer
[17] smoothing flag      1 = on
[18] reserved 0x00
[19] XOR of bytes 0..18
```

Frames with a wrong length, header, checksum or sign byte are dropped and counted
(`checksumFailRate` on the Diagnostics screen).

## Commands (6 bytes)

`03 0A CMD D1 D2 XOR`, XOR over the first five bytes, computed at runtime.

| Command | CMD | D1 D2 | Wire bytes |
|---|---|---|---|
| tare | 01 | 00 00 | `03 0A 01 00 00 08` |
| beep n | 02 | 00 n | `03 0A 02 00 n (0B^n)` |
| auto-off m min (5–30) | 03 | 00 m | `03 0A 03 00 1E 14` for 30 min |
| start timer | 04 | 00 00 | `03 0A 04 00 00 0D` |
| stop timer | 05 | 00 00 | `03 0A 05 00 00 0C` |
| reset timer | 06 | 00 00 | `03 0A 06 00 00 0F` |
| tare + start | 07 | 00 00 | `03 0A 07 00 00 0E` |
| smoothing off / on | 08 | 00 00 / 01 00 | `03 0A 08 00 00 01` / `03 0A 08 01 00 00` |

The official document printed `0A / 0D / 0C / 00` for start / stop / reset / tare+start for a
year; Beanconqueror, aiobookoo and AcaiaArduinoBLE copied them. A test asserts those bytes are
never emitted.

## Timer semantics (misch0n hardware tests, medium confidence)

- `05` freezes the timer, `06` zeroes it only when stopped, `04` does not resume a frozen timer
  (restart = `06` then `04`).
- `04` and `07` are ignored in Auto / Flow-rate mode; they work only in Timer mode. There is no
  mode command. The recorder checks the first `07` of a session: timer still 0 after five frames
  ⇒ "not in Timer mode" warning, app clock used instead.
- The timer ticks 100 ms and runs about 0.7 % slow; `timerDriftPct` is stored per curve.

## Auto-off

5–30 min, default 15. The standby field reports the setting, not the remaining time. The app keeps
its own `autoOffAt` clock and re-sends the auto-off command on "re-arm"; whether that extends
the scale's timer is a field-test item.
