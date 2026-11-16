/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ported from Zen Browser's nsZenBCOverrides.cpp, by the Zen OSS Team.

#include "mozilla/dom/BrowsingContext.h"

#include "mozilla/MediaFeatureChange.h"
#include "mozilla/RefPtr.h"
#include "mozilla/ServoStyleConstsInlines.h"
#include "nsChangeHint.h"
#include "nsIDocShell.h"
#include "nsPresContext.h"

namespace mozilla::dom {

/**
 * Colors take the site style as they are painted (SvalSiteStyleColors), so a
 * change to it recascades every document in the tab, which repaints each
 * frame with the colors it resolves then.
 */
static void RepaintForSiteStyle(BrowsingContext* aTop) {
  aTop->PreOrderWalk([](BrowsingContext* aContext) {
    if (nsIDocShell* shell = aContext->GetDocShell()) {
      if (RefPtr presContext = shell->GetPresContext()) {
        presContext->MediaFeatureValuesChanged(
            {RestyleHint::RecascadeSubtree(), NS_STYLE_HINT_VISUAL,
             MediaFeatureChangeReason::PreferenceChange},
            MediaFeatureChangePropagation::Images);
      }
    }
  });
}

void BrowsingContext::DidSet(FieldIndex<IDX_SvalSiteStyleAccent>,
                             uint32_t aOldValue) {
  if (GetSvalSiteStyleAccent() != aOldValue) {
    RepaintForSiteStyle(this);
  }
}

void BrowsingContext::DidSet(FieldIndex<IDX_SvalSiteStyleRotation>,
                             float aOldValue) {
  if (GetSvalSiteStyleRotation() != aOldValue) {
    RepaintForSiteStyle(this);
  }
}

void BrowsingContext::DidSet(FieldIndex<IDX_SvalSiteStyleContrast>,
                             float aOldValue) {
  if (GetSvalSiteStyleContrast() != aOldValue) {
    RepaintForSiteStyle(this);
  }
}

void BrowsingContext::DidSet(FieldIndex<IDX_SvalSiteStyleBrightness>,
                             float aOldValue) {
  if (GetSvalSiteStyleBrightness() != aOldValue) {
    RepaintForSiteStyle(this);
  }
}

void BrowsingContext::DidSet(FieldIndex<IDX_SvalSiteStyleSaturation>,
                             float aOldValue) {
  if (GetSvalSiteStyleSaturation() != aOldValue) {
    RepaintForSiteStyle(this);
  }
}

void BrowsingContext::DidSet(FieldIndex<IDX_SvalSiteStyleDark>,
                             bool aOldValue) {
  if (GetSvalSiteStyleDark() != aOldValue) {
    RepaintForSiteStyle(this);
  }
}

}  // namespace mozilla::dom
