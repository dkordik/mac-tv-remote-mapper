// Client for the ymc-500-remote service, which drives the receiver and tracks its
// volume/mute. That service is the source of truth: we display what it reports, send it
// one key request per remote press, and never keep our own volume model or retry presses.
//
// Status comes from its /receiver/events Server-Sent Events stream; while the stream is
// down we fall back to polling /receiver/status. The latest value is cached so the CEC
// audio system can answer the TV instantly.

const http = require('http');
const https = require('https');

const UNKNOWN_AUDIO_STATUS = 0x7f;
const RECEIVER_KEYS = {
  volume_up: 'vol+',
  volume_down: 'vol-',
  mute: 'mute',
};

function createReceiverStatus(options = {}) {
  const baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
  const volumeMax = Number(options.volumeMax) > 0 ? Number(options.volumeMax) : 100;
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 5000;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 2000;
  const verbose = Boolean(options.verbose);
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

  let cecByte = UNKNOWN_AUDIO_STATUS;
  let stopped = true;
  let pollTimer = null;
  let reconnectTimer = null;
  let reconnectMs = 2000;
  let eventsRequest = null;
  let streamConnected = false;
  let inFlight = false;
  let lastError = '';

  // <Report Audio Status> operand: bit 7 = mute, bits 0-6 = volume 0-100.
  function toCecByte(status) {
    if (!status || typeof status.volume !== 'number') {
      return UNKNOWN_AUDIO_STATUS;
    }
    const percent = Math.max(0, Math.min(100, Math.round((status.volume / volumeMax) * 100)));
    return (status.muted ? 0x80 : 0) | percent;
  }

  function applyStatus(status) {
    const next = toCecByte(status);
    if (next !== cecByte) {
      cecByte = next;
      onChange(cecByte);
    }
  }

  function logErrorOnce(context, err) {
    const cause = err && err.cause ? err.cause.code || err.cause.message : '';
    const message = `${context}: ${err && err.message}${cause ? ` (${cause})` : ''}`;
    if (verbose && message !== lastError) {
      console.error(`Receiver ${message}`);
    }
    lastError = message;
  }

  // --- Fallback polling (only while the event stream is down) ---

  async function refresh() {
    if (!baseUrl || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const res = await fetch(`${baseUrl}/receiver/status`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      applyStatus(await res.json());
    } catch (err) {
      // Keep the last known value.
      logErrorOnce('status unavailable', err);
    } finally {
      inFlight = false;
    }
  }

  function startPolling() {
    if (pollTimer || stopped) {
      return;
    }
    refresh();
    pollTimer = setInterval(refresh, pollMs);
    pollTimer.unref();
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // --- Event stream ---

  function scheduleReconnect() {
    streamConnected = false;
    eventsRequest = null;
    if (stopped || reconnectTimer) {
      return;
    }
    startPolling();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectEvents();
    }, reconnectMs);
    reconnectTimer.unref();
  }

  function handleEvent(eventName, data) {
    if (eventName !== 'status' || !data) {
      return;
    }
    try {
      applyStatus(JSON.parse(data));
    } catch (err) {
      logErrorOnce('bad status event', err);
    }
  }

  function connectEvents() {
    if (stopped || eventsRequest) {
      return;
    }
    const url = new URL(`${baseUrl}/receiver/events`);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        logErrorOnce('events unavailable', new Error(`HTTP ${res.statusCode}`));
        scheduleReconnect();
        return;
      }

      streamConnected = true;
      lastError = '';
      stopPolling();
      if (verbose) {
        console.log('Receiver event stream connected');
      }

      res.setEncoding('utf8');
      let buffer = '';
      let eventName = 'message';
      let dataLines = [];
      res.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line === '') {
            handleEvent(eventName, dataLines.join('\n'));
            eventName = 'message';
            dataLines = [];
          } else if (line.startsWith(':')) {
            // Keep-alive comment.
          } else if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          } else if (line.startsWith('retry:')) {
            const retry = Number(line.slice(6).trim());
            if (retry > 0) {
              reconnectMs = retry;
            }
          }
        }
      });
      res.on('end', () => {
        logErrorOnce('event stream ended', new Error('server closed the stream'));
        scheduleReconnect();
      });
      res.on('error', (err) => {
        logErrorOnce('event stream error', err);
        scheduleReconnect();
      });
    });
    req.on('error', (err) => {
      logErrorOnce('events unavailable', err);
      scheduleReconnect();
    });
    eventsRequest = req;
  }

  // --- Commands ---

  // One request per remote press, fire and forget. The service queues and paces presses,
  // so this must never be retried: a retry would double the press.
  function sendRemoteKey(keyName) {
    const key = RECEIVER_KEYS[keyName];
    if (!baseUrl || !key) {
      return false;
    }
    fetch(`${baseUrl}/receiver/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error(`Receiver key ${key} rejected: HTTP ${res.status} ${body}`);
        }
      })
      .catch((err) => {
        console.error(`Receiver key ${key} failed: ${err.message}`);
      });
    return true;
  }

  function start() {
    if (!baseUrl || !stopped) {
      return;
    }
    stopped = false;
    connectEvents();
  }

  function stop() {
    stopped = true;
    stopPolling();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (eventsRequest) {
      eventsRequest.destroy();
      eventsRequest = null;
    }
    streamConnected = false;
  }

  return {
    start,
    stop,
    sendRemoteKey,
    currentCecByte: () => cecByte,
    isStreamConnected: () => streamConnected,
  };
}

function describeAudioStatus(byte) {
  if (byte === UNKNOWN_AUDIO_STATUS) {
    return 'unknown';
  }
  return `${byte & 0x7f}%${byte & 0x80 ? ' (muted)' : ''}`;
}

module.exports = { createReceiverStatus, describeAudioStatus, UNKNOWN_AUDIO_STATUS };
