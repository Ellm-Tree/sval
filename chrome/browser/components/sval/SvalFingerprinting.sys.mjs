/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The fingerprinting settings (protections spec §3.3): every protection Sval
 * turns on by default and every strict item, each as a setting, grouped by
 * kind. The decision behind each one, and its note, is its entry in
 * `docs/fingerprinting-catalogue.md`.
 *
 * **A setting backed by prefs is those prefs**, the ones Gecko reads for that
 * behaviour, read and written as they are.
 *
 * **A setting backed by RFP targets is its own pref**, `CHOICE_BRANCH` and
 * its id: `true` or `false` once the user has chosen, no value while it
 * stands at Sval's default. Settings sync carries each such pref as its own
 * setting. Gecko reads the targets from one string,
 * `privacy.fingerprintingProtection.overrides`, which
 * `nsRFPService::CreateOverridesFromText` applies on top of
 * `RFPTargetsDefault.inc` token by token; each device composes that string
 * from its own build's default string and the choices, so a device on an
 * older build never takes away a target a newer build turns on by default.
 * `start` keeps the string composed, and reads a string set by hand in
 * `about:config` back into choices.
 *
 * **The overrides string stays canonical.** Sval's default string is the
 * baseline: its tokens keep their order, a token a setting adds goes after
 * them in the order the settings are listed, and a token no setting owns is
 * kept at the end. Settings at their defaults therefore write exactly the
 * default string, which is cleared rather than stored.
 *
 * Some targets are global-only and are read once (`FrameRate` when the vsync
 * source is made, `UseStandinsForNativeColors` when the preference sheet is
 * built). Those settings write the pref Gecko observes for the same
 * behaviour instead: `layout.frame_rate` and
 * `ui.use_standins_for_native_colors`.
 */

const OVERRIDES_PREF = "privacy.fingerprintingProtection.overrides";

/** The branch each RFP target setting's choice is a pref under. */
const CHOICE_BRANCH = "browser.sval.fingerprinting.switch.";

/**
 * True once this profile's overrides string has been read into choices, which
 * a profile from a build that kept the choices only in that string needs once.
 */
const CHOICES_READ_PREF = "browser.sval.fingerprinting.choicesRead";

/**
 * Prefs a setting writes that stay on their device: WebRTC's proxy-only stops
 * calls on a device with no proxy, and a frame rate belongs to a display.
 */
const DEVICE_PREFS = [
  "media.peerconnection.ice.proxy_only",
  "layout.frame_rate",
];

/**
 * A setting backed by RFP targets.
 *
 * @param {string} id
 * @param {string} label
 * @param {string} note What it does. What can break.
 * @param {object} tokens
 * @param {string[]} [tokens.on] The tokens it writes when on.
 * @param {string[]} [tokens.off] The tokens it writes when off.
 * @param {object} [extra] `strict`, `warn`.
 * @returns {object}
 */
const targets = (id, label, note, tokens, extra = {}) => ({
  id,
  label,
  note,
  on: tokens.on ?? [],
  off: tokens.off ?? [],
  strict: false,
  ...extra,
});

/**
 * A setting backed by prefs.
 *
 * @param {string} id
 * @param {string} label
 * @param {string} note
 * @param {object} prefMap `{[name]: [onValue, offValue]}`. With no
 *   `offValue`, off is the pref's default.
 * @param {object} [extra] `strict`, `warn`.
 * @returns {object}
 */
const prefs = (id, label, note, prefMap, extra = {}) => ({
  id,
  label,
  note,
  prefs: prefMap,
  strict: false,
  ...extra,
});

const STRICT = { strict: true };

/**
 * The groups, in the order the card shows them. `shown` settings sit in the
 * group itself; `items` are its advanced switches, Sval's defaults first and
 * then the strict items. A group with a `card` is drawn in a card of that
 * name instead, and a shown setting marked `advanced` is in that card's
 * Advanced.
 */
