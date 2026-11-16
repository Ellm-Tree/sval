# 0132. Site controls in the address pill

**Status:** Accepted on 2026-10-18.

## Context

What Sval does to protect a person and what a site may do are different
questions. The Privacy and Security button answers the first
([0131](0131-one-privacy-and-security-button.md)). Blocked playback defends
against audio fingerprinting, but a person meets it as "why won't this video
play", a question about what the site may do, like JavaScript. Firefox shows
site permissions as small icons in the address bar, each with its own popup.

## Decision

- **The address pill's end holds the site controls:** a media button, the
  JavaScript button, and a sliders button that opens the site menu. The
  sliders say the menu holds the site's settings. A chevron would read as
  more of the button next to it.
- **The translate, reader and favorite buttons are the page's own cluster**,
  after a divider. They act on the page in front of the person and save
  nothing for the site.
- **The media button is a plain on and off for this visit.** It shows whether
  media plays on the page now, as the site's choice or the global default
  decides, and shows sound the page plays as playing whatever let it. Off, a click allows media for this visit and reloads. On, a click
  stops what plays and blocks media for the rest of the visit. It saves
  nothing.
- **The JavaScript button saves a choice for the site**: one click
  turns script on or off for the site, on every device, and reloads.
- **The site menu** holds the site's saved media choice (Always allow, Ask
  first, Always deny: the same words, in the same order, as the global
  default in Settings), its JavaScript choice, the site's permissions
  (camera, microphone, location, notifications, pop-ups and the rest),
  "Clear cookies and site data", and "Manage sites".
- **The site menu shows controls and their state.** A line under a control
  says only what its name leaves out: how long Remove and Snip last, and
  that turning JavaScript off breaks some sites. Where a choice comes from
  belongs in Settings, since a menu opened to act buries its controls
  under explanations.
  Firefox's permission icons leave the address bar, so the pop-ups row shows
  how many pop-ups the page was denied. A camera or
  microphone in use keeps an indicator in the bar.
- **Only the person's allowance plays media.** On a site on Ask first, its own
  choice or the default's, which mean the same, nothing plays until the person
  allows it: from the media prompt, the media button, the site menu, or by
  pressing play. A press of play counts when the page calls `play()` inside
  the handler of that press, as a player's play button does, Gecko's own
  controls included. Such a press allows media for this visit, as the
  prompt's "Allow for this visit" does, and the video plays at once. A
  `play()` the page makes later, from a timer or after a load the press
  started, is no allowance, so a click on a link or a thumbnail never lets an
  ad or a looping player start. Which element was pressed is no test: players
  hide their video until it plays and keep it outside the box the person
  pressed. So a page that calls `play()` from every click it gets plays on
  any click; the person sees and hears it, and the media button stops it. On
  Always deny, and on a visit the person stopped, a press allows nothing:
  they said no to the site itself. Video and audio elements and a realtime
  `AudioContext` wait alike; a context plays once a visit is allowed. Its
  output and `AnalyserNode` data also fingerprint the device.
  `OfflineAudioContext` renders, with noise, as the fingerprinting catalogue
  decides.
- **Ask first asks.** A page whose play is blocked on a site set to Ask first
  opens a prompt from the media button: allow for this visit, always allow, or
  don't allow for this visit. A choice named Ask first that only lights a
  button leaves the person to find out why the page doesn't play. The prompt
  opens once a visit, however it is answered or closed, because a page tries
  to play on load and again each time the person presses play on it, and a
  prompt that came back each time would nag. Closed unanswered, it leaves the
  media button lit in Sval's accent colour, never the security colours of
  decision 0131. On a site set to Always deny nothing asks and the button
  stays quiet. The tooltip says what happened and what a click does, and names
  audio or video as the page tried to play it.

## Consequences

- Gecko's gate needs a native change to tell an element from Web Audio, and
  its blocked-play report gains which one tried to play, for the tooltip.
- JavaScript costs one click and media one click; the saved media choice and
  permissions cost two.
- Permission prompts anchor to the site controls.
