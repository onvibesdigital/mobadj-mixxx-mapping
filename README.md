# MobaDJ — Mixxx controller mapping

The [Mixxx](https://mixxx.org) mapping for the **MobaDJ** app, which turns a phone into a
touch DJ controller for Mixxx. This repository holds only the mapping; the app itself is not
open source.

- **`MobaDJ.midi.xml`** — bindings from each MIDI note/CC to a Mixxx control
- **`MobaDJ.script.js`** — logic: jog wheels (scratch + pitch bend), tempo, PFL, loops,
  crossfader curve, and the feedback the app reads back (BPM, VU, loop and FX state)

Works with Mixxx 2.4+.

## Install

Most people don't need to do this by hand: **MobaDJ Link** for Mac installs and updates the
mapping for you — see [mobadj.com/link](https://mobadj.com/link/).

To install it manually, copy both files into Mixxx's `controllers` folder:

| OS | Folder |
|---|---|
| macOS (download from mixxx.org) | `~/Library/Application Support/Mixxx/controllers/` |
| macOS (sandboxed / App Store build) | `~/Library/Containers/org.mixxx.mixxx/Data/Library/Application Support/Mixxx/controllers/` |
| Windows | `%APPDATA%\Mixxx\controllers\` |
| Linux | `~/.mixxx/controllers/` |

Then in Mixxx: **Preferences → Controllers**, pick the phone's device, load the **MobaDJ**
mapping and check **Enabled**.

## Versions

The script answers the app's hello message with `MobaDJ.MAPPING_VERSION`; the app asks you to
update when the mapping is older than it needs.

## License

GNU General Public License v2 or later, the same license as Mixxx — see [LICENSE](LICENSE).
Copyright (c) 2026 ONVIBES DIGITAL LTDA.
