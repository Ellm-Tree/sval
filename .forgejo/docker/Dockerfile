# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Build environment for Sval's CI jobs.
#
# Nothing in here is a compiler for Gecko. A Gecko build bootstraps its own,
# and `--enable-artifact-builds` implies `--disable-compile-environment`, so an
# artifact build compiles only the front end. That is what makes a Windows
# artifact build possible on a Linux runner with no MSVC and no Windows SDK.
#
# The base is a Node image because Forgejo Actions runs JS actions
# (actions/checkout among them) with the `node` found inside the job container.
# Node plays no part in building Sval; mach installs its own into the mozbuild
# state directory.
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

ENV DEBIAN_FRONTEND=noninteractive \
    MOZBUILD_STATE_PATH=/mozbuild \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# bash, findutils, gzip, make, perl, tar and unzip are the list `mach
# bootstrap` installs on Debian (python/mozboot/mozboot/linux_common.py). The
# rest is what mach itself needs: python3 to run it, zstd and xz for the
# archive formats TaskCluster publishes artifacts in, git for the pinned-commit
# checkout, and wine because configure requires it for any Windows target from
# a non-Windows host (toolkit/moz.configure).
#
# gcc and libc6-dev are for Rust: rustc invokes `cc` to link, the build scripts
# of pure-Rust crates included, so the engine cannot compile without them.
#
# wine64 installs its binaries under /usr/lib/wine; the PATH-visible wrapper
# comes from the wine package, so both are needed.
#
# Everything from libgtk-3-0 onwards is so this image can run a browser, for
# the Linux job's test suites. The list is what Mozilla's own Linux ESR build
# asks for in this base image. Debian's firefox-esr dependencies do not fit:
# Debian system-links libraries Mozilla's binary bundles, and
# Debian's libnss3 shadows the one Firefox ships, which surfaces as
# `NSS_3.101 not found` against libxul. With this list and no libnss3,
# `ldd firefox` reports nothing missing.
#
# libgl1, libegl1, libpci3 and the mesa pair are the software rendering path;
# without them gfx reports `libGL.so.1 missing` and `No GPUs detected via PCI`.
# dbus-x11 provides dbus-launch, without which Gecko cannot create its
# accessibility bus proxy and never maps a window.
#
# mesa-vulkan-drivers and libvulkan1 give WebGPU an adapter: Mesa's software
# Vulkan driver, lavapipe, through the Vulkan loader. wgpu accepts a CPU
# adapter when nothing else is present (wgpu-core's Instance::request_adapter).
#
# Xvfb, as in Mozilla's own test image (it sets DISPLAY and ships
# taskcluster/docker/recipes/xvfb.sh): in this image a browser under Xvfb maps
# its windows and spawns content processes, while `--headless` reports
# `RenderCompositorSWGL failed mapping default framebuffer`.
#
# mutter is the window manager, as in Mozilla's own Linux test tasks, which
# run every suite in a GNOME session (NEED_WINDOW_MANAGER in
# taskcluster/gecko_taskgraph/transforms/job/mozharness_test.py, started by
# taskcluster/scripts/tester/test-linux.sh). On a bare X server nothing
# activates a newly mapped window, so a dialog Gecko opens never becomes
# Services.focus.activeWindow, and toolkit's EnableDelayHelper keeps a
# dialog's Accept button disabled until it does.
#
# pulseaudio and xdg-user-dirs make the container resemble a desktop closely
# enough for tests that assume one. A tab only gains `soundplaying` if audio
# starts, so a test of an audible tab needs a sink; Mozilla's harness starts
# pulseaudio the same way (taskcluster/scripts/tester/test-linux.sh). Gecko's
# BackupService resolves the profile's Documents directory on idle, which
# throws `PathUtils does not support empty paths` when XDG user dirs do not
# exist, an uncaught rejection against whichever test is running.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl file findutils git gzip make perl procps \
      python3 python3-dev python3-venv python3-pip \
      tar unzip zip xz-utils zstd bzip2 \
      wine wine64 msitools libc6-i386 lib32gcc-s1 \
      gcc libc6-dev \
      libgtk-3-0 libdbus-glib-1-2 libasound2 libxt6 libx11-xcb1 libxcb-shm0 \
      libgbm1 libgl1 libegl1 libpci3 libglx-mesa0 libgl1-mesa-dri \
      mesa-vulkan-drivers libvulkan1 \
      xvfb xauth x11-utils dbus-x11 mutter fonts-dejavu-core fontconfig \
      pulseaudio pulseaudio-utils xdg-user-dirs \
    && rm -rf /var/lib/apt/lists/*

# libc6-i386 and lib32gcc-s1 are what the wine configure bootstraps for the
# gecko runner's win64 compile needs to run MIDL, as in Mozilla's own build
# image (taskcluster/docker/debian-build/Dockerfile).
#
# A toolchain the jobs depend on that is absent fails the image build rather
# than a job: wine for the Windows target, msiextract for the gecko
# runner's win64 compile (configure bootstraps the Windows SDK by unpacking its
# .msi files, taskcluster/scripts/misc/get_vs.py), and Xvfb, dbus-launch and
# mutter for running a browser on Linux.
RUN wine --version && command -v msiextract && command -v Xvfb \
    && command -v dbus-launch && command -v xdpyinfo && command -v mutter

# The default toolchain is the one the repository's rust-toolchain.toml pins,
# with every component and target the file lists, so a checkout's builds find
# it installed and rustup has nothing to download at job time. The workflows
# pass the repository root as the `repo` build context, and `rustup toolchain
# install` with no toolchain named installs what the file in its directory
# says. The engine also builds for wasm32-unknown-unknown, which only the image
# needs.
COPY --from=repo rust-toolchain.toml /tmp/rust-pin/
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none \
    && cd /tmp/rust-pin && rustup toolchain install \
    && rustup default "$(rustup show active-toolchain | cut -d' ' -f1)" \
    && cd / && rm -rf /tmp/rust-pin \
    && rustup target add wasm32-unknown-unknown

# Must match the engine's wasm-bindgen dependency exactly; a mismatched CLI
# generates glue the module rejects at instantiation.
RUN cargo install wasm-bindgen-cli --version 0.2.130 --locked

# Last, so it covers everything the installs above wrote, the registry
# included: the test user runs cargo too, when mach lint builds mozcheck.
RUN chmod -R a+rwX "$RUSTUP_HOME" "$CARGO_HOME"

# Mount point for the cached mozbuild state directory (mach reads
# MOZBUILD_STATE_PATH). A named Docker volume there keeps what mach downloads
# between runs, without putting build state on the runner VM's filesystem.
RUN mkdir -p /mozbuild