export const GROUPS = Object.freeze([
  {
    id: "graphics",
    name: "Graphics",
    shown: [],
    items: [
      targets(
        "canvas-noise",
        "Canvas noise",
        "Adds faint noise to images sites read back from a canvas. Image editors may show tiny color shifts.",
        // CanvasRandomization is in RFPTargetsDefault.inc, so off says so:
        // WebGL readback noise may have taken EfficientCanvasRandomization
        // away, which would otherwise let 2D noise through.
        {
          on: ["-EfficientCanvasRandomization", "+CanvasRandomization"],
          off: ["-CanvasRandomization"],
        }
      ),
      targets(
        "webgl-bucket",
        "WebGL vendor bucketing",
        "Reports your graphics card as a common family. Some games may pick lower quality.",
        { on: ["+WebGLVendorSanitize"] }
      ),
      targets(
        "webgpu-flag",
        "WebGPU fallback flag hidden",
        "Hides whether WebGPU runs in software. Sites may try graphics your device can't run fast.",
        { on: ["+WebGPUIsFallbackAdapter"] }
      ),
      targets(
        "webgpu-timestamps",
        "WebGPU timestamp queries hidden",
        "Hides precise GPU timing. GPU profiling tools lose exact timings.",
        { on: ["+WebGPUTimestampQueryHidden"] }
      ),
      targets(
        "canvas-3p",
        "Third-party canvas reads blocked",
        "Embedded frames can't read canvas images. Embedded maps, captchas, or editors may fail.",
        { on: ["+CanvasExtractionFromThirdPartiesIsBlocked"] },
        STRICT
      ),
      targets(
        "webgl-fixed",
        "Fixed WebGL strings",
        "Every Sval reports the same graphics strings. 3D sites may pick wrong shaders or refuse to run.",
        { on: ["+WebGLRenderInfo"] },
        STRICT
      ),
      targets(
        "gl-limits",
        "Clamped WebGL and WebGPU limits",
        "Reports common graphics limits. Demanding 3D sites may lower detail or fail.",
        { on: ["+WebGLRenderCapability", "+WebGPULimits"] },
        STRICT
      ),
      targets(
        "gl-noise",
        "WebGL readback noise",
        "Adds noise to pixels read back from WebGL. Screenshots from 3D tools may look grainy.",
        // CanvasUtils::ImageExtractionResult picks EfficientCanvasRandomization
        // before WebGLRandomization, so this owns its removal too, jointly
        // with Canvas noise.
        { on: ["-EfficientCanvasRandomization", "+WebGLRandomization"] },
        STRICT
      ),
    ],
  },
  {
    id: "fonts",
    name: "Fonts and text",
    shown: [],
    items: [
      targets(
        "lang-fonts",
        "Language-pack fonts only",
        "Sites see only fonts that come with your system languages. Fonts you installed don't show.",
        { off: ["-FontVisibilityLangPack"] }
      ),
      targets(
        "math",
        "Standard Math results",
        "Math functions give the same results on every device. Scientific tools may differ in the last digit.",
        { off: ["-JSMathFdlibm"] }
      ),
      targets(
        "emoji",
        "Bundled emoji font",
        "Emoji use Sval's own font, the same on every device. Emoji look different from your system's, and the newest ones may show in your system's style.",
        { on: ["+EmojiFontBundled"] },
        STRICT
      ),
      targets(
        "generics",
        "Restricted font generics",
        "Serif, sans-serif, and monospace map to fixed fonts. Pages may look plainer than intended.",
        { on: ["+FontVisibilityRestrictGenerics"] },
        STRICT
      ),
    ],
  },
  {
    id: "appearance",
    name: "Appearance",
    // The Theme setting, the same pref, has its one home in Firefox's
    // Appearance category.
    shown: [],
    items: [
      prefs(
        "accent",
        "OS accent color hidden",
        "Sites get a standard accent color. Form controls won't match your system color.",
        { "widget.non-native-theme.use-theme-accent": [false, true] }
      ),
      targets(
        "a11y-hidden",
        "Reduced transparency and inverted colors hidden",
        "Sites can't tell these system settings are on, so they won't adapt to them.",
        { on: ["+CSSPrefersReducedTransparency", "+CSSInvertedColors"] }
      ),
      targets(
        "srgb",
        "sRGB and standard range",
        "Reports a standard display. HDR and wide-color images show in standard color.",
        { on: ["+CSSColorInfo", "+CSSVideoDynamicRange"] }
      ),
      prefs(
        "sys-colours",
        "Stand-in system colors",
        "Sites get standard system colors. Some controls may look off-theme.",
        { "ui.use_standins_for_native_colors": [true] },
        STRICT
      ),
      targets(
        "motion",
        "Reduced motion and contrast hidden",
        "Sites can't see that you asked for reduced motion or more contrast. If you rely on these, leave this off, because sites won't honor them.",
        { on: ["+CSSPrefersReducedMotion", "+CSSPrefersContrast"] },
        { strict: true, warn: true }
      ),
    ],
  },
  {
    id: "screen",
    name: "Screen and window",
    shown: [],
    items: [
      targets(
        "size",
        "Screen size bucketed",
        "Reports your screen as a common size at or above the real one. Pop-ups may open slightly out of place.",
        { on: ["+ScreenSizeCommon"] }
      ),
      targets(
        "avail",
        "Available screen",
        "Reports the available screen as the whole screen. Pop-ups may open slightly out of place.",
        { off: ["-ScreenAvailToResolution"] }
      ),
      targets(
        "outer",
        "Outer window size",
        "Reports the window as the page plus a standard toolbar. Pop-ups sized to the window may be slightly off.",
        { on: ["+WindowOuterSizeTypical"] }
      ),
      targets(
        "pos",
        "Window position 0,0",
        "Sites see the window at the top left. Pop-ups placed next to the window may land elsewhere.",
        {
          on: [
            "+WindowScreenXY",
            "+WindowInnerScreenXY",
            "+MouseEventScreenPoint",
          ],
        }
      ),
      targets(
        "depth",
        "Color depth",
        "Reports the color depth most screens on your system report. No known breakage.",
        { on: ["+ScreenPixelDepth"] }
      ),
      targets(
        "size-tight",
        "Tighter screen buckets",
        "Reports your screen as one of a few very common sizes at or above the real one. Pop-ups may open further out of place.",
        { on: ["+ScreenSizeTight"] },
        STRICT
      ),
      prefs(
        "letterbox",
        "Letterboxing",
        "Adds margins so the page is a common size. You'll see bars around pages.",
        { "privacy.resistFingerprinting.letterboxing": [true, false] },
        STRICT
      ),
      targets(
        "dpr",
        "Device pixel ratio fixed",
        "Reports a display scale of 2 at normal zoom. Text and images may look slightly soft.",
        { on: ["+WindowDevicePixelRatio"] },
        STRICT
      ),
    ],
  },
  {
    id: "media",
    name: "Audio, video, and media",
    shown: [],
    items: [
      targets(
        "audio-noise",
        "Audio noise",
        "Adds an inaudible change to the audio sites analyze or render offline. Audio tools may measure levels a hair low.",
        { on: ["+AudioOutputRandomization"] }
      ),
      targets(
        "voices",
        "OS default voices only",
        "Read-aloud uses your system's own voices for your language. Voices you added, or for other languages, aren't offered.",
        { on: ["+SpeechVoicesDefault"] }
      ),
      targets(
        "vstats",
        "Video frame stats",
        "Hides dropped-frame counts. Streaming sites may pick quality less well.",
        {
          on: [
            "+VideoElementMozFrames",
            "+VideoElementMozFrameDelay",
            "+VideoElementPlaybackQuality",
          ],
        }
      ),
      targets(
        "merr",
        "Media error text",
        "Media errors give generic messages. Players may show less helpful errors.",
        { on: ["+MediaError"] }
      ),
      targets(
        "captions",
        "Caption loading",
        "Caption files load like other page content. Some players' captions may not appear.",
        { on: ["+WebVTT"] }
      ),
      targets(
        "devices",
        "Constant device list before permission",
        "Sites see one camera and one microphone until you allow that kind of device. Device pickers show a kind's full list only after you allow it.",
        { on: ["+MediaDevicesBeforePermission"] }
      ),
      targets(
        "hwdec",
        "Normalized hardware decoding and DRM",
        "Reports standard video decoding and hides hardware DRM. Streaming services may pick lower quality or resolution.",
        { on: ["+MediaCapabilities"] },
        STRICT
      ),
    ],
  },
  {
    id: "language",
    name: "Language and region",
    shown: [
      targets(
        "all-languages",
        "Tell sites all your languages",
        "Off: sites see only your first language. On: sites can offer your other languages, and you're easier to tell apart.",
        // The target is in Sval's string and absent from RFPTargetsDefault.inc,
        // so off writes it back.
        { on: ["-LanguagesPrimaryOnly"], off: ["+LanguagesPrimaryOnly"] }
      ),
    ],
    items: [
      targets(
        "tz",
        "Spoofed timezone",
        "Reports your timezone as UTC. Calendars and booking sites may show wrong times.",
        { on: ["+JSDateTimeUTC"] },
        STRICT
      ),
    ],
  },
  {
    id: "hardware",
    name: "Hardware and devices",
    shown: [
      targets(
        "real-cores",
        "Report the real CPU core count",
        "Off: each site sees its own count, between half your cores and all of them. On: heavy web apps may run faster, and you're easier to tell apart.",
        // NavigatorHWConcurrencyRandomized is in Sval's string and absent from
        // RFPTargetsDefault.inc, and takes precedence over the tiers. On
        // leaves it out and takes the tiers away; off writes it back.
        {
          on: ["-NavigatorHWConcurrencyTiered"],
          off: ["+NavigatorHWConcurrencyRandomized"],
        }
      ),
    ],
    items: [
      targets(
        "touch",
        "Touch points collapsed",
        "Reports touch support as yes or no. No known breakage.",
        { off: ["-MaxTouchPointsCollapse"] }
      ),
      targets(
        "radius",
        "Touch radius and force zeroed",
        "Hides finger size and pressure. Drawing apps lose touch pressure.",
        { on: ["+TouchEvents"] }
      ),
      targets(
        "pdf",
        "PDF viewer flag",
        "Sites always see a built-in PDF viewer. No known breakage.",
        { on: ["+PdfjsSpoof"] }
      ),
      targets(
        "gp-id",
        "Generic gamepad ids",
        "Standard gamepads report a generic name. A game may not show your controller's name.",
        { on: ["+GamepadIdGeneric"] }
      ),
      targets(
        "perm-states",
        "Permission states",
        "Permissions you block for every site read as not yet asked. A site may ask for a permission you block everywhere.",
        { on: ["+PermissionsDefaultDenyPrompt"] }
      ),
      targets(
        "gp-block",
        "Gamepads blocked",
        "Sites can't use gamepads. Browser games won't see your controller.",
        { on: ["+Gamepad"] },
        STRICT
      ),
      targets(
        "pen",
        "Pen pressure and tilt normalized",
        "Pens report fixed pressure and tilt. Drawing apps lose pen pressure.",
        { on: ["+PointerEvents"] },
        STRICT
      ),
      targets(
        "kb",
        "Spoofed keyboard layout",
        "Reports a standard keyboard layout. Games and shortcuts may show the wrong keys.",
        { on: ["+KeyboardEvents"] },
        STRICT
      ),
    ],
  },
  {
    id: "timing",
    name: "Timing",
    shown: [],
    items: [
      targets(
        "timers",
        "Coarser timers",
        "Rounds timers more coarsely. Animations, games, and benchmarks may stutter.",
        { on: ["+ReduceTimerPrecision"] },
        STRICT
      ),
      prefs(
        "fps",
        "60 Hz frame cap",
        "Caps animation at 60 frames a second. High-refresh screens look less smooth.",
        { "layout.frame_rate": [60] },
        STRICT
      ),
    ],
  },
  {
    id: "network",
    name: "Network",
    shown: [
      {
        id: "webrtc",
        label: "WebRTC (calls in the browser)",
        choices: [
          {
            value: "on",
            label: "Allow calls",
            note: "Calls and video chat work. Sites don't see your local network address.",
            prefs: {
              "media.peerconnection.enabled": true,
              "media.peerconnection.ice.proxy_only": false,
            },
            fallback: true,
          },
          {
            value: "proxy",
            label: "Only through your proxy",
            note: "Calls connect only through your proxy, and only when the service offers a relay reachable through it. With no proxy, calls won't connect.",
            prefs: {
              "media.peerconnection.enabled": true,
              "media.peerconnection.ice.proxy_only": true,
            },
          },
          {
            value: "off",
            label: "Block",
            note: "Sites can't use WebRTC. Calls and video chat in the browser won't work.",
            // Blocked whatever the proxy pref holds.
            match: { "media.peerconnection.enabled": false },
            prefs: {
              "media.peerconnection.enabled": false,
              "media.peerconnection.ice.proxy_only": false,
            },
          },
        ],
      },
    ],
    items: [
      prefs(
        "rtc-proxy",
        "WebRTC never bypasses a proxy",
        "Calls go through your proxy too. Calls may connect more slowly behind a proxy.",
        { "media.peerconnection.ice.proxy_only_if_behind_proxy": [true, false] }
      ),
      prefs(
        "partition",
        "Proxied connections partitioned",
        "Each site gets its own proxied connections. Pages may load slightly slower.",
        {
          "privacy.partition.network_state.connection_with_proxy": [
            true,
            false,
          ],
        }
      ),
      prefs(
        "prefetch",
        "Prefetch off",
        "Sval doesn't load links before you click them. Pages may open a moment later.",
        {
          "network.prefetch-next": [false],
          "network.dns.disablePrefetch": [true],
          "network.dns.disablePrefetchFromHTTPS": [true],
          "network.http.speculative-parallel-limit": [0],
          "browser.places.speculativeConnect.enabled": [false],
        },
        STRICT
      ),
    ],
  },
  {
    id: "signals",
    name: "Privacy signals",
    // A card of its own in Privacy and protection, because these set what
    // Sval tells sites.
    card: "signals",
    shown: [
      prefs(
        "gpc",
        "Global Privacy Control",
        "Tells sites not to sell or share your data. In some places the law requires them to honor it.",
        { "privacy.globalprivacycontrol.enabled": [true, false] }
      ),
      prefs(
        "dnt",
        "Do Not Track",
        "Asks sites not to track you. Nothing requires them to honor it, and few do.",
        { "privacy.donottrackheader.enabled": [true] },
        { advanced: true }
      ),
    ],
    items: [],
  },
  {
    id: "compat",
    name: "Compatibility",
    shown: [],
    items: [
      prefs(
        "moz-compat",
        "Mozilla's compatibility fixes",
        "Weakens protection on Google's and Bing's sites, following a list Mozilla publishes. This may improve functionality on those sites, but they can also recognize your device more easily.",
        {
          "privacy.fingerprintingProtection.remoteOverrides.enabled": [
            true,
            false,
          ],
        }
      ),
    ],
  },
]);

