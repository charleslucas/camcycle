# CamCycle

A static web app (PWA) that shuffles through live public webcams on a timer. It's built to run fullscreen in a TV browser (Fire TV Silk) or on a phone. There's no build step and no server code.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `cameras.json` | The camera list (edit this to add or remove cameras) |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA install support and offline app shell |
| `tools/check-cameras.mjs` | Checks which cameras are currently live |

## Run locally

A plain `file://` open won't work, because YouTube embeds need a real origin. Serve the folder instead:

```sh
python -m http.server 8000
# then open http://localhost:8000
```

## Deploy to GitHub Pages

1. Create an empty public repo on GitHub, for example `camcycle`.
2. Push this folder:
   ```sh
   git remote add origin https://github.com/<you>/camcycle.git
   git push -u origin main
   ```
3. In the repo, open **Settings → Pages**, set **Source** to "Deploy from a branch", and pick `main` and `/ (root)`.
4. After a minute or so the site is live at `https://<you>.github.io/camcycle/`.

## Using it on a Fire TV Stick

1. Install **Amazon Silk** from the Fire TV app store if it isn't already installed.
2. Open the site URL. Typing on a TV is slow, so bookmark it once in Silk.
3. Press **Start**, then **⛶** for fullscreen.

On a remote or keyboard:

| Key | Action |
|---|---|
| → or ⏭ | Next camera |
| ← or ⏮ | Previous camera |
| Space or ⏯ | Pause or resume the shuffle timer (the video keeps playing) |
| M | Sound on/off |
| F | Favorite |
| L | Camera list |

Silk usually moves an on-screen cursor with the D-pad, so you can also point at the buttons and press the select button.

## URL options

These are handy for a TV bookmark:

| Option | Example | Effect |
|---|---|---|
| `cat` | `?cat=beaches` | Start in a category (`all`, `favorites` or any category name in `cameras.json`) |
| `t` | `?t=300` | Seconds per camera |
| `sound` | `?sound=1` | Start with sound on (the browser may still force mute until you interact) |
| `autostart` | `?autostart=1` | Skip the Start screen |

Example: `https://<you>.github.io/camcycle/?cat=nature&t=120&autostart=1`

Settings changed in the app (category, timer, sound, favorites) are remembered per device.

## Camera list format

```json
{ "id": "unique-id", "name": "Display name", "type": "youtube", "videoId": "11-char id",
  "channelId": "UC…", "category": "beaches", "location": "City, Region", "country": "US",
  "credit": "Shown on screen as Source: …", "source": "https://page where the owner publishes it" }

{ "id": "unique-id", "name": "Display name", "type": "hls", "url": "https://…/playlist.m3u8",
  "category": "traffic", "location": "City, Region", "country": "US", "source": "https://…" }
```

- **YouTube:** the stream's owner must allow embedding. Live video IDs sometimes change when a channel restarts its stream. If the video fails, the app falls back to the channel's current live stream, which is why `channelId` matters.
- **HLS:** the URL must be `https`, and the server must send CORS headers (`Access-Control-Allow-Origin`). Otherwise browsers won't play it outside Safari.
- Only add cameras that their owners publish on purpose (parks, DOTs, tourism boards, zoos and so on). Don't use "insecure camera" directories.

Cameras that fail to load are skipped automatically and retried after 2 hours. To retry them sooner, open the camera list (☰) and choose **Retry skipped cameras**.

The app re-downloads `cameras.json` every hour, so a TV left running picks up list changes without a reload, and the camera on screen keeps playing.

## Checking camera health

```sh
node tools/check-cameras.mjs          # report
node tools/check-cameras.mjs --prune  # also delete dead entries from cameras.json
```

## Roadmap

- Chromecast: a Cast receiver page that runs the shuffle on the TV, with Android or Chrome as the remote.
- More sources, such as the Windy webcam API, and snapshot (JPEG) cameras.
- A scheduled GitHub Action that runs the health check.
