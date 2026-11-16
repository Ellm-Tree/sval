// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.
//
// Installed by soak.py into the copy of Sval it tests, under defaults/pref/.
// It loads sval-soak.cfg from the install directory with chrome privileges:
// autoconfig sandboxes the file on the release channel unless the default
// branch turns that off (nsReadConfig::readConfigFile).
pref("general.config.filename", "sval-soak.cfg");
pref("general.config.obscure_value", 0);
pref("general.config.sandbox_enabled", false);
