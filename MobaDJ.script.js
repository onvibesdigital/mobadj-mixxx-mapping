// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (c) 2026 ONVIBES DIGITAL LTDA. Licensed under the GNU GPL v2 or later (see LICENSE).
//
// MobaDJ — Mixxx JS script
// Responsible for:
//  - Jog wheel: scratch mode (touch in inner zone) + pitch bend (outer ring)
//  - Tempo (rate) with bipolar conversion (0..127 → -1..+1)
//  - PFL (headphone cue) as toggle
//  - Filter chain bypass (toggle) + chain preset selector (◀/▶ in the Mix tab)
//  - FX slot enable (deterministic toggle via script)
//  - Beatloop handler (correct toggle via reloop_toggle when a loop is active)
//  - Decoding of relative two's complement 7-bit CC (jog turn)
// (Hot cues, beatjumps and fx prev/next_effect go through directly as <button /> in the XML —
//  Mixxx natively responds to note on velocity 127.)

var MobaDJ = {};

MobaDJ.alpha = 1.0 / 8;
MobaDJ.beta = MobaDJ.alpha / 32;
MobaDJ.rpm = 33 + 1 / 3;

// ===== SCRATCH calibration =====
// CC ticks per virtual platter revolution. HIGHER = subtler scratch.
MobaDJ.ticksPerRev = 720;

// ===== BEND calibration (outer ring) =====
MobaDJ.bendScale = 0.35;

// Connections for continuous outputs (BPM, VU, loop). Saved to disconnect on shutdown.
MobaDJ._connections = [];

// Pending hot-cue resync timer per deck (index 0 = deck 1, 1 = deck 2). 0 = none.
// At most one timer per deck at any time — track_loaded events cancel any pending
// timer and start a new one. Ensures track replace (1 → 0 → 1) cancels the eject
// blast before it can clobber the new track's pad state.
MobaDJ._pendingHotcueTimer = [0, 0];

