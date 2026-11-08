# CLIAMP RTMP / SRT Dashboard

A lightweight, authenticated Node.js control panel for turning existing CLIAMP radio streams into **720p RTMP/RTMPS live video**. Intended to run on a VPS or a dedicated encoding machine, **not** on the Raspberry Pi hosting CLIAMP.

## CLIAMP integration (implemented)

This dashboard now uses the real API in `NekoSuneProjectsForks/cliamp-server`:

- `GET /api/v1/radios` discovers all configured station IDs and names.
- `GET /api/v1/radios/{stationId}` retrieves now-playing artist and title.
- `GET /{stationId}/art.png` retrieves the current-song artwork, refreshed at most every 30 seconds or immediately when the song changes.
- `GET /{stationId}/stream` supplies original MP3 radio audio directly to FFmpeg. This avoids decoding and upscaling the Pi's low-resolution VRChat HLS output.
- The VPS synthesizes its own 1280×720 title/cover artwork, renders a cached JPEG on metadata changes and feeds it to FFmpeg at a configurable low frame rate. The Raspberry Pi performs no new 720p encoding.
- FFmpeg is supervised with exponential reconnect delay and supports optional autostart after dashboard container restart.

Set `CLIAMP_BASE_URL=https://radio.nekosunevr.co.uk` in `.env`, choose **Import CLIAMP radios** on the dashboard, and configure the full publishing URL of each RTMP platform. **Import does not start broadcasting** until destinations are configured and Start is pressed (or autostart is enabled and the container restarts).

## Architecture

```text
Raspberry Pi 5: CLIAMP HLS/audio stations
             |
             | HTTP(S) HLS / audio
             v
VPS: CLIAMP RTMP Dashboard + FFmpeg
             |
             +-- Station 1: one 720p H.264/AAC encoder -> multiple RTMP endpoints
             +-- Station 2: one 720p H.264/AAC encoder -> multiple RTMP endpoints
             +-- Station 3: one 720p H.264/AAC encoder -> multiple RTMP endpoints
             +-- Station 4: one 720p H.264/AAC encoder -> multiple RTMP endpoints
```

**One video encode per station, not per publishing platform.** FFmpeg's tee muxer duplicates encoded packets to several RTMP destinations with on-failure isolation via FIFO. This substantially reduces processing compared with four separate encodes per destination, but **four 720p stations still require four encoders**. Monitor VPS CPU and test with one station before enabling all four. The current implementation uses software libx264, **1fps by default**, ultrafast and 1500kbps. Choose 5–15fps for more fluid visuals if your VPS can handle the load. Hardware encoding, browser graphics, album art updates, fault-restart policies, remote workers and platform-specific OAuth are future extensions.

## Deploy on the VPS

1. Clone this branch onto the VPS.
2. Copy `.env.example` to `.env`; set a strong unique password.
3. Run `mkdir -p data && sudo chown -R 1000:1000 data` if your bind mount is root-owned.
4. Run `docker compose up -d --build`.
5. Set `CLIAMP_BASE_URL` in `.env` to the base URL of the existing Pi radio service.
6. Open `http://VPS-IP:8096` in a browser. Put it behind HTTPS with restricted access before exposing it publicly.
7. Click **Import CLIAMP radios** or add a station using its CLIAMP HLS audio URL (for example `https://radio.example.org/monstercat-music/vrchat/index.m3u8`) or an HTTP audio stream.
8. Add RTMP destinations using their complete publishing URLs including stream keys.
9. Save, then press **Start**.

The stream key stays on the VPS in `data/stations.json`; API responses do not return it. Keep `data/`, `.env`, and container logs private. Basic authentication must be protected with HTTPS or a private VPN; do not expose the raw HTTP control panel directly to the internet. Do not pass an untrusted URL or malicious media source to FFmpeg.

### Example station settings

| Setting | Example |
|---|---|
| Name | Monstercat Music |
| Audio URL | `https://radio.example.org/monstercat-music/vrchat/index.m3u8` |
| Resolution | fixed 1280 × 720 |
| FPS | 1 (default; 2 or 5 is another lightweight choice) |
| Video bitrate | 1500 kbps |
| Artwork | Automatically fetched from CLIAMP `/<id>/art.png` |
| Destination | `rtmps://ingest.example.org/live/YOUR_STREAM_KEY` |

No audio player changes are required on the Raspberry Pi. CLIAMP's existing HLS output remains available to listeners and VRChat.

### Notes and limitations

