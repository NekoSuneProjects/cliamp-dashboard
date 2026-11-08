# CLIAMP RTMP Dashboard

A lightweight, authenticated Node.js control panel for turning existing CLIAMP radio streams into **720p RTMP/RTMPS live video**. Intended to run on a VPS or a dedicated encoding machine, **not** on the Raspberry Pi hosting CLIAMP.

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

**One video encode per station, not per publishing platform.** FFmpeg's tee muxer duplicates encoded packets to several RTMP destinations with on-failure isolation via FIFO. This substantially reduces processing compared with four separate encodes per destination, but **four 720p stations still require four encoders**. Monitor VPS CPU and test with one station before enabling all four. The initial implementation uses software libx264, 15fps, ultrafast, and 1500kbps by default. Hardware encoding, browser graphics, album art updates, fault-restart policies, remote workers and platform-specific OAuth are future extensions.

## Deploy on the VPS

1. Clone this branch onto the VPS.
2. Copy `.env.example` to `.env`; set a strong unique password.
3. Run `mkdir -p data && sudo chown -R 1000:1000 data` if your bind mount is root-owned.
4. Run `docker compose up -d --build`.
5. Open `http://VPS-IP:8096` in a browser. Put it behind HTTPS with restricted access before exposing it publicly.
6. Add a station using its CLIAMP HLS audio URL (for example `https://radio.example.org/monstercat-music/vrchat/index.m3u8`) or an HTTP audio stream.
7. Add RTMP destinations using their complete publishing URLs including stream keys.
8. Save, then press **Start**.

The stream key stays on the VPS in `data/stations.json`; API responses do not return it. Keep `data/`, `.env`, and container logs private. Basic authentication must be protected with HTTPS or a private VPN; do not expose the raw HTTP control panel directly to the internet. Do not pass an untrusted URL or malicious media source to FFmpeg.

### Example station settings

| Setting | Example |
|---|---|
| Name | Monstercat Music |
| Audio URL | `https://radio.example.org/monstercat-music/vrchat/index.m3u8` |
| Resolution | fixed 1280 × 720 |
| FPS | 15 (default) |
| Video bitrate | 1500 kbps |
| Optional artwork | `/data/art/station.png` (absolute worker-local path) |
| Destination | `rtmps://ingest.example.org/live/YOUR_STREAM_KEY` |

No audio player changes are required on the Raspberry Pi. CLIAMP's existing HLS output remains available to listeners and VRChat.

### Notes and limitations

- If `imagePath` is omitted, a static dark background is used. Add artwork to the worker container using a volume mount before supplying an absolute path. Do **not** assume a Pi-local artwork path exists in the VPS container.
- Image changes are not dynamic in this version; save/stop/start a station to update.
- FFmpeg failure stops that station; the UI shows an error when a process exits. Automatic recovery is not implemented in this first version.
- Not all HLS sources offer audio streams compatible with FFmpeg. Test the source manually using `ffprobe` or `ffmpeg`.
- Editing a running station stops it. Restart manually once you've saved.
- The RTMP targets must accept H.264 video and AAC audio. Platforms may impose additional bitrate, frame-rate, duration, or keyframe rules.
- The tee muxer reports encoder-process health, not independent downstream platform health. A station appearing 'running' does not prove every destination is connected or live.
- Run this on an appropriately sized VPS; a weak VPS may also struggle with four 720p software encodes. Do not mistake 720p output dimensions for 720p-quality animation; the starter output is a low-frame-rate static card.
- No OAuth integration or NekoLive/CastNexus API integration is included in this starter version.
- Protect the JSON storage with file permissions and regular backups. Avoid exposing the management port directly.

## API (Basic authentication)

- `GET /api/stations`: list stations without secrets
- `POST /api/stations`: add a station
- `PUT /api/stations/:id`: update station, retaining existing destination secrets when URL fields are empty
- `DELETE /api/stations/:id`: delete station
- `POST /api/stations/:id/start`: start station
- `POST /api/stations/:id/stop`: stop station

## Future development

- Remote Pi dashboard controlling one or more dedicated FFmpeg workers
- Ingest from HLS, Icecast, or direct CLIAMP metadata API
- Auto-generated 720p artwork/track title overlay
- Continuous artwork refresh without restarting output
- Per-destination monitoring and retry/recovery
- Hardware encoder selection and worker capacity checks
- Secure per-platform presets with encrypted credential storage
- Streaming analytics, bitrate monitoring, and failover