MobaDJ.init = function () {
    // BPM per deck — 14-bit precision via two CCs.
    // raw = (bpm - 60) / 140 * 16383, then split into high (>>7) and low (&0x7F)
    // bytes. CC 0x40 = high, CC 0x41 = low. App combines into a 14-bit value for
    // ~0.0085 BPM precision (was ~0.55 BPM with single-byte). Both sends happen
    // back-to-back in the same callback tick — order is guaranteed for the app.
    function sendBpm14bit(channel, bpm) {
        var raw = Math.round((bpm - 60) * 16383 / 140);
        if (raw < 0) raw = 0;
        if (raw > 16383) raw = 16383;
        midi.sendShortMsg(channel, 0x40, (raw >> 7) & 0x7F);  // high 7 bits
        midi.sendShortMsg(channel, 0x41,  raw       & 0x7F);  // low 7 bits
    }
    MobaDJ._connections.push(
        engine.makeConnection("[Channel1]", "bpm", function (value) { sendBpm14bit(0xB0, value); })
    );
    MobaDJ._connections.push(
        engine.makeConnection("[Channel2]", "bpm", function (value) { sendBpm14bit(0xB1, value); })
    );

    // Master VU L/R — scale 0..1 → 0..127. CC 0x42/0x43 on channel 0xB0.
    MobaDJ._connections.push(
        engine.makeConnection("[Master]", "VuMeterL", function (value) {
            midi.sendShortMsg(0xB0, 0x42, Math.round(value * 127));
        })
    );
    MobaDJ._connections.push(
        engine.makeConnection("[Master]", "VuMeterR", function (value) {
            midi.sendShortMsg(0xB0, 0x43, Math.round(value * 127));
        })
    );

    // Deck VU (mono, 0..1) → CC 0x49 on the deck's channel, for the meters next to the
    // volume faders on the Beatmatch tab. Sent only when the 7-bit value changes, so four
    // meters don't flood a Bluetooth link.
    MobaDJ._connections.push(
        engine.makeConnection("[Channel1]", "vu_meter", function (value) { MobaDJ._sendDeckVu(0, 0xB0, value); })
    );
    MobaDJ._connections.push(
        engine.makeConnection("[Channel2]", "vu_meter", function (value) { MobaDJ._sendDeckVu(1, 0xB1, value); })
    );

    // Loop state per deck — combines loop_enabled + beatloop_size into a single CC (0x44).
    // Value: index 0..8 of the active size, or 127 = no loop.
    MobaDJ._connections.push(
        engine.makeConnection("[Channel1]", "loop_enabled", function () { MobaDJ._notifyLoopState(1); })
    );
    MobaDJ._connections.push(
        engine.makeConnection("[Channel1]", "beatloop_size", function () { MobaDJ._notifyLoopState(1); })
    );
    MobaDJ._connections.push(
        engine.makeConnection("[Channel2]", "loop_enabled", function () { MobaDJ._notifyLoopState(2); })
    );
    MobaDJ._connections.push(
        engine.makeConnection("[Channel2]", "beatloop_size", function () { MobaDJ._notifyLoopState(2); })
    );

    // Hot cue re-sync on track load.
    // The existing <output> blocks in MobaDJ.midi.xml emit hotcue_N_enabled feedback
    // only when the value *changes*. That misses two cases: (1) app connects after
    // a track is already loaded, (2) a new track loads with the same enabled flags
    // as the previous one (engine.trigger doesn't reliably wake those <output>
    // blocks for hotcue_N_enabled — tested empirically). On track_loaded → 1,
    // defer 150 ms (Mixxx needs time to populate all 8 hotcue values for the new
    // track), then read each hotcue_N_enabled and emit the same MIDI byte the
    // <output> block would have. Tightly scoped: only fires on track_loaded
    // change, no per-hotcue subscriptions (those were the suspected cause of the
    // earlier cross-deck regression).
    function refreshHotcuesAfterLoad(deckNum) {
        return function (v) {
            var status = deckNum === 1 ? 0x90 : 0x91;
            var idx = deckNum - 1;

            // Cancel any pending timer for this deck. Crucial for track replace
            // (1 → 0 → 1): the 0 schedules an eject blast; the 1 arrives quickly
            // and cancels it before it can clobber the new track's pad state.
            if (MobaDJ._pendingHotcueTimer[idx] !== 0) {
                engine.stopTimer(MobaDJ._pendingHotcueTimer[idx]);
                MobaDJ._pendingHotcueTimer[idx] = 0;
            }

            if (v > 0) {
                // Track loaded — 150 ms gives Mixxx time to populate hotcue values.
                // Read hotcue_N_position (the underlying stored sample position) instead
                // of _enabled (a derived/cached value that was unreliable in testing).
                // pos == -1 means cue is unset; pos >= 0 means cue exists.
                MobaDJ._pendingHotcueTimer[idx] = engine.beginTimer(150, function () {
                    MobaDJ._pendingHotcueTimer[idx] = 0;
                    var group = "[Channel" + deckNum + "]";
                    for (var i = 1; i <= 8; i++) {
                        var pos = engine.getValue(group, "hotcue_" + i + "_position");
                        var on  = pos >= 0;
                        midi.sendShortMsg(status, 0x17 + i, on ? 0x7F : 0);
                    }
                }, true);
            } else {
                // Defer the eject blast — if v → 1 arrives within 300 ms it was a
                // track replace, not a real eject, and the cancel above wipes this.
                MobaDJ._pendingHotcueTimer[idx] = engine.beginTimer(300, function () {
                    MobaDJ._pendingHotcueTimer[idx] = 0;
                    for (var i = 1; i <= 8; i++) {
                        midi.sendShortMsg(status, 0x17 + i, 0);
                    }
                }, true);
            }
        };
    }
    MobaDJ._connections.push(engine.makeConnection("[Channel1]", "track_loaded", refreshHotcuesAfterLoad(1)));
    MobaDJ._connections.push(engine.makeConnection("[Channel2]", "track_loaded", refreshHotcuesAfterLoad(2)));

    // Continuous knob/fader feedback (Mixxx → app). Uses engine.getParameter to
    // read the *normalized* 0..1 representation — same scale Mixxx uses internally
    // for the input direction's <normal /> bindings. So MIDI 64 maps to the
    // control's neutral state for every knob (filter mid, EQ neutral=1.0, gain
    // neutral=1.0, crossfader/headMix center, etc) without per-control scaling math.
    function bindCCParam(group, key, status, midino) {
        MobaDJ._connections.push(
            engine.makeConnection(group, key, function () {
                var p = engine.getParameter(group, key);
                var n = Math.round(p * 127);
                if (n < 0) n = 0;
                if (n > 127) n = 127;
                midi.sendShortMsg(status, midino, n);
            })
        );
    }

    // Tempo fader feedback. Uses rate_ratio (the real speed ratio) instead of `rate`,
    // whose sign depends on Mixxx's "slider direction" preference — so in the app
    // up is always faster, whatever that preference says.
    function bindTempo(group, status) {
        var send = function () {
            var range = engine.getValue(group, "rateRange");
            if (range <= 0) return;
            var norm = (engine.getValue(group, "rate_ratio") - 1) / range;   // −1..+1, + = faster
            var n = Math.round(64 + norm * 63);
            midi.sendShortMsg(status, 0x14, Math.max(0, Math.min(127, n)));
        };
        MobaDJ._connections.push(engine.makeConnection(group, "rate_ratio", send));
        MobaDJ._connections.push(engine.makeConnection(group, "rateRange", send));
    }

    // Per-deck continuous controls (10 per deck × 2 decks = 20).
    for (var d = 1; d <= 2; d++) {
        var status = d === 1 ? 0xB0 : 0xB1;
        var ch = "[Channel" + d + "]";
        var quickFx = "[QuickEffectRack1_[Channel" + d + "]]";
        var eq = "[EqualizerRack1_[Channel" + d + "]_Effect1]";
        var fxUnit = "[EffectRack1_EffectUnit" + d + "]";
        bindCCParam(ch,      "volume",      status, 0x07);
        bindTempo(ch, status);
        bindCCParam(quickFx, "super1",      status, 0x13);
        bindCCParam(eq,      "parameter1",  status, 0x12);  // EQ low (CC 0x12 = EQ_LOW per MidiMap)
        bindCCParam(eq,      "parameter2",  status, 0x11);  // EQ mid
        bindCCParam(eq,      "parameter3",  status, 0x10);  // EQ high
        bindCCParam("[EffectRack1_EffectUnit" + d + "_Effect1]", "meta", status, 0x21);
        bindCCParam("[EffectRack1_EffectUnit" + d + "_Effect2]", "meta", status, 0x22);
        bindCCParam("[EffectRack1_EffectUnit" + d + "_Effect3]", "meta", status, 0x23);
        bindCCParam(fxUnit,  "mix",         status, 0x24);
    }

    // Pitch (semitones, integer) feedback per deck. Encoded as data2 = pitch + 64
    // so MIDI 64 = neutral, 65 = +1, 63 = -1. The app decodes with `cc - 64` and
    // shows the offset on the Beatmatch tab.
    function bindPitch(deckNum) {
        var status = deckNum === 1 ? 0xB0 : 0xB1;
        var ch = "[Channel" + deckNum + "]";
        MobaDJ._connections.push(
            engine.makeConnection(ch, "pitch", function (value) {
                var v = Math.round(value) + 64;
                if (v < 0) v = 0;
                if (v > 127) v = 127;
                midi.sendShortMsg(status, 0x46, v);
            })
        );
    }
    bindPitch(1);
    bindPitch(2);

    // Master continuous controls (channel 1 only — script convention; app reads
    // these from DECK_A status byte regardless of "deck").
    bindCCParam("[Master]", "crossfader", 0xB0, 0x08);
    bindCCParam("[Master]", "gain",       0xB0, 0x06);
    bindCCParam("[Master]", "headVolume", 0xB0, 0x09);
    bindCCParam("[Master]", "headMix",    0xB0, 0x0A);

    // Initial trigger — sends the current value of each connection so the app syncs
    // as soon as it connects (no need to wait for the first change).
    for (var i = 0; i < MobaDJ._connections.length; i++) {
        MobaDJ._connections[i].trigger();
    }

    // Mixxx sends the initial value of every XML <output> while applying the
    // mapping, *before* the MIDI output port is open (Mixxx 2.5 logs 32×
    // "not open for output"), so pads like PLAY/PFL/hot cues start out wrong.
    // Re-send them once the port is up.
    engine.beginTimer(300, MobaDJ._sendButtonStates, true);
};

