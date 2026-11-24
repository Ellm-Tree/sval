// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import os
import WebKit

/// A site's choices, read and written as the desktop's site controls keep
/// them, so a choice made on either reaches the other.
struct SiteRules {
    let settings: [String: Any]
    /// The private session's video and audio choices, for a private tab's
    /// rules, and nil for the user's. They are kept in memory and never
    /// synced, and a private tab goes by them and the default alone, as the
    /// desktop's private window does (`SvalSiteProtections`).
    var session: [String: Media]? = nil
    /// The private session's protections choices, "on" or "off" by name,
    /// for a private tab's rules, and nil for the user's. Kept and gone as
    /// `session` is.
    var sessionProtections: [String: String]? = nil

    /// The names a host's rules are filed under, most specific first, down
    /// to its site (`siteNames`).
    static func names(of host: String) -> [String] {
        if let names = known.withLock({ $0[host] }) { return names }
        let names = siteNames(host: host)
        known.withLock { known in
            if known.count >= 256 { known.removeAll() }
            known[host] = names
        }
        return names
    }

    /// The names of hosts already asked, since the bar asks for the page
    /// in front's on every frame it folds, and each answer is a call into
    /// the engine. A host's names depend on the host alone.
    private static let known = OSAllocatedUnfairLock<[String: [String]]>(initialState: [:])

    /// The name a choice made on a page of `host` is saved under, as the
    /// desktop's `scopeOfHost` names it: the host when it differs from its
    /// site and isn't `www.` of it, otherwise the site.
    static func scope(of host: String) -> String? {
        let names = names(of: host)
        guard let host = names.first, let site = names.last else { return nil }
        return host == site || host == "www." + site ? site : host
    }

    static func site(of host: String) -> String? {
        names(of: host).last
    }

    // MARK: JavaScript (`SvalJavascript.sys.mjs`)

    func javaScriptEnabled(on host: String) -> Bool {
        JavaScriptRules.allowed(host: host, settings: settings)
    }

    /// What `name` gets without a rule of its own: the rule of the nearest
    /// name above it, or the default (`inheritedFor`).
    func javaScriptInherited(for name: String) -> Bool {
        let above = Self.names(of: name).dropFirst().first
        return JavaScriptRules.allowed(host: above, settings: settings)
    }

    /// The setting to write so `name` gets `enabled`: a choice that matches
    /// what the name inherits takes its rule away (`setEnabled`).
    func javaScriptChange(for name: String, enabled: Bool) -> (key: String, value: Any?) {
        let key = JavaScriptRules.siteBranch + name
        return enabled == javaScriptInherited(for: name) ? (key, nil) : (key, enabled ? "allow" : "block")
    }

    // MARK: Keep links in this tab (`SvalKeepLinks.sys.mjs`)

    static let keepLinksBranch = "browser.sval.keepLinks.site."

    /// Whether the rule is on for a page of `host`: the rule of the most
    /// specific name holding one, or off where none does (`onFor`).
    func keepLinks(on host: String?) -> Bool {
        guard let host else { return false }
        for name in Self.names(of: host) {
            if let rule = settings[Self.keepLinksBranch + name] as? String, rule == "on" || rule == "off" {
                return rule == "on"
            }
        }
        return false
    }

    /// The setting to write so `name` gets `on`: a choice that matches what
    /// the name inherits takes its rule away (`setOn`).
    func keepLinksChange(for name: String, on: Bool) -> (key: String, value: Any?) {
        let key = Self.keepLinksBranch + name
        let inherited = keepLinks(on: Self.names(of: name).dropFirst().first)
        return on == inherited ? (key, nil) : (key, on ? "on" : "off")
    }

    // MARK: Protections (`SvalSiteProtections.sys.mjs`)

    static let protectionBranch = "browser.sval.protection.site."

