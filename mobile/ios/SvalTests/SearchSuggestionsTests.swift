// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// When the Launcher asks the synced engine for suggestions, and what it
/// keeps of the answer.
final class SearchSuggestionsTests: XCTestCase {
    private func parse(_ json: String, _ query: String, limit: Int = 3) -> [String] {
        SearchSuggestions.parse(Data(json.utf8), query: query, limit: limit)
    }

    func testAsksTheSyncedEngine() {
        XCTAssertEqual(SearchEngine(settings: [:]).suggestions("darn tough")?.absoluteString,
                       "https://duckduckgo.com/ac/?type=list&q=darn%20tough")
        XCTAssertEqual(SearchEngine(settings: [SearchEngine.key: "kagi"]).suggestions("darn tough")?.absoluteString,
                       "https://kagisuggest.com/api/autosuggest?q=darn%20tough")
        XCTAssertNil(SearchEngine(settings: [SearchEngine.key: "youtube"]).suggestions("cats"),
                     "a site search has no suggestions")
    }

    func testEachSwitchAndPrivateTurnSuggestionsOff() {
        XCTAssertEqual(SearchSuggestions.limit(settings: [:], inPrivate: false), 3)
        XCTAssertEqual(SearchSuggestions.limit(settings: [:], inPrivate: true), 0)
        XCTAssertEqual(SearchSuggestions.limit(settings: ["browser.search.suggest.enabled": false], inPrivate: false), 0)
        XCTAssertEqual(SearchSuggestions.limit(settings: ["browser.urlbar.suggest.searches": false], inPrivate: false), 0)
        XCTAssertEqual(SearchSuggestions.limit(settings: ["browser.sval.launcher.limit.suggestions": 5], inPrivate: false), 5)
    }

    /// An address or one character never goes to the engine.
    func testAsksOnlyForASearch() {
        XCTAssertTrue(SearchSuggestions.asks("darn tough"))
        XCTAssertFalse(SearchSuggestions.asks("d"))
        XCTAssertFalse(SearchSuggestions.asks("example.com"))
        XCTAssertFalse(SearchSuggestions.asks("192.168.1.1"))
        XCTAssertFalse(SearchSuggestions.asks("mailto:someone"))
        XCTAssertFalse(SearchSuggestions.asks("user:secret@intranet"))
        XCTAssertFalse(SearchSuggestions.asks("node.js"))
    }

    func testKeepsTheSuggestionsOfAnOpenSearchAnswer() {
        XCTAssertEqual(parse(#"["darn tough",["darn tough socks","Darn Tough","darntough.com","darn tough hiking","darn tough sale"]]"#, "darn tough"),
                       ["darn tough socks", "darn tough hiking", "darn tough sale"])
    }

    func testDropsAnAnswerForOtherTerms() {
        XCTAssertEqual(parse(#"["darn",["darn it"]]"#, "darn tough"), [])
        XCTAssertEqual(parse(#"{"error":"busy"}"#, "darn tough"), [])
    }
}