// Reads loop_enabled + beatloop_size from the deck and sends CC 0x44 with the active index (0..8) or 127.
MobaDJ._loopSizes = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32];
MobaDJ._notifyLoopState = function (deckNum) {
    var group = "[Channel" + deckNum + "]";
    var status = deckNum === 1 ? 0xB0 : 0xB1;
    var enabled = engine.getValue(group, "loop_enabled") > 0;
    if (!enabled) {
        midi.sendShortMsg(status, 0x44, 127);
        return;
    }
    var size = engine.getValue(group, "beatloop_size");
    var index = -1;
    for (var i = 0; i < MobaDJ._loopSizes.length; i++) {
        if (Math.abs(size - MobaDJ._loopSizes[i]) < 0.001) {
            index = i;
            break;
        }
    }
    midi.sendShortMsg(status, 0x44, index >= 0 ? index : 127);
};

// Button-style outputs, mirrored from the <outputs> block of MobaDJ.midi.xml.
// Used by resync() to push their current state explicitly — engine.trigger()
// doesn't reliably wake XML <output> bindings (see hot cue note in init()).
MobaDJ._buttonOutputs = function () {
    var list = [];
    for (var d = 1; d <= 2; d++) {
        var st = d === 1 ? 0x90 : 0x91;
        var ch = "[Channel" + d + "]";
        list.push([ch, "pfl", st, 0x3F]);
        list.push([ch, "play", st, 0x3B]);
        list.push([ch, "slip_enabled", st, 0x29]);
        list.push(["[QuickEffectRack1_[Channel" + d + "]]", "enabled", st, 0x2A]);
        list.push(["[EffectRack1_EffectUnit" + d + "]", "group_[Channel" + d + "]_enable", st, 0x28]);
        for (var s = 1; s <= 3; s++) {
            list.push(["[EffectRack1_EffectUnit" + d + "_Effect" + s + "]", "enabled", st, 0x2A + s]);
        }
    }
    return list;
};

