# Fingerprinting catalogue

This is the reference for what Sval does about each fingerprinting surface. It
covers every JS API, and the closely related CSS and HTTP surface, that
fingerprinting scripts, test suites and papers use, grouped by area. Each
area's table is a decision, and the decisions are built.

Each decision sets a default and a control: none, global, strict or per site.
Gecko facts come from the tree pinned in `upstream.txt` (153 ESR) and are
cited by file and symbol. Claims not confirmed are marked **[unverified]**.

## Where the decisions live in code

- **Defaults.** `branding/sval/pref/app-sval-prefs.js` turns fingerprinting
  protection (FPP) on in every window and sets
  `privacy.fingerprintingProtection.overrides` on top of Gecko's
  `RFPTargetsDefault.inc`. Its comment says why each target is in or out.
- **Native targets.** Where Gecko had no target, Sval adds one in a patch named
  `patches/fp-*.patch`. The media gate is
  `patches/media-autoplay-site-permission.patch` with the pref
  `media.autoplay.site-permission-only`.
- **Settings.** `SvalFingerprinting.sys.mjs` lists every default and strict item
  as a setting, each a token in the overrides string or a Gecko pref.
- **Per site.** `SvalSiteProtections.sys.mjs` keeps each site's choice. A site's
  "fingerprinting off" choice is a `-AllTargets` granular entry, which
  `FingerprintingWebCompatService` reads from Sval's own override prefs beside
  `privacy.fingerprintingProtection.granularOverrides`, so every Doc-gated
  target lifts together. The tables' finer per-site controls (fonts, voices,
  sample rate, languages, sensors, `timestamp-query`) are not separate
  switches; that one switch covers them.
- **Secure DNS.** §4 line 18's DNS-over-HTTPS is off by default
  (decision 0105): the network's own DNS keeps internal names, VPNs and router
  filters working. Protections' Secure DNS card, and the protection button's
  panel, offer encrypted DNS with or without fallback, through Quad9
  (pre-selected), Cloudflare or a custom URL, and the names that always use the
  network's DNS. ECH is Gecko's default and works whenever encrypted DNS is
  on. Mozilla's DoH rollout stays off.

## Terms

- **RFP:** `privacy.resistFingerprinting`. Every target, no per-site
  exceptions.
- **FPP:** `privacy.fingerprintingProtection`. `RFPTargetsDefault.inc` plus
  `privacy.fingerprintingProtection.overrides`.
- **Baseline:** Firefox's baseline FPP, on everywhere by default
  (`RFPTargetsDefaultBaseline.inc`): `EfficientCanvasRandomization`,
  `ScreenAvailToResolution` and `MaxTouchPointsCollapse`.
- **Doc-gated:** checked through a document or global, so
  `privacy.fingerprintingProtection.granularOverrides` can change it per site
  from the next load.
- **Global-only:** checked through the string or principal form of
  `nsContentUtils::ShouldResistFingerprinting`, or a pref, so it cannot vary
  per site.

## How Gecko decides a target (verified)

- `Document::ShouldResistFingerprinting` and
  `WorkerPrivate::ShouldResistFingerprinting` pass
  `mOverriddenFingerprintingSettings` into `nsRFPService::IsRFPEnabledFor`.
  Targets checked through them are Doc-gated. `nsGlobalWindowInner` and
  `nsGlobalWindowOuter` forward to their document, and workers carry their
  document's state and overrides.
- The string form, `nsContentUtils::ShouldResistFingerprinting(const char*, …)`,
  hard-codes private mode on and passes no overrides. A target in the FPP set
  that only the string form checks is on in every window and cannot vary per
  site: `FrameRate`, `RoundWindowSize`, `UseStandinsForNativeColors` and the
  smooth-scroll half of `CSSPrefersReducedMotion`. `KeyboardEvents` and
  `PointerEvents` use it as a pre-check before the document check, so a site
  can be exempted from them but not opted in beyond the global set.
- The principal form, `ShouldResistFingerprinting_dangerous(nsIPrincipal*)`,
  reads only the global prefs and
  `privacy.resistFingerprinting.exemptedDomains`. The channel form honours the
  ETP allow list and `exemptedDomains` but not `granularOverrides`.
- `nsRFPService::HandleExceptionalRFPTargets` handles `JSLocale` before any
  override: it is on only when the target is active **and**
  `privacy.spoof_english == 2`.
- The ETP site exception (`ContentBlockingAllowList`) lifts every FPP target
  for a site. Font visibility applies its own check
  (`FontVisibilityProvider.cpp`).
- `BrowsingContext` already carries per-tab overrides that DevTools RDM and
  WebDriver BiDi use: `customUserAgent` (header too), `customPlatform`,
  `languageOverride`, `timezoneOverride`, `maxTouchPointsOverride` and
  `forceOffline`. They are top-level scoped.
- Sval keeps the `fingerprinting-protection-overrides` Remote Settings
  collection (`browser.sval.remoteSettings.collections`), so Mozilla's webcompat
  granular overrides arrive through `FingerprintingWebCompatService.sys.mjs`.
  `privacy.fingerprintingProtection.remoteOverrides.enabled` is false by
  default (decision 1685), so they apply only once the user turns on
  Settings' "Mozilla's compatibility fixes".

## 1. Graphics, fonts and layout measurement

### Decisions

| # | Entries | Default | Control |
|---|---|---|---|
| 1 | Canvas 2D readback, `getImageData`, OffscreenCanvas and workers | Real pixel noise per site and session (`+CanvasRandomization`, `-EfficientCanvasRandomization`) | Per site: the `canvas` permission. Strict adds `CanvasExtractionFromThirdPartiesIsBlocked`. |
| 2 | `isPointInPath` / `isPointInStroke` | Allow | None |
| 3 | Canvas text and emoji rendering | Covered by line 1. Native emoji. | Strict: bundled emoji font |
| 4 | `measureText`, SVG text measurement, element measurement, scrollbar width | Allow | None |
| 5 | WebGL vendor and renderer strings | `+WebGLVendorSanitize` on top of the sanitized renderer | Strict: `+WebGLRenderInfo` |
| 6 | WebGL parameters and limits | Allow | Strict: `+WebGLRenderCapability` |
| 7 | WebGL extension list, shader precision, availability | Allow | None |
| 8 | WebGL `readPixels` | Allow | Strict: `+WebGLRandomization`. Per site: the `canvas` permission. |
| 9 | Installed fonts (measurement, `document.fonts`, `FontFace local()`, CSS-only) | `+FontVisibilityLangPack` everywhere | Per site: allow installed fonts (granularOverrides) |
| 10 | Font preferences, system font keywords | Allow | Strict: `FontVisibilityRestrictGenerics` |
| 11 | WebGPU adapter info | Empty strings, `+WebGPUIsFallbackAdapter` | None |
| 12 | WebGPU limits, features, timing | Allow limits and features. `timestamp-query` hidden (native, new target), decided 2026-10-13: quantising needs a vendored-wgpu patch, and its users are developers profiling their own code. | Per site: allow `timestamp-query`. Strict: `+WebGPULimits` |
| 13 | System colours and accent colour | `widget.non-native-theme.use-theme-accent=false` | Strict: stand-in native colours |
| 14 | Font smoothing, CSS feature surface, devicePixelRatio | Allow, matching Firefox ESR. devicePixelRatio is decided in §4. | None |

