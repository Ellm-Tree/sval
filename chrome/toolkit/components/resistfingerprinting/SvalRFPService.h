/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// What Sval's RFPTargets (SvalRFPTargets.inc) report in place of the real
// values. Each spoofing call site asks here, so the sites that must agree,
// such as nsScreen and the device-size media features, share one answer.

#ifndef mozilla_SvalRFPService_h
#define mozilla_SvalRFPService_h

#include <array>
#include <cstdint>

#include "nsRFPService.h"

class nsIGlobalObject;

namespace mozilla {

class SvalRFPService final {
 public:
  // The targets whose noise is drawn from the browsing session key.
  static constexpr RFPTarget kRandomizationTargets[] = {
      RFPTarget::CanvasRandomization, RFPTarget::WebGLRandomization,
      RFPTarget::EfficientCanvasRandomization,
      RFPTarget::AudioOutputRandomization,
      RFPTarget::NavigatorHWConcurrencyRandomized};

  // The smallest common screen resolution, in CSS pixels, that is at least
  // aRealSize in both dimensions (RFPTarget::ScreenSizeCommon), from a
  // shorter list when aTight (RFPTarget::ScreenSizeTight).
  static CSSIntSize GetSpoofedScreenSize(const CSSIntSize& aRealSize,
                                         bool aTight);

  // The screen size reported for aRealSize, or Nothing when
  // aShouldResistFingerprinting holds for neither ScreenSizeTight nor
  // ScreenSizeCommon. Tight wins when both are on.
  template <typename ShouldResistFingerprinting>
  static Maybe<CSSIntSize> SpoofedScreenSize(
      const CSSIntSize& aRealSize,
      ShouldResistFingerprinting&& aShouldResistFingerprinting) {
    bool tight = aShouldResistFingerprinting(RFPTarget::ScreenSizeTight);
    if (!tight && !aShouldResistFingerprinting(RFPTarget::ScreenSizeCommon)) {
      return Nothing();
    }
    return Some(GetSpoofedScreenSize(aRealSize, tight));
  }

  // The screen colour depth, in bits per pixel, under
  // RFPTarget::ScreenPixelDepth and RFPTarget::CSSColorInfo: the value most
  // screens of the platform report. ScreenHelperCocoa reports a Mac screen's
  // deepest window depth, capped at 30, which a 10-bit panel reaches.
  static constexpr int32_t kSpoofedScreenPixelDepth =
#ifdef XP_MACOSX
      30;
#else
      24;
#endif

  // aInnerSize plus the browser chrome of a default window, or aInnerSize
  // alone in fullscreen, where a window has no chrome
  // (RFPTarget::WindowOuterSizeTypical).
  static CSSIntSize GetSpoofedOuterSize(const CSSIntSize& aInnerSize,
                                        bool aIsFullscreen);

  // Keeps the first of aLanguages and adds its base language, so "de-CH, fr,
  // en" becomes "de-CH, de" (RFPTarget::LanguagesPrimaryOnly).
  template <typename T>
  static void SpoofLanguages(nsTArray<T>& aLanguages) {
    if (aLanguages.IsEmpty()) {
      return;
    }
    aLanguages.TruncateLength(1);
    int32_t separator = aLanguages[0].FindChar('-');
    if (separator < 0) {
      separator = aLanguages[0].FindChar('_');
    }
    if (separator > 0) {
      aLanguages.AppendElement(T(Substring(aLanguages[0], 0, separator)));
    }
  }

  // The first of the user's languages, the default locale of a realm under
  // RFPTarget::LanguagesPrimaryOnly. Main thread only.
  static void PrimaryLanguage(nsACString& aLanguage);

  // Whether speechSynthesis.getVoices lists a voice under
  // RFPTarget::SpeechVoicesDefault: the OS's default voice, or a voice for
  // aUILanguage (a language subtag) that the user did not download.
  static bool IsDefaultSpeechVoice(const nsAString& aURI,
                                   const nsAString& aLang, bool aIsDefault,
                                   const nsAString& aUILanguage);

  // RFPTarget::AudioOutputRandomization's key for the audio output aGlobal
  // reads, drawn from its fingerprinting randomization key, or Nothing when
  // the target is off for aGlobal or it has no randomization key.
  using AudioNoiseKey = std::array<uint64_t, 2>;
  static Maybe<AudioNoiseKey> AudioOutputNoiseKey(nsIGlobalObject* aGlobal);
  // Scales each of aLength samples of channel aChannel by its own gain
  // between 0.999 and 0.9999, drawn from aKey, the channel, the sample's
  // index and the samples themselves.
  static void RandomizeAudioOutput(const AudioNoiseKey& aKey, uint32_t aChannel,
                                   float* aData, size_t aLength);

  // RFPTarget::NavigatorHWConcurrencyRandomized's core count for aGlobal: a
  // count in [max(2, ceil(aRealCount / 2)), aRealCount] drawn from its
  // fingerprinting randomization key, or Nothing when the target is off for
  // aGlobal or it has no randomization key.
  static Maybe<uint32_t> RandomizedHardwareConcurrency(nsIGlobalObject* aGlobal,
                                                       uint32_t aRealCount);

  // The first-party domain a first-party load of aFirstPartyURI takes its
  // overrides from: the URI's host, or the nearest name above it short of
  // aDomain, that has a first-party key in aOverrides, so a host's own entry
  // beats its site's. aDomain holds the URI's base domain, and keeps it where
  // no such name has one. aIsBaseline picks the keys' baseline suffix.
  static void NarrowFirstPartyDomain(
      const nsTHashMap<nsCStringHashKey, RFPTargetSet>& aOverrides,
      nsIURI* aFirstPartyURI, bool aIsBaseline, nsACString& aDomain);
};

}  // namespace mozilla

#endif  // mozilla_SvalRFPService_h