// Bumped when the app ↔ mapping protocol changes; the app warns when it's too old.
// v2: crossfader curve + reverse (CC 0x0B / 0x0C). v3: deck VU (CC 0x49).
MobaDJ.MAPPING_VERSION = 3;

MobaDJ._lastDeckVu = [-1, -1];

// Library scroll (notes 0x37 up / 0x38 down). [Library] MoveUp/MoveDown move whatever
// library widget has keyboard focus, so they do nothing while Mixxx's window is in the
// background or the sidebar has focus, and LOAD then finds no selected track.
// [Playlist] SelectTrackKnob moves the track table's selection directly, focus or not.
MobaDJ.libraryMove = function (channel, control, value) {
    if (value <= 0) return;
    engine.setValue("[Playlist]", "SelectTrackKnob", control === 0x37 ? -1 : 1);
};
MobaDJ._sendDeckVu = function (idx, status, value) {
    var n = Math.round(value * 127);
    if (n < 0) n = 0;
    if (n > 127) n = 127;
    if (n === MobaDJ._lastDeckVu[idx]) return;
    MobaDJ._lastDeckVu[idx] = n;
    midi.sendShortMsg(status, 0x49, n);
};

// The app sends note 0x6B every few seconds and expects this answer — that's how
// it knows Mixxx is running with this mapping enabled (and which version).
MobaDJ.hello = function (channel, control, value) {
    if (value <= 0) return;
    midi.sendShortMsg(0x90, 0x6B, MobaDJ.MAPPING_VERSION);
};

// The app sends note 0x6A on every (re)connect. Re-emit every piece of feedback
// so pads, knobs, BPM and hot cues match Mixxx even after a Bluetooth drop or a
// cable re-plug — without having to disable/enable the controller in Mixxx.
MobaDJ.resync = function (channel, control, value) {
    if (value <= 0) return;
    MobaDJ._lastDeckVu = [-1, -1];   // let the deck VUs through again
    for (var i = 0; i < MobaDJ._connections.length; i++) {
        MobaDJ._connections[i].trigger();
    }
    MobaDJ._sendButtonStates();
};

// Pushes the current state of every button-style output plus hot cues.
MobaDJ._sendButtonStates = function () {
    var i;
    var outs = MobaDJ._buttonOutputs();
    for (i = 0; i < outs.length; i++) {
        var o = outs[i];
        midi.sendShortMsg(o[2], o[3], engine.getValue(o[0], o[1]) >= 0.5 ? 0x7F : 0x00);
    }
    // Hot cues: same rule as the track-load refresh (position >= 0 → cue exists).
    for (var d = 1; d <= 2; d++) {
        var group = "[Channel" + d + "]";
        var status = d === 1 ? 0x90 : 0x91;
        for (var h = 1; h <= 8; h++) {
            var on = engine.getValue(group, "hotcue_" + h + "_position") >= 0 &&
                     engine.getValue(group, "track_loaded") > 0;
            midi.sendShortMsg(status, 0x17 + h, on ? 0x7F : 0);
        }
    }
};