This area carries the highest-entropy, most stable signals: canvas and WebGL
render hashes (GPU, driver, font rasteriser, OS), GPU identity strings,
WebGL and WebGPU limits, and the installed-font set. Gecko has no protection
at all for element measurement, SVG text metrics, `measureText`, emoji sets,
scrollbar width or WebGL extension lists outside RFP. Almost every target here
is Doc-gated. The exceptions are `UseStandinsForNativeColors` and the
`DrawTargetWebgl` fallback.

### Verified findings

- **F1, Efficient shadows real noise.** `CanvasUtils::ImageExtractionResult`
  returns `EfficientRandomize` before it checks `CanvasRandomization` or
  `WebGLRandomization`, for elements and for OffscreenCanvas. The pixel-noise
  paths act only on `ImageExtraction::Randomize`:
  `CanvasRenderingContext2D::GetImageData` and `GetImageBuffer`,
  `ClientWebGLContext`'s `readPixels` and `getBufferSubData`, and
  `OffscreenCanvasDisplayHelper::MaybeRandomizePixels`. With both targets on,
  2D and WebGL pixels are never noised, so real noise needs
  `-EfficientCanvasRandomization,+CanvasRandomization`. The WebGPU canvas is
  the exception: `webgpu::CanvasContext::GetImageBuffer` checks
  `CanvasRandomization` directly.
- **F2, what efficient randomisation is.** `EfficientRandomize` passes a key to
  the image encoder, and only `nsPNGEncoder::MaybeAddCustomMetadata` uses it: a
  16-byte private `deBG` chunk after IDAT. JPEG, WebP and BMP ignore the key.
  `getImageData`, a JPEG export or stripping the chunk bypasses it.
- **F3, how real noise works.** `nsRFPService::RandomizeElements` flips the low
  bit of some pixel channels. Positions come from an HMAC of a per-session key
  and the top-level site (`nsRFPService::GenerateKey`), so third parties share
  the top site's seed. Alpha and uniform images are skipped, and a principal
  holding the `canvas` permission ALLOW is never noised. The key resets daily
  (`privacy.resistFingerprinting.randomization.daily_reset.enabled`).
- **F4, the `canvas` permission.** `CanvasUtils::GetCanvasExtractDataPermission`
  reads it. ALLOW exempts a site from the prompt, the noise and the efficient
  key. Firefox's site-permission UI hides it unless RFP is on
  (`SitePermissions.sys.mjs`).
- **F5, gating.** Canvas checks route through the owner document or the
  OffscreenCanvas global. Font code goes through
  `nsPresContext::ShouldResistFingerprinting` to the document. WebGPU uses
  `nsIGlobalObject::ShouldResistFingerprinting`. Global-only:
  `UseStandinsForNativeColors` (`PreferenceSheet`) and the `DrawTargetWebgl`
  capability check.

### Entries

- **Canvas 2D readback** (`toDataURL`, `toBlob`, `convertToBlob`). A hash of
  rendered text and geometry: GPU, Skia, rasteriser, fonts, OS. The most-used
  vector. Gecko: `EfficientCanvasRandomization` (baseline), `CanvasRandomization`
  (FPP), and RFP's `CanvasImageExtractionPrompt`,
  `CanvasExtractionBeforeUserInputIsBlocked` and
  `CanvasExtractionFromThirdPartiesIsBlocked` (placeholder data, logic in
  `IsImageExtractionAllowed_impl`). System callers are unrestricted.
- **Canvas `getImageData`.** The same hash, bypassing encoder-level defences.
  Gecko: noised by `CanvasRandomization` only when Efficient is off (F1). Same
  seed as readback, so the two agree.
- **`isPointInPath` / `isPointInStroke`.** Antialiasing edge behaviour, a few
  bits. Gecko: return `false` only under the RFP prompt targets. Hit-testing
  in charts and games needs them.
- **Canvas text and emoji rendering.** Fallback fonts, emoji font and version,
  AA mode, and GPU under accelerated canvas. Gecko: readback controls and font
  visibility apply. No AA normalisation. Bundled `TwemojiMozilla.ttf` comes
  after the system emoji font in `font.name-list.emoji` on Windows and Linux.
  Sval ships it on macOS too (`--enable-bundled-fonts`), and Strict's
  `EmojiFontBundled` (native, Doc-gated) resolves emoji fallback to it
  alone (`gfxPlatformFontList::GetPrefFontsLangGroupLocked`). The pref is
  global and styles the browser's own UI, so it cannot do this. An emoji
  newer than Twemoji's set still falls back to the system font.
- **`measureText` / `TextMetrics`.** Advance widths and bounding boxes: font
  presence without the DOM. Gecko: no target in
  `CanvasRenderingContext2D::MeasureText`; font visibility narrows it.
- **OffscreenCanvas and canvas in workers.** The same signals off the main
  thread. Gecko: the same targets through `OffscreenCanvas::ShouldResistFingerprinting`
  and the worker's overrides; the prompt is proxied to the main thread.
- **WebGL vendor and renderer.** GPU vendor and model, 5–8 bits. Gecko:
  `VENDOR` is always "Mozilla". `RENDERER` and `UNMASKED_RENDERER_WEBGL` are
  bucketed by `webgl::SanitizeRenderer` by default. `UNMASKED_VENDOR_WEBGL` is
  raw unless `WebGLVendorSanitize`. RFP targets: `WebGLRenderInfo`,
  `WebGLRendererConstant`, `WebGLVendorConstant`, `WebGLVendorRandomize`.
- **WebGL parameters and limits.** Texture, uniform and viewport maxima: GPU
  class, 3–6 bits. Gecko: `WebGLRenderCapability` clamps to common values at
  context creation (RFP); `webgl.min_capability_mode` clamps to spec minimums.
