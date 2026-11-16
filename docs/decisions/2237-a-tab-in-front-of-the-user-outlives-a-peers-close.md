# 2237. A tab in front of the user outlives another device's close

**Status:** Accepted on 2026-11-11. Specified in
`2026-09-24-sval-browser-design.md`, §5.4.

## Context

A tab closed on one device closes on every other at its next pass (spec
§5.4). Where the other device has the tab on screen, the close takes away the
page the user is reading, and a call or a picture-in-picture video in it
ends. A video call is a tab like any other, so it shows on every device, and
a click on another device ends it.

## Decision

- **Another device's delete never closes a tab in front of the user:** a
  window's selected tab, or one in a call or in picture-in-picture. The
  device keeps the tab and adds its node back under its own id, at its place
  when its parent is still in the Workspace and at the Workspace's top level
  otherwise. Every peer reads the node as news, so the tab returns on the
  device that closed it. The tab in front wins because losing it costs the
  user something live, and the device that closed it gets it back as a row.
- **The device learns of the delete from the merge that brings it in,**
  before anything can draw the node's absence, and only a merge reports it.
  A delete made on this device closes its tabs as it always does.
- **A tab in a call is local** (decision 1372) for as long as the call
  lasts: sharing the camera, the microphone or the screen, or holding a peer
  connection open, as Firefox's tab unloader asks. Going local takes it off
  every other device as a close does, so no other device shows a call it
  could end. When the call ends it comes back under the same id, stamped
  now. `setLocal` changes the mark without the address.
- **No call outlives its session.** At startup, a local node whose address
  `syncableAddress` accepts was marked for a call alone, and is published
  again.

## Consequences

- A close made on one device is undone by a device that has the tab in
  front.
- A tab Firefox shows as sharing nothing, holding a peer connection alone, is
  kept by a peer's close but stays shared until something else changes its
  mark.
- A delete of the Workspace itself still closes the tab.

### Rejected

- **A separate record of call tabs outside the document.** Every tree rule
  works on the one document, and decision 1372's mark already keeps a node on
  one device.
- **Keeping the tab without its node.** The panel draws only the document,
  so the tab would be open with no row to reach it by.
- **A new id for the tab put back.** Selection, last-active time and agent
  records are keyed by node id, as decision 1372 found for its mark.
