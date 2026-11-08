// Broadcast destination types use one encoded H.264/AAC stream, but different muxers.
// SRT publishing is caller-mode MPEG-TS; RTMP and RTMPS publishing use FLV.
export const PROTOCOLS = Object.freeze(['rtmp', 'rtmps', 'srt']);

export function outputProtocol(destination) {
  const value = String(destination?.protocol || '').trim().toLowerCase();
  if (value && !PROTOCOLS.includes(value)) throw Error('Unsupported destination type');
  const url = String(destination?.url || '').trim();
  if (!url) return value || 'rtmp';
  let parsed;
  try { parsed = new URL(url); } catch { throw Error('Invalid publishing URL'); }
  const scheme = parsed.protocol.slice(0, -1);
  if (!PROTOCOLS.includes(scheme)) throw Error('Publishing URL must start with rtmp://, rtmps:// or srt://');
  if (value && value !== scheme) throw Error('Destination protocol does not match its URL');
  if (!parsed.hostname || parsed.username || parsed.password) throw Error('Publishing URL must have a host without user-info credentials');
  if (scheme === 'srt') {
    if (!parsed.port) throw Error('SRT destination requires an explicit UDP port');
    const mode = parsed.searchParams.get('mode');
    if (mode && mode !== 'caller') throw Error('SRT publishing requires mode=caller');
    if (!mode) parsed.searchParams.set('mode', 'caller');
    const pass = parsed.searchParams.get('passphrase');
    if (pass && (pass.length < 10 || pass.length > 79)) throw Error('SRT passphrase must be 10–79 characters');
  }
  return scheme;
}

export function validatePublishingUrl(url, selectedProtocol) {
  const candidate = {url, protocol:selectedProtocol};
  const protocol = outputProtocol(candidate);
  const parsed = new URL(url);
  if (protocol === 'srt' && !parsed.searchParams.has('mode')) parsed.searchParams.set('mode','caller');
  return {protocol, url:parsed.href};
}

function escapeTeeUrl(value) {
  // Escape tee's slave separator, the bracket delimiters and the escape character.
  // Colons in URLs are not option separators outside the leading [options] block.
  return String(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|')
    .replaceAll('[', '\\[').replaceAll(']', '\\]');
}

export function teeOutput(destinations) {
  const active = destinations.filter(d => d.enabled !== false && d.url);
  if (!active.length) throw Error('No enabled publishing destinations');
  return active.map(destination => {
    const {protocol, url} = validatePublishingUrl(destination.url, destination.protocol);
    const format = protocol === 'srt' ? 'mpegts' : 'flv';
    // FIFO isolates slow or disconnected destinations; a failed output won't halt the others.
    return '[f=' + format + ':onfail=ignore:use_fifo=1]' + escapeTeeUrl(url);
  }).join('|');
}

export function redactPublishingURLs(value) {
  return String(value).replace(/(?:rtmps?|srt):\/\/[^\s"']+/gi, '[publishing destination redacted]');
}
