# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Sval branding.
#
# MOZ_APP_DISPLAYNAME is the user-visible name. MOZ_APP_NAME, the executable's
# name, is not set here: --with-app-name in sval/mozconfig sets it.
#
# MOZ_APP_BASENAME is also not set here — it is set via --with-app-basename
# in sval/mozconfig instead, which is what stops Sval from sharing
# Firefox's profile directory (application.ini's "Name" field, absent a
# "Profile" field, controls profile location). See the mozconfig for the
# full explanation.
#
# What genuinely remains a post-v1 concern is MOZ_APP_VENDOR, still
# "Mozilla": it affects the Windows %APPDATA%\Mozilla\ parent directory,
# crash-reporter identity, and update paths. It cannot be changed from here
# or from mozconfig — browser/moz.configure:14 implies it via project_flag,
# so changing it requires a patch.
#
# MOZ_APP_REMOTINGNAME is the Unix remoting name and window class, which the
# Linux .desktop files' StartupWMClass matches.
MOZ_APP_DISPLAYNAME=Sval
MOZ_APP_REMOTINGNAME=sval
MOZ_MACBUNDLE_NAME=Sval
