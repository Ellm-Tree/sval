/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#ifndef mozilla_SvalScriptPolicy_h
#define mozilla_SvalScriptPolicy_h

#include "nsError.h"

class nsIDomainPolicy;
class nsIURI;

namespace mozilla {

// Whether aURI may run script under aPolicy, where aDefault is
// javascript.enabled. The entry of the most specific name decides, in either
// direction, so a host's allow beats its site's block whatever the default:
// the URI's host in the exact lists, then the host and each name above it in
// the super lists. At one name, the list that flips aDefault is asked first.
nsresult SvalPolicyAllowsScript(nsIDomainPolicy* aPolicy, nsIURI* aURI,
                                bool aDefault, bool* aAllowed);

}  // namespace mozilla

#endif  // mozilla_SvalScriptPolicy_h
