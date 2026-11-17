const { NodeCec, CEC } = require('node-cec');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createCecMouseMapper } = require('./cec-mouse-mapper');
const { createCecMediaMapper } = require('./cec-media-mapper');
const { createCecKeyboardMapper } = require('./cec-keyboard-mapper');
const { createReceiverStatus, describeAudioStatus } = require('./receiver-status');

const cecClientBin = process.env.CEC_CLIENT_BIN || 'cec-client';
const retryDelayMs = Number(process.env.CEC_RETRY_MS || 3000);
const shutdownTimeoutMs = Number(process.env.CEC_SHUTDOWN_TIMEOUT_MS || 2000);
const verbose = /^(1|true|yes)$/i.test(process.env.CEC_VERBOSE || '');
const cecDebugLevel = process.env.CEC_DEBUG_LEVEL || '8';
const cecDeviceType = process.env.CEC_DEVICE_TYPE || 'p';
// Also register as a CEC Audio System (logical address 5) so the TV forwards its
// volume up/down/mute buttons to us when its speaker output is set to "Audio System".
const audioSystemEnabled = /^(1|true|yes)$/i.test(process.env.CEC_AUDIO_SYSTEM || '0');
const CEC_AUDIO_SYSTEM_LA = 0x05;
const volumeKeyNames = new Set(['volume_up', 'volume_down', 'mute']);
// Receiver volume reported to the TV (ymc-500-remote service). Set CEC_RECEIVER_URL= to disable.
const receiverUrl = process.env.CEC_RECEIVER_URL ?? 'http://127.0.0.1:8732';
const monitorMode = !/^(0|false|no)$/i.test(process.env.CEC_MONITOR_MODE || '0');
const cecHdmiPort = process.env.CEC_HDMI_PORT || '2';
const selectHoldMs = Number(process.env.CEC_SELECT_HOLD_MS || '500');
const autoClaimActiveSource = /^(1|true|yes)$/i.test(
  process.env.CEC_AUTO_CLAIM_ACTIVE_SOURCE || '0'
);
const useNodeEvents = /^(1|true|yes)$/i.test(process.env.CEC_USE_NODE_EVENTS || '0');
const defaultHostName = os.hostname().split('.')[0] || 'cec-listener';
const defaultOsdName = `${defaultHostName} (+CEC)`;
const cecOsdName =
  (process.env.CEC_OSD_NAME || defaultOsdName)
    .replace(/[^a-zA-Z0-9 _().+-]/g, '')
    .slice(0, 14) || 'cec-listener';
const modeStateFile = process.env.CEC_MODE_STATE_FILE || '/tmp/cec-listener-mode.txt';
const menuBarScriptPath = path.join(__dirname, 'menubar', 'cec-mode-menubar.swift');

let cec = null;
let shuttingDown = false;
let retryTimer = null;
let menuBarProcess = null;
let lastRawKeyEvent = '';
let lastRawKeyEventAt = 0;
let lastPressedKeyName = '';
let lastPressedKeyAt = 0;
let currentLogicalAddress = 0x08;
let isLocalInputActive = true;
let hasSeenLocalInputPath = false;
let lastPressedKeyForRelease = '';
let selectHoldTimer = null;
let selectHoldTriggered = false;
let lastKnownActivePath = null;
// When the user picks another input, the TV polls that device's power status every ~2s
// for up to ~10s before announcing the switch, and meanwhile keeps sending remote keys
// to us. Rapid repeated polls of one device are our early sign the TV is switching away.
const SWITCH_POLL_WINDOW_MS = 3500;
const SWITCH_FAILSAFE_MS = 15000;
const releaseOnSwitch = /^(1|true|yes)$/i.test(process.env.CEC_RELEASE_ON_SWITCH || '0');
const lastPowerPollAt = {};
let suspectedSwitchAt = 0;
// Logical addresses this adapter has transmitted from (e.g. 4 = Playback, 5 = Audio).
// The adapter sees every frame on the bus, so key frames addressed to other devices
// (like the PS5) must be ignored rather than acted on.
const ownLogicalAddresses = new Set();
let lastVolumeKeyAt = 0;
let lastVolumeKeyCode = -1;

