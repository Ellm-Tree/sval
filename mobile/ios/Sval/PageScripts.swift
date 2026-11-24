// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import Observation
import SwiftUI
import UIKit
import WebKit

extension Page {
    static let reportTouch = """
        addEventListener("pointerdown", function report(event) {
          if (!event.isTrusted) return;
          removeEventListener("pointerdown", report, true);
          webkit.messageHandlers.svalTouched.postMessage(1);
        }, true);
        """

    /// A video already in Picture-in-Picture isn't full screen, so a page's
    /// call to leave full screen leaves it be. WebKit takes the call as
    /// leaving Picture-in-Picture as well, and YouTube's player makes it as
    /// soon as its video moves from full screen into Picture-in-Picture, so
    /// the video snapped straight back into the page. A page ends
    /// Picture-in-Picture with the calls made for it, which are untouched.
    static let keepPictureInPicture = """
        (() => {
          const exit = HTMLVideoElement.prototype.webkitExitFullscreen;
          if (typeof exit !== "function") return;
          HTMLVideoElement.prototype.webkitExitFullscreen = function () {
            if (this.webkitPresentationMode === "picture-in-picture") return;
            return exit.apply(this, arguments);
          };
        })();
        """

    /// A touch or key press of the user's own in any frame, which ends a
    /// hold (`Suspension.hold`). A touch lifts it as it lands, so the
    /// tap's click finds the media free to play.
    static let reportPressed = """
        for (const type of ["pointerdown", "keydown"]) {
          addEventListener(type, event => {
            if (event.isTrusted) webkit.messageHandlers.svalPressed.postMessage(1);
          }, true);
        }
        """

    /// Each frame says, on every change, whether any of its media plays,
    /// whether all of that is muted, and whether a tap started it
    /// (`userActivation`), which tells the user's play from a player
    /// starting itself. WebKit's own `requestMediaPlaybackState` can't say
    /// this: it answers "paused" while any of a page's media is paused
    /// (`MediaSessionManagerInterface::mediaPlaybackIsPaused`), which a page
    /// with a second, paused player, as YouTube's has, always is.
    static let reportPlayback = """
        (() => {
          const frame = Math.random().toString(36).slice(2);
          // Media the frame has seen, held weakly; `seen` keeps each in
          // `known` once, as every event of the media passes here.
          const known = new Set();
          const seen = new WeakSet();
          // Whether each media element is drawn on the screen, as an
          // IntersectionObserver with the top-level viewport as its root
          // sees it: a frame under a `display: none` parent, or media off
          // the screen or a couple of pixels in size, is not. Media not yet
          // measured counts as shown.
          const shown = new WeakMap();
          const watch = new IntersectionObserver(entries => {
            for (const entry of entries) {
              const box = entry.boundingClientRect;
              shown.set(entry.target, entry.isIntersecting && box.width * box.height > 4);
            }
            report(false, false);
          });
          const keep = m => {
            if (seen.has(m)) return;
            seen.add(m);
            known.add(new WeakRef(m));
            watch.observe(m);
          };
          let last = null;
          const report = (gesture, force) => {
            for (const ref of known) if (!ref.deref()) known.delete(ref);
            const all = [...document.querySelectorAll("audio, video"), ...[...known].map(r => r.deref())];
            const live = all.filter(m => m && !m.paused && !m.ended);
            live.forEach(keep);
            const playing = live.length > 0;
            const silent = m => m.muted || m.volume === 0;
            const muted = playing && live.every(silent);
            // Media nobody can see or hear: every playing element is
            // silent and not drawn on the screen.
            const unseen = muted && live.every(m => shown.get(m) === false);
            const pip = !!document.pictureInPictureElement
              || all.some(m => m && m.webkitPresentationMode === "picture-in-picture");
            const state = playing + "/" + muted + "/" + unseen + "/" + pip;
            if (state === last && !force) return;
            last = state;
            webkit.messageHandlers.svalPlayback.postMessage({ frame, playing, muted, unseen, gesture, pip });
          };
          for (const type of ["playing", "pause", "ended", "emptied", "volumechange",
                              "enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged"]) {
            document.addEventListener(type, event => {
              const m = event.target;
              if (!(m instanceof HTMLMediaElement)) return;
              keep(m);
              if (type === "playing") window.__svalMedia = new WeakRef(m);
              const gesture = type === "playing" && !!(navigator.userActivation && navigator.userActivation.isActive);
              report(gesture, gesture);
            }, true);
          }
          addEventListener("pagehide", () => {
            if (last && last.startsWith("true")) {
              last = "false/false/false/false";
              webkit.messageHandlers.svalPlayback.postMessage({ frame, playing: false, muted: false, unseen: false, gesture: false, pip: false });
            }
          });
        })();
        """

