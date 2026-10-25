# Camera stream formats

Many IP cameras listed on insecam.org are linked by a **snapshot** URL that returns a single JPEG. In CamCycle a snapshot shows up as a frozen frame. Some camera brands also serve a live **MJPEG** stream from the same host, which the app plays as video in a plain `<img>` (the `mjpeg` type). This page records which formats have a usable stream and which don't.

Browsers can't play RTSP, and CamCycle doesn't run a relay server, so RTSP-only cameras aren't supported.

**Policy:** cameras that only serve stills are rejected. Reloading a snapshot about once a second was considered and dropped as too slow to be interesting.

## Formats

| Brand | Snapshot URL on insecam | MJPEG stream URL | Result |
|---|---|---|---|
| Panasonic (BB-HCM / BL-C series) | `/SnapshotJPEG?Resolution=640x480&Quality=Clarity&COUNTER` | `/nphMotionJpeg?Resolution=640x480&Quality=Standard` | Stream works. Converted. |
| Panasonic (other models) | `/cgi-bin/camera?resolution=640&quality=1&Language=0&COUNTER` | `/cgi-bin/mjpeg?resolution=640` | Stream works on most. Converted. |
| Vivotek | `/cgi-bin/viewer/video.jpg?r=COUNTER` | `/video.mjpg` | Works on some cameras only. Converted, then checked. |
| Axis | `/jpg/image.jpg?COUNTER` | `/mjpg/video.mjpg` | Works on some cameras only. Converted, then checked. 1 of 2 streamed. |
| Mobotix | `/cgi-bin/faststream.jpg?stream=half&fps=15&rand=COUNTER` | Same URL, already a stream | Plays as is. No conversion. |
| Canon (VB series) | `/-wvhttp-01-/GetOneShot?image_size=640x480&frame_count=1000000000` | Same URL, already a stream (`frame_count` asks for that many frames). `frame_count=0` and `/-wvhttp-01-/video.cgi` also stream. | Plays as is. No conversion. 15 of 16 streamed. |
| webcamXP / webcam 7 (Windows webcam software) | `/cam_1.cgi` (the number is the camera) | Same URL, already a stream | Plays as is. No conversion. 4 of 4 streamed. |
| Unknown brand (`nph-jpeg.cgi`) | `/nph-jpeg.cgi?0` | `/nph-mjpeg.cgi?0` | Stream works. Converted. 2 of 2 streamed. |
| Yawcam (Windows webcam software) | `:<web port>/out.jpg?q=30&id=…&r=COUNTER` (web port is often 8888) | `:8081/video.mjpg` (Yawcam's default stream port) | Stream works when the default port is used. Converted, then checked. 1 of 1 streamed. |
| Bosch (VideoJet) | `/snap.jpg?JpegSize=M&JpegCam=1&r=COUNTER` | None found (`/img/video.mjpeg`, `/img/mjpeg.jpg` and `/video.mjpg` return `400`) | Stills only. 2 of 2. |
| Sony (gen 5) | `/oneshotimage1?COUNTER` | None usable. `/image1` and `/image2` stream H.264, which doesn't play in an `<img>`. `/mjpeg` returns `400`. | Stills only. 2 of 2. Not skipped by discovery, because a Sony camera set to JPEG output would stream at `/image1`. |
| MJPG-Streamer (Raspberry Pi and Linux) | `/?action=stream` | Same URL, already a stream | Plays as is. No conversion. |
| Unknown brand (`img/video.mjpeg`) | `/img/video.mjpeg` | Same URL, already a stream | Plays as is. No conversion. |
| Xiongmai (XMEye) | `/webcapture.jpg?command=snap&channel=1?COUNTER` | None (only RTSP or Xiongmai's own protocol) | Stills only. Skipped by discovery. |

The stream URL goes on the same host and port as the snapshot URL.

## Exceptions found in testing (October 2026)

- **Vivotek:** many cameras have MJPEG switched off and return `400 Bad Request` for `/video.mjpg`. `/video2.mjpg` and `/video3.mjpg` failed on the same cameras. Of 7 tested, 1 streamed and 5 were stills only (the other camera didn't respond).
- **Panasonic `cgi-bin/camera`:** 12 of 14 streamed. `166.159.46.172:81` is a different device (its server reports `mxhttpd`) that returns `403` for every stream path, so it's stills only. One more camera didn't respond in time.
- **Axis:** `212.154.245.179` returned `404` for both `/mjpg/video.mjpg` and the older `/axis-cgi/mjpg/video.cgi`, so it's stills only.
- **Mobotix:** 28 of 29 streamed. `91.214.60.211` returned a single `image/jpeg` from the `faststream.jpg` URL, so it's stills only.

## Where this is handled

- [`tools/discover-cameras.mjs`](../tools/discover-cameras.mjs) (`extractInsecamCamera`) converts snapshot URLs to stream URLs and skips Xiongmai cameras.
- [`tools/insecam-discover.mjs`](../tools/insecam-discover.mjs) only keeps YouTube and HLS cameras, so none of these formats come through it.
- `tools/rejected.json` blocks cameras by their URL. A camera rejected under its old snapshot URL comes back for review once discovery produces its stream URL, because the two URLs don't match.

## Checking a new format

When a new snapshot-style URL turns up, check what the camera returns:

```sh
curl -s -m 5 -o /dev/null -w "%{http_code} %{content_type}\n" "http://<host>/<path>"
```

- `multipart/x-mixed-replace` is an MJPEG stream and will play.
- `image/jpeg` is a single still.

The `COUNTER` (or `rand=COUNTER`, `r=COUNTER`) in insecam URLs is a placeholder that insecam's own viewer replaces to force a reload. The camera ignores it.