function parseMouseSteps(stepsValue) {
  const defaultSteps = [10, 80];
  const parsed = String(stepsValue || defaultSteps.join(','))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : defaultSteps;
}

const configuredMouseSteps = parseMouseSteps(process.env.CEC_MOUSE_STEPS || '10,80');
const configuredMouseInitialMode = Number(process.env.CEC_MOUSE_STEP_MODE || '0');
const normalizedMouseStepMode =
  Number.isInteger(configuredMouseInitialMode) &&
  configuredMouseInitialMode >= 0 &&
  configuredMouseInitialMode < configuredMouseSteps.length
    ? configuredMouseInitialMode
    : Math.min(1, configuredMouseSteps.length - 1);
let mouseStepPx = configuredMouseSteps[normalizedMouseStepMode];

const userControlCodeByValue = Object.entries(CEC.UserControlCode).reduce(
  (acc, [name, code]) => {
    acc[code] = name.toLowerCase();
    return acc;
  },
  {}
);
const configuredPhysicalAddress = (() => {
  const p = Number(cecHdmiPort);
  if (Number.isInteger(p) && p >= 1 && p <= 15) {
    return p << 12;
  }
  return null;
})();

function formatPhysicalAddress(path) {
  const a = (path >> 12) & 0x0f;
  const b = (path >> 8) & 0x0f;
  const c = (path >> 4) & 0x0f;
  const d = path & 0x0f;
  return `${a}.${b}.${c}.${d}`;
}

function writeModeStateFile() {
  try {
    fs.writeFileSync(modeStateFile, `${JSON.stringify({ step: mouseStepPx })}\n`, 'utf8');
  } catch (err) {
    if (verbose) {
      console.error('Failed writing mode state file:', err.message);
    }
  }
}

