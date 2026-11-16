/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#include "SvalScriptPolicy.h"

#include "nsCOMPtr.h"
#include "nsIDomainPolicy.h"
#include "nsIURI.h"
#include "nsIURIMutator.h"
#include "nsString.h"

namespace mozilla {

// The entry in aFlip or aKeep for aName, flipping or keeping aDefault.
static nsresult Decide(nsIDomainSet* aFlip, nsIDomainSet* aKeep, nsIURI* aName,
                       bool aDefault, bool* aDecided, bool* aAllowed) {
  bool contains = false;
  nsresult rv = aFlip->Contains(aName, &contains);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!contains) {
    rv = aKeep->Contains(aName, &contains);
    NS_ENSURE_SUCCESS(rv, rv);
    if (contains) {
      *aDecided = true;
      *aAllowed = aDefault;
    }
    return NS_OK;
  }
  *aDecided = true;
  *aAllowed = !aDefault;
  return NS_OK;
}

nsresult SvalPolicyAllowsScript(nsIDomainPolicy* aPolicy, nsIURI* aURI,
                                bool aDefault, bool* aAllowed) {
  *aAllowed = aDefault;
  nsCOMPtr<nsIDomainSet> block, superBlock, allow, superAllow;
  aPolicy->GetBlocklist(getter_AddRefs(block));
  aPolicy->GetSuperBlocklist(getter_AddRefs(superBlock));
  aPolicy->GetAllowlist(getter_AddRefs(allow));
  aPolicy->GetSuperAllowlist(getter_AddRefs(superAllow));
  nsIDomainSet* flip = aDefault ? block : allow;
  nsIDomainSet* keep = aDefault ? allow : block;
  nsIDomainSet* superFlip = aDefault ? superBlock : superAllow;
  nsIDomainSet* superKeep = aDefault ? superAllow : superBlock;

  bool decided = false;
  nsresult rv = Decide(flip, keep, aURI, aDefault, &decided, aAllowed);
  if (NS_FAILED(rv) || decided) {
    return rv;
  }
  // A URI with no host, such as a null principal's, names no domain.
  nsAutoCString host;
  if (NS_FAILED(aURI->GetAsciiHost(host)) || host.IsEmpty()) {
    return NS_OK;
  }
  if (host.Last() == '.') {
    host.Truncate(host.Length() - 1);
  }
  nsCOMPtr<nsIURI> name = aURI;
  while (true) {
    rv = Decide(superFlip, superKeep, name, aDefault, &decided, aAllowed);
    if (NS_FAILED(rv) || decided) {
      return rv;
    }
    int32_t dot = host.FindChar('.');
    if (dot == kNotFound || dot + 1 >= int32_t(host.Length())) {
      return NS_OK;
    }
    host.Cut(0, dot + 1);
    rv = NS_MutateURI(aURI).SetHost(host).Finalize(name);
    NS_ENSURE_SUCCESS(rv, rv);
  }
}

}  // namespace mozilla
