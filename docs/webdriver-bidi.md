# Driving Sval with WebDriver BiDi

Sval carries Gecko's WebDriver BiDi server unchanged, so Puppeteer, Selenium
and other BiDi clients can drive it the way they drive Firefox. Nothing in
Sval's settings turns it on. The server starts only when Sval is launched with
`--remote-debugging-port`, and it stops when that run of Sval quits.

## What a BiDi client can do

It has the whole browser: every window and tab, including sites the profile is
signed in to. It can run scripts in pages and read cookies. None of Sval's
agent controls apply to it: no pairing, no site levels, no approvals, no
withheld content and no Take control. While it runs, Gecko marks every
window as remote-controlled (`gRemoteControl` in `browser.js`).

That is the right shape for test automation on a profile made for it. For an
agent working in the user's own browser, use Sval's agent access (sval-mcp)
instead, which keeps the agent to its workspace and asks the user before it
writes.

## Its own cookie jar

What a WebDriver client opens never shares the user's cookies, and never
reaches the user's workspaces. Each window it opens, with BiDi's
`browsingContext.create` or classic `WebDriver:NewWindow`, shows a workspace
of its own, named "WebDriver" and isolated, so its tabs use that workspace's
cookie jar, the way an agent's isolated workspace does.

- A tab a client opens in a WebDriver window, without naming a user context
  or naming `"default"`, opens in that window's jar.
- A tab a client opens in one of the user's windows goes to a WebDriver
  window instead, as an agent's tabs go to the agent's workspace: the most
  recent one, or a new one when there is none, whose only tab it is.
- A user context the client made with `browser.createUserContext` in this
  run of Sval is a jar apart from the user's already. A window or tab opened
  on it stays in it. Any other user context a client names opens in the
  window's jar instead.
- A private window is private browsing's own jar, and gets no workspace.

A WebDriver window's tabs are held in memory, as a private window's are
(`SvalPrivateSession.sys.mjs`), though the window is not private. Its
workspace is never saved or synced, so no other device sees it, and the
switcher does not list it. The panel says so in the window's footer. The
window is in no session Firefox saves either, so a restart, a crash, Restore
Previous Session or the recently closed windows never bring it back
(`sessionstore-unsaved-windows.patch`). When
the window closes, its workspace goes, and so do its jar's cookies and site
data. If Sval stops first, as in a crash, nothing of the workspace was
written, and Sval removes the jar it leaves the next time it removes the jars
of deleted workspaces.

A profile that recorded WebDriver workspaces in the synced document
(`webDriverWorkspaces` in `sval-local-settings.json`) has them deleted at its
next launch, unless one of the user's windows shows one or it is the last
workspace, and the record goes from the file.

**Let WebDriver use your Workspaces' cookies** (Settings, Agents, under
Advanced) is off by default. Turned on, a tab a client opens in one of the
user's windows stays there, in the jar of the workspace that window shows,
so scripts get the user's logins. New windows still get a WebDriver
workspace. The switch is this device's alone and does not sync.

The rest of what a client can do is unchanged: it can still reach every
window and tab, the user's among them.

## Use a profile of its own

Starting the server also applies Mozilla's automation preferences to the
profile (`remote/shared/RecommendedPreferences.sys.mjs`). They turn off,
among other things, Safe Browsing, extension updates, password saving and
autofill, and point Remote Settings at a dummy server. A clean quit restores
them; a crash or a killed process leaves them in the profile's `prefs.js`,
marked by `remote.prefs.recommended.applied`. So always launch with a
throwaway profile:

    /Applications/sval.app/Contents/MacOS/sval \
      --profile "$(mktemp -d)" --remote-debugging-port 9222

The binary is `sval` inside Sval's install on every platform:
`sval.app/Contents/MacOS/sval` on macOS, `sval.exe` on Windows and
`sval` on Linux. `--headless` runs it with no window.

The server listens on localhost only, at `ws://127.0.0.1:<port>/session`.
Port `0` picks a free one, and Sval prints the address it listens on:

    WebDriver BiDi listening on ws://127.0.0.1:9222

A session reports `browserName` as `firefox`. That is the protocol's name for
the Gecko engine, and clients match on it, so Sval leaves it as it is.

## Clients

**Puppeteer** (23 or later) connects over pure BiDi:

```js
const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://127.0.0.1:9222/session",
  protocol: "webDriverBiDi",
});
```

or launches Sval itself with `puppeteer.launch({ browser: "firefox",
executablePath: "<path to Sval's firefox binary>" })`.

**Selenium** drives Sval through geckodriver. Set the binary in Firefox's
options (`moz:firefoxOptions.binary`, or `setBinary` in the bindings) and ask
for BiDi with the `webSocketUrl: true` capability. geckodriver makes its own
throwaway profile.

**Playwright** normally drives its own patched Firefox build. Its WebDriver
BiDi support for Firefox is still experimental, so it is not a supported way
to drive Sval yet.

## Tests

`browser_sval_webdriver_window.js` checks the jar of each kind of window and
tab above, that a WebDriver window's workspace and pages never reach the
synced document, and that closing the window removes its workspace and jar.
