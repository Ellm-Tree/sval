# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

# The FasterMake backend gives each install target under dist/bin a manifest
# of its own, and process_install_manifest removes a file that a manifest no
# longer lists by reading the record of the previous install in the
# manifest's .track file. A target that leaves the build, as when a
# directory's moz.build goes, has no manifest, so make never processes its
# .track, and what it installed stays in dist/bin, where the package
# manifest's wildcards (@RESPATH@/moz-src/*) ship it.

import glob
import os

import mozpack.path as mozpath

from mozbuild.action.process_install_manifest import process_manifest


def purge_removed_install_targets(topobjdir, bases):
    """Remove what each install target outside `bases` installed under the
    faster backend, and the .track file that recorded it."""
    live = {"install_%s.track" % base.replace("/", "_") for base in bases}
    tracks = glob.glob(mozpath.join(topobjdir, "faster", "install_*.track"))
    for track in sorted(tracks):
        name = os.path.basename(track)
        if name in live:
            continue
        with open(track, encoding="utf-8") as fh:
            installed = fh.read()
        underscored = name[len("install_") : -len(".track")]
        for base in _bases_named(topobjdir, underscored):
            # process_manifest rewrites the .track file with what it
            # installed, which for an empty manifest is nothing.
            with open(track, "w", encoding="utf-8") as fh:
                fh.write(installed)
            destdir = mozpath.join(topobjdir, base)
            process_manifest(destdir, [], track)
            try:
                os.removedirs(destdir)
            except OSError:
                pass
        os.remove(track)


def _bases_named(topobjdir, underscored):
    # A .track file's name is its target with each "/" turned into "_", which
    # loses which one a target's own "_" was, so the target is every
    # directory in the objdir whose path gives the name.
    def walk(base, rest):
        if not rest:
            yield base
            return
        for n in range(1, len(rest) + 1):
            path = mozpath.join(base, "_".join(rest[:n]))
            if os.path.isdir(mozpath.join(topobjdir, path)):
                yield from walk(path, rest[n:])

    return list(walk("", underscored.split("_")))