MobaDJ.shutdown = function () {
    for (var i = 0; i < MobaDJ._connections.length; i++) {
        MobaDJ._connections[i].disconnect();
    }
    MobaDJ._connections = [];
    // Hand the crossfader back the way the user set it in Mixxx's preferences.
    MobaDJ.xfaderCurve(0, 0x0B, 0);
    MobaDJ.xfaderReverse(0, 0x0C, 0);
};

// ---- Crossfader setup (from the app's Beatmatch tab and Settings) ----
//
// Mixxx's crossfader gain on the far side is 1 - |position|^xFaderCurve
// (EngineXfader, Mixxx 2.5). Curve 1 = linear fade; the max (1000) keeps both
// decks at full volume until the very edge, so a short move cuts — a scratch
// curve. Values a script sets are not saved by Mixxx (they last until Mixxx
// restarts), so the app re-sends its choice whenever Mixxx comes back.
//
// 127 = on. 0 = put back what was there before we touched it — so a user who
// set a curve or hamster mode in Mixxx's preferences keeps it.
MobaDJ.XFADER_GROUP = "[Mixer Profile]";
MobaDJ.SCRATCH_CURVE = 1000;      // EngineXfader::kTransformMax
MobaDJ.XFADER_ADDITIVE = 0;       // xFaderMode: 0 = additive, 1 = constant power
MobaDJ._savedCurve = null;        // { curve, mode } before scratch was switched on
MobaDJ._savedReverse = null;      // xFaderReverse before reverse was switched on

MobaDJ.xfaderCurve = function (channel, control, value) {
    var g = MobaDJ.XFADER_GROUP;
    if (value >= 64) {
        if (MobaDJ._savedCurve === null) {
            MobaDJ._savedCurve = {
                curve: engine.getValue(g, "xFaderCurve"),
                mode: engine.getValue(g, "xFaderMode")
            };
        }
        // Additive: constant power would also pull the center down by its calibration.
        engine.setValue(g, "xFaderMode", MobaDJ.XFADER_ADDITIVE);
        engine.setValue(g, "xFaderCurve", MobaDJ.SCRATCH_CURVE);
    } else if (MobaDJ._savedCurve !== null) {
        engine.setValue(g, "xFaderMode", MobaDJ._savedCurve.mode);
        engine.setValue(g, "xFaderCurve", MobaDJ._savedCurve.curve);
        MobaDJ._savedCurve = null;
    }
};

MobaDJ.xfaderReverse = function (channel, control, value) {
    var g = MobaDJ.XFADER_GROUP;
    if (value >= 64) {
        if (MobaDJ._savedReverse === null) {
            MobaDJ._savedReverse = engine.getValue(g, "xFaderReverse");
        }
        engine.setValue(g, "xFaderReverse", 1);
    } else if (MobaDJ._savedReverse !== null) {
        engine.setValue(g, "xFaderReverse", MobaDJ._savedReverse);
        MobaDJ._savedReverse = null;
    }
};

// ---- Helpers ----

MobaDJ._decodeRelative = function (value) {
    return value < 64 ? value : value - 128;
};

MobaDJ._jogTouch = function (deckNum, value) {
    if (value > 0) {
        engine.scratchEnable(
            deckNum,
            MobaDJ.ticksPerRev,
            MobaDJ.rpm,
            MobaDJ.alpha,
            MobaDJ.beta
        );
    } else {
        engine.scratchDisable(deckNum);
    }
};

MobaDJ._jogTurn = function (deckNum, value) {
    var delta = MobaDJ._decodeRelative(value);
    if (engine.isScratching(deckNum)) {
        engine.scratchTick(deckNum, delta);
    } else {
        engine.setValue("[Channel" + deckNum + "]", "jog", delta * MobaDJ.bendScale);
    }
};