/** Every advanced switch, in the order the groups list them. */
export const ITEMS = Object.freeze(GROUPS.flatMap(g => g.items));

/** The strict items, which the Strict switch turns on and off together. */
export const STRICT_ITEMS = Object.freeze(ITEMS.filter(i => i.strict));

/** Every setting that is a switch, shown or advanced. */
const SWITCHES = [...GROUPS.flatMap(g => g.shown), ...ITEMS].filter(
  s => !s.choices
);

/** Every setting backed by RFP targets. */
const TARGET_SETTINGS = SWITCHES.filter(s => s.on);

/**
 * @param {object} setting A setting backed by RFP targets.
 * @returns {string} The pref its choice is kept in.
 */
export function choicePref(setting) {
  return CHOICE_BRANCH + setting.id;
}

/** Every target a setting owns, by name. */
const OWNED_TARGETS = new Set(
  TARGET_SETTINGS.flatMap(s => [...s.on, ...s.off]).map(t => t.slice(1))
);

/**
 * The fingerprinting choices a person may make for one site (fingerprinting
 * spec §3, the groups' per-site column, and catalogue §1 for
 * `timestamp-query`). Most lift every target their settings name. Audio
 * hardware has no setting, since its values are real by default (catalogue
 * §2), so its choice names the targets it turns on (`adds`). Each is
 * a first-party entry in the granular overrides that `SvalSiteProtections`
 * writes; each of those targets is Doc-gated, so the entry reaches it from
 * the site's next load.
 */