    static let reportTyping = """
        addEventListener("input", function report(event) {
          if (!event.isTrusted) return;
          removeEventListener("input", report, true);
          webkit.messageHandlers.svalTyped.postMessage(1);
        }, true);
        """

    #if DEBUG
    static let reportModeCalls = """
        (() => {
          const send = fields => window.webkit?.messageHandlers?.svalMedia?.postMessage({ world: "page", ...fields });
          const wrap = (target, name) => {
            const original = target?.[name];
            if (typeof original !== "function") return;
            target[name] = function (...args) {
              send({ event: "call:" + name, mode: String(args[0] ?? "") });
              return original.apply(this, args);
            };
          };
          wrap(HTMLVideoElement.prototype, "webkitSetPresentationMode");
          wrap(HTMLVideoElement.prototype, "requestPictureInPicture");
          wrap(HTMLVideoElement.prototype, "webkitExitFullscreen");
          wrap(HTMLVideoElement.prototype, "webkitEnterFullscreen");
          wrap(Document.prototype, "exitPictureInPicture");
          wrap(Document.prototype, "exitFullscreen");
          wrap(Document.prototype, "webkitExitFullscreen");
        })();
        """
    /// Each media element's events, and the frame's script errors and blocked
    /// loads, without an address: one is replaced with `<address>`.
    static let reportMedia = """
        (() => {
          const frame = window === window.top ? "main" : "frame";
          const send = fields => webkit.messageHandlers.svalMedia.postMessage({ frame, ...fields });
          const scrub = text => String(text ?? "").replace(/[a-z]+:\\/\\/\\S+/gi, "<address>").slice(0, 160);
          if (frame === "main") send({ event: "user-agent", detail: navigator.userAgent });
          for (const type of ["play", "playing", "pause", "waiting", "stalled", "error", "abort", "emptied"]) {
            document.addEventListener(type, event => {
              const media = event.target;
              if (!(media instanceof HTMLMediaElement)) return;
              send({ event: type, kind: media.tagName.toLowerCase(), code: media.error?.code ?? 0,
                     network: media.networkState, ready: media.readyState,
                     visibility: document.visibilityState });
              if (type === "playing") {
                // The video and the elements around it, with their sizes, to
                // see what keeps a playing video out of sight.
                const chain = [];
                for (let node = media; node instanceof Element && chain.length < 8; node = node.parentElement) {
                  const style = getComputedStyle(node);
                  const box = node.getBoundingClientRect();
                  chain.push(node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") +
                    [...node.classList].slice(0, 3).map(name => "." + name).join("") +
                    "[" + Math.round(box.width) + "x" + Math.round(box.height) + " " + style.display +
                    (style.visibility === "visible" ? "" : " " + style.visibility) + "]");
                }
                send({ event: "media-layout", chain: chain.join(" < ") });
              }
            }, true);
          }
          for (const type of ["enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged",
                              "webkitbeginfullscreen", "webkitendfullscreen", "fullscreenchange", "webkitfullscreenchange"]) {
            document.addEventListener(type, event => {
              const target = event.target;
              send({ event: type, kind: target?.tagName?.toLowerCase() ?? "?",
                     mode: target?.webkitPresentationMode ?? "", visibility: document.visibilityState });
            }, true);
          }
          addEventListener("error", event => {
            if (event.target instanceof HTMLMediaElement || event.target instanceof HTMLSourceElement) return;
            send({ event: "script-error", detail: scrub(event.message || event.target?.tagName) });
          }, true);
          addEventListener("unhandledrejection", event => {
            send({ event: "unhandled-rejection", detail: scrub(event.reason?.name + ": " + event.reason?.message) });
          });
          addEventListener("securitypolicyviolation", event => {
            send({ event: "csp-violation", detail: event.effectiveDirective });
          });
        })();
        """
    #endif
}