// Tempo fader: 0..127 → −1..+1 (64 = unity), where + is always FASTER.
// Written through rate_ratio because the sign of `rate` flips with Mixxx's
// "slider direction" preference (Preferences → Decks), which made the fader
// run backwards on a default install.
MobaDJ._tempoSet = function (deckNum, value) {
    var group = "[Channel" + deckNum + "]";
    var norm = (value - 64) / 63;
    if (norm < -1) norm = -1;
    if (norm > 1) norm = 1;
    engine.setValue(group, "rate_ratio", 1 + norm * engine.getValue(group, "rateRange"));
};

MobaDJ._pflToggle = function (deckNum, value) {
    if (value > 0) {
        var group = "[Channel" + deckNum + "]";
        var current = engine.getValue(group, "pfl");
        engine.setValue(group, "pfl", current > 0 ? 0 : 1);
    }
};

// Toggle slip_enabled on the deck (deterministic toggle on press only, ignore release).
MobaDJ._slipToggle = function (deckNum, value) {
    if (value > 0) {
        var group = "[Channel" + deckNum + "]";
        var current = engine.getValue(group, "slip_enabled");
        engine.setValue(group, "slip_enabled", current > 0 ? 0 : 1);
    }
};

// Toggle bypass on the QuickEffectRack (filter chain) per deck.
MobaDJ._filterEnableToggle = function (deckNum, value) {
    if (value > 0) {
        var group = "[QuickEffectRack1_[Channel" + deckNum + "]]";
        var current = engine.getValue(group, "enabled");
        engine.setValue(group, "enabled", current > 0 ? 0 : 1);
    }
};

// Cycles between QuickEffect chain presets (Filter, LP/HP, Echo, etc).
// dir = +1 next, -1 previous. chain_selector accepts an incremental value.
MobaDJ._chainPresetChange = function (deckNum, dir) {
    if (dir === 0) return;
    var group = "[QuickEffectRack1_[Channel" + deckNum + "]]";
    engine.setValue(group, "chain_selector", dir);
};

// Tempo range — index 0..3 from the app maps to a float in rateRange (±fraction, e.g. 0.08 = ±8%).
MobaDJ._tempoRanges = [0.04, 0.08, 0.16, 0.5];
MobaDJ._setTempoRange = function (deckNum, idx) {
    var bounded = Math.max(0, Math.min(3, idx));
    engine.setValue("[Channel" + deckNum + "]", "rateRange", MobaDJ._tempoRanges[bounded]);
};

// Tempo fine nudge — adds/subtracts 0.01 to the current BPM, directly.
// Mixxx 2.4 accepts setValue on `bpm` and adjusts `rate` internally respecting
// the configured `rateRange`. Zero math on our side.
MobaDJ._tempoFineNudge = function (deckNum, dir) {
    var group = "[Channel" + deckNum + "]";
    var current = engine.getValue(group, "bpm");
    if (current <= 0) return;
    engine.setValue(group, "bpm", current + dir * 0.01);
};

// Toggle the enabled state of an FX rack slot (unit 1=deck1, unit 2=deck2; slot 1..3).
MobaDJ._fxSlotToggle = function (deckNum, slotNum, value) {
    if (value > 0) {
        var group = "[EffectRack1_EffectUnit" + deckNum + "_Effect" + slotNum + "]";
        var current = engine.getValue(group, "enabled");
        engine.setValue(group, "enabled", current > 0 ? 0 : 1);
    }
};

// Beatloop sizes corresponding to the 9 pads (indexed 0..8).
MobaDJ.beatloopSizes = ["0.125", "0.25", "0.5", "1", "2", "4", "8", "16", "32"];

// Generic handler for beatloop pads — one shared by all 9 pads × 2 decks.
// Mixxx passes `control` = midino (0x40..0x48) and `group` = [ChannelN] via the XML.
//
// Behavior:
//   - Ignores release (value=0) so Mixxx doesn't deactivate the loop the moment
//     you lift your finger from the pad.
//   - Press of the same size already running → `reloop_toggle` (turns it off).
//   - Press of a different size while a loop is active → switches to the new size.
//   - Press with no loop active → activates it.
MobaDJ.beatloopHandler = function (channel, control, value, status, group) {
    if (value <= 0) return;
    var padIndex = control - 0x40;
    if (padIndex < 0 || padIndex > 8) return;
    var beats = MobaDJ.beatloopSizes[padIndex];

    var loopActive = engine.getValue(group, "loop_enabled") > 0;
    if (loopActive) {
        var currentBeats = engine.getValue(group, "beatloop_size");
        var requested = parseFloat(beats);
        if (Math.abs(currentBeats - requested) < 0.001) {
            // Same size — turn off
            engine.setValue(group, "reloop_toggle", 1);
            return;
        }
        // Different size — turn off the current one before activating the new one
        // (ensures `beatloop_<new>_activate` won't be a no-op)
        engine.setValue(group, "reloop_toggle", 1);
    }
    engine.setValue(group, "beatloop_" + beats + "_activate", 1);
};