export const SITE_EXCEPTIONS = Object.freeze(
  [
    {
      id: "canvas",
      label: "Canvas",
      note: "The site reads canvas and WebGL images without noise.",
      settings: ["canvas-noise", "gl-noise"],
    },
    {
      id: "fonts",
      label: "Installed fonts",
      note: "The site sees fonts you installed.",
      settings: ["lang-fonts"],
    },
    {
      id: "voices",
      label: "All speech voices",
      note: "The site can read aloud with every voice on your system.",
      settings: ["voices"],
    },
    {
      id: "languages",
      label: "All your languages",
      note: "The site sees every language you set.",
      settings: ["all-languages"],
    },
    {
      id: "gpu-timing",
      label: "WebGPU timestamp queries",
      note: "The site can time GPU work precisely.",
      settings: ["webgpu-timestamps"],
    },
    {
      id: "audio",
      label: "Standard audio hardware",
      note: "The site sees a standard sample rate, output latency, and channel count.",
      // AudioSampleRate sets AudioContext.sampleRate; AudioContext sets the
      // output latency, maxChannelCount and the destination's own rate.
      adds: ["AudioSampleRate", "AudioContext"],
    },
  ].map(exception =>
    Object.freeze({
      ...exception,
      tokens: Object.freeze(
        exception.adds
          ? exception.adds.map(name => `+${name}`)
          : [
              ...new Set(
                exception.settings
                  .map(id => TARGET_SETTINGS.find(s => s.id === id))
                  .flatMap(s => [...s.on, ...s.off])
                  .map(token => `-${token.slice(1)}`)
              ),
            ]
      ),
    })
  )
);

