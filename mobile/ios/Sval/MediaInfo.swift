// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// A page's media, as the media card shows it: what plays, where it is,
/// and whether it can skip or float. Read from the media the page last
/// played (`Page.reportPlayback` keeps it), in the page's top frame.
struct MediaInfo: Equatable {
    /// The Media Session title, when the page sets one.
    let title: String
    let paused: Bool
    let muted: Bool
    /// The length in seconds, or nil for a live stream.
    let duration: Double?
    let time: Double
    let video: Bool

    init?(_ fields: [String: Any]) {
        guard let paused = fields["paused"] as? Bool else { return nil }
        self.paused = paused
        title = fields["title"] as? String ?? ""
        muted = fields["muted"] as? Bool ?? false
        let length = fields["duration"] as? Double ?? -1
        duration = length >= 0 ? length : nil
        time = fields["time"] as? Double ?? 0
        video = fields["video"] as? Bool ?? false
    }

    var live: Bool { duration == nil }

    /// The media the page last played, or one playing now.
    private static let find = """
        const all = [...document.querySelectorAll("audio, video")];
        const m = (window.__svalMedia && window.__svalMedia.deref && window.__svalMedia.deref())
          || all.find(e => !e.paused && !e.ended) || all.find(e => e.currentTime > 0);
        """

    static let read = """
        (() => {
          \(find)
          if (!m) return null;
          const meta = navigator.mediaSession && navigator.mediaSession.metadata;
          return {
            title: (meta && meta.title) || "",
            paused: m.paused,
            muted: m.muted,
            duration: isFinite(m.duration) ? m.duration : -1,
            time: m.currentTime,
            video: m.tagName === "VIDEO" && m.videoWidth > 0,
          };
        })()
        """

    /// The body of an async function that runs a command on the page's
    /// media and says how it went, for the log: how many media elements
    /// there are, whether it acted on the one last played, and the media's
    /// state after, or the error play() gave. Nothing names the page.
    static func command(_ name: String, value: Double, mute: Bool) -> String {
        let action = switch name {
        case "toggle": """
            if (m.paused) { document.documentElement.removeAttribute("\(hold)"); await m.play(); }
            else { m.pause(); document.documentElement.setAttribute("\(hold)", ""); }
            """
        case "skip": "m.currentTime = Math.max(0, m.currentTime + \(value));"
        case "seek": "m.currentTime = \(value);"
        case "mute": "for (const e of all) e.muted = \(mute);"
        case "pip": """
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            else if (m.requestPictureInPicture) await m.requestPictureInPicture();
            else if (m.webkitSetPresentationMode) m.webkitSetPresentationMode("picture-in-picture");
            """
        default: ""
        }
        return """
            \(find)
            if (!m) return "no media among " + all.length;
            const last = window.__svalMedia && window.__svalMedia.deref && window.__svalMedia.deref();
            const how = all.length + " element(s), " + (m === last ? "the one last played" : "another");
            try { \(action) } catch (e) { return how + ", " + e.name; }
            return how + ", now " + (m.paused ? "paused" : "playing");
            """
    }

    /// The mark a pause from Sval's controls leaves on the page's root,
    /// which keeps its media from playing until the user next clicks or
    /// presses a key in the page (`Page.mediaGuard`).
    static let hold = "data-sval-hold"

    /// Mutes the page's media, marking what it muted.
    static let muteForPrivacy = """
        for (const m of document.querySelectorAll("audio, video")) {
          if (!m.muted) { m.muted = true; m.setAttribute("data-sval-unmute", ""); }
        }
        null
        """

    /// Unmutes what `muteForPrivacy` muted.
    static let unmuteAfterPrivacy = """
        for (const m of document.querySelectorAll("[data-sval-unmute]")) {
          m.removeAttribute("data-sval-unmute");
          m.muted = false;
        }
        null
        """

    /// Holds the page's media as a pause from Sval's controls does.
    static let holdScript = #"document.documentElement.setAttribute("\#(hold)", ""); null"#

    static func clock(_ seconds: Double) -> String {
        let total = Int(seconds.rounded(.down))
        let hours = total / 3600, minutes = total / 60 % 60, secs = total % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%d:%02d", minutes, secs)
    }
}
