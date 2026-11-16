# 0045. `claim` tells "nothing has arrived yet" from "your code is wrong"

**Status:** Accepted on 2026-10-07.

## Context

On a slow provider the ordinary case is a correct code typed before the offer
file lands.

## Decision

`claim` reports waiting until a file sealed under the code arrives. An
expired-only or junk-only folder also reads as waiting.

## Consequences

Reporting a slow provider as a bad code would send someone back for a new code
over a channel measured in tens of minutes.
