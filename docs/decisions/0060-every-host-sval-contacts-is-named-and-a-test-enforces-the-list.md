# 0060. Every host Sval contacts is named, and a test enforces the list

**Status:** Accepted on 2026-10-07.

## Context

Stock Firefox on a fresh profile contacts about twenty hosts with nobody
touching it, including one that sends the user's city to Mozilla for a
new-tab weather widget. "Sval runs no servers" is empty if the browser phones
Mozilla, Google and Cisco on its own.

## Decision

Each host is decided on its own merits: kept and disclosed, kept behind a user
choice, or removed (spec §10.9). `scripts/network-contact/allowed-hosts.txt` is
the list, and `scripts/network-contact-test.sh` fails on any host outside it.

The check runs in the nightly workflow, because it takes longer than the rest
of the Linux job and would add that to every pull request.

## Consequences

A pull request that adds an unlisted host can merge and is caught the next
night, so contributors run `scripts/network-contact-test.sh` first.