- **WebGL extension list.** GPU family and driver, 3–5 bits. Gecko: filtered
  only by `IsExtensionForbiddenForCaller`; RFP hides `WEBGL_debug_shaders`.
- **WebGL shader precision.** Mobile versus desktop, 1–2 bits. Gecko: no
  target; `webgl.min_capability_mode` zeroes fragment highp.
- **WebGL `readPixels` / `getBufferSubData`.** A GPU and driver render hash.
  Gecko: `WebGLRandomization` noise, shadowed by Efficient (F1); the `canvas`
  permission exempts. TF.js and GPU picking break under noise.
- **WebGL availability probes.** Software compositor (a VM or bot signal) via
  `failIfMajorPerformanceCaveat`. Gecko: no target; `webgl.disabled` and
  `webgl.enable-webgl2` are global.
- **WebGPU adapter info.** Gecko: `vendor`, `architecture`, `device` and
  `description` are always empty; subgroup sizes are fixed; `isFallbackAdapter`
  is forced false under `WebGPUIsFallbackAdapter`. WebGPU needs
  `dom.webgpu.enabled` and a secure context.
- **WebGPU limits.** GPU class, 3–5 bits. Gecko: `WebGPULimits` fills spec
  defaults on the adapter and on `requestDevice`.
- **WebGPU features.** Platform and GPU family. Gecko: no target in
  `Adapter::Adapter`.
- **WebGPU timing.** GPU microarchitecture through `timestamp-query` and
  compute timing. Gecko: no quantisation of timestamps was found
  **[unverified]**; Sval's `WebGPUTimestampQueryHidden` hides the feature.
- **SVG text measurement** (`getComputedTextLength`, `getBBox` and the rest).
  Glyph advances, bypassing canvas defences. Gecko: no target; font visibility
  only.
- **Font enumeration by measurement.** Which probe fonts are installed: OS
  version and installed apps, 6–10 bits. Gecko: visibility levels from
  `nsPresContext::ComputeFontVisibility`. `FontVisibilityBaseSystem` (RFP)
  allows OS fonts only, `FontVisibilityLangPack` (FPP) adds language packs,
  otherwise `layout.css.font-visibility` allows all. Enforced in
  `gfxPlatformFontList::FindAndAddFamilies` and `IsVisibleToCSS`. Windows RFP
  adds `UseHardcodedFontSubstitutes`.
- **`document.fonts.check()` and `FontFace` `local()`.** The same font set
  without layout. Gecko: `LookupLocalFont` applies the same visibility.
- **CSS-only font probing.** `@font-face` with `local()` and a beacon URL, no
  JS. Gecko: the same visibility filter.
- **Font preferences and generics.** Default fonts, minimum size, text zoom.
  Gecko: `FontVisibilityRestrictGenerics` keeps generics off hidden fonts and
  resolves `system-ui` to a standard face; `font.name.*` prefs are global.
- **CSS system font keywords** (`font: caption` and the rest). The OS UI font.
  Gecko: `GetSpoofedSystemFontForRFP` under `FontVisibilityRestrictGenerics`.
- **Element measurement** (`getBoundingClientRect`, `getClientRects`,
  `offset*`, observers). Sub-pixel layout of crafted content. Gecko: no
  target; inputs are fonts and `WindowDevicePixelRatio`.
- **Emoji glyph set.** OS and emoji font version. Gecko: no target; emoji fonts
  are base system fonts and stay visible. Strict: Sval's `EmojiFontBundled`.
- **Scrollbar width.** OS and overlay setting, 1–2 bits. Gecko: no target;
  `widget.non-native-theme.scrollbar.*` and `ui.useOverlayScrollbars` are
  global. Sval's UA sheet makes a page's scrollbars thin by default
  (`content-thin-scrollbars.patch`), which narrows the classic strip and keeps
  the same inputs: an overlay scrollbar still takes no layout space, and
  Windows' thin size still follows the system's size.
- **System colours and accent colour.** About 38 system colour keywords. The
  user's accent colour is the high-entropy part. Gecko:
  `UseStandinsForNativeColors` or `ui.use_standins_for_native_colors`, both
  global. The non-native theme leaks the accent colour on macOS and Linux
  unless `widget.non-native-theme.use-theme-accent` is false
  (`ShouldUseStandinsForNativeColorForNonNativeTheme`).
- **Font smoothing.** `-moz-osx-font-smoothing` reveals macOS. Gecko:
  `DOMStyleOsxFontSmoothing` hides it (RFP).
- **devicePixelRatio and zoom.** Scale every measurement. Decided in §4.
- **Computed-style surface and `CSS.supports`.** Engine version. Gecko:
  `layout.css.*.enabled` prefs, kept at ESR's values.

## 2. Audio, media and device access

### Decisions

| # | Entries | Default | Control |
|---|---|---|---|
| 1 | Media playback: video, audio, realtime `AudioContext` and its `AnalyserNode` data | Plays only on sites the user allowed. A gesture alone does not unblock (native). | A header control, visible when the site is blocked, that says the site is trying to play and offers allow now, always or never. Per-site choices are editable in settings. Stored in the `autoplay-media` permission. |
| 2 | Silent audio rendering: `OfflineAudioContext`, and `AnalyserNode` data in one | Renders, as in Firefox: it makes no sound. Blocking it made Sval stand out, decided 2026-10-16: the 2026-10-16 audit read an audio timeout, 13.02 bits (1 in 8,317), where Firefox's rendered value cost 3.71, and CreepJS hung on it. Every sample a page reads carries its own gain between 0.999 and 0.9999, per site and session (`+AudioOutputRandomization`, native). | The noise has a global switch, and a site with fingerprinting protection off reads the raw output. |
| 3 | Audio sample rate, latency, channel count | Gecko's default (real values) | Per site: standard audio hardware (`+AudioSampleRate,+AudioContext`), in the Sites card |
| 4 | Audio constants, audio timing | Allow | None |
| 5 | Camera, mic and speaker list, `devicechange` | Constant shape before permission, full list after (native) | Existing camera and mic permissions |
| 6 | Camera constraints, permission states, speaker selection | Allow | Existing site permissions |
| 7 | Speech voices | OS default voices only (native) | Per site: full list |
| 8 | Speech recognition | Off | None |
| 9 | Codec support: `canPlayType`, `MediaRecorder`, WebRTC codecs | Allow | None |
| 10 | Hardware decoding and smoothness: `MediaCapabilities`, MSE, WebCodecs hints | Truthful (Gecko default) | Strict: normalize (`+MediaCapabilities`) |
| 11 | WebCodecs availability | Expose | None |
| 12 | DRM (EME) | On, hardware DRM truthful (Gecko default). Hiding it drops Windows PlayReady sites to software DRM. | Strict: hide hardware DRM |
| 13 | Video frame stats, `MediaError` text, caption-track loading, preload | Normalize | None |
| 14 | Gamepads | Generic id (native) | Per site: block in strict |
| 15 | Motion and orientation sensors | Allow on desktop | Per site |
| 16 | `getAutoplayPolicy()` | Allow. It reports "disallowed" under line 1. | Follows line 1 |
| 17 | Picture-in-picture, wake lock, Serial, MIDI, presence-only APIs, and the absent APIs | Firefox defaults | Existing permissions |

