# mac-tv-remote-mapper

Small Node.js service for listening to HDMI-CEC remote events on macOS and mapping them to local actions.

## Requirements

- macOS machine connected via HDMI
- Installed Pulse-Eight USB-CEC adapter
- Node.js

## Install

```bash
brew install libcec
npm install
```

## Run

```bash
./start.sh
```

## Restart

```bash
./restart.sh
```

## Stop any zombie processes, if needed:

```bash
./stop.sh
```

## Current key mappings

### Remote -> Mouse

- `select`/`enter` tap -> mouse click
- `select`/`enter` hold (500ms) -> toggle mouse step size (`10 <-> 80`)
- `left`, `right`, `up`, `down` -> mouse move

### Remote -> Keyboard

- `channel_up` -> Up arrow
- `channel_down` -> Down arrow
- `exit` hold (500ms) -> Escape key
- `electronic_program_guide` -> Enter key

### Remote -> Media

- `play`, `pause`, `stop` -> Spotify media control
- `fast_forward`, `forward` -> Spotify next track
- `rewind`, `backward` -> Spotify previous track

## Useful env vars

- `CEC_VERBOSE=1` for verbose CEC logs
- `CEC_HDMI_PORT=2` to force HDMI port
- `CEC_MONITOR_MODE=0` runs as active client mode (default)
- `CEC_AUTO_CLAIM_ACTIVE_SOURCE=0` keeps this listener from stealing active input (default)
- `CEC_MEDIA_PLAYER=Spotify` to choose media app target
- `CEC_MOUSE_ENABLED=0` to disable mouse mapping
- `CEC_MOUSE_STEPS=10,80` to set movement step sizes
- `CEC_MOUSE_STEP_MODE=0` to choose initial mode index (0-based)
- `CEC_EXIT_HOLD_MS=500` to set exit-button hold threshold
- `CEC_SELECT_HOLD_MS=500` to set select-button hold threshold for step toggle
- `CEC_KEYBOARD_ENABLED=1` to enable keyboard actions (Escape on hold)

## Menu bar mode icon

- A macOS menu bar icon is started automatically and shows mouse mode + current movement step (`1` or `8`)