/**
 * Every pref the settings read and write, the overrides first: the ones
 * Restore resets, and the ones the card redraws on.
 */
export const PREFS = Object.freeze([
  OVERRIDES_PREF,
  ...TARGET_SETTINGS.map(choicePref),
  ...new Set(
    GROUPS.flatMap(g => [...g.shown, ...g.items]).flatMap(s =>
      s.choices
        ? s.choices.flatMap(c => Object.keys(c.prefs))
        : Object.keys(s.prefs ?? {})
    )
  ),
]);

/**
 * The prefs settings sync carries for these settings: each choice and each
 * pref a setting writes, but for the ones that stay on their device. The
 * overrides string is not among them, since each device composes its own.
 */
export const SYNCED_PREFS = Object.freeze(
  PREFS.filter(name => name !== OVERRIDES_PREF && !DEVICE_PREFS.includes(name))
);

/**
 * A synced choice applies only as a boolean (`SvalSettingsRegistry.VALUE_RULES`):
 * the choice prefs have no default to give them a type, so any other value
 * would become a pref of the wrong type.
 */
export const SYNC_RULES = Object.freeze(
  Object.fromEntries(
    TARGET_SETTINGS.map(setting => [
      choicePref(setting),
      Object.freeze({ accepts: value => typeof value === "boolean" }),
    ])
  )
);

