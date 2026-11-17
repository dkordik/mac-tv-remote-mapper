// Polls the ymc-500-remote service for the receiver's volume/mute and caches it, so the
// CEC audio system can answer the TV's <Give Audio Status> instantly. The service reports
// its believed state (it can't read the receiver), so values drift if the receiver is
// changed outside the service, e.g. with its own remote or knob.

const UNKNOWN_AUDIO_STATUS = 0x7f;

function createReceiverStatus(options = {}) {
  const baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
  const volumeMax = Number(options.volumeMax) > 0 ? Number(options.volumeMax) : 100;
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 5000;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 2000;
  const verbose = Boolean(options.verbose);
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

  let cecByte = UNKNOWN_AUDIO_STATUS;
  let timer = null;
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

  // A reused keep-alive connection can be closed by the server just as we send on it
  // (Node servers drop idle sockets after 5s), so retry once on a network-level failure.
  async function fetchStatus() {
    const url = `${baseUrl}/receiver/status`;
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw err;
      }
      if (verbose) {
        console.log(`Receiver status: retrying after ${describeError(err)}`);
      }
      return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    }
  }

  function describeError(err) {
    const cause = err && err.cause ? err.cause.code || err.cause.message : '';
    return cause ? `${err.message} (${cause})` : String(err && err.message);
  }

  async function refresh() {
    if (!baseUrl || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const res = await fetchStatus();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const next = toCecByte(await res.json());
      lastError = '';
      if (next !== cecByte) {
        cecByte = next;
        onChange(cecByte);
      }
    } catch (err) {
      // Keep the last known value; log each distinct failure once.
      const message = describeError(err);
      if (verbose && message !== lastError) {
        console.error(`Receiver status unavailable: ${message}`);
      }
      lastError = message;
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (!baseUrl || timer) {
      return;
    }
    refresh();
    timer = setInterval(refresh, pollMs);
    timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    refresh,
    currentCecByte: () => cecByte,
  };
}

function describeAudioStatus(byte) {
  if (byte === UNKNOWN_AUDIO_STATUS) {
    return 'unknown';
  }
  return `${byte & 0x7f}%${byte & 0x80 ? ' (muted)' : ''}`;
}

module.exports = { createReceiverStatus, describeAudioStatus, UNKNOWN_AUDIO_STATUS };