Line 13's preload part is not applied: its target, `NetworkConnection`, also
pins `navigator.onLine` to true, which offline-first apps need to read
truthfully (`app-sval-prefs.js`).

This area has three kinds of signal: DSP output (OfflineAudioContext and
AnalyserNode vary with CPU, SIMD path, OS and build, with no permission),
capability lists (codecs, hardware decode, CDMs), and device and user
configuration (voices, devices, sample rate, latency, autoplay, gamepads,
sensors). None of Gecko's targets here is in either default list, so all are
off outside RFP until Sval's overrides add them.

### Verified findings

- Gecko adds no audio noise in any mode. Its Web Audio targets only normalize
  sample rate, latency and channel count. Sval's `AudioOutputRandomization`
  adds it. Brave scales all of a site's audio by one gain in [0.999, 1);
  Sval gives each sample its own gain between 0.999 and 0.9999, drawn by
  `SvalRFPService::RandomizeAudioOutput` from a per-site, per-session key, the
  channel, the sample's index and a hash of the samples, as canvas noise
  hashes the image. Each gain is a base the key alone fixes plus a jitter,
  so what a page learns from many renders of the same samples, such as each
  sample's largest gain, still differs between sites. A reference signal
  rendered beside a fingerprint, such
  as a `ConstantSourceNode` on another channel or in another context, so
  draws unrelated gains and cannot divide them out. The noise goes into an
  offline render once, in `OfflineDestinationNodeEngine::CreateAudioBuffer`,
  so `getChannelData` and `copyFromChannel` agree; into the samples
  `AnalyserNode::GetTimeDomainData` returns, which its frequency data is
  computed from; into the input a `ScriptProcessorNode` or an
  `AudioWorkletProcessor` reads, and the values of a param a node feeds; and
  into a `DynamicsCompressorNode`'s `reduction`. No sample moves by more than 0.01 dB, so the
  byte forms of the analyser data rarely change.
  `SvalRFPService::AudioOutputNoiseKey` draws the key from the randomization
  key canvas noise uses, which the session key and the top-level site fix;
  private browsing has its own session key.
- Gecko exempts offline contexts from autoplay blocking
  (`AutoplayPolicy::IsAllowedToPlay(const AudioContext&)` returns true for
  `IsOffline()`), and a user gesture unblocks media in every Gecko autoplay
  mode, `BLOCKED_ALL` included. Line 1 therefore needed a native change.
  Sval's gate keeps Gecko's offline exemption (line 2).
- Absent or chrome-only in Gecko 153: Battery (ChromeOnly), WebHID, WebUSB,
  Web Bluetooth and the Generic Sensor API (not implemented); Vibration,
  WebXR, WebVR, SpeechRecognition, ImageCapture, AudioSession and
  `audioTracks`/`videoTracks` (pref-off).
- `WebCodecs` hides the API through `nsRFPService::ExposeWebCodecsAPI`, which
  uses the principal form, so it cannot vary per site.

### Entries

- **OfflineAudioContext render hash.** A float sum over a compressed oscillator
  render: CPU, SIMD path, OS maths. Gecko: no target touches offline output;
  `AudioSampleRate` does not apply to offline contexts. `dom.webaudio.enabled`
  removes all of Web Audio. Sval: `AudioOutputRandomization` changes the sum
  per site and session.
- **AnalyserNode data.** FFT output on top of the sample sum. Gecko: no target.
  Sval: `AudioOutputRandomization`, as for the render.
- **DynamicsCompressor `reduction` and node constants.** Engine-specific spec
  constants, the same for all Firefox users.
- **`AudioContext.sampleRate`.** The output device's rate. Gecko:
  `AudioSampleRate` normalizes to 44100 (`CubebUtils::PreferredSampleRate`).
- **`outputLatency`, `getOutputTimestamp`.** Output device type (Bluetooth
  headsets report high latency). Gecko: `AudioContext` returns fixed per-OS
  values from `AudioContext::OutputLatency`. `baseLatency` is always 0
  (`AudioContext::BaseLatency`), so it reveals nothing.
- **`maxChannelCount`.** Surround or pro interfaces. Gecko: `AudioContext`
  returns 2.
- **Audio timing.** Render speed and `currentTime`. Gecko: `currentTime` is
  already reduced; `ReduceTimerPrecision` applies.
- **Autoplay gating.** Whether media starts without a gesture reveals the
  user's setting. Gecko: `media.autoplay.default`, `blocking_policy` and the
  per-site `autoplay-media` permission (`AutoplayPolicy::GetSiteAutoplayPermission`),
  read from the top-level window context. `IsAllowedToPlayByBlockingModel`
  lets sticky activation and traits (capture, top-level video documents,
  extension pages) through.
- **`navigator.getAutoplayPolicy()`.** The same bit without playing. Gecko:
  `dom.media.autoplay-policy-detection.enabled`; implemented by
  `IsDocAllowedToPlay`.
- **`enumerateDevices()`.** Before permission, at most one device per kind with
  empty labels; after, the full list. Gecko: spec mode
  (`MediaDevices::FilterExposedDevices`) with a legacy allow list. RFP's
  `MediaDevices` shows one of each kind, inserting fakes, and Sval's
  `MediaDevicesBeforePermission` does that per kind until the kind is granted.
- **`devicechange`.** Plug timing seen by every open site at once. Gecko: not
  sent to unfocused contexts (`media.devices.unfocused.enabled`); RFP
  suppresses it.
- **getUserMedia constraints and track settings.** Camera ranges after a
  grant. Gecko: RFP's `ReduceConstraint` and `StreamVideoFacingMode`.
- **Permissions API for camera and mic.** Gecko reports a saved "Always Ask"
  as `granted`; RFP's `MediaDevices` stops that.
- **`setSinkId` / `selectAudioOutput`.** Speakers after a grant. Gecko:
  `media.setsinkid.enabled`, listed only after a mic or output grant.