const defaults = () => Services.prefs.getDefaultBranch("");

/**
 * What `name` reads with no user value. A pref Gecko reads only with a
 * fallback, such as letterboxing, has no default; its fallback is the value
 * its setting writes when off.
 *
 * @param {string} name
 * @returns {boolean|number|string|undefined}
 */
function defaultOf(name) {
  const branch = defaults();
  switch (
    Services.prefs.prefHasDefaultValue(name) &&
    branch.getPrefType(name)
  ) {
    case Ci.nsIPrefBranch.PREF_BOOL:
      return branch.getBoolPref(name);
    case Ci.nsIPrefBranch.PREF_INT:
      return branch.getIntPref(name);
    case Ci.nsIPrefBranch.PREF_STRING:
      return branch.getStringPref(name);
  }
  for (const s of SWITCHES) {
    if (s.prefs && name in s.prefs) {
      return s.prefs[name][1];
    }
  }
  return undefined;
}

/**
 * @param {string} name
 * @returns {boolean|number|string|undefined}
 */
function read(name) {
  if (!Services.prefs.prefHasUserValue(name)) {
    return defaultOf(name);
  }
  switch (Services.prefs.getPrefType(name)) {
    case Ci.nsIPrefBranch.PREF_BOOL:
      return Services.prefs.getBoolPref(name);
    case Ci.nsIPrefBranch.PREF_INT:
      return Services.prefs.getIntPref(name);
    default:
      return Services.prefs.getStringPref(name);
  }
}

/**
 * Writes `value`, or clears the user value when it is the default.
 *
 * @param {string} name
 * @param {boolean|number|string} value
 */
function write(name, value) {
  if (value === defaultOf(name)) {
    Services.prefs.clearUserPref(name);
  } else if (typeof value === "boolean") {
    Services.prefs.setBoolPref(name, value);
  } else if (typeof value === "number") {
    Services.prefs.setIntPref(name, value);
  } else {
    Services.prefs.setStringPref(name, value);
  }
}

/**
 * @param {string} text An overrides string.
 * @returns {string[]} Its tokens, each a sign and a target name.
 */
function tokensOf(text) {
  return text.split(",").filter(Boolean);
}

/** Sval's overrides string: the baseline every composition starts from. */
export function defaultOverrides() {
  return defaultOf(OVERRIDES_PREF) ?? "";
}

/**
 * What an overrides string does to each target, read as
 * `nsRFPService::CreateOverridesFromText` applies it: in order, so the last
 * token for a target wins, with `AllTargets` setting every target.
 *
 * @param {string} text An overrides string.
 * @returns {Function} Given a target name, its sign: "+", "-", or undefined
 *   where the string leaves Gecko's default set alone.
 */
function signsOf(text) {
  const signs = new Map();
  let all;
  for (const token of tokensOf(text)) {
    const sign = token[0];
    const name = token.slice(1);
    if (sign !== "+" && sign !== "-") {
      continue;
    }
    if (name === "AllTargets") {
      all = sign;
      signs.clear();
    } else {
      signs.set(name, sign);
    }
  }
  return name => signs.get(name) ?? all;
}

/**
 * Whether a target setting is in force under `signs`: every token it writes
 * when on holds, and no token it writes when off does.
 *
 * @param {object} setting
 * @param {Function} signs From `signsOf`.
 * @returns {boolean}
 */
function targetsOn(setting, signs) {
  const holds = token => signs(token.slice(1)) === token[0];
  return setting.on.every(holds) && !setting.off.some(holds);
}