- Station artwork is fetched from CLIAMP with a 4 MiB limit. If it is unavailable, the VPS renders a dark card showing the station and song information. This version does not support custom uploaded background videos.
- Cover changes are detected at most once every 30 seconds, and immediately when CLIAMP now-playing metadata changes. The VPS re-renders JPEG artwork without restarting FFmpeg.
- Unexpected FFmpeg exits trigger automatic reconnect attempts with backoff. This does not yet verify each RTMP destination separately.
- Not all HLS sources offer audio streams compatible with FFmpeg. Test the source manually using `ffprobe` or `ffmpeg`.
- Editing a running station stops it. Restart manually once you've saved.
- The RTMP targets must accept H.264 video and AAC audio. Platforms may impose additional bitrate, frame-rate, duration, or keyframe rules.
- The tee muxer reports encoder-process health, not independent downstream platform health. A station appearing 'running' does not prove every destination is connected or live.
- Run this on an appropriately sized VPS; a weak VPS may also struggle with four 720p software encodes. Do not mistake 720p output dimensions for 720p-quality animation; the starter output is a low-frame-rate static card.
- No OAuth integration or NekoLive/CastNexus API integration is included. RTMP/RTMPS publishing URLs are configured manually.
- Protect the JSON storage with file permissions and regular backups. Avoid exposing the management port directly.

## API (Basic authentication)

- `GET /api/discover`: discover stations from CLIAMP via the configured base URL
- `POST /api/import`: create local station entries for any discovered stations not already imported
- `GET /api/stations`: list stations without secrets
- `POST /api/stations`: add a station
- `PUT /api/stations/:id`: update station, retaining existing destination secrets when URL fields are empty
- `DELETE /api/stations/:id`: delete station
- `POST /api/stations/:id/start`: start station
- `POST /api/stations/:id/stop`: stop station


## RTMP, RTMPS, SRT, RTSP and VRChat RTSPT publishing

Choose the format for each destination in the dashboard. **RTMPS was already supported** and remains available. An RTSP-compatible server such as MediaMTX is required to *receive* RTSP publishing; FFmpeg cannot create a multi-client RTSP viewer server from a URL alone.

| Destination selector | Example publishing URL | Transport / FFmpeg output |
|---|---|---|
| RTMP | `rtmp://relay.example/live/key` | FLV over RTMP |
| RTMPS | `rtmps://relay.example/live/key` | FLV over TLS |
| SRT | `srt://relay.example:9000?mode=caller&latency=200000` | MPEG-TS over SRT UDP |
| RTSP | `rtsp://relay.example:8554/radio` | RTSP ANNOUNCE, UDP transport |
| RTSPT (VRChat TCP style) | `rtspt://relay.example:8554/radio` | Internally translated to `rtsp://`, RTSP ANNOUNCE with TCP transport |

**Important:** `rtspt://` is a **VRChat player-side URL convention**, not a supported FFmpeg protocol. The dashboard translates it when publishing. Your streaming server must support RTSP publishing (ANNOUNCE/RECORD) and distribute the stream to viewers. RTSP URL compatibility varies by VRChat player and build; some Quest clients only accept `rtsp://` while PC players may require `rtspt://`. A live receiver and each intended VRChat client should be tested before relying on cross-platform playback. No direct VRChat playback server is bundled in the dashboard.

### Optional RTSP relay for VRChat playback

If you don't already have an RTSP server that accepts publishers, run the provided optional MediaMTX relay alongside the GHCR dashboard. It is **not** included in the GHCR application image:

```bash
docker compose -f compose.ghcr.yml -f compose.rtsp-relay.yml up -d
```

The relay is on the same Docker network as the dashboard. In the dashboard add a **RTSPT** publishing destination pointing at:

```text
rtspt://mediamtx:8554/monstercat-music
```

FFmpeg will translate that to `rtsp://mediamtx:8554/monstercat-music` and publish using TCP. For a VRChat player outside Docker, try these **viewer** addresses using the VPS public hostname, not the Docker service hostname:

```text
rtsp://YOUR-VPS-HOST:8554/monstercat-music
rtspt://YOUR-VPS-HOST:8554/monstercat-music
```

The included MediaMTX profile enables **TCP only** to avoid Docker's UDP/NAT issues. VRChat Quest/Android versus PC RTSP support depends on client version and video-player implementation; Quest may require UDP or an updated player, and therefore this optional TCP-only setup is **not guaranteed** to work on both clients. For broader RTSP UDP/TCP support, configure a dedicated MediaMTX service with host networking and firewall/authentication suited to your deployment.

**Security:** the example relay has no publisher authentication by default and exposes port 8554/TCP. Do not expose it to untrusted networks without configuring MediaMTX authentication and appropriate firewall rules. Restrict access while testing.

### FFmpeg exit 234 / tee outputs failed

The previous FFmpeg argument builder contained a badly escaped `fifo_options` string (for example the trailing `er_any_error'` in the reported log). That could cause FFmpeg's tee output to fail with an invalid argument. The new builder removes that malformed string and uses separate muxer options for each supported destination. We successfully tested the corrected tee syntax locally with simultaneous FLV and MPEG-TS file outputs. This is not a live RTMP/RTSP/SRT receiver test.