// ---- Bindings exposed in the XML ----

MobaDJ.jogTouchA = function (ch, ctl, v) { MobaDJ._jogTouch(1, v); };
MobaDJ.jogTurnA  = function (ch, ctl, v) { MobaDJ._jogTurn(1, v); };
MobaDJ.jogTouchB = function (ch, ctl, v) { MobaDJ._jogTouch(2, v); };
MobaDJ.jogTurnB  = function (ch, ctl, v) { MobaDJ._jogTurn(2, v); };
MobaDJ.tempoA    = function (ch, ctl, v) { MobaDJ._tempoSet(1, v); };
MobaDJ.tempoB    = function (ch, ctl, v) { MobaDJ._tempoSet(2, v); };
MobaDJ.pflA      = function (ch, ctl, v) { MobaDJ._pflToggle(1, v); };
MobaDJ.pflB      = function (ch, ctl, v) { MobaDJ._pflToggle(2, v); };
MobaDJ.filterEnableA = function (ch, ctl, v) { MobaDJ._filterEnableToggle(1, v); };
MobaDJ.filterEnableB = function (ch, ctl, v) { MobaDJ._filterEnableToggle(2, v); };
MobaDJ.slipToggleA = function (ch, ctl, v) { MobaDJ._slipToggle(1, v); };
MobaDJ.slipToggleB = function (ch, ctl, v) { MobaDJ._slipToggle(2, v); };
MobaDJ.filterPrevA = function (ch, ctl, v) { if (v > 0) MobaDJ._chainPresetChange(1, -1); };
MobaDJ.filterNextA = function (ch, ctl, v) { if (v > 0) MobaDJ._chainPresetChange(1,  1); };
MobaDJ.filterPrevB = function (ch, ctl, v) { if (v > 0) MobaDJ._chainPresetChange(2, -1); };
MobaDJ.filterNextB = function (ch, ctl, v) { if (v > 0) MobaDJ._chainPresetChange(2,  1); };
MobaDJ.tempoRangeA = function (ch, ctl, v) { MobaDJ._setTempoRange(1, v); };
MobaDJ.tempoRangeB = function (ch, ctl, v) { MobaDJ._setTempoRange(2, v); };
MobaDJ.tempoFineUpA = function (ch, ctl, v) { if (v > 0) MobaDJ._tempoFineNudge(1, +1); };
MobaDJ.tempoFineDownA = function (ch, ctl, v) { if (v > 0) MobaDJ._tempoFineNudge(1, -1); };
MobaDJ.tempoFineUpB = function (ch, ctl, v) { if (v > 0) MobaDJ._tempoFineNudge(2, +1); };
MobaDJ.tempoFineDownB = function (ch, ctl, v) { if (v > 0) MobaDJ._tempoFineNudge(2, -1); };
MobaDJ.fxSlot1EnableA = function (ch, ctl, v) { MobaDJ._fxSlotToggle(1, 1, v); };
MobaDJ.fxSlot2EnableA = function (ch, ctl, v) { MobaDJ._fxSlotToggle(1, 2, v); };
MobaDJ.fxSlot3EnableA = function (ch, ctl, v) { MobaDJ._fxSlotToggle(1, 3, v); };
MobaDJ.fxSlot1EnableB = function (ch, ctl, v) { MobaDJ._fxSlotToggle(2, 1, v); };
MobaDJ.fxSlot2EnableB = function (ch, ctl, v) { MobaDJ._fxSlotToggle(2, 2, v); };
MobaDJ.fxSlot3EnableB = function (ch, ctl, v) { MobaDJ._fxSlotToggle(2, 3, v); };
// beatloopHandler is called directly by the 18 <control> entries in the XML
// (9 pads × 2 decks), all pointing to the same handler.