- **`speechSynthesis.getVoices()`.** Installed voices, including downloaded
  ones. Gecko: RFP's `SpeechSynthesis` returns none. Sval's
  `SpeechVoicesDefault` keeps the OS default voice and the UI language's
  shipped voices. macOS marks downloaded voices by identifier; Windows and
  Linux backends do not, so there the list is limited by language alone.
- **SpeechRecognition.** Gecko: `media.webspeech.recognition.enable` is false.
- **`canPlayType()`.** OS decoders and licensed codecs. Gecko: no target;
  codec prefs are global.
- **MSE `isTypeSupported`.** The same matrix plus VP9 pref state. Gecko:
  `MediaCapabilities` answers as if prefs were default; without a document it
  falls back to the string form.
- **`MediaRecorder.isTypeSupported`.** Uniform per build. Gecko: no target.
- **`mediaCapabilities.decodingInfo`.** `powerEfficient` reveals the hardware
  decoder. Gecko: `MediaCapabilities` reports supported, smooth, not
  power-efficient, and hides hardware DRM in key-system queries.
- **WebCodecs.** Codec matrix and hardware hints. Gecko: `WebCodecs` hides the
  API (principal form); `MediaCapabilities` forces `hardwareAcceleration` to
  no-preference.
- **RTP `getCapabilities` and SDP codecs.** Gecko: no target.
- **EME.** Which CDMs exist and hardware robustness. Gecko: `media.eme.enabled`
  and Widevine prefs are global; `MediaCapabilities` hides hardware decrypt in
  `MediaKeySystemAccess`.
- **Video frame stats** (`mozParsedFrames` and the rest, `getVideoPlaybackQuality`).
  Decode performance and an engine tell. Gecko: `VideoElementMozFrames`,
  `VideoElementMozFrameDelay` and `VideoElementPlaybackQuality` spoof them.
- **`MediaError.message`.** Decoder detail. Gecko: `MediaError` empties it for
  content.
- **WebVTT track loading.** Caption preferences. Gecko: `WebVTT` loads tracks
  even when disabled.
- **Media preload.** Differs on cellular. Gecko: `NetworkConnection`.
- **Picture-in-picture.** Presence and whether the user turned it off. Gecko:
  `dom.media-pip.enabled`, `dom.documentpip.enabled`.
- **Presence-only media APIs.** Engine and version only. Gecko: pref-gated,
  no target.
- **Gamepad.** Controller vendor and product ids after a button press on the
  page. Gecko: RFP's `Gamepad` returns none; exposure needs input seen in the
  window. Sval's `GamepadIdGeneric` replaces the id.
- **Device motion and orientation.** Sensor calibration error is a stable id
  on mobile. Gecko: RFP's `DeviceSensors` stops events; `device.sensors.*`
  prefs.
- **Battery, WebHID, WebUSB, Web Bluetooth, Generic Sensors, Vibration,
  WebXR.** Absent in Gecko 153.
- **WebSerial and WebMIDI.** Device ids after a grant. Gecko: gated behind a
  site-permission add-on prompt, with randomized denial delays.
- **Screen Wake Lock.** Presence only. Gecko: `dom.screenwakelock.enabled`.

## 3. Navigator, locale and the JS engine

### Decisions

| # | Entries | Default | Control |
|---|---|---|---|
| 1 | User agent (JS and HTTP), `appVersion`, `platform`, `oscpu`, `buildID`, vendor constants, Firefox markers | Allow, identical to Firefox ESR. Accepted gap: a page still tells Sval apart by loading one of its files under `chrome://browser/content/sval/` as an image or stylesheet, which succeeds in Sval alone, and which files load narrows down the build. The `browser` package is `contentaccessible` (`browser/base/jar.mn`), and `nsScriptSecurityManager::CheckLoadURIWithPrincipal` lets any page load such a file as a subresource. | None |
| 2 | CPU core count | Per site and session, a count between half the real count, at least 2, and the real count (`+NavigatorHWConcurrencyRandomized`, native), in documents and workers alike. A fixed tier made Sval stand out, decided 2026-10-16: the 2026-10-16 audit read a fixed 8 at 2.0 bits, the same on every site and across restarts. A web app sizing a worker pool to it keeps at least half its parallelism. | Global: report the real core count. A site with fingerprinting protection off reads the real count. |
| 3 | `deviceMemory`, UA Client Hints, `navigator.connection` | Absent | None |
| 4 | Touch points | Collapsed (baseline) | None |
| 5 | Languages: `navigator.languages`, `Accept-Language`, JS default locale | Primary language only, JS locale matching (native for the locale) | Global: send all languages. Per site: exemption (new Doc-gated target). |
| 6 | `Intl` formatting surface | Allow | None |
| 7 | Timezone | Real | Strict: spoof |
| 8 | PDF viewer flag | `+PdfjsSpoof` | None |
| 9 | `webdriver`, `cookieEnabled`, `onLine`, `window.name`, `history.length`, `referrer` | Firefox defaults | None |
| 10 | Do Not Track, Global Privacy Control | DNT off. GPC on in all windows. | Global: GPC toggle |
| 11 | Storage quota | Real (Gecko default). `DiskStorageLimit` also enforces its 10 GiB group limit (`GetTemporaryStorageLimit`), capping real site storage, so it stays off. | None |
| 12 | Permission states | "prompt" where a denial is a global default (native) | Existing site permissions |
| 13 | Keyboard layout from key events | Allow | Strict: `+KeyboardEvents` |
| 14 | Math precision, CPU architecture tricks, error and stack format, feature detection, API surface | `+JSMathFdlibm`. The rest allow. The API surface stays identical to Firefox ESR. | None |
| 15 | Ad-blocker detection | No default may make anti-adblock work better. List defaults favour blocking strength, and page rules defeat anti-adblock. | Blocking settings |
| 16 | Private-mode detection | Same protections in both window types. A per-site fingerprinting choice made in a normal window does not reach private windows, which keep full protection unless the private session chooses otherwise. OPFS keeps Firefox's behaviour in private windows (decided 2026-10-14). | None |
| 17 | Extension UUID leaks, headless detection, agent-mode detectability, worker parity | Identical answers in every realm (requirement). UUID leaks go with extension work, agent detectability with the agent design, headless detection unchanged. | None |

Most navigator strings are already frozen or hard-coded in Gecko whatever the
mode: `appVersion`, `platform` ("MacIntel" even on ARM), `oscpu`, `productSub`
"20100101", an empty `vendor`, and `buildID` "20181001000000" off
`*.mozilla.org`. `deviceMemory`, `userAgentData`, `navigator.keyboard`,
`getBattery` and `navigator.connection` are absent. So this area's real entropy
comes from core count, languages and locale, timezone, the ESR population, and
engine traits. A Sval build's UA is byte-identical to Firefox's, and Sval adds no
UA token.