function startModeMenuBar() {
  if (menuBarProcess || !fs.existsSync(menuBarScriptPath)) {
    return;
  }

  writeModeStateFile();

  try {
    menuBarProcess = spawn('swift', [menuBarScriptPath, modeStateFile], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    menuBarProcess.on('exit', () => {
      menuBarProcess = null;
    });
  } catch (err) {
    menuBarProcess = null;
    if (verbose) {
      console.error('Failed starting mode menu bar:', err.message);
    }
  }
}

function stopModeMenuBar() {
  if (!menuBarProcess) {
    return;
  }
  try {
    menuBarProcess.kill('SIGTERM');
  } catch (err) {
    if (verbose) {
      console.error('Failed stopping mode menu bar:', err.message);
    }
  }
  menuBarProcess = null;
}

function isDirectionalKey(keyName) {
  const normalized = (keyName || '').toLowerCase();
  return normalized === 'up' || normalized === 'down' || normalized === 'left' || normalized === 'right';
}
const keyboardMapper = createCecKeyboardMapper({
  enabled: process.env.CEC_KEYBOARD_ENABLED || '1',
  verbose: process.env.CEC_KEYBOARD_VERBOSE || (verbose ? '1' : '0'),
  osascriptBin: process.env.CEC_OSASCRIPT_BIN || 'osascript',
});
const mouseMapper = createCecMouseMapper({
  enabled: process.env.CEC_MOUSE_ENABLED || '1',
  verbose: process.env.CEC_MOUSE_VERBOSE || (verbose ? '1' : '0'),
  steps: process.env.CEC_MOUSE_STEPS || '10,80',
  initialMode: process.env.CEC_MOUSE_STEP_MODE || '0',
  exitHoldMs: process.env.CEC_EXIT_HOLD_MS || '500',
  onExitHoldStart: (holdMs) => {
    console.log(`📺 exit hold started (${holdMs}ms threshold)`);
  },
  onExitTap: (newStep) => {
    mouseStepPx = newStep;
    writeModeStateFile();
    console.log(`📺 exit tap -> mouse step ${newStep}px`);
  },
  onExitHold: () => {
    const ok = keyboardMapper.sendEscape();
    console.log(`📺 exit hold -> Escape (${ok ? 'ok' : 'failed'})`);
  },
  clickDelayMs: process.env.CEC_MOUSE_CLICK_DELAY_MS || '0',
  cliclickBin: process.env.CEC_CLICK_BIN || 'cliclick',
});
const mediaMapper = createCecMediaMapper({
  enabled: process.env.CEC_MEDIA_ENABLED || '1',
  verbose: process.env.CEC_MEDIA_VERBOSE || (verbose ? '1' : '0'),
  osascriptBin: process.env.CEC_OSASCRIPT_BIN || 'osascript',
  player: process.env.CEC_MEDIA_PLAYER || 'Spotify',
});

const receiverStatus = createReceiverStatus({
  baseUrl: audioSystemEnabled ? receiverUrl : '',
  volumeMax: process.env.CEC_RECEIVER_VOLUME_MAX || '100',
  pollMs: process.env.CEC_RECEIVER_POLL_MS || '5000',
  verbose,
  onChange: (byte) => {
    console.log(`🔊 receiver volume: ${describeAudioStatus(byte)}`);
    reportAudioStatus(0x00);
  },
});

// <Report Audio Status> from our Audio System address. libCEC also answers the TV's
// <Give Audio Status> itself with 0x7F (unknown); this follow-up carries the real value.
function reportAudioStatus(destination) {
  if (!audioSystemEnabled || monitorMode || !cec || !cec.ready) {
    return;
  }
  transmitFrame([(CEC_AUDIO_SYSTEM_LA << 4) | (destination & 0x0f), 0x7a, receiverStatus.currentCecByte()]);
}

function onRemoteKeyPressed(keyName, context) {
  // If a suspected switch away was never confirmed, the TV is still on us: stop ignoring keys.
  if (
    suspectedSwitchAt &&
    Date.now() - suspectedSwitchAt > SWITCH_FAILSAFE_MS &&
    lastKnownActivePath === configuredPhysicalAddress
  ) {
    suspectedSwitchAt = 0;
    isLocalInputActive = true;
    console.log('📺 suspected input switch not confirmed; handling keys again');
  }

  // Fail-open until we have confidently observed the local HDMI path at least once.
  if (hasSeenLocalInputPath && !isLocalInputActive) {
    if (verbose) {
      console.log(`Ignoring key while inactive input: ${keyName}`);
    }
    return;
  }

  const now = Date.now();
  if (keyName === lastPressedKeyName && now - lastPressedKeyAt < 120) {
    return;
  }
  lastPressedKeyName = keyName;
  lastPressedKeyAt = now;

  console.log('📺 key:', keyName);
  if (keyName === 'select' || keyName === 'enter') {
    if (!selectHoldTimer) {
      selectHoldTriggered = false;
      selectHoldTimer = setTimeout(() => {
        selectHoldTriggered = true;
        mouseMapper.cycleStepMode();
        mouseStepPx = mouseMapper.currentStep();
        writeModeStateFile();
        console.log(`📺 select hold -> mouse step ${mouseStepPx}px`);
      }, selectHoldMs);
    }
    return;
  }

  if (isDirectionalKey(keyName)) {
    mouseMapper.handleKeyPressed(keyName);
    return;
  }

  if (keyName === 'channel_up') {
    const ok = keyboardMapper.sendArrow('up');
    console.log(`📺 channel_up -> ArrowUp (${ok ? 'ok' : 'failed'})`);
    return;
  }

  if (keyName === 'channel_down') {
    const ok = keyboardMapper.sendArrow('down');
    console.log(`📺 channel_down -> ArrowDown (${ok ? 'ok' : 'failed'})`);
    return;
  }

  if (keyName === 'electronic_program_guide') {
    const ok = keyboardMapper.sendEnter();
    console.log(`📺 electronic_program_guide -> Enter (${ok ? 'ok' : 'failed'})`);
  }
  mouseMapper.handleKeyPressed(keyName);
  mediaMapper.handleKey(keyName);

  // Add custom logic here.
  // context includes the raw CEC packet and numeric key code.
  void context;
}

function onRemoteKeyReleased(context) {
  const releasedKey = (context.keyName || '').toLowerCase();
  if (releasedKey === 'select' || releasedKey === 'enter') {
    if (selectHoldTimer) {
      clearTimeout(selectHoldTimer);
      selectHoldTimer = null;
    }
    if (!selectHoldTriggered) {
      mouseMapper.clickCurrent();
      console.log(`📺 ${releasedKey} tap -> click`);
    }
    selectHoldTriggered = false;
    return;
  }

  mouseMapper.handleKeyReleased(releasedKey);
  if (verbose) {
    console.log('Remote key released', context);
  }
}

function sendActiveSource(reason) {
  if (!autoClaimActiveSource || !cec || !cec.ready || !configuredPhysicalAddress) {
    return;
  }

  const source = currentLogicalAddress & 0x0f;
  const header = (source << 4) | 0x0f;
  const hi = (configuredPhysicalAddress >> 8) & 0xff;
  const lo = configuredPhysicalAddress & 0xff;
  cec.sendCommand(header, CEC.Opcode.ACTIVE_SOURCE, hi, lo);
  if (verbose) {
    console.log(`Sent ACTIVE_SOURCE (${configuredPhysicalAddress.toString(16)}) because ${reason}`);
  }
}

function noteActivePath(path) {
  lastKnownActivePath = path;
  suspectedSwitchAt = 0;
}

function noteTvPowerPoll(targetLa) {
  const now = Date.now();
  const previous = lastPowerPollAt[targetLa] || 0;
  lastPowerPollAt[targetLa] = now;
  if (now - previous <= SWITCH_POLL_WINDOW_MS) {
    markSuspectedSwitch(targetLa, 'repeated power polls');
  }
}

// The TV is (probably) moving remote focus to another device before it announces the
// switch: stop acting on keys still addressed to us until the input is confirmed.
function markSuspectedSwitch(targetLa, reason) {
  if (suspectedSwitchAt || !isLocalInputActive) {
    return;
  }

  suspectedSwitchAt = Date.now();
  hasSeenLocalInputPath = true;
  isLocalInputActive = false;
  console.log(`📺 TV appears to be switching to LA ${targetLa.toString(16)} (${reason}); ignoring remote keys`);

  if (releaseOnSwitch && cec && cec.ready && configuredPhysicalAddress != null) {
    const hi = (configuredPhysicalAddress >> 8) & 0xff;
    const lo = configuredPhysicalAddress & 0xff;
    // <Inactive Source> from our playback address, so the TV stops treating us as the source.
    transmitFrame([(currentLogicalAddress << 4) | 0x00, 0x9d, hi, lo]);
    console.log('📺 sent Inactive Source');
  }
}

// Broadcast <Report Physical Address> from the Audio System address right away, so the
// TV doesn't wait for its next ~15s device poll to discover us and start System Audio Mode.
function announceAudioSystem() {
  if (!audioSystemEnabled || monitorMode || !cec || !cec.ready || configuredPhysicalAddress == null) {
    return;
  }
  const hi = (configuredPhysicalAddress >> 8) & 0xff;
  const lo = configuredPhysicalAddress & 0xff;
  const header = (CEC_AUDIO_SYSTEM_LA << 4) | 0x0f;
  transmitFrame([header, 0x84, hi, lo, CEC_AUDIO_SYSTEM_LA]);
  console.log('🔊 announced audio system to TV');
}

// node-cec's sendCommand() writes "tx ..." without a trailing newline, so cec-client
// never executes it. Write the command line ourselves.
function transmitFrame(bytes) {
  const frame = bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join(':');
  cec.send(`tx ${frame}\n`);
  if (verbose) {
    console.log(`Transmitted: ${frame}`);
  }
}

// Volume keys sent to the Audio System address arrive whatever input the TV is on,
// so they skip the local-input gating and the shared press/release state.
function onVolumeKeyPressed(keyName, keyCode) {
  const now = Date.now();
  if (keyCode === lastVolumeKeyCode && now - lastVolumeKeyAt < 60) {
    return;
  }
  lastVolumeKeyCode = keyCode;
  lastVolumeKeyAt = now;

  const input =
    lastKnownActivePath == null ? 'unknown' : formatPhysicalAddress(lastKnownActivePath);
  const local = configuredPhysicalAddress != null && lastKnownActivePath === configuredPhysicalAddress;
  console.log(`🔊 volume key: ${keyName} (input ${input}${local ? ', this Mac' : ''})`);
  // A real audio system answers each volume press with its new status; the TV may only
  // show its volume display in response to a press.
  reportAudioStatus(0x00);
}

function maybeEmitRawKeyEvent(direction, keyCode, packetInfo) {
  const now = Date.now();
  const signature = `${direction}:${keyCode}:${packetInfo.source || ''}:${packetInfo.target || ''}`;
  if (signature === lastRawKeyEvent && now - lastRawKeyEventAt < 250) {
    return;
  }
  lastRawKeyEvent = signature;
  lastRawKeyEventAt = now;

  const keyName = userControlCodeByValue[keyCode] || `unknown_${keyCode}`;
  if (direction === 'pressed') {
    lastPressedKeyForRelease = keyName;
    onRemoteKeyPressed(keyName, { keyCode, packet: packetInfo, raw: true });
  } else {
    onRemoteKeyReleased({
      keyCode,
      keyName: lastPressedKeyForRelease || keyName,
      packet: packetInfo,
      raw: true,
    });
    lastPressedKeyForRelease = '';
  }
}

function parseRawFrameLine(line) {
  const frameMatch = line.match(/(>>|<<)\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2})+)/);
  if (!frameMatch) {
    return;
  }

  const direction = frameMatch[1];
  const bytes = frameMatch[2].split(':').map((hex) => parseInt(hex, 16));
  if (bytes.length < 2) {
    return;
  }

  const header = bytes[0];
  const opcode = bytes[1];
  const args = bytes.slice(2);
  const packetInfo = {
    direction,
    source: (header >> 4) & 0x0f,
    target: header & 0x0f,
    opcode,
    args,
  };

  if (direction === '<<' && packetInfo.source !== 0x0f && !ownLogicalAddresses.has(packetInfo.source)) {
    ownLogicalAddresses.add(packetInfo.source);
    if (packetInfo.source !== CEC_AUDIO_SYSTEM_LA) {
      currentLogicalAddress = packetInfo.source;
    }
    if (verbose) {
      console.log(`Own logical addresses: ${[...ownLogicalAddresses].map((a) => a.toString(16)).join(', ')}`);
    }
  }

  if (
    audioSystemEnabled &&
    direction === '>>' &&
    opcode === 0x71 &&
    packetInfo.target === CEC_AUDIO_SYSTEM_LA
  ) {
    reportAudioStatus(packetInfo.source);
  }

  if (
    direction === '>>' &&
    opcode === 0x8f &&
    packetInfo.source === 0x00 &&
    packetInfo.target !== 0x0f &&
    !ownLogicalAddresses.has(packetInfo.target)
  ) {
    noteTvPowerPoll(packetInfo.target);
  }

  const isPress = (opcode === CEC.Opcode.USER_CONTROL_PRESSED || opcode === 0x44) && args.length > 0;
  const isRelease = opcode === CEC.Opcode.USER_CONTROL_RELEASE || opcode === 0x45;
  if (
    (isPress || isRelease) &&
    !monitorMode &&
    [...ownLogicalAddresses].some((a) => a !== CEC_AUDIO_SYSTEM_LA) &&
    !ownLogicalAddresses.has(packetInfo.target)
  ) {
    if (verbose) {
      console.log(`Ignoring key frame for another device (LA ${packetInfo.target.toString(16)})`);
    }
    // The TV sending remote keys elsewhere (e.g. power-on to wake the PS5) means the
    // remote's focus has left us, even if the input switch isn't announced yet.
    if (isPress && packetInfo.source === 0x00 && packetInfo.target !== 0x0f) {
      markSuspectedSwitch(packetInfo.target, `TV sent key ${args[0].toString(16)}`);
    }
    return;
  }
  if (audioSystemEnabled && packetInfo.target === CEC_AUDIO_SYSTEM_LA && (isPress || isRelease)) {
    const keyName = isPress ? userControlCodeByValue[args[0]] || `unknown_${args[0]}` : '';
    if (isPress && volumeKeyNames.has(keyName)) {
      onVolumeKeyPressed(keyName, args[0]);
    } else if (isPress) {
      console.log(`🔊 audio-system key (unhandled): ${keyName}`);
    }
    return;
  }

  if (isPress) {
    // In monitor mode, key frames may be routed in different ways depending on TV behavior.
    // We intentionally avoid strict source/target filtering here and rely on active-input gating.
    maybeEmitRawKeyEvent('pressed', args[0], packetInfo);
  } else if (isRelease) {
    maybeEmitRawKeyEvent('released', CEC.UserControlCode.UNKNOWN, packetInfo);
  } else if ((opcode === CEC.Opcode.VENDOR_REMOTE_BUTTON_DOWN || opcode === 0x8a) && args.length > 0) {
    console.log('Vendor remote button down:', args[0]);
  } else if (opcode === CEC.Opcode.VENDOR_REMOTE_BUTTON_UP || opcode === 0x8b) {
    if (verbose) {
      console.log('Vendor remote button up');
    }
  } else if ((opcode === CEC.Opcode.ROUTING_CHANGE || opcode === 0x80) && args.length >= 4) {
    const fromPath = (args[0] << 8) | args[1];
    const toPath = (args[2] << 8) | args[3];
    noteActivePath(toPath);
    if (configuredPhysicalAddress != null && toPath === configuredPhysicalAddress) {
      hasSeenLocalInputPath = true;
      isLocalInputActive = true;
    } else if (hasSeenLocalInputPath) {
      isLocalInputActive = false;
    }
    console.log(
      `📺 input routing changed: ${formatPhysicalAddress(fromPath)} -> ${formatPhysicalAddress(toPath)}`
    );
    if (configuredPhysicalAddress && toPath === configuredPhysicalAddress) {
      setTimeout(() => sendActiveSource('routing-change-to-local-input'), 300);
    }
  } else if ((opcode === CEC.Opcode.ROUTING_INFORMATION || opcode === 0x81) && args.length >= 2) {
    const path = (args[0] << 8) | args[1];
    noteActivePath(path);
    if (configuredPhysicalAddress != null && path === configuredPhysicalAddress) {
      hasSeenLocalInputPath = true;
      isLocalInputActive = true;
    } else if (hasSeenLocalInputPath) {
      isLocalInputActive = false;
    }
    console.log(`📺 routing info: active path ${formatPhysicalAddress(path)}`);
  } else if (opcode === 0x86 && args.length >= 2) {
    // <Set Stream Path>: the TV announcing which input it switched to.
    noteActivePath((args[0] << 8) | args[1]);
    if (configuredPhysicalAddress != null && lastKnownActivePath === configuredPhysicalAddress) {
      hasSeenLocalInputPath = true;
      isLocalInputActive = true;
    } else if (hasSeenLocalInputPath) {
      isLocalInputActive = false;
    }
    console.log(`📺 TV switched input: ${formatPhysicalAddress(lastKnownActivePath)}`);
  } else if ((opcode === CEC.Opcode.ACTIVE_SOURCE || opcode === 0x82) && args.length >= 2) {
    const path = (args[0] << 8) | args[1];
    noteActivePath(path);
    if (configuredPhysicalAddress != null && path === configuredPhysicalAddress) {
      hasSeenLocalInputPath = true;
      isLocalInputActive = true;
    } else if (hasSeenLocalInputPath) {
      isLocalInputActive = false;
    }
    console.log(`📺 active source: ${formatPhysicalAddress(path)} (LA ${packetInfo.source.toString(16)})`);
  }
}

