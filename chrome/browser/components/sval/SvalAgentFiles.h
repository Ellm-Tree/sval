/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Every file picker, download and clipboard write a web page asks for is put
// to Sval first, through nsISvalAgentFiles, because only Sval knows which tabs
// an agent controls. A picker, download or clipboard write Sval cannot be
// asked about is refused in a tab Sval marks as an agent's
// (BrowsingContext::GetSvalAgentTab), and made anywhere else. A download Sval
// answers with no component of its own goes to Firefox's.

#ifndef mozilla_SvalAgentFiles_h
#define mozilla_SvalAgentFiles_h

#include "mozilla/dom/BrowsingContext.h"
#include "nsCOMPtr.h"
#include "nsComponentManagerUtils.h"
#include "nsISvalAgentFiles.h"
#include "nsIHelperAppLauncherDialog.h"
#include "nsITransfer.h"
#include "nsServiceManagerUtils.h"
#include "nsXULAppAPI.h"

namespace mozilla::dom {
class BrowserParent;
}  // namespace mozilla::dom

namespace mozilla::sval {

inline bool AsksSval(dom::BrowsingContext* aContext) {
  return XRE_IsParentProcess() && aContext && aContext->IsContent();
}

inline nsCOMPtr<nsISvalAgentFiles> AgentFilesFor(
    dom::BrowsingContext* aContext) {
  if (!AsksSval(aContext)) {
    return nullptr;
  }
  return do_GetService("@sval/agent-files;1");
}

inline bool RefusesFilePicker(dom::BrowsingContext* aContext) {
  if (!AsksSval(aContext)) {
    return false;
  }
  nsCOMPtr<nsISvalAgentFiles> files = AgentFilesFor(aContext);
  bool refuses = false;
  if (!files || NS_FAILED(files->RefusesFilePicker(aContext, &refuses))) {
    return aContext->Top()->GetSvalAgentTab();
  }
  return refuses;
}

inline bool RefusesClipboardWrite(dom::BrowsingContext* aContext) {
  if (!AsksSval(aContext)) {
    return false;
  }
  nsCOMPtr<nsISvalAgentFiles> files = AgentFilesFor(aContext);
  bool refuses = false;
  if (!files || NS_FAILED(files->RefusesClipboardWrite(aContext, &refuses))) {
    return aContext->Top()->GetSvalAgentTab();
  }
  return refuses;
}

// A content process names no live window for a clipboard write when the
// window is gone or the process does not say, which a compromised process can
// choose to do. Such a write is refused when the process hosts any tab or
// frame whose own writes are refused. Process is dom::ContentParent; a
// template, so this header needs neither it nor dom::BrowserParent complete
// until a caller uses it.
template <typename Process, typename Browser = dom::BrowserParent>
inline bool RefusesClipboardWriteWithoutWindow(Process* aProcess) {
  for (const auto& browser : aProcess->ManagedPBrowserParent()) {
    if (RefusesClipboardWrite(
            static_cast<Browser*>(browser)->GetBrowsingContext())) {
      return true;
    }
  }
  return false;
}

// A download's dialog or transfer comes back null with a failure in *aRv when
// it is refused, which nsExternalAppHandler takes as a cancelled download.
inline nsCOMPtr<nsIHelperAppLauncherDialog> DownloadDialog(
    dom::BrowsingContext* aContext, nsresult* aRv) {
  nsCOMPtr<nsIHelperAppLauncherDialog> dialog;
  if (AsksSval(aContext)) {
    nsCOMPtr<nsISvalAgentFiles> files = AgentFilesFor(aContext);
    nsresult rv = files
                      ? files->DownloadDialog(aContext, getter_AddRefs(dialog))
                      : NS_ERROR_NOT_AVAILABLE;
    if (NS_FAILED(rv) && aContext->Top()->GetSvalAgentTab()) {
      *aRv = rv;
      return nullptr;
    }
  }
  if (dialog) {
    *aRv = NS_OK;
    return dialog;
  }
  dialog = do_CreateInstance(NS_HELPERAPPLAUNCHERDLG_CONTRACTID, aRv);
  return dialog;
}

inline nsCOMPtr<nsITransfer> DownloadTransfer(dom::BrowsingContext* aContext,
                                              nsresult* aRv) {
  nsCOMPtr<nsITransfer> transfer;
  if (AsksSval(aContext)) {
    nsCOMPtr<nsISvalAgentFiles> files = AgentFilesFor(aContext);
    nsresult rv =
        files ? files->DownloadTransfer(aContext, getter_AddRefs(transfer))
              : NS_ERROR_NOT_AVAILABLE;
    if (NS_FAILED(rv) && aContext->Top()->GetSvalAgentTab()) {
      *aRv = rv;
      return nullptr;
    }
  }
  if (transfer) {
    *aRv = NS_OK;
    return transfer;
  }
  transfer = do_CreateInstance(NS_TRANSFER_CONTRACTID, aRv);
  return transfer;
}

}  // namespace mozilla::sval

#endif  // mozilla_SvalAgentFiles_h