/**
 * Whether a switch is on, read from its prefs.
 *
 * @param {object} setting A switch from `GROUPS`.
 * @returns {boolean}
 */
export function isOn(setting) {
  if (setting.on) {
    return targetsOn(setting, signsOf(read(OVERRIDES_PREF) ?? ""));
  }
  return Object.entries(setting.prefs).every(
    ([name, [onValue]]) => read(name) === onValue
  );
}

/**
 * Whether a switch is in the state Sval ships, read from the default branch.
 *
 * @param {object} setting
 * @returns {boolean}
 */
export function isOnByDefault(setting) {
  if (setting.on) {
    return targetsOn(setting, signsOf(defaultOverrides()));
  }
  return Object.entries(setting.prefs).every(
    ([name, [onValue]]) => defaultOf(name) === onValue
  );
}

/**
 * Whether a switch is one of Sval's defaults, switched off. A strict item
 * switched on is what Strict asks for and does not count.
 *
 * @param {object} setting
 * @returns {boolean}
 */
export function isChanged(setting) {
  return !setting.strict && isOnByDefault(setting) && !isOn(setting);
}

/**
 * @param {object} setting A setting backed by RFP targets.
 * @returns {boolean|undefined} Whether the user turned it on or off, or
 *   undefined while it stands at Sval's default.
 */
function chosen(setting) {
  const name = choicePref(setting);
  return Services.prefs.getPrefType(name) === Ci.nsIPrefBranch.PREF_BOOL &&
    Services.prefs.prefHasUserValue(name)
    ? Services.prefs.getBoolPref(name)
    : undefined;
}

/**
 * The overrides string a device holds: its own default string, with every
 * setting the user chose set as chosen, and the tokens no setting owns kept
 * from the string it holds now.
 *
 * @param {object} [from] What to compose from, for a device other than this
 *   one. Each defaults to this device's own.
 * @param {Function} [from.choice] Given a setting, as `chosen` answers.
 * @param {string} [from.current] The overrides string held now.
 * @param {string} [from.baseline] The build's default overrides string.
 * @returns {string}
 */
export function composeOverrides({
  choice = chosen,
  current = read(OVERRIDES_PREF) ?? "",
  baseline = defaultOverrides(),
} = {}) {
  const held = tokensOf(current);
  const byDefault = signsOf(baseline);
  // A hand-set +AllTargets turns every target on, so a switch that is off
  // has to say -Target for each target it turns on, or it stays on.
  const allOn =
    held.findLast(t => t.slice(1) === "AllTargets") === "+AllTargets";
  const wanted = [];
  const negated = [];
  for (const setting of TARGET_SETTINGS) {
    const on = choice(setting) ?? targetsOn(setting, byDefault);
    wanted.push(...(on ? setting.on : setting.off));
    if (!on && allOn) {
      negated.push(
        ...setting.on.filter(t => t[0] === "+").map(t => `-${t.slice(1)}`)
      );
    }
  }
  // A target another setting turns on stays on.
  wanted.push(...negated.filter(t => !wanted.includes(`+${t.slice(1)}`)));
  const want = new Set(wanted);
  const base = tokensOf(baseline);
  const foreign = held.filter(t => !OWNED_TARGETS.has(t.slice(1)));
  const isAll = t => t.slice(1) === "AllTargets";
  // Gecko wants AllTargets first, or the rest is undefined behaviour.
  const ordered = [
    ...foreign.filter(isAll),
    ...base.filter(t => want.has(t)),
    ...wanted.filter(t => !base.includes(t)),
    ...foreign.filter(t => !isAll(t)),
  ];
  return [...new Set(ordered)].join(",");
}

/** True while this module writes choices or the string itself. */
let writing = false;

/**
 * Runs `fn`, whose pref writes are this module's own, then composes the
 * overrides string once.
 *
 * @param {Function} fn
 */
function thenCompose(fn) {
  const outer = writing;
  writing = true;
  try {
    fn();
    write(OVERRIDES_PREF, composeOverrides());
  } finally {
    writing = outer;
  }
}

/**
 * Records a choice: the pref is cleared when `on` is Sval's default.
 *
 * @param {object} setting A setting backed by RFP targets.
 * @param {boolean} on
 */
function recordChoice(setting, on) {
  if (on === isOnByDefault(setting)) {
    Services.prefs.clearUserPref(choicePref(setting));
  } else {
    Services.prefs.setBoolPref(choicePref(setting), on);
  }
}

/** Reads the overrides string held now into a choice for every setting. */
function readChoices() {
  const signs = signsOf(read(OVERRIDES_PREF) ?? "");
  for (const setting of TARGET_SETTINGS) {
    recordChoice(setting, targetsOn(setting, signs));
  }
}