    /// A name's saved choices, `{protections, media, exceptions}`.
    func protectionRule(for name: String) -> [String: Any] {
        guard let text = settings[Self.protectionBranch + name] as? String,
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        else { return [:] }
        return object
    }

    /// Whether protections are on for a page of `host`.
    func protectionsOn(for host: String) -> Bool {
        protections(for: host) != "off"
    }

    /// The protections a page of `host` gets: the field of the most specific
    /// name holding one, or "on" where none does (`protectionsFor`).
    func protections(for host: String?) -> String {
        for name in host.map(Self.names(of:)) ?? [] {
            if let sessionProtections {
                if let protections = sessionProtections[name] { return protections }
                continue
            }
            if let protections = protectionRule(for: name)["protections"] as? String {
                return protections
            }
        }
        return "on"
    }

    /// The setting to write so protections are `on` for `name`, keeping the
    /// rest of its choices. A site keeps the field unless it is "on"; a host
    /// keeps it only where it differs from what the names above give
    /// (`_change`), so a host can stay on under a site that is off.
    func protectionsChange(for name: String, on: Bool) -> (key: String, value: Any?) {
        var rule = protectionRule(for: name)
        let value = on ? "on" : "off"
        let isHost = Self.site(of: name).map { $0 != name } ?? false
        let inherited = isHost ? protections(for: Self.names(of: name).dropFirst().first) : "on"
        if value == inherited {
            rule.removeValue(forKey: "protections")
        } else {
            rule["protections"] = value
        }
        let key = Self.protectionBranch + name
        guard !rule.isEmpty,
              let json = try? JSONSerialization.data(withJSONObject: rule, options: .sortedKeys)
        else { return (key, nil) }
        return (key, String(decoding: json, as: UTF8.self))
    }

    /// The private session's protections choices once `name` gets `on`,
    /// kept as `protectionsChange` keeps a saved one.
    func sessionProtectionsChange(for name: String, on: Bool) -> [String: String] {
        var session = sessionProtections ?? [:]
        let value = on ? "on" : "off"
        let isHost = Self.site(of: name).map { $0 != name } ?? false
        let inherited = isHost ? protections(for: Self.names(of: name).dropFirst().first) : "on"
        session[name] = value == inherited ? nil : value
        return session
    }

    // MARK: Video and audio (`SvalSiteProtections.sys.mjs`, protections spec §4.1)

    /// The choice for every site without one of its own: 0 Ask first, 1
    /// Always allow, 2 Always deny, and Ask first when unset.
    static let mediaDefaultKey = "media.autoplay.site-permission-only.default"

    /// A site's video and audio choice, in the order and words every control
    /// lists them (`MEDIA_CHOICES`).
    enum Media: String, CaseIterable, Identifiable {
        case allow, ask, block

        var id: String { rawValue }

        var words: String {
            switch self {
            case .allow: "Always allow"
            case .ask: "Ask first"
            case .block: "Always deny"
            }
        }
    }

    var mediaDefault: Media {
        switch (settings[Self.mediaDefaultKey] as? NSNumber)?.intValue {
        case 1: .allow
        case 2: .block
        default: .ask
        }
    }

    /// What a page of `host` gets: the choice of the most specific name
    /// holding one, or the default (`mediaFor`).
    func media(for host: String?) -> Media {
        for name in host.map(Self.names(of:)) ?? [] {
            if let session {
                if let choice = session[name] { return choice }
                continue
            }
            if let choice = (protectionRule(for: name)["media"] as? String).flatMap(Media.init) { return choice }
        }
        return mediaDefault
    }