### Verified findings

- OPFS throws a SecurityError in private windows
  (`FileSystemManager::BeginRequest`, `CreateFileSystemManagerParent`), a
  private-mode tell. Removing those blocks would write private files to disk
  unencrypted, so Sval waits for Mozilla's encrypted private OPFS (bug 1975760)
  to reach an ESR.
- Firefox sends GPC in private windows only
  (`privacy.globalprivacycontrol.pbmode.enabled`), another private-mode tell.
  Sval sends it in both.
- `navigator.webdriver` is true only while Marionette or the Remote Agent runs.
  Sval's agent synthesizes input through Gecko's WebDriver event module from its
  own actor (`SvalAgentPageChild.sys.mjs`) and starts neither, so it reports
  false.
- `DiskStorageLimit` is checked through the global string form and enforces
  the spoofed quota, so it is a real storage cap, not just a reported value.

### Entries

- **User agent, JS and HTTP.** Browser, major version, OS family. Gecko freezes
  the OS token (`nsHttpHandler::InitUserAgentComponents`). RFP's
  `NavigatorUserAgent` (Doc-gated) and `HttpUserAgent` (channel, global) keep
  the real version, so they gain nothing on macOS and Windows. Overriding one
  without the other is itself a signal.
- **`appVersion`, `platform`, `oscpu`, `buildID`, NavigatorID constants.** OS
  family or nothing. Gecko: hard-coded; the RFP targets only stop `general.*.override`.
- **`hardwareConcurrency`.** About 3 bits. Gecko: `NavigatorHWConcurrencyTiered`
  (in `RFPTargetsDefault.inc`) reports 4 below 8 cores, else 8; RFP's
  `NavigatorHWConcurrency` reports a fixed value. Sval's
  `NavigatorHWConcurrencyRandomized` takes precedence over the tiers, and
  RFP's fixed value over it: `SvalRFPService::RandomizedHardwareConcurrency`
  draws a count in [max(2, ceil(real / 2)), real] from the randomization key
  canvas and audio noise use, which the session key and the top-level site
  fix, so a site reads one count for the session and private browsing draws
  its own. `RuntimeService::ClampedHardwareConcurrency` answers documents and
  dedicated, shared and service workers alike, each from its own global's
  key, and a worker's key is its owning site's, so CreepJS's worker and
  navigator counts agree.
- **`deviceMemory`, UA Client Hints.** Not implemented in Gecko.
- **`maxTouchPoints`.** Device class. Gecko: `MaxTouchPointsCollapse` maps any
  value above 1 to 5, in baseline.
- **`navigator.languages`.** The ordered language list, highly identifying when
  long. Gecko: no target; RFP's `privacy.spoof_english` rewrites the global
  pref. Sval's `LanguagesPrimaryOnly` exposes the primary language and its base,
  Doc-gated.
- **`Accept-Language`.** The same list, sent passively. Gecko: built by
  `nsHttpHandler::SetAcceptLanguages`, global. Sval's target covers it.
- **JS default locale.** From the OS regional settings
  (`LocaleService::GetWebExposedLocales`), so it can disagree with the
  languages. Gecko: `JSLocale` forces en-US, only with `spoof_english == 2`.
  Sval's language patch makes the realm locale match the primary language.
- **`Intl` surface.** ICU and CLDR version. Gecko: bundled ICU, uniform per
  version.
- **Timezone.** 3–5 bits, geographic. Gecko: `JSDateTimeUTC` sets the realm
  zone to Atlantic/Reykjavik (Doc-gated).
- **`plugins`, `mimeTypes`, `pdfViewerEnabled`.** A fixed PDF list per spec.
  Gecko: `PdfjsSpoof` hides whether the user turned PDF.js off.
- **`webdriver`.** See the findings.
- **`doNotTrack`.** One bit, rare. Gecko: `privacy.donottrackheader.enabled`.
- **`globalPrivacyControl` and `Sec-GPC`.** Gecko:
  `privacy.globalprivacycontrol.enabled` and `.pbmode.enabled`.
- **`cookieEnabled`, `onLine`.** Low entropy. Gecko: `NetworkConnection` pins
  `onLine` to true (RFP).
- **`navigator.connection`.** Gecko: `dom.netinfo.enabled` is false.
- **`storage.estimate()`.** The quota reveals disk size on small disks
  (`QuotaManager::GetGroupLimitForLimit`). Gecko: `DiskStorageLimit`; see the
  findings.
- **Permissions API.** Accepted names reveal the engine; states reveal choices,
  and a global default denial looks unusual. Gecko: no target. Sval's
  `PermissionsDefaultDenyPrompt` reports "prompt" for those.
- **`getAutoplayPolicy()`.** See §2.
- **Keyboard layout.** `navigator.keyboard` is absent; key events still leak
  the layout. Gecko: `KeyboardEvents` spoofs to an en-US consensus
  (`KeyCodeConsensus_En_US.inc`), string-form pre-check.
- **Math precision.** Gecko uses fdlibm for every Math function but
  sin, cos and tan; `JSMathFdlibm` (in `RFPTargetsDefault.inc`) covers those.
- **CPU architecture from JS.** The sign of a Float32 NaN (x86 versus ARM) and
  relaxed SIMD. Gecko: no control.
- **Error messages, stacks, `Function.prototype.toString`.** Engine family.
  Gecko: no control; messages are not localized.
- **JS, CSS and Wasm feature detection.** Exact engine version. Gecko:
  per-feature prefs, kept at ESR's values.
- **Browser-family markers** (`InstallTrigger`, `mozInnerScreenX` and the
  rest). Firefox identity. Gecko: `extensions.InstallTrigger.enabled`.
- **Global API-surface enumeration.** Every `[Pref=]` and `[Func=]` gate is a
  fingerprint delta, so Sval keeps ESR's surface.
- **Release channel.** "Firefox/153" marks the ESR population. Nothing hides
  it truthfully.
- **`window.name`.** Gecko clears it on cross-site top-level navigation
  (`privacy.window.name.update.enabled`).
- **`history.length`.** Low entropy. No control.
- **`document.referrer`.** Gecko's default policy is
  strict-origin-when-cross-origin.
- **Private-browsing detection.** See the findings.
- **Extension UUIDs.** Firefox extension URLs use a random per-install UUID
  (`UUIDMap`), so fixed-id probing fails, but a leaked UUID is a latent
  supercookie. No per-session rotation.