function scheduleRestart(reason) {
  if (shuttingDown || retryTimer) {
    return;
  }

  console.error(`${reason} Retrying in ${retryDelayMs}ms...`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    startCec();
  }, retryDelayMs);
}

function startCec() {
  cec = new NodeCec(cecOsdName);
  cec.ready = false;
  ownLogicalAddresses.clear();
  if (audioSystemEnabled && !monitorMode) {
    ownLogicalAddresses.add(CEC_AUDIO_SYSTEM_LA);
  }

  if (verbose) {
    console.log(
      `Starting CEC with bin=${cecClientBin}, debug=${cecDebugLevel}, deviceType=${cecDeviceType}, audioSystem=${audioSystemEnabled}, monitorMode=${monitorMode}, hdmiPort=${cecHdmiPort || 'auto'}`
    );
    console.log(`Using OSD name: ${cecOsdName}`);
  }

  cec.once('ready', () => {
    cec.ready = true;
    console.log('CEC adapter ready');
    isLocalInputActive = true;
    hasSeenLocalInputPath = false;
    sendActiveSource('ready');
    announceAudioSystem();
    receiverStatus.start();
  });

  if (useNodeEvents) {
    cec.on('USER_CONTROL_PRESSED', (packet, keyCode) => {
      const keyName =
        typeof keyCode === 'number' ? userControlCodeByValue[keyCode] || `unknown_${keyCode}` : 'unknown';
      onRemoteKeyPressed(keyName, { packet, keyCode });
      if (verbose) {
        console.log('USER_CONTROL_PRESSED raw:', { keyCode, packet });
      }
    });

    cec.on('USER_CONTROL_RELEASE', (packet) => {
      if (verbose) {
        console.log('USER_CONTROL_RELEASE raw:', packet);
      }
    });

    cec.on('VENDOR_REMOTE_BUTTON_DOWN', (packet, buttonCode) => {
      console.log('Vendor remote button down:', buttonCode);
      if (verbose) {
        console.log('VENDOR_REMOTE_BUTTON_DOWN raw:', { buttonCode, packet });
      }
    });

    cec.on('VENDOR_REMOTE_BUTTON_UP', (packet) => {
      if (verbose) {
        console.log('VENDOR_REMOTE_BUTTON_UP raw:', packet);
      }
    });
  }

  cec.on('line', (line) => {
    if (verbose && line.trim().length > 0) {
      console.log('[cec line]', line);
    }

    const laMatch = line.match(/logical address(?:\(es\))?.*?\(([0-9a-fA-F])\)/i);
    if (laMatch) {
      currentLogicalAddress = parseInt(laMatch[1], 16);
      if (verbose) {
        console.log(`Detected logical address: 0x${currentLogicalAddress.toString(16)}`);
      }
    }

    parseRawFrameLine(line);
    if (line.toLowerCase().includes('error')) {
      console.error('CEC line:', line);
    }
  });

  cec.on('packet', (packet) => {
    if (verbose) {
      console.log('Unmapped CEC packet:', packet);
    }
  });

  cec.on('stop', () => {
    if (!cec.ready && !shuttingDown) {
      scheduleRestart(
        'CEC stopped before ready. Check adapter/TV CEC settings or serial lock.'
      );
    }
  });

  const args = ['-d', cecDebugLevel, '-t', cecDeviceType];
  // cec-client needs a separate -t per type ("-t pa" is misparsed as a recorder).
  if (audioSystemEnabled && !monitorMode && cecDeviceType !== 'a') {
    args.push('-t', 'a');
  }
  if (monitorMode) {
    args.unshift('-m');
  }
  if (cecHdmiPort) {
    args.push('-p', cecHdmiPort);
  }
  cec.start(cecClientBin, ...args);

  if (cec.client) {
    cec.client.on('error', (err) => {
      if (shuttingDown) {
        return;
      }

      if (err && err.code === 'ENOENT') {
        console.error(
          `CEC error: could not find "${cecClientBin}". Install libCEC and ensure cec-client is in PATH.`
        );
        process.exit(1);
      } else {
        console.error('CEC error:', err);
        scheduleRestart('CEC process error.');
      }
    });
  }
}

function shutdown(signal, options = {}) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (selectHoldTimer) {
    clearTimeout(selectHoldTimer);
    selectHoldTimer = null;
  }
  stopModeMenuBar();
  receiverStatus.stop();

  console.log(`\nShutting down CEC listener (${signal})...`);

  const client = cec && cec.client ? cec.client : null;
  if (!client) {
    process.exit(exitCode);
  }

  let exited = false;
  const finish = (code) => {
    if (exited) {
      return;
    }
    exited = true;
    process.exit(code);
  };

  client.once('close', () => finish(exitCode));

  try {
    cec.stop();
  } catch (err) {
    console.error('CEC stop error:', err);
    finish(1);
  }

  setTimeout(() => {
    if (!client.killed) {
      try {
        client.kill('SIGKILL');
      } catch (err) {
        console.error('CEC force-kill error:', err);
      }
    }
    finish(exitCode);
  }, shutdownTimeoutMs).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('SIGUSR1', () => shutdown('SIGUSR1', { exitCode: 75 }));

writeModeStateFile();
startModeMenuBar();
startCec();
