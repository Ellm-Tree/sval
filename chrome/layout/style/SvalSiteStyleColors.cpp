/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ported from Zen Browser's nsZenBoostsBackend.cpp, by the Zen OSS Team: the
// Oklab duotone tint and the hue-keeping inversion. Contrast, brightness and
// saturation are Sval's.

#include "mozilla/SvalSiteStyleColors.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>

#include "mozilla/PseudoStyleType.h"
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/Element.h"
#include "mozilla/dom/ShadowRoot.h"
#include "nsGkAtoms.h"
#include "nsIContent.h"
#include "nsIFrame.h"
#include "nsPresContext.h"
#include "nsXULAppAPI.h"

namespace mozilla {

namespace {

// The lowest channel an inverted dark color keeps, so white inverts to a
// near black: pure black behind light text reads harsher than the page did.
constexpr uint32_t kInvertChannelFloor = 15;

// The tint's strength at the end of the scale. Past it, every color takes
// one of the two accents and the page loses its own colors.
constexpr float kMaxStrength = 0.9f;

struct Oklab {
  float L, a, b;
};

struct Accent {
  nscolor color;
  Oklab lab;
  float contrastFactor;
};

inline float SrgbToLinear(float c) {
  return c <= 0.04045f ? c * (1.0f / 12.92f)
                       : std::pow((c + 0.055f) * (1.0f / 1.055f), 2.4f);
}

inline float LinearToSrgb(float c) {
  c = std::max(0.0f, c);
  return c <= 0.0031308f ? 12.92f * c
                         : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f;
}

// A cube root close enough for color work, at a fraction of std::cbrt's cost
// on the per-color paint path.
inline float FastCbrt(float x) {
  if (x == 0.0f) {
    return 0.0f;
  }
  float a = std::abs(x);
  uint32_t i;
  std::memcpy(&i, &a, sizeof(i));
  i = i / 3 + 0x2a504a2e;
  float y;
  std::memcpy(&y, &i, sizeof(y));
  y = (2.0f * y + a / (y * y)) * (1.0f / 3.0f);
  y = (2.0f * y + a / (y * y)) * (1.0f / 3.0f);
  return x < 0.0f ? -y : y;
}

// Every channel reaching the math is 8-bit, so its 256 linear values are
// computed once.
inline float SrgbToLinear8(uint8_t aChannel) {
  static const std::array<float, 256> kTable = [] {
    std::array<float, 256> table{};
    for (int i = 0; i < 256; ++i) {
      table[i] = SrgbToLinear(i * (1.0f / 255.0f));
    }
    return table;
  }();
  return kTable[aChannel];
}

inline Oklab ToOklab(nscolor aColor) {
  const float lr = SrgbToLinear8(NS_GET_R(aColor));
  const float lg = SrgbToLinear8(NS_GET_G(aColor));
  const float lb = SrgbToLinear8(NS_GET_B(aColor));
  const float l_ =
      FastCbrt(0.4122214708f * lr + 0.5363325363f * lg + 0.0514459929f * lb);
  const float m_ =
      FastCbrt(0.2119034982f * lr + 0.6806995451f * lg + 0.1073969566f * lb);
  const float s_ =
      FastCbrt(0.0883024619f * lr + 0.2817188376f * lg + 0.6299787005f * lb);
  return {0.2104542553f * l_ + 0.7936177850f * m_ - 0.0040720468f * s_,
          1.9779984951f * l_ - 2.4285922050f * m_ + 0.4505937099f * s_,
          0.0259040371f * l_ + 0.7827717662f * m_ - 0.8086757660f * s_};
}

inline uint8_t ToChannel(float aLinear) {
  return static_cast<uint8_t>(
      std::clamp(LinearToSrgb(aLinear) * 255.0f + 0.5f, 0.0f, 255.0f));
}

inline nscolor FromOklab(const Oklab& aLab, uint8_t aAlpha) {
  const float l_ = aLab.L + 0.3963377774f * aLab.a + 0.2158037573f * aLab.b;
  const float m_ = aLab.L - 0.1055613458f * aLab.a - 0.0638541728f * aLab.b;
  const float s_ = aLab.L - 0.0894841775f * aLab.a - 1.2914855480f * aLab.b;
  const float l = l_ * l_ * l_;
  const float m = m_ * m_ * m_;
  const float s = s_ * s_ * s_;
  return NS_RGBA(
      ToChannel(4.0767416621f * l - 3.3077115913f * m + 0.2309699292f * s),
      ToChannel(-1.2684380046f * l + 2.6097574011f * m - 0.3413193965f * s),
      ToChannel(-0.0041960863f * l - 0.7034186147f * m + 1.7076147010f * s),
      aAlpha);
}

inline Accent MakeAccent(nscolor aAccent) {
  return {aAccent, ToOklab(aAccent), NS_GET_A(aAccent) * (1.0f / 255.0f)};
}

// The complementary accent: the base accent's hue turned in the a/b plane,
// its lightness and strength kept.
inline Accent RotateAccent(const Accent& aBase, float aRotationDeg) {
  constexpr float kDegToRad = 3.14159265358979323846f / 180.0f;
  const float cosR = std::cos(aRotationDeg * kDegToRad);
  const float sinR = std::sin(aRotationDeg * kDegToRad);
  return {aBase.color,
          {aBase.lab.L, aBase.lab.a * cosR - aBase.lab.b * sinR,
           aBase.lab.a * sinR + aBase.lab.b * cosR},
          aBase.contrastFactor};
}

// A few tabs painting with different accents interleave on the main thread,
// so the last accents are kept to spare the cube roots on every color.
struct AccentCacheEntry {
  nscolor accent = 0;
  float rotation = 0.0f;
  bool valid = false;
  Accent base{};
  Accent complementary{};
};

constexpr size_t kAccentCacheSize = 4;
AccentCacheEntry sAccentCache[kAccentCacheSize];
size_t sAccentCacheNext = 0;

const AccentCacheEntry& CachedAccent(nscolor aAccent, float aRotation) {
  for (const auto& entry : sAccentCache) {
    if (entry.valid && entry.accent == aAccent && entry.rotation == aRotation) {
      return entry;
    }
  }
  AccentCacheEntry& slot = sAccentCache[sAccentCacheNext];
  sAccentCacheNext = (sAccentCacheNext + 1) % kAccentCacheSize;
  slot.accent = aAccent;
  slot.rotation = aRotation;
  slot.base = MakeAccent(aAccent);
  slot.complementary = RotateAccent(slot.base, aRotation);
  slot.valid = true;
  return slot;
}

/**
 * Tints a color toward one of two accents by its lightness: dark colors
 * toward the base accent, light ones toward the complementary, crossfading
 * between. The strength, the accent's alpha byte, sets both how far the
 * color moves and how sharp the dark and light split is. The color keeps
 * most of its lightness, so text keeps its contrast with its background.
 */
nscolor Tint(nscolor aColor, const Accent& aAccent,
             const Accent& aComplementary) {
  const float blend = aAccent.contrastFactor;
  const Oklab orig = ToOklab(aColor);

  constexpr float kPivot = 0.5f;
  const float halfWidth = std::clamp(0.5f - blend * 0.45f, 0.05f, 0.5f);
  float t = std::clamp((orig.L - (kPivot - halfWidth)) / (2.0f * halfWidth),
                       0.0f, 1.0f);
  t = t * t * (3.0f - 2.0f * t);

  const Oklab sel{aAccent.lab.L + (aComplementary.lab.L - aAccent.lab.L) * t,
                  aAccent.lab.a + (aComplementary.lab.a - aAccent.lab.a) * t,
                  aAccent.lab.b + (aComplementary.lab.b - aAccent.lab.b) * t};
  const float selContrast =
      aAccent.contrastFactor +
      (aComplementary.contrastFactor - aAccent.contrastFactor) * t;

  const float bA = orig.a + (sel.a - orig.a) * blend;
  const float bB = orig.b + (sel.b - orig.b) * blend;

  // Lightness moves toward the accent's by at most half the strength, so a
  // strong tint never flattens the page to the accent's lightness.
  const float lumDelta = sel.L - orig.L;
  const float fL = orig.L + lumDelta * (blend * selContrast * 0.5f);

  // The hue turns a little with the lightness shift, darker clockwise and
  // lighter the other way, which keeps the two tones apart.
  const float angle =
      (lumDelta > 0.0f ? -1.0f : 1.0f) * blend * selContrast * 0.25f;
  const float cosR = std::cos(angle);
  const float sinR = std::sin(angle);
  return FromOklab({fL, bA * cosR - bB * sinR, bA * sinR + bB * cosR},
                   NS_GET_A(aColor));
}

/**
 * Contrast stretches lightness around its middle, brightness moves it toward
 * white or black in proportion to the room left, and saturation scales
 * chroma. All three work in Oklab, so a hue stays the hue it was.
 */
nscolor Adjust(nscolor aColor, float aContrast, float aBrightness,
               float aSaturation) {
  Oklab lab = ToOklab(aColor);
  lab.L = 0.5f + (lab.L - 0.5f) * (1.0f + 0.5f * aContrast);
  lab.L = std::clamp(lab.L, 0.0f, 1.0f);
  lab.L += 0.4f * aBrightness * (aBrightness > 0.0f ? 1.0f - lab.L : lab.L);
  const float chroma = 1.0f + aSaturation;
  lab.a *= chroma;
  lab.b *= chroma;
  return FromOklab(lab, NS_GET_A(aColor));
}

/**
 * Inverts each channel, then shifts all three by the sum of the inverted
 * extremes, which turns lightness over and keeps the hue. Dark results are
 * lifted off black, and light ones left as they are, since lifting them
 * would wash them out toward grey.
 */
nscolor Invert(nscolor aColor) {
  const int rInv = 255 - NS_GET_R(aColor);
  const int gInv = 255 - NS_GET_G(aColor);
  const int bInv = 255 - NS_GET_B(aColor);
  const int sum = std::max({rInv, gInv, bInv}) + std::min({rInv, gInv, bInv});
  const int r = sum - rInv;
  const int g = sum - gInv;
  const int b = sum - bInv;
  const uint8_t a = NS_GET_A(aColor);

  const int luma = (r * 54 + g * 183 + b * 19) >> 8;
  if (luma > 127) {
    return NS_RGBA(r, g, b, a);
  }
  constexpr uint32_t range = 255 - kInvertChannelFloor;
  const auto lift = [](int c) -> uint8_t {
    return static_cast<uint8_t>(kInvertChannelFloor + (c * range) / 255);
  };
  return NS_RGBA(lift(r), lift(g), lift(b), a);
}

/**
 * Content a page did not author keeps its colors: scrollbars and other
 * native anonymous UI, and what Sval, DevTools and the screenshot overlay
 * draw over the page (`Document::InsertAnonymousContent`), a shadow tree
 * hosted in native anonymous content. Form controls' insides are shadow
 * trees hosted by the page's own elements, and pseudo-elements are native
 * anonymous, yet both are the page's, so both are styled.
 *
 * An SVG mask's content keeps its colors too: a mask hides by its
 * luminance, so dark would turn what it shows into what it hides.
 */
bool IsExempt(const nsIFrame* aFrame) {
  // The viewport has no content, and its frame paints the canvas's default
  // background, which is the page's.
  const nsIContent* content = aFrame->GetContent();
  if (!content) {
    return false;
  }
  if (aFrame->HasAnyStateBits(NS_FRAME_SVG_LAYOUT)) {
    for (const nsIContent* c = content; c; c = c->GetParent()) {
      if (c->IsSVGElement(nsGkAtoms::mask)) {
        return true;
      }
    }
  }
  if (!content->IsInNativeAnonymousSubtree()) {
    return false;
  }
  if (const dom::ShadowRoot* shadow = content->GetContainingShadow()) {
    const dom::Element* host = shadow->GetHost();
    return !host || host->IsInNativeAnonymousSubtree();
  }
  const nsIContent* root = content->GetClosestNativeAnonymousSubtreeRoot();
  return !root || !root->IsElement() ||
         !PseudoStyle::IsPseudoElement(
             root->AsElement()->GetPseudoElementType());
}

/**
 * The style a frame's document paints with. An SVG image is a document of
 * its own with no BrowsingContext, so the page drawing it hands its style
 * to the image's pres context (SVGImageContext).
 */
SvalSiteStyle StyleFor(const nsIFrame* aFrame) {
  nsPresContext* presContext = aFrame->PresContext();
  if (!presContext) {
    return {};
  }
  if (const SvalSiteStyle* handed = presContext->GetSvalSiteStyleOverride()) {
    return *handed;
  }
  const dom::Document* document = presContext->Document();
  return SvalSiteStyle::Of(document ? document->GetBrowsingContext() : nullptr);
}

}  // namespace

/* static */
SvalSiteStyle SvalSiteStyle::Of(const dom::BrowsingContext* aContext) {
  if (!aContext) {
    return {};
  }
  const dom::BrowsingContext* top = aContext->Top();
  return {top->GetSvalSiteStyleAccent(),     top->GetSvalSiteStyleRotation(),
          top->GetSvalSiteStyleContrast(),   top->GetSvalSiteStyleBrightness(),
          top->GetSvalSiteStyleSaturation(), top->GetSvalSiteStyleDark()};
}

/* static */
nscolor SvalSiteStyleColors::Apply(nscolor aColor,
                                   const SvalSiteStyle& aStyle) {
  if (NS_GET_A(aColor) == 0) {
    return aColor;
  }
  if (NS_GET_A(aStyle.mAccent)) {
    // The strength the accent carries runs to kMaxStrength, past which the
    // page would keep none of its own colors.
    const nscolor accent =
        (aStyle.mAccent & 0x00ffffff) |
        (static_cast<uint32_t>(NS_GET_A(aStyle.mAccent) * kMaxStrength + 0.5f)
         << 24);
    const AccentCacheEntry& cached = CachedAccent(accent, aStyle.mRotation);
    aColor = Tint(aColor, cached.base, cached.complementary);
  }
  if (aStyle.mDark) {
    aColor = Invert(aColor);
  }
  if (aStyle.mContrast || aStyle.mBrightness || aStyle.mSaturation) {
    aColor = Adjust(aColor, aStyle.mContrast, aStyle.mBrightness,
                    aStyle.mSaturation);
  }
  return aColor;
}

/* static */
nscolor SvalSiteStyleColors::Resolve(nscolor aColor, const nsIFrame* aFrame) {
  // The frame is checked first: a color resolved with none can come from a
  // thread other than the main one, which the accent cache serves alone.
  if (!aFrame || NS_GET_A(aColor) == 0 || !XRE_IsContentProcess() ||
      IsExempt(aFrame)) {
    return aColor;
  }
  const SvalSiteStyle style = StyleFor(aFrame);
  return style.IsEmpty() ? aColor : Apply(aColor, style);
}

}  // namespace mozilla