    /// The setting to write so `name` gets `choice`, keeping its other
    /// choices. A site keeps its choice even where it matches the default; a
    /// host keeps one only where it differs from the names above it
    /// (`_change`).
    func mediaChange(for name: String, to choice: Media) -> (key: String, value: Any?) {
        var rule = protectionRule(for: name)
        let isHost = Self.site(of: name).map { $0 != name } ?? false
        if isHost, choice == media(for: Self.names(of: name).dropFirst().first) {
            rule.removeValue(forKey: "media")
        } else {
            rule["media"] = choice.rawValue
        }
        let key = Self.protectionBranch + name
        guard !rule.isEmpty,
              let json = try? JSONSerialization.data(withJSONObject: rule, options: .sortedKeys)
        else { return (key, nil) }
        return (key, String(decoding: json, as: UTF8.self))
    }

    /// The private session's choices once `name` gets `choice`, kept as
    /// `mediaChange` keeps a saved one.
    func sessionMediaChange(for name: String, to choice: Media) -> [String: Media] {
        var session = self.session ?? [:]
        let isHost = Self.site(of: name).map { $0 != name } ?? false
        if isHost, choice == media(for: Self.names(of: name).dropFirst().first) {
            session[name] = nil
        } else {
            session[name] = choice
        }
        return session
    }

    /// The setting to write so `name` takes the choice of the names above
    /// it, keeping its other choices.
    func mediaClear(for name: String) -> (key: String, value: Any?) {
        var rule = protectionRule(for: name)
        rule.removeValue(forKey: "media")
        let key = Self.protectionBranch + name
        guard !rule.isEmpty,
              let json = try? JSONSerialization.data(withJSONObject: rule, options: .sortedKeys)
        else { return (key, nil) }
        return (key, String(decoding: json, as: UTF8.self))
    }

    /// Every name with a video and audio choice of its own.
    var namesWithMediaChoice: [String] {
        settings.keys
            .filter { $0.hasPrefix(Self.protectionBranch) }
            .map { String($0.dropFirst(Self.protectionBranch.count)) }
            .filter { protectionRule(for: $0)["media"] != nil }
            .sorted()
    }

    /// The setting to write so every site without a choice gets `choice`:
    /// Ask first clears it (`setMediaDefault`).
    static func mediaDefaultChange(to choice: Media) -> (key: String, value: Any?) {
        switch choice {
        case .ask: (mediaDefaultKey, nil)
        case .allow: (mediaDefaultKey, 1)
        case .block: (mediaDefaultKey, 2)
        }
    }
}

/// Whether a page may run JavaScript, by the rules the desktop syncs
/// (`SvalJavascript.sys.mjs`): each rule is a setting under `siteBranch`,
/// named for a site or a host and holding `allow` or `block`, and the rule
/// for the most specific name covering the host wins (`siteNames`). With
/// none, `javascript.enabled` decides.
enum JavaScriptRules {
    static let siteBranch = "browser.sval.javascript.site."
    static let enabledKey = "javascript.enabled"

    static func allowed(host: String?, settings: [String: Any]) -> Bool {
        let fallback = settings[enabledKey] as? Bool ?? true
        for name in SiteRules.names(of: host ?? "") {
            if let rule = settings[siteBranch + name] as? String, rule == "allow" || rule == "block" {
                return rule == "allow"
            }
        }
        return fallback
    }

    /// Whether a load may run JavaScript. A web address takes its own host's
    /// rule. A frame loaded from anything else (`about:blank`, `data:`,
    /// `blob:`) takes the rule of the frame that made it, as it does on the
    /// desktop, where such a frame gets its creator's principal. One whose
    /// creator has no host of its own, such as a sandboxed frame, runs
    /// JavaScript only when both its page's rule and the default allow it.
    static func allowed(_ action: WKNavigationAction, in webView: WKWebView, settings: [String: Any]) -> Bool {
        if let url = action.request.url, let scheme = url.scheme?.lowercased(),
           ["http", "https"].contains(scheme) {
            return allowed(host: url.host(), settings: settings)
        }
        let origin = action.sourceFrame.securityOrigin.host
        if !origin.isEmpty {
            return allowed(host: origin, settings: settings)
        }
        return allowed(host: nil, settings: settings) && allowed(host: webView.url?.host(), settings: settings)
    }
}
