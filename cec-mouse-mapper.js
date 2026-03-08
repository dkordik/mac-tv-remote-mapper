const { execFileSync } = require('child_process');

function parseBoolean(value, defaultValue) {
  if (value == null || value === '') {
    return defaultValue;
  }
  return /^(1|true|yes)$/i.test(String(value));
}

function createCecMouseMapper(options = {}) {
  const enabled = parseBoolean(options.enabled, true);
  const verbose = parseBoolean(options.verbose, false);
  const defaultSteps = [10, 80];
  const parsedSteps = String(options.steps || defaultSteps.join(','))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const steps = parsedSteps.length > 0 ? parsedSteps : defaultSteps;
  const initialMode = Number(options.initialMode || 1);
  let stepModeIndex =
    Number.isInteger(initialMode) && initialMode >= 0 && initialMode < steps.length
      ? initialMode
      : Math.min(1, steps.length - 1);
  const clickDelayMs = Number(options.clickDelayMs || 0);
  const cliclickBin = options.cliclickBin || 'cliclick';
  const exitHoldMs = Number(options.exitHoldMs || 2000);
  const onExitHold = typeof options.onExitHold === 'function' ? options.onExitHold : null;
  const onExitHoldStart =
    typeof options.onExitHoldStart === 'function' ? options.onExitHoldStart : null;
  const onExitTap = typeof options.onExitTap === 'function' ? options.onExitTap : null;

  let missingBinaryLogged = false;
  let exitHoldTimer = null;
  let exitHoldTriggered = false;

  function runCliclick(args) {
    try {
      const output = execFileSync(cliclickBin, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return output;
    } catch (err) {
      if (!missingBinaryLogged && err && err.code === 'ENOENT') {
        missingBinaryLogged = true;
        console.error(
          'CEC mouse mapper: `cliclick` not found. Install with: brew install cliclick'
        );
      } else if (verbose) {
        console.error('CEC mouse mapper command failed:', err.message);
      }
      return null;
    }
  }

  function getMousePosition() {
    const output = runCliclick(['p']);
    if (!output) {
      return null;
    }

    const match = output.trim().match(/(-?\d+)\s*,\s*(-?\d+)/);
    if (!match) {
      if (verbose) {
        console.error('CEC mouse mapper: unexpected `cliclick p` output:', output.trim());
      }
      return null;
    }

    return { x: Number(match[1]), y: Number(match[2]) };
  }

  function moveBy(dx, dy) {
    const pos = getMousePosition();
    if (!pos) {
      return;
    }

    const targetX = pos.x + dx;
    const targetY = pos.y + dy;
    runCliclick([`m:${targetX},${targetY}`]);
    if (verbose) {
      console.log(`Mouse moved to ${targetX},${targetY}`);
    }
  }

  function currentStep() {
    return steps[stepModeIndex];
  }

  function cycleStepMode() {
    stepModeIndex = (stepModeIndex + 1) % steps.length;
    console.log(`Mouse movement step set to ${currentStep()}px`);
  }

  function clickCurrent() {
    const pos = getMousePosition();
    if (!pos) {
      return;
    }

    if (clickDelayMs > 0) {
      runCliclick([`w:${clickDelayMs}`]);
    }
    runCliclick([`c:${pos.x},${pos.y}`]);
    if (verbose) {
      console.log(`Mouse clicked at ${pos.x},${pos.y}`);
    }
  }

  function handleKey(keyName) {
    handleKeyPressed(keyName);
  }

  function handleKeyPressed(keyName) {
    if (!enabled) {
      return;
    }

    switch ((keyName || '').toLowerCase()) {
      case 'enter':
        clickCurrent();
        break;
      case 'up':
        moveBy(0, -currentStep());
        break;
      case 'down':
        moveBy(0, currentStep());
        break;
      case 'left':
        moveBy(-currentStep(), 0);
        break;
      case 'right':
        moveBy(currentStep(), 0);
        break;
      case 'exit':
        if (exitHoldTimer) {
          // Ignore repeated key-repeat presses while the button is held.
          break;
        }
        exitHoldTriggered = false;
        if (onExitHoldStart) {
          onExitHoldStart(exitHoldMs);
        }
        exitHoldTimer = setTimeout(() => {
          exitHoldTriggered = true;
          if (onExitHold) {
            onExitHold();
          }
        }, exitHoldMs);
        break;
      default:
        break;
    }
  }

  function handleKeyReleased(keyName) {
    if (!enabled) {
      return;
    }

    if ((keyName || '').toLowerCase() !== 'exit') {
      return;
    }

    if (exitHoldTimer) {
      clearTimeout(exitHoldTimer);
      exitHoldTimer = null;
    }

    exitHoldTriggered = false;
  }

  return {
    handleKey,
    handleKeyPressed,
    handleKeyReleased,
    clickCurrent,
    cycleStepMode,
    currentStep,
  };
}

module.exports = {
  createCecMouseMapper,
};
