/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#include "SvalRFPService.h"

#include <algorithm>
#include <cstring>

#include "ScopedNSSTypes.h"
#include "mozilla/HashFunctions.h"
#include "mozilla/Span.h"
#include "mozilla/dom/Navigator.h"
#include "nsICookieJarSettings.h"
#include "nsIGlobalObject.h"
#include "nsIURI.h"
#include "nsTHashMap.h"
#include "nsReadableUtils.h"
#include "nsString.h"
#include "nsTArray.h"

namespace mozilla {

/* static */
CSSIntSize SvalRFPService::GetSpoofedScreenSize(const CSSIntSize& aRealSize,
                                                bool aTight) {
  // Landscape desktop resolutions in CSS pixels. The common sizes
  // are StatCounter's desktop screen resolution statistics and Steam's
  // hardware survey (2026); the rest are Apple's default scaled sizes for
  // current Macs and the CSS sizes of 1920x1080 and 2560x1440 screens at
  // Windows' 125% and 150% scaling.
  static constexpr CSSIntSize kCommon[] = {
      {1280, 720},  {1280, 800},  {1366, 768},  {1440, 900},  {1470, 956},
      {1536, 864},  {1600, 900},  {1512, 982},  {1680, 1050}, {1710, 1112},
      {1728, 1117}, {1920, 1080}, {1920, 1200}, {2048, 1152}, {2240, 1260},
      {2560, 1440}, {2560, 1600}, {3440, 1440}, {3840, 2160}};
  // The tight list keeps the most common size of each 16:9 class, so far
  // more screens share each answer.
  static constexpr CSSIntSize kTight[] = {
      {1366, 768}, {1920, 1080}, {2560, 1440}, {3840, 2160}};
  const Span<const CSSIntSize> sizes =
      aTight ? Span<const CSSIntSize>(kTight) : Span<const CSSIntSize>(kCommon);

  bool portrait = aRealSize.height > aRealSize.width;
  CSSIntSize real =
      portrait ? CSSIntSize(aRealSize.height, aRealSize.width) : aRealSize;
  Maybe<CSSIntSize> spoofed;
  for (const CSSIntSize& size : sizes) {
    if (size.width >= real.width && size.height >= real.height &&
        (!spoofed ||
         size.width * size.height < spoofed->width * spoofed->height)) {
      spoofed = Some(size);
    }
  }
  // Beyond the list, the size is rounded up to letterboxing's 200x100 steps
  // (RFPHelper.sys.mjs), or to 1280x720 steps when tight, so it still never
  // falls below the real one.
  if (!spoofed) {
    const CSSIntSize step =
        aTight ? CSSIntSize(1280, 720) : CSSIntSize(200, 100);
    spoofed = Some(CSSIntSize(
        (real.width + step.width - 1) / step.width * step.width,
        (real.height + step.height - 1) / step.height * step.height));
  }
  return portrait ? CSSIntSize(spoofed->height, spoofed->width) : *spoofed;
}

/* static */
CSSIntSize SvalRFPService::GetSpoofedOuterSize(const CSSIntSize& aInnerSize,
                                               bool aIsFullscreen) {
  if (aIsFullscreen) {
    return aInnerSize;
  }
  // A default window's toolbars: the tab strip (--tabstrip-min-height,
  // --tab-min-height plus twice --tab-block-margin, 44px), the navigation bar
  // (--urlbar-min-height plus twice --urlbar-padding-block, 40px) and the
  // toolbox's 1px border, in browser/themes. A window on Windows also counts
  // its invisible resize borders, 8px on the left, right and bottom.
#ifdef XP_WIN
  constexpr int32_t kChromeWidth = 16;
  constexpr int32_t kChromeHeight = 85 + 8;
#else
  constexpr int32_t kChromeWidth = 0;
  constexpr int32_t kChromeHeight = 85;
#endif
  return {aInnerSize.width + kChromeWidth, aInnerSize.height + kChromeHeight};
}

// HMAC-SHA256 of aTarget's name under aGlobal's fingerprinting randomization
// key, or Nothing when aTarget is off for aGlobal or it has no key. The name
// keeps each target's draw independent of the others' and of the canvas noise
// drawn from the same key.
static Maybe<nsTArray<uint8_t>> RandomizationDigest(nsIGlobalObject* aGlobal,
                                                    RFPTarget aTarget,
                                                    const nsACString& aName) {
  if (!aGlobal || !aGlobal->ShouldResistFingerprinting(aTarget)) {
    return Nothing();
  }
  nsICookieJarSettings* cookieJarSettings = aGlobal->GetCookieJarSettings();
  nsTArray<uint8_t> randomKey;
  if (!cookieJarSettings ||
      NS_FAILED(
          cookieJarSettings->GetFingerprintingRandomizationKey(randomKey))) {
    return Nothing();
  }
  HMAC hmac;
  nsTArray<uint8_t> digest;
  if (NS_FAILED(hmac.Begin(SEC_OID_SHA256, Span(randomKey))) ||
      NS_FAILED(
          hmac.Update(reinterpret_cast<const uint8_t*>(aName.BeginReading()),
                      aName.Length())) ||
      NS_FAILED(hmac.End(digest))) {
    return Nothing();
  }
  return Some(std::move(digest));
}

/* static */
Maybe<SvalRFPService::AudioNoiseKey> SvalRFPService::AudioOutputNoiseKey(
    nsIGlobalObject* aGlobal) {
  const auto digest =
      RandomizationDigest(aGlobal, RFPTarget::AudioOutputRandomization,
                          "AudioOutputRandomization"_ns);
  AudioNoiseKey key;
  if (!digest || digest->Length() < sizeof(key)) {
    return Nothing();
  }
  memcpy(key.data(), digest->Elements(), sizeof(key));
  return Some(key);
}

/* static */
Maybe<uint32_t> SvalRFPService::RandomizedHardwareConcurrency(
    nsIGlobalObject* aGlobal, uint32_t aRealCount) {
  const auto digest =
      RandomizationDigest(aGlobal, RFPTarget::NavigatorHWConcurrencyRandomized,
                          "NavigatorHWConcurrencyRandomized"_ns);
  if (!digest || digest->Length() < 4 || aRealCount == 0) {
    return Nothing();
  }
  // A web app sizing a worker pool to the count keeps at least half its
  // parallelism, and no site sees fewer than 2 cores the device has.
  const uint32_t lowest =
      std::min(aRealCount, std::max(2u, (aRealCount + 1) / 2));
  const uint8_t* d = digest->Elements();
  const uint32_t draw = uint32_t(d[0]) << 24 | uint32_t(d[1]) << 16 |
                        uint32_t(d[2]) << 8 | uint32_t(d[3]);
  return Some(lowest + draw % (aRealCount - lowest + 1));
}

/* static */
void SvalRFPService::RandomizeAudioOutput(const AudioNoiseKey& aKey,
                                          uint32_t aChannel, float* aData,
                                          size_t aLength) {
  // Each gain depends on the samples as well as the position, so a reference
  // signal rendered beside a fingerprint draws unrelated gains and cannot
  // divide them out, while the same samples always draw the same gains.
  const HashNumber content =
      AddToHash(HashBytes(aData, aLength * sizeof(float)), aChannel);
  HashCodeScrambler scrambler(aKey[0], aKey[1]);
  const auto unit = [&](HashNumber aInput) {
    return double(scrambler.scramble(aInput)) / double(UINT32_MAX);
  };
  // Each gain is a base the key alone fixes plus a jitter. Whatever a page
  // learns from many renders of the same samples, such as each sample's
  // largest gain, still carries the site's base, so it links no two sites.
  // Gains between 0.999 and 0.9999 move no sample by more than 0.01 dB, far
  // below what anyone hears, yet change every float32 sample's value.
  const double base = 0.999 + 0.0004 * unit(0);
  for (size_t i = 0; i < aLength; ++i) {
    aData[i] *= float(base + 0.0005 * unit(AddToHash(content, i)));
  }
}

/* static */
bool SvalRFPService::IsDefaultSpeechVoice(const nsAString& aURI,
                                          const nsAString& aLang,
                                          bool aIsDefault,
                                          const nsAString& aUILanguage) {
  if (aIsDefault) {
    return true;
  }
  // macOS names the voices a user downloads in Settings by quality, as
  // com.apple.voice.enhanced.* and com.apple.voice.premium.*; the voices it
  // ships are com.apple.voice.compact.*, com.apple.speech.synthesis.voice.*
  // and com.apple.eloquence.* (OSXSpeechSynthesizerService registers each as
  // urn:moz-tts:osx:<identifier>). SAPI and speech-dispatcher voices carry no
  // such mark, so on Windows and Linux only the language limits the list.
  if (FindInReadable(u"com.apple.voice.enhanced."_ns, aURI) ||
      FindInReadable(u"com.apple.voice.premium."_ns, aURI)) {
    return false;
  }
  int32_t separator = aLang.FindCharInSet(u"-_");
  const nsDependentSubstring language =
      separator < 0 ? Substring(aLang, 0) : Substring(aLang, 0, separator);
  return language.Equals(aUILanguage);
}

/* static */
void SvalRFPService::PrimaryLanguage(nsACString& aLanguage) {
  nsTArray<nsString> languages;
  dom::Navigator::GetAcceptLanguages(languages, nullptr);
  if (!languages.IsEmpty()) {
    CopyUTF16toUTF8(languages[0], aLanguage);
  }
}

/* static */
void SvalRFPService::NarrowFirstPartyDomain(
    const nsTHashMap<nsCStringHashKey, RFPTargetSet>& aOverrides,
    nsIURI* aFirstPartyURI, bool aIsBaseline, nsACString& aDomain) {
  nsAutoCString host;
  if (NS_FAILED(aFirstPartyURI->GetAsciiHost(host))) {
    return;
  }
  if (StringEndsWith(host, "."_ns)) {
    host.Truncate(host.Length() - 1);
  }
  // The keys nsRFPService::CreateOverrideDomainKey makes for a first-party
  // entry, {domain} and {domain, *}, joined by FP_OVERRIDES_DOMAIN_KEY_DELIMITER.
  const char* suffix = aIsBaseline ? ",1" : ",0";
  nsAutoCString under(".");
  under.Append(aDomain);
  while (StringEndsWith(host, under)) {
    nsAutoCString key(host);
    key.Append(suffix);
    nsAutoCString wildcard(host);
    wildcard.Append(",*");
    wildcard.Append(suffix);
    if (aOverrides.Contains(key) || aOverrides.Contains(wildcard)) {
      aDomain.Assign(host);
      return;
    }
    host.Cut(0, host.FindChar('.') + 1);
  }
}

}  // namespace mozilla
