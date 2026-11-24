# MobaDJ — Mixxx controller mapping

The [Mixxx](https://mixxx.org) mapping for the **MobaDJ** apps (iPhone and Android), which turn a phone into a
touch DJ controller for Mixxx. This repository holds only the mapping; the app itself is not
open source.

- **`MobaDJ.midi.xml`** — bindings from each MIDI note/CC to a Mixxx control
- **`MobaDJ.script.js`** — logic: jog wheels (scratch + pitch bend), tempo, PFL, loops,
  crossfader curve, and the feedback the app reads back (BPM, VU, loop and FX state)

Works with Mixxx 2.4+.

## Install

Most people don't need to do this by hand: **MobaDJ Link** for Mac installs and updates the
mapping for you (it will be at [mobadj.com/link](https://mobadj.com/link/) when MobaDJ 1.0 launches).

To install it manually, copy both files into Mixxx's `controllers` folder (Mixxx › Preferences › Controllers › **Open User Mapping Folder** opens it):

| OS | Folder |
|---|---|
| macOS, Mixxx from mixxx.org (sandboxed; also the Homebrew cask) | `~/Library/Containers/org.mixxx.mixxx/Data/Library/Application Support/Mixxx/controllers/` |
| macOS, non-sandboxed builds (e.g. self-built) | `~/Library/Application Support/Mixxx/controllers/` |
| Windows | `%LOCALAPPDATA%\Mixxx\controllers\` |
| Linux | `~/.mixxx/controllers/` |

Then in Mixxx: **Preferences → Controllers**, pick the phone's device (or **MobaDJ Link**), load the **MobaDJ**
mapping and check **Enabled**.

## Versions

The script answers the app's hello message with `MobaDJ.MAPPING_VERSION`; the app asks you to
update when the mapping is older than it needs.

## License

GNU General Public License v2 or later, the same license as Mixxx — see [LICENSE](LICENSE).
Copyright (c) 2026 ONVIBES DIGITAL LTDA.
