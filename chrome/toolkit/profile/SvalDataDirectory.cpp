/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/*
 * Sval keeps its data in one directory: `Data` in the application's data
 * directory, with its caches at the same place in the local data directory.
 * The profile service knows that directory as its one profile, `default`,
 * which is the default profile of every install, so every build and every
 * install location opens the same data.
 *
 * The service never reads profiles.ini or installs.ini and never writes
 * them, so nothing on disk can add a profile, ask for the profile manager
 * or the profile selector, or tie the data to the path an install runs
 * from. `--profile <path>` still starts Sval on another directory, as the
 * command line's override: that directory is no profile the service knows.
 */

#include "nsToolkitProfileService.h"

nsresult nsToolkitProfileService::InitSvalDataDirectory() {
  nsCOMPtr<nsIFile> rootDir;
  nsresult rv = mAppData->Clone(getter_AddRefs(rootDir));
  NS_ENSURE_SUCCESS(rv, rv);

  rv = rootDir->AppendNative("Data"_ns);
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIFile> localDir;
  rv = GetLocalDirFromRootDir(rootDir, getter_AddRefs(localDir));
  NS_ENSURE_SUCCESS(rv, rv);

  RefPtr<nsToolkitProfile> profile = new nsToolkitProfile(
      "default"_ns, rootDir, localDir, true, VoidCString(), false);

  mNormalDefault = profile;
  mDedicatedProfile = profile;
  mStartWithLast = true;
  mIsFirstRun = false;

  return NS_OK;
}