let composePending = false;

/**
 * Composes once for every choice that changed in one turn, as a sync pass
 * changes several at once, so nsRFPService reads the string once.
 */
const choiceObserver = {
  observe(_subject, _topic, name) {
    if (writing || composePending || !name.startsWith(CHOICE_BRANCH)) {
      return;
    }
    composePending = true;
    Promise.resolve().then(() => {
      composePending = false;
      thenCompose(() => {});
    });
  },
};

const overridesObserver = {
  observe(_subject, _topic, name) {
    if (!writing && name === OVERRIDES_PREF) {
      thenCompose(readChoices);
    }
  },
};

let started = false;

/**
 * Keeps the overrides string composed from this build's defaults and the
 * choices, from now on: a choice arriving from settings sync, or a string
 * set in `about:config`, which is read into choices. Once per profile, the
 * string an earlier build left is read into choices first, so none is lost.
 * Idempotent.
 */
export function start() {
  if (started) {
    return;
  }
  started = true;
  thenCompose(() => {
    if (!Services.prefs.getBoolPref(CHOICES_READ_PREF, false)) {
      readChoices();
      Services.prefs.setBoolPref(CHOICES_READ_PREF, true);
    }
  });
  Services.prefs.addObserver(CHOICE_BRANCH, choiceObserver);
  Services.prefs.addObserver(OVERRIDES_PREF, overridesObserver);
}

/**
 * Sets switches, in one write of the overrides string.
 *
 * @param {Map<object, boolean>} changes Each switch and whether it is on.
 */
export function setSwitches(changes) {
  const targetChanges = [...changes].filter(([setting]) => setting.on);
  if (targetChanges.length) {
    thenCompose(() => {
      for (const [setting, on] of targetChanges) {
        recordChoice(setting, on);
      }
    });
  }
  for (const [setting, on] of changes) {
    if (setting.prefs) {
      for (const [name, [onValue, offValue]] of Object.entries(setting.prefs)) {
        const value = on ? onValue : offValue;
        if (value === undefined) {
          Services.prefs.clearUserPref(name);
        } else {
          write(name, value);
        }
      }
    }
  }
}

/**
 * @param {object} setting A shown setting with `choices`.
 * @returns {string} The value of the choice its prefs read as: the first
 *   whose `match` (or `prefs`) they hold, else the `fallback` one.
 */
export function choiceOf(setting) {
  const choice =
    setting.choices.find(c =>
      Object.entries(c.match ?? c.prefs).every(
        ([name, value]) => read(name) === value
      )
    ) ?? setting.choices.find(c => c.fallback);
  return choice.value;
}

/**
 * @param {object} setting A shown setting with `choices`.
 * @param {string} value
 */
export function choose(setting, value) {
  const choice = setting.choices.find(c => c.value === value);
  for (const [name, prefValue] of Object.entries(choice.prefs)) {
    write(name, prefValue);
  }
}

/**
 * Strict's state.
 *
 * @returns {object} `{on, total, offItems, onItems}`.
 */
export function strictState() {
  const onItems = STRICT_ITEMS.filter(isOn);
  return {
    on: onItems.length,
    total: STRICT_ITEMS.length,
    onItems,
    offItems: STRICT_ITEMS.filter(i => !onItems.includes(i)),
  };
}

/**
 * Turns every strict item on or off.
 *
 * @param {boolean} on
 */
export function setStrict(on) {
  setSwitches(new Map(STRICT_ITEMS.map(i => [i, on])));
}

/** Whether every setting reads as Sval ships it. */
export function atDefaults() {
  return PREFS.every(name => read(name) === defaultOf(name));
}

/**
 * What the settings' prefs hold now, for `restore`.
 *
 * @returns {Map<string, *>} Each pref's user value, or undefined for none.
 */
export function snapshot() {
  return new Map(
    PREFS.map(name => [
      name,
      Services.prefs.prefHasUserValue(name) ? read(name) : undefined,
    ])
  );
}

/**
 * Puts the settings' prefs back as `snapshot` found them.
 *
 * @param {Map<string, *>} saved
 */
export function restore(saved) {
  for (const [name, value] of saved) {
    if (value === undefined) {
      Services.prefs.clearUserPref(name);
    } else {
      write(name, value);
    }
  }
}

/** Every setting back to Sval's default. */
export function restoreDefaults() {
  for (const name of PREFS) {
    Services.prefs.clearUserPref(name);
  }
}
