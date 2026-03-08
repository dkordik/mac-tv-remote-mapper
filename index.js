const { NodeCec, CEC } = require('node-cec');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createCecMouseMapper } = require('./cec-mouse-mapper');
const { createCecMediaMapper } = require('./cec-media-mapper');
const { createCecKeyboardMapper } = require('./cec-keyboard-mapper');

const cecClientBin = process.env.CEC_CLIENT_BIN || 'cec-client';
const retryDelayMs = Number(process.env.CEC_RETRY_MS || 3000);
const shutdownTimeoutMs = Number(process.env.CEC_SHUTDOWN_TIMEOUT_MS || 2000);
const verbose = /^(1|true|yes)$/i.test(process.env.CEC_VERBOSE || '');
const cecDebugLevel = process.env.CEC_DEBUG_LEVEL || '8';
const cecDeviceType = process.env.CEC_DEVICE_TYPE || 'p';
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

function onRemoteKeyPressed(keyName, context) {
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
  if (keyName === 'select') {
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

  if (keyName === 'enter') {
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
  if (releasedKey === 'select') {
    if (selectHoldTimer) {
      clearTimeout(selectHoldTimer);
      selectHoldTimer = null;
    }
    if (!selectHoldTriggered) {
      mouseMapper.clickCurrent();
      console.log('📺 select tap -> click');
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

  if ((opcode === CEC.Opcode.USER_CONTROL_PRESSED || opcode === 0x44) && args.length > 0) {
    // In monitor mode, key frames may be routed in different ways depending on TV behavior.
    // We intentionally avoid strict source/target filtering here and rely on active-input gating.
    maybeEmitRawKeyEvent('pressed', args[0], packetInfo);
  } else if (opcode === CEC.Opcode.USER_CONTROL_RELEASE || opcode === 0x45) {
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
    if (configuredPhysicalAddress != null && path === configuredPhysicalAddress) {
      hasSeenLocalInputPath = true;
      isLocalInputActive = true;
    } else if (hasSeenLocalInputPath) {
      isLocalInputActive = false;
    }
    console.log(`📺 routing info: active path ${formatPhysicalAddress(path)}`);
  } else if ((opcode === CEC.Opcode.ACTIVE_SOURCE || opcode === 0x82) && args.length >= 2) {
    const path = (args[0] << 8) | args[1];
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

  if (verbose) {
    console.log(
      `Starting CEC with bin=${cecClientBin}, debug=${cecDebugLevel}, deviceType=${cecDeviceType}, monitorMode=${monitorMode}, hdmiPort=${cecHdmiPort || 'auto'}`
    );
    console.log(`Using OSD name: ${cecOsdName}`);
  }

  cec.once('ready', () => {
    cec.ready = true;
    console.log('CEC adapter ready');
    isLocalInputActive = true;
    hasSeenLocalInputPath = false;
    sendActiveSource('ready');
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
