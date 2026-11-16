# 0127. No Firefox Enhanced Tracking Protection UI

**Status:** Accepted on 2026-10-16.

## Context

Sval has its own protection button and Protections card. Firefox's Enhanced
Tracking Protection controls would be a second, competing picture of the same
thing, as Firefox's tab strip would be beside Sval's panel
([0049](0049-sval-owns-the-tabs.md)).

## Decision

No Firefox ETP UI appears anywhere: no ETP setting group (`etpStatus`,
`etpCustomize` or any other), no ETP page, no `about:protections` dashboard and
no address-bar shield. A Firefox pref that only ETP's UI reached gets a switch
in Sval's own card, in Sval's wording, under Show advanced
([0126](0126-every-default-is-a-setting.md)).

## Consequences

Moving a Firefox group under Show advanced does not remove it while Firefox's
own group still renders. A change that removes Firefox UI is checked by
searching for the group ids, because its description can be wrong.
