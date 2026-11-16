/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ported from Zen Browser's nsZenBoostsBackend.h, by the Zen OSS Team.

#ifndef mozilla_SvalSiteStyleColors_h_
#define mozilla_SvalSiteStyleColors_h_

#include "mozilla/Casting.h"
#include "mozilla/HashFunctions.h"
#include "nsColor.h"

class nsIFrame;

namespace mozilla {

namespace dom {
class BrowsingContext;
}

/**
 * The site style a document paints with, as its top BrowsingContext carries
 * it. Every value at zero, and dark off, leaves each color as the page gave
 * it.
 */
struct SvalSiteStyle {
  // The hue dark colors are tinted toward, as an opaque color whose alpha
  // byte holds the strength of the tint. Zero is no tint.
  nscolor mAccent = 0;
  // The turn, in degrees, from the accent's hue to the hue light colors are
  // tinted toward.
  float mRotation = 0.0f;
  // Each in [-1, 1], zero leaving the color as it is.
  float mContrast = 0.0f;
  float mBrightness = 0.0f;
  float mSaturation = 0.0f;
  // Inverts each color's lightness and keeps its hue.
  bool mDark = false;

  bool IsEmpty() const {
    return !mAccent && !mContrast && !mBrightness && !mSaturation && !mDark;
  }
  bool operator==(const SvalSiteStyle& aOther) const {
    return mAccent == aOther.mAccent && mRotation == aOther.mRotation &&
           mContrast == aOther.mContrast && mBrightness == aOther.mBrightness &&
           mSaturation == aOther.mSaturation && mDark == aOther.mDark;
  }
  bool operator!=(const SvalSiteStyle& aOther) const {
    return !(*this == aOther);
  }
  HashNumber Hash() const {
    return HashGeneric(mAccent, mDark, BitwiseCast<uint32_t>(mRotation),
                       BitwiseCast<uint32_t>(mContrast),
                       BitwiseCast<uint32_t>(mBrightness),
                       BitwiseCast<uint32_t>(mSaturation));
  }

  // The style the fields of aContext's top BrowsingContext describe.
  static SvalSiteStyle Of(const dom::BrowsingContext* aContext);
};

class SvalSiteStyleColors final {
 public:
  /**
   * The color a frame paints in place of aColor, under the site style of
   * the frame's document. StyleAbsoluteColor::ToColor calls this for every
   * color resolved for a frame, so a second call on its result would apply
   * the style twice.
   *
   * A null frame, a frame in the parent process, content Sval or the
   * platform draws over a page (scrollbars, DevTools' highlighters) and an
   * SVG mask's content keep aColor.
   */
  static nscolor Resolve(nscolor aColor, const nsIFrame* aFrame);

  // aColor under aStyle, for any caller with a style in hand.
  static nscolor Apply(nscolor aColor, const SvalSiteStyle& aStyle);
};

}  // namespace mozilla

#endif
