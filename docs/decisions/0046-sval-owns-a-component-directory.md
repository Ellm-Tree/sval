# 0046. Sval owns a component directory

**Status:** Accepted on 2026-10-19.

## Context

Every Mozilla file Sval patches is a rebase cost. Adding files to Mozilla's
own `jar.mn` files would patch them once per file.

## Decision

Sval's chrome code lives in `browser/components/sval/`, with its own `jar.mn` and
`moz.build`, both added files. The one Mozilla file that changes is a single
`DIRS` entry. Sval's pages are `chrome://` pages in that `jar.mn`, because an
`about:` page would mean patching Mozilla's `components.conf`.

## Consequences

Patch surface is flat in the number of files Sval adds. Every file added costs
no patch at all.
