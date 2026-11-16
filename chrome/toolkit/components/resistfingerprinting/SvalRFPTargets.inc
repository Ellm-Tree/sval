/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Sval's RFPTargets, included into the list of targets. Each value is a bit in
// the target set and a name in the overrides strings, so a value never moves
// and is never reused.

// Screen size reported as a common resolution at or above the real one.
ITEM_VALUE(ScreenSizeCommon,            81)
// Outer window size reported as the inner size plus a typical toolbar.
ITEM_VALUE(WindowOuterSizeTypical,      82)
// navigator.languages, Accept-Language and the JS default locale carry only
// the primary language.
ITEM_VALUE(LanguagesPrimaryOnly,        83)
// enumerateDevices reports MediaDevices' one device for each input kind the
// page holds no permission for.
ITEM_VALUE(MediaDevicesBeforePermission, 84)
// Standard-mapped gamepads report a generic id.
ITEM_VALUE(GamepadIdGeneric,            85)
// navigator.permissions.query reads a deny that only a global default gives
// as "prompt".
ITEM_VALUE(PermissionsDefaultDenyPrompt, 86)
// speechSynthesis.getVoices lists only the OS's own voices for the UI language.
ITEM_VALUE(SpeechVoicesDefault,         87)
// WebGPU adapters report timestamp-query as unsupported.
ITEM_VALUE(WebGPUTimestampQueryHidden,  88)
// Screen size reported from a shorter list of common resolutions than
// ScreenSizeCommon's.
ITEM_VALUE(ScreenSizeTight,             89)
// Emoji fall back to the bundled Twemoji Mozilla instead of the OS emoji font.
ITEM_VALUE(EmojiFontBundled,            90)
// Each sample of audio output a page reads is scaled by its own gain just
// under 1, drawn from a per-site, per-session key and the samples.
ITEM_VALUE(AudioOutputRandomization,    91)
// navigator.hardwareConcurrency is a count between half the real count and
// the real count, drawn from a per-site, per-session key.
ITEM_VALUE(NavigatorHWConcurrencyRandomized, 92)