- **Ad-blocker side effects.** Bait elements reveal a blocker and its lists.
  Extension behaviour, outside Gecko.
- **Headless and automation signals.** Headless Firefox reports a fixed screen
  and no voices. Unchanged by design.
- **Sval agent input.** Events are trusted; timing may still tell. Belongs to
  the agent design.
- **Worker and worklet parity.** CreepJS compares worker and window values.
  Gecko: workers carry the document's state and overrides. Service workers
  derive it from their principal **[unverified]**.

## 4. Screen, window, media queries, input, timing and network

### Decisions

| # | Entries | Default | Control |
|---|---|---|---|
| 1 | Screen size, CSS `device-width`/`device-height` | A common resolution at or above the real one (native) | Strict: tighter buckets |
| 2 | Available screen | `ScreenAvailToResolution`, derived from line 1 | None |
| 3 | Colour depth, `color`/`monochrome`, `mozInnerScreenX/Y` | Fixed values. Colour depth is the platform's common one: 30 on macOS, 24 on Windows and Linux (native), decided 2026-10-16. | None |
| 4 | Window outer size and position, mouse `screenX/Y` | Outer = inner + a typical toolbar height (native). Position 0,0 (`WindowScreenXY`, `MouseEventScreenPoint`). | None |
| 5 | Inner window size, letterboxing, window rounding | Real. No letterboxing. | Strict: letterboxing |
| 6 | Device pixel ratio, page zoom | Real | Strict: round to 1 or 2 |
| 7 | `visualViewport`, orientation, multi-screen APIs, scrollbar width, minor media queries | Allow. Orientation derived from the viewport. | None |
| 8 | Colour gamut, HDR queries | sRGB, standard range | Strict |
| 9 | Dark mode, reduced motion, contrast, forced colours | Allow | Global: website appearance. Strict hides reduced motion and contrast, with a warning. |
| 10 | Reduced transparency, inverted colours | No preference | None |
| 11 | Pointer and hover queries; touch radius, rotation, force | Pointer and hover real (`CSSPointerCapabilities` would force mouse UIs on touch laptops). Touch radius, rotation and force zeroed (`+TouchEvents`). | None |
| 12 | Pen pressure and tilt, coalesced events, wheel | Allow | Strict |
| 13 | Keyboard events | Allow (§3 line 13) | Strict |
| 14 | Typing and mouse rhythm | Allow | None |
| 15 | Timers, frame rate, `SharedArrayBuffer`, performance timing, benchmarks | Firefox's | Strict: coarser timers, 60 Hz |
| 16 | WebRTC IP addresses | Firefox's: mDNS host addresses and the default route until the page holds camera or mic access. Plus `media.peerconnection.ice.proxy_only_if_behind_proxy`. The public address STUN reads is the one the site's own connection carries, so gathering relay-only before access hides it from no site. That rule broke a call page that connects before it asks for the camera, as Google Meet does, decided on 2026-10-29. | Global: default, proxy only, off. |
| 17 | Headers, TLS, HTTP/2, QUIC, supercookies, prefetch, referrer | Byte-identical to Firefox ESR. Partition proxied connections. | Strict: prefetch off |
| 18 | DNS-over-HTTPS, ECH | The network's DNS (decision 0105). ECH whenever encrypted DNS is on. No Sval server. | Global: Secure DNS choice, resolver, internal names |

Line 6's strict setting uses Gecko's `WindowDevicePixelRatio`, a fixed density
of 2 scaled by zoom. Line 12's strict setting covers pen pressure and tilt
(`PointerEvents`); Gecko has no target for coalesced events or wheel deltas.

Four classes of signal. Geometry is high entropy and correlated, so spoofing
one value without the others is detectable, and CreepJS flags exactly those
mismatches. CSS media features are readable without JS through `@media` and
`url()` ("Cascading Spy Sheets", NDSS 2025), so protection has to live in the
style engine, which is where Gecko puts it (`nsMediaFeatures.cpp`, all
Doc-gated). Input events reveal hardware, layout and behaviour. Timing enables
microbenchmarks; WebRTC leaks addresses; the network layer leaks TLS and
HTTP/2 fingerprints and can hold supercookies. Gecko partitions all network
state by top-level site, unconditionally.

### Verified findings

- RFP's `ScreenRect` reports the top window's inner size as the screen
  (`nsScreen::GetRect`, `GetTopWindowInnerRectForRFP`), and `WindowOuterSize`
  reports outer equal to inner. Both are well-known RFP tells, which is why
  Sval added `ScreenSizeCommon` and `WindowOuterSizeTypical` instead.
- Network state is partitioned by top-level site without a pref
  (`StoragePrincipalHelper::GetOriginAttributesForNetworkState`): the HTTP
  cache, HSTS, HTTPS-RR, CORS preflight, auth and DNS prefetch. Connections
  through a proxy are partitioned only with
  `privacy.partition.network_state.connection_with_proxy`.
- WebRTC exposes the public address through STUN unless one of the
  `media.peerconnection.ice.proxy_only*`, `relay_only` or `no_host` prefs is
  set. mDNS host obfuscation and default-route-only gathering stop once the
  page captures or holds a camera or mic permission
  (`MediaManager::IsActivelyCapturingOrHasAPermission`).
  Sval keeps Firefox's gathering (line 16).

### Entries: screen and window

- **`screen.width/height`, `left/top`.** Resolution and monitor position, 4–6
  bits. Sval's `ScreenSizeCommon` reports a common resolution at or above the
  real one. Strict's `ScreenSizeTight` (native, Doc-gated) picks from 1366x768,
  1920x1080, 2560x1440 and 3840x2160 instead, in
  `SvalRFPService::GetSpoofedScreenSize`, so the available screen and
  `device-width` follow it. Window sizes are lines 4 and 5.
- **`availWidth/Height`.** Dock and taskbar. Gecko:
  `ScreenAvailToResolution` subtracts a fixed per-OS offset
  (`nsRFPService::GetSpoofedScreenAvailSize`), in baseline.
