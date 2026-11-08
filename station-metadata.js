// Read-only CLIAMP metadata client. Runs independently of video publishing.
const validStationId = id => typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id);
export function sourceIdFor(station, baseURL) {
  if (validStationId(station.sourceId)) return station.sourceId;
  if (!baseURL) return '';
  try {
    const base = new URL(baseURL), audio = new URL(station.audioUrl);
    // Only infer from the trusted, configured CLIAMP server.
    if (base.origin !== audio.origin) return '';
    const m = /^\/([a-z0-9-]{1,64})\/(?:stream|vrchat\/index\.m3u8)$/.exec(audio.pathname);
    return m ? m[1] : '';
  } catch { return ''; }
}
export async function readMetadata(baseURL, sourceId, signal) {
  if (!baseURL || !validStationId(sourceId)) throw Error('CLIAMP station ID not configured');
  const url = new URL('/api/v1/radios/' + sourceId, baseURL);
  const response = await fetch(url, { signal, headers: { accept: 'application/json' }, redirect: 'error' });
  if (!response.ok) throw Error('CLIAMP API returned HTTP ' + response.status);
  const body = await response.text();
  if (body.length > 64_000) throw Error('CLIAMP metadata response too large');
  const data = JSON.parse(body);
  const now = data.now_playing ?? {};
  const trim = value => typeof value === 'string' ? value.slice(0, 240).trim() : '';
  return { title: trim(now.title), artist: trim(now.artist), album: trim(now.album), online: data.online === true };
}