If you still see `All tee outputs failed` after upgrading: verify the server address, publishing stream key, network reachability, output protocol/port, and whether the receiver accepts the incoming format. RTSP uses port 8554 in the example; SRT needs outbound UDP; RTMPS needs TLS. Low 1 FPS output can also be rejected by some platforms. FFmpeg logs are exposed through the worker error with publishing URLs redacted.


## SRT restreaming (PR #3)

Stations can now publish **RTMP, RTMPS and SRT simultaneously** using one 720p H.264/AAC encode per station. Choose the protocol separately for each destination in the NekoSune dashboard. RTMP/RTMPS is muxed as FLV; SRT is muxed as **MPEG-TS**.

For example, add an SRT destination:

```text
Protocol: SRT
Name: Remote SRT ingest
Publishing URL: srt://ingest.example.org:9000?mode=caller&latency=200000
```

The destination must be a reachable **SRT listener**, and the VPS must be allowed to make outbound UDP connections to its port. This feature publishes using SRT **caller** mode only; it does not create a public inbound SRT ingest listener. Use an SRT relay/receiver such as your media server or a configured FFmpeg listener. A passphrase can be supplied in the URL with `passphrase` (10–79 characters) and matching receiver settings. If encrypting, configure the receiver's matching `pbkeylen` as needed.

SRT publishing URLs may contain sensitive passphrases or stream IDs. Treat `data/stations.json` as private. The API returns only the destination name, protocol, enabled/configured state and generated ID—not the full URL. The worker redacts publishing URLs in its captured errors.

**Limits:** The SRT output currently sends MPEG-TS with the same low-FPS 720p video as RTMP, and shares the encoding budget. Platform-specific SRT stream ID / encryption parameters must be entered in the URL. FFmpeg-process status is not proof every destination is receiving media; verify the actual SRT receiver. Some destinations require frame rates higher than 1 FPS.


## Future development

- Remote Pi dashboard controlling one or more dedicated FFmpeg workers
- Ingest from HLS, Icecast, or direct CLIAMP metadata API
- Optional animated 720p background/video modes
- Artwork/layout themes and accessible text-fitting for long track titles
- Accurate per-destination monitoring and retry/recovery (the worker currently only monitors FFmpeg itself)
- Hardware encoder selection and worker capacity checks
- Secure per-platform presets with encrypted credential storage
- Streaming analytics, bitrate monitoring, and failover


## GitHub-hosted Docker publishing (main only)

Docker images are **built and pushed by GitHub-hosted** `ubuntu-latest` runners, not your Raspberry Pi or VPS. The workflow is `.github/workflows/docker-publish.yml`. It runs **only on pushes to `main`** that change Docker/application files; it does not run for PRs or feature branches. There is no manual or scheduled publish trigger. PRs still run JavaScript syntax and unit tests in CI, without Docker builds.

The multi-architecture image is published to:

```text
ghcr.io/nekosuneprojects/cliamp-dashboard:latest
ghcr.io/nekosuneprojects/cliamp-dashboard:sha-<commit>
```

Supported Linux architectures: `amd64` and `arm64`. The workflow logs in to GHCR using GitHub's built-in `GITHUB_TOKEN`, with `packages: write` scoped to its publish job. No personal access token is needed. The GHCR package may initially be **private** even when the repository is public. If you want anonymous pulls, open the package's settings on GitHub and explicitly change its visibility to **Public** after the first successful publication.

### Pull the release on your VPS

After merging this PR into `main` and the first successful GHCR publish:

```bash
cp .env.example .env
nano .env
mkdir -p data
sudo chown -R 1000:1000 data
docker compose -f compose.ghcr.yml pull
docker compose -f compose.ghcr.yml up -d
```

`compose.ghcr.yml` uses the published image directly; unlike the development `docker-compose.yml`, it does **not** build the image locally. If the package remains private, Docker login to GHCR is needed on the VPS. Keep the dashboard behind HTTPS or a private VPN.



## Missing cover artwork (VPS fallback)

The VPS worker first requests `/<station>/art.png` from CLIAMP. That endpoint may return 404 when no cover has been saved by CLIAMP's optional VRChat HLS visual system, even if the stream is playing normally. In this case, the worker performs an artist/title-matched lookup against Apple's public iTunes search API and uses a matching cover when available. If the catalogue has no exact match or networking is unavailable, a 390×390 **CD jewel-case** placeholder with a visible reflective compact disc, transparent plastic lid and LIVE RADIO label is rendered instead. The last valid image persists through short failures and worker reconnects. No extra API key is needed.

On the VPS, allow outbound HTTPS to the configured CLIAMP host, `itunes.apple.com`, and approved `mzstatic.com` artwork hosts. Covers are capped at 4 MiB. This fallback does not guarantee artwork exists for every independent track; to enforce a particular cover, add it to CLIAMP's saved per-track artwork library.