- **`colorDepth` / `pixelDepth`.** HDR panels report 30. Gecko:
  `ScreenPixelDepth` reports 24 on every platform. Most Macs report 30
  (`ScreenHelperCocoa` caps a screen's deepest window depth at 30), so the
  2026-10-16 audit read Sval's 24 at 10.6 bits against Firefox's 30 at 7.25.
  Sval reports `SvalRFPService::kSpoofedScreenPixelDepth`: 30 on
  macOS, 24 elsewhere.
- **`screen.colorGamut` / `luminance`.** Gecko: behind
  `media.media_capabilities.screen.enabled`, hard-coded sRGB when on.
- **`innerWidth/Height`.** Often unique but short-lived. Gecko: no spoofing;
  letterboxing (`privacy.resistFingerprinting.letterboxing`, front end, global)
  rounds the content area.
- **`outerWidth/Height`.** Toolbar height and window state. See the findings.
- **`screenX/Y`, `mozInnerScreenX/Y`.** Window position and layout. Gecko:
  `WindowScreenXY` and `WindowInnerScreenXY` report 0.
- **`devicePixelRatio` and CSS `resolution`.** OS scale times zoom, 2–4 bits.
  Gecko: `WindowDevicePixelRatio` and `CSSResolution`
  (`nsRFPService::GetDevicePixelRatioAtZoom`).
- **Page zoom.** Per-site zoom persists. Gecko: `browser.zoom.siteSpecific`;
  `SiteSpecificZoom` (RFP). Kept for accessibility.
- **`visualViewport`.** Duplicates the viewport on desktop. No target.
- **Orientation.** A portrait monitor is rare. Gecko: `ScreenOrientation`
  derives it from the spoofed inner size.
- **New-window sizing.** Gecko: `RoundWindowSize`, string form.
- **Multi-screen APIs.** Not implemented in Gecko.
- **Scrollbar width.** See §1.

### Entries: CSS media features

- **`device-width`, `device-height`, `device-aspect-ratio`.** Gecko:
  `CSSDeviceSize`. Must agree with `screen.width`.
- **`color`, `color-index`, `monochrome`.** Gecko: `CSSColorInfo`. `color`
  follows `SvalRFPService::kSpoofedScreenPixelDepth`, 10 bits per component on
  macOS and 8 elsewhere, so it agrees with `colorDepth`.
- **`color-gamut`.** Wide-gamut hardware, 1–2 bits. Gecko: `CSSColorInfo`
  reports sRGB.
- **`dynamic-range`, `video-dynamic-range`.** Gecko: `dynamic-range` is
  always standard; `CSSVideoDynamicRange` covers the other.
- **`prefers-color-scheme`.** One bit. Gecko: `CSSPrefersColorScheme`; the
  user's choice is `layout.css.prefers-color-scheme.content-override`, shown
  as Website appearance.
- **`prefers-reduced-motion`.** Rare, so informative. Gecko:
  `CSSPrefersReducedMotion`, whose smooth-scroll half is string form.
- **`prefers-reduced-transparency`, `inverted-colors`.** Gecko:
  `CSSPrefersReducedTransparency`, `CSSInvertedColors`.
- **`prefers-contrast`.** Gecko: `CSSPrefersContrast`.
- **`forced-colors`.** Gecko: no target; driven by
  `browser.display.document_color_use`.
- **`pointer`, `hover` and the `any-` forms.** Touch laptops and pens. Gecko:
  `CSSPointerCapabilities`.
- **Other features** (`scripting`, `display-mode`, `update` and the rest). Low
  entropy or true state layout needs. No target.
- **System colours.** See §1.

### Entries: input events

- **Pointer events** (pressure, tilt, twist, size, type). Pen and touch
  hardware. Gecko: `PointerEvents` spoofs them for trusted non-mouse events,
  string-form pre-check.
- **Coalesced events.** Mouse report rate and refresh rate. Gecko: no target.
- **Touch radius, rotation, force.** Digitizer traits. Gecko: `TouchEvents`
  zeroes them.
- **`MouseEvent.screenX/Y`.** Window position. Gecko: `MouseEventScreenPoint`.
  Must agree with `WindowScreenXY`.
- **Keyboard events.** Layout and language. Gecko: `KeyboardEvents`;
  `WidgetEvents` suppresses modifier-only keydowns.
- **Typing and mouse rhythm.** Re-identifies a person. Gecko: only the
  timestamp clamp.
- **Wheel deltas.** OS scroll settings. Gecko: no target.
- **Online and offline events.** Gecko: `NetworkConnection`.

### Entries: timing

- **`performance.now()`, `Event.timeStamp`, rAF.** Microbenchmarks, clock skew,
  side channels. Gecko: `privacy.reduceTimerPrecision` gives 1 ms with jitter,
  20 µs when cross-origin isolated; `ReduceTimerPrecision` raises it to
  16.67 ms (RFP), per global through `nsIGlobalObject::GetRTPCallerType`.
- **`Date`.** The same realm clamp. No skew correction.
- **`SharedArrayBuffer` counters.** A clamp-free timer, available only when
  cross-origin isolated. No target.
- **rAF frame rate.** Display refresh rate. Gecko: `FrameRate` forces
  `layout.frame_rate` to 60, string form, browser-wide.
- **Navigation and resource timing.** Network position and cache hits. Gecko:
  timestamps clamped; RFP collapses DNS timing; cross-origin detail needs
  `Timing-Allow-Origin`; the partitioned cache stops cross-site probing.
- **Microbenchmarks.** CPU class. No control beyond the clamp.
- **`requestIdleCallback`, timer clamping.** Weak. No target found
  **[unverified]**.

### Entries: network

- **WebRTC ICE candidates.** LAN addresses and the real public address behind
  a proxy. See the findings. Sval: Firefox's gathering, and a proxy's
  route behind a proxy.
- **`navigator.connection`.** Absent (`dom.netinfo.enabled` false).
- **DNS prefetch and speculative connections.** Page-controlled lookups.
  Gecko: partitioned; `network.dns.disablePrefetch`, `network.prefetch-next`
  and `network.http.speculative-parallel-limit` are global.
- **Supercookies** (HTTP cache, ETag, HSTS, Alt-Svc, TLS sessions). See the
  findings. ETags still work as first-party identifiers within a partition,
  cleared with site data.
- **Header set and order.** Engine and version. Fixed by necko.
- **TLS ClientHello (JA3, JA4).** Any cipher or group change makes a user
  unique, so Sval sends release Firefox's: NSS's defaults without the cipher
  (`security.ssl3.ecdhe_ecdsa_aes_256_sha`) and the FFDHE groups release
  Firefox has turned off.
- **HTTP/2 and QUIC fingerprints.** The same class as JA4. Stock necko and
  neqo.
- **UA Client Hints.** Not implemented in Gecko.
- **DNS resolver, DoH and ECH.** The ISP resolver sees every hostname. Gecko:
  `network.trr.mode` 0 by default; ECH on (`network.dns.echconfig.enabled`).
- **Referrer.** Gecko: `network.http.referer.defaultPolicy` 2.
