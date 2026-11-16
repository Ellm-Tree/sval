# 1985. One look rule for the site controls

**Status:** Accepted on 2026-11-04. Specified in
`docs/superpowers/specs/2026-10-28-header-signals-design.md`, §1.

## Context

The site controls at the address pill's end
([0132](0132-site-controls-in-the-address-pill.md)) each answer a question
about the page: may it play media, run JavaScript, use the camera, know the
person's location, and is it translated. Each control drew its states its own
way. A refused device and a refused location carried a dot beside their
slash, a translated page took the grey pressed chip, and media playing on the
page had no mark. A person had to learn each control apart.

## Decision

Every site control draws its state by one rule:

- **A plain glyph** means allowed or available.
- **A slash** means blocked. It never carries a dot.
- **A dot** means a prompt waits for the person's answer, and nothing else:
  a permission prompt, open or held, and media that tried to play on a site
  set to Ask first, which the media button answers. Waiting for an answer is
  not blocked, so that media draws its plain glyph with the dot. The slash
  is for a site set to Never and a visit the person stopped.
- **The live fill** means it happens on this page now: a camera, microphone or
  screen in use, location in use, media playing, and a translated page. The
  fill is the same chip on every control, in the same colours and hover.
- **JavaScript** is plain or crossed. It has no dot and no fill.

## Consequences

- A person who has learned one control can read the others.
- A refused request shows as the crossed glyph alone, so the dot always means
  that something waits for an answer.
- The translate cell keeps the target language's code beside its icon inside
  the live fill.
