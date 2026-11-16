# 1368. An agent's tab opens apps only as its policy says

**Status:** Accepted on 2026-10-24.

## Context

A page can hand an address to an application on the user's computer: a
meeting client (`zoommtg:`), a mail client (`mailto:`), an editor, an OS
handler. Agents should be able to do this, since joining a call or writing a
mail is part of many tasks, but the agent chooses what to click and text on
any page can steer it.

Refusing such addresses through the content policy, and in frames through a
check of its own, misses paths. A link click to a scheme
Firefox does not expose goes from `nsDocShell::OnLinkClickSync` straight to the
external protocol service and opens no channel the content policy sees. A
`window.open` to one during the agent's click loads in a tab the tree has not
yet filed under the agent. Firefox lets some schemes through without its own
dialog (`network.protocol-handler.external.mailto` is true in `firefox.js`), and its
`open-protocol-handler` permission is shared with the user's own tabs in a
workspace that uses the user's sign-ins (security audit 2026-10-24, URL-1).

Every path ends in the parent's `nsExternalHelperAppService::LoadURI`, which
hands the address to `nsContentDispatchChooser.handleURI` with the context and
the principal that asked.

## Decision

- **`apps` is a per-site permission beside `downloads` and `uploads`**, keyed
  by scheme: `"apps": { "zoom.us": { "zoommtg": "allow" }, "shop.example":
  "deny" }`. `"deny"` for a whole site is the site-wide Deny Settings sets.
- **It is asked the first time a page starts a scheme its site has no entry
  for.** The alert shows the full address. Allow and Deny answer for that
  launch; Always allow and Always deny record that scheme alone for the site.
  The site is the one whose document started the launch, a frame's own, as for
  downloads and as Firefox's own dialog keys it.
- **A launch opens nothing, unasked, when the launching site or the tab's
  top-level page's site is Blocked or Read only.**
- **A tab holds one apps alert at a time.** A further launch in that tab while
  it is up opens nothing.
- **It is enforced in one place**, at the start of `handleURI` in the parent,
  for any context `agentForLoad` says is in an agent's tab. A tab the tree has
  not filed yet, as one a page's `window.open` made, is the agent's its
  openers are: Gecko closes such a tab once it hands the address on, so it
  may never be filed. The gate's content policy lets a page's
  external-protocol loads through to it, in the top-level document and in
  frames. Tools refuse such addresses with `unsupported_url`.
- **Firefox's own rules run as well.** What Firefox refuses before the
  dispatcher is refused without an alert, and after Sval allows, Firefox's
  handler preferences, its permission dialog and its app chooser decide as
  in any tab.
- The hook is a patch to `ContentDispatchChooser.sys.mjs`, a front-end file,
  so it leaves the Gecko key where it is. No chrome API sees a launch before
  it happens, and replacing the dispatcher's contract would depend on which
  registration wins.

## Consequences

- The first launch of a scheme in an agent's tab can show two prompts in a
  row: Sval's alert, then Firefox's own dialog where Firefox would ask.
- A user's own "always allow" in Firefox's dialog does not open an app for an
  agent without Sval asking.
- The change is a patch to Mozilla's code, `sval-agent-apps.patch`.
