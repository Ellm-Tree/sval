# What Sval does

<!--
For contributors: a pull request that adds, removes or changes a user-facing
feature updates this page. List what a person using Sval would notice and want
to know. Leave out visual polish, bug fixes and implementation details.
-->

Sval is a browser for Linux, macOS, and Windows, built around privacy and
Workspaces that sync through storage you control. An iPhone app syncs with it
and Android is coming soon. There is no account to create and no telemetry or
personal data collection, and AI stays out of your way unless you add it. Sval
blocks common tracking and fingerprinting, and you decide what each site can
do.

## Setting up Sval

- **A quick tour first.** Setup opens with a tour of Workspaces, the Launcher,
  and how Sval protects your privacy, and Skip takes you straight to the
  questions.
- **Your first Workspace.** If you're new to Sval and don't import
  anything, you name your first Workspace and choose its color and emoji.
  If you skip setup, Sval names it "Default Workspace" and gives it an emoji.
- **Your answers.** Sval asks for your search engine and your password
  manager, and asks how much to block if you're new to Sval. Then you choose
  which side of the window the Workspace panel goes on, whether AI apps can
  use Sval, and whether Sval is your default browser. Skip setup keeps what
  you've chosen so far.
- **Your welcome.** Setup ends with your Sval Card. If you're new to Sval,
  your tabs stay on this computer until you set up sync, and Set up sync
  takes you to Settings › Sync and devices.
- **Your Sval Card.** View › Your Sval Card shows how long you've used Sval
  and what you've built and blocked, and Save image keeps a copy. Your card
  is the same on every device you sync. If Arc gave you a card, your Arc
  years carry over.

## Workspaces

- **Workspaces.** Workspaces keep your projects apart, like work and home.
  Each one gets a name and an emoji you choose, along with a color that tints
  the window and the home page.
- **Workspace and group colors.** Pick one of ten colors in a dark or light
  version, or make your own on a color wheel. If you pick the version that
  matches your computer's light or dark appearance, the color switches when
  your appearance does.
- **See-through Workspaces.** Set a Workspace's Transparency to let your
  desktop show through the window. Transparency works on a Mac, Windows 11,
  and Linux on Wayland with GNOME 51 or KDE Plasma 6.7 and later. Sval turns
  it off while your system's reduce-transparency or high contrast setting is
  on.
- **One Workspace per window.** Work and home can sit side by side in two
  windows without mixing. Use the switcher above your tabs to change a
  window's Workspace, or Shift-click a Workspace to open it in a new window.
  To move a tab to another window, drag it into that window's Workspace.
- **Choose your Workspace switcher.** In Settings › Appearance › Workspace
  appearance, choose Menu or Strip. The strip shows every Workspace in a row
  above your tabs, and you can hide it or choose which names it shows.
- **Put Workspaces in order.** Drag a Workspace up or down in the switcher's
  list, or along the strip. The new order syncs to your other devices.
- **Isolated Workspaces.** A Workspace can keep its own cookies and sign-ins,
  so you can be signed in to two accounts on the same site at once.
- **Workspace Sync.** Your Workspaces sync to your other devices, along with
  their tabs and groups. See [Sync](#sync).
- **Device Workspaces.** Each phone or tablet that syncs with Sval keeps a
  Workspace of its own for the tabs you open on it. On your computer, the
  switcher lists them under Devices, and you can open, rename, or delete them
  like any other Workspace.
- **Archive idle tabs (if you want).** Turn on Archive idle tabs in Settings ›
  Workspaces › Idle tabs, or for one Workspace in its Edit Workspace dialog.
  Sval then moves tabs you haven't used in a while to History › Archived tabs,
  and one click puts a tab back where it was. Sval never archives the tab
  you're looking at. Sval also leaves alone a tab that's in a group, playing
  sound, in Picture-in-Picture or a call, set to Keep Awake, or holding text
  you typed.
- **Light or dark themes.** Choose Automatic, Light, or Dark in Settings ›
  Appearance › Theme. Websites that support both follow your choice.

## Tabs in a Workspace

- **Nested groups.** Your tabs live in the Workspace, down one side of the
  window, where you can put them in groups and put groups inside other
  groups. Drag one row onto another to reorder, group, or split them. You can
  put the Workspace panel on either side of the window and make it any width
  you like.
- **Tab previews.** Point at a tab in the Workspace to see a preview with the
  tab's title, its site, and a picture of the page. You can turn previews off
  in Settings › Appearance.
- **Hide the Workspace panel.** Press ⌃Z (Ctrl+Alt+Z on Windows and Linux) to
  give the page the whole window. Hold the pointer at the window's edge on the
  Workspace panel's side, and the Workspace panel slides back over the page.
- **Put the toolbar in the Workspace panel.** Choose In the Workspace panel in
  Settings › Appearance › Workspace appearance to move the address bar and its
  buttons to the top of the Workspace panel. The page then gets the window's
  full height.
- **Select several rows.** ⌘-click (Ctrl-click on Windows and Linux) rows to
  select them, or Shift-click to select every row in between. You can then
  close the selected tabs, move them to a group or a Workspace, make a new
  group from them, or drag them all at once.
- **Closing a tab goes back.** Close a tab, and Sval shows the one you looked
  at before it in that Workspace. In a tab a link opened, Back closes the tab
  and returns you to the page that held the link.
- **Undo.** When you close several tabs or delete a group, a pin, or a
  Workspace, the bottom of the Workspace panel offers Undo for a few seconds.
- **Pins.** Pinned sites sit as icons above your tabs. A pin keeps its page
  while you work elsewhere, and closing the pin takes the pin back to its
  saved page. Each Workspace has its own copy of a pin's page, signed in as
  that Workspace, and you choose which Workspaces show a pin. Drag one pin
  onto another to make a pin folder, and drag inside an open pin folder to
  reorder its pins. A link in a pin to another site opens in a Quick Peek.
- **Favorites.** Your bookmarks are in the Favorites menu, which opens from
  the Favorites button at the bottom of the Workspace panel. Pins are kept
  apart from Favorites, so a site can be a pin or a Favorite or both. Your
  pins also appear as tiles on the home page. Right-click a tab in the
  Workspace to add its page to Favorites or take the page out. Pins and
  Favorites sync along with your Workspaces and groups.
- **Split View.** Show up to four tabs side by side in a Split. To split, use
  a link's or a tab's menu, or Alt-click (Option-click on a Mac) a second
  tab. Splits keep their sizes after a restart and sync to your other
  devices.
- **Quick Peek.** ⌥-click (Alt+click on Windows and Linux) a link, or choose
  Open Link in Quick Peek, to see the link over the page. Close the Quick
  Peek with Escape, or keep it as a tab or a Split. Settings › Links turns
  Quick Peek off.
- **Email an address on a page.** Select an email address that isn't a
  link, right-click it, and choose Email followed by the address. A new
  message to that address opens in the app or site you've chosen for email.
- **Rename a tab.** To rename a tab, choose Rename from its menu, press F2, or
  double-click its name. The tab keeps your name as you browse on every device
  until you choose Remove Name to show the page's title again.
- **Copy a Markdown link.** Choose Copy Markdown Link from a tab's menu to
  copy its title and address as a link you can paste into notes or chat.
- **Copy a clean address.** Choose Copy Clean Address in the site settings
  menu to copy the page's address without tracking parameters like
  `utm_source`.
- **Put tabs to sleep.** Choose Put to Sleep from a tab's or a group's menu
  to free the memory its pages use. Sleeping tabs stay in the Workspace,
  dimmed, and wake when you select them.
- **Switch Workspaces without reloading.** The Workspace you leave keeps
  running, so when you come back its pages are where you left them. Sval
  puts its tabs to sleep once you've been away a while, or sooner if your
  computer runs low on memory. A tab playing sound or holding text you typed
  stays awake.
- **Keep a tab awake.** Choose Keep Awake from a tab's menu, and Sval never
  puts it to sleep, however long you're away from its Workspace.
- **Battery Saver.** When your laptop runs on battery, Sval draws fewer frames
  and slows background tabs, and it puts Workspaces you've left to sleep
  sooner. You choose when Battery Saver turns on in Settings › General.
- **Pause what's playing.** A pause button shows next to any tab, group, or
  Workspace that's playing sound. The controls at the bottom of the Workspace
  panel play and pause whatever played last and skip through it.
- **Keep watching in Picture-in-Picture.** Switch away from a playing video,
  and the video keeps playing in a Picture-in-Picture window until you come
  back, unless you turn that off in Settings › General.
- **Downloads and History per Workspace.** Downloads and History show the
  current Workspace's items, or everything.
- **Private windows.** Press ⇧⌘N (Ctrl+Shift+N). Each private window is its
  own session, saves nothing to disk, and leaves the page's title out of the
  window's title. When you close one, Sval cancels its unfinished downloads,
  and Settings › Privacy and protection can have Sval delete the files the
  window downloaded too. Websites can't show notifications from a private
  window unless you turn on Show website notifications from private windows in
  the same Settings page.

## Address bar and Launcher

- **The Launcher.** Press ⌘L (Ctrl+L) to open the Launcher. As you type, it
  lists matching open tabs from every Workspace, pins and Favorites, Sval's
  commands, history, and search suggestions. You can reorder the sections and
  choose how many results each shows in Settings › Search and Launcher. With
  nothing typed, the Launcher and the home page's search field list your
  recent tabs and the sites you visit most.
- **Commands.** Type a few letters like "new wor" or "split" to run one of
  Sval's commands. Commands can manage your Workspaces and the tabs and Splits
  in them, your agents and site settings, and Sval itself, from opening
  Settings to entering full screen or restarting Sval. They can also print or
  translate the page.
- **Choose where a page opens.** Enter opens it in this tab, and Shift+Enter
  opens it in a new tab. ⌘⇧Enter (Ctrl+Shift+Enter) opens it in a new
  window, and ⌥Enter (Alt+Enter) opens it in a Split next to this tab.
- **Choose what the address bar shows.** Settings › Appearance lets you show
  the site name, the site with its path, or the full address. A long name is
  shortened from the left so the part that says whose site it is stays in
  view.
- **Your search on its results page.** On the results page of a search you
  made, the address bar shows what you searched for. The link button at its
  end shows the page's address.
- **One search everywhere.** The search field on the home page, the address
  bar, and the Launcher all work the same way, whichever you start from.
- **Search with another engine once.** Select your default engine's icon at
  the start of the Launcher, the address bar, or the home page's search field
  to pick another engine for this search.
- **Search with a keyword.** Type a keyword and a space before your search,
  like `@yt cats` for YouTube. Every built-in engine has a keyword starting
  with `@`, and `@` alone lists them. You can give any engine a keyword of
  your own in Settings › Search and Launcher.
- **Reader View.** To read an article in Reader View, click the book button
  next to the address bar or press ⌥⌘R (F9 on Windows and Ctrl+Alt+R on
  Linux).
- **Reload menu.** Right-click the Reload button to reload, hard reload past
  the cache, or clear the site's cache and reload.
- **Narrow windows.** As a window narrows, toolbar buttons move into the »
  menu.

## Links from other apps

- **Peeks.** A link from another app, like Slack or Mail, opens in a Peek: a
  small window outside your Workspaces. Read the page and close the Peek, or
  open the page as a tab in a Workspace. A Peek you don't use closes on its
  own, and Settings › Links sets how soon or turns Peeks off.
- **New Peek Window.** Press ⌥⌘N (Ctrl+Alt+N on Windows and Linux), or choose
  File › New Peek Window, to open an empty Peek for something you won't keep,
  like a video call. The Peek is signed in as the Workspace you opened it
  from, and closing the Peek adds nothing to your Workspaces.
- **Private Peeks.** A Peek you open from a private window is private and
  belongs to that window, so the Peek shares the window's sign-ins and saves
  nothing. When you close the private window, its Peeks close too.
- **Link Docking.** Add a rule in Settings › Links › Link Docking, and links
  to that site from other apps open as a tab in the Workspace you choose. Your
  rules sync to your other devices.

## Sval for iPhone

- **Tabs keep their history.** A tab you come back to keeps its Back and
  Forward history and its place on the page, even after Sval closes. Private
  tabs keep neither.
- **Switch tabs from the address bar.** Hold the address bar and slide to
  move through your tabs.
- **Search suggestions.** As you type in the address bar, the iPhone app
  shows suggestions from your search engine, following the search settings
  you chose on your computer. A private tab gets no suggestions.
- **Private tabs.** A link you tap in a private tab opens in Sval, even when
  another app on your iPhone could open that link.
- **Rearrange tabs in the grid.** Hold and drag a card to move it, or drop it
  on another card to make a group or a Split.

## Sync

- **No account.** Sval syncs through any folder you choose: a cloud folder
  like iCloud Drive or Dropbox, a network drive, or even a USB drive. Sval
  doesn't run a sync service, so your data stays yours.
- **SMB servers.** Sval can sync through a folder on an SMB file server, such
  as a NAS, without you connecting to the server first.
- **End-to-end encrypted.** Everything in the folder is encrypted with a key
  that only your devices have. Your cloud provider can't read any of it.
- **What syncs.** Your Workspaces sync with their tabs and groups, and so do
  your Favorites, your history, and your settings, from your choices for each
  site to your blocking setup. History reaches your other devices a little
  later than tabs do, and history you delete leaves your sync folder too.
- **Tabs in use stay put.** A tab in a call stays off your other devices until
  the call ends. A tab another device is showing stays open on that device
  when you close the tab here.
- **Adding a device.** When you first set up Sval on the new device, choose
  the folder your other devices sync to. To add a device later, go to
  Settings › Sync and devices › Sync with another device for a one-time code.
- **Back up your sync key.** Sval offers to back up the key when it makes
  it. If you lose every device, set up Sval on a new one, choose your sync
  folder, and select "Restore with your backup key". Your Workspaces come
  back from the folder.

## Import and export

- **Keep Firefox.** You can run Sval and Firefox at the same time, because
  Sval keeps its own data and extensions and leaves Firefox's alone unless you
  import from Firefox.
- **Import from another browser.** Sval brings over your open tabs, your
  history, and your bookmarks as Favorites from these browsers and from any
  bookmarks file:
  - Chrome, Edge, Brave, and Vivaldi
  - Arc and Zen
  - Safari and Orion
  - Firefox
  - Dia, without its open tabs, because Dia encrypts them
- **Profiles and Spaces become Workspaces.** Each browser profile becomes a
  Workspace, as does each Arc or Zen Space, Vivaldi or Edge Workspace, and
  Safari Tab Group, with its groups and folders intact. Arc's Favorites and
  Zen's Essentials become pins and side-by-side tabs in both browsers become
  Splits.
- **Arc without Arc.** If Arc is gone, import the `Arc Data Export.md` file
  Arc exported. Arc's archived tabs land in History › Archived tabs.
- **Export.** If you want to leave Sval, you can export your Workspaces and
  Favorites in a format your new browser imports, including Opera. Safari can
  take your history too. You can also save everything Sval holds as one
  plain JSON file.

## Privacy and blocking

- **No telemetry.** Sval sends no usage data and runs no studies or
  experiments. It never contacts an advertiser, a tracker, or an account
  server, and a new install contacts only the services below for the reasons
  given:
  - **Sval's update server** (`download.sval.app`), once a day, to check for
    updates. It sends only your release channel and platform.
  - **The publishers of your blocking lists**, to keep ad and tracker blocking
    up to date.
  - **Mozilla's Remote Settings**, for security and compatibility data: revoked
    certificates, blocked malicious extensions, tracking protection lists,
    cookie banner rules, and fixes for sites that break.
  - **addons.mozilla.org**, to check for updates to your extensions.
  - **Google Safe Browsing**, to warn you before you open a phishing or
    malware site. Sval checks addresses on your device and never sends the
    address itself.
  - **Your search engine**, for suggestions as you type in the address bar.
    DuckDuckGo is the default.
  - **Cisco's OpenH264 codec**, once per release, so video calls work.
  - **Mozilla's Web Push service**, only if you allow a site to send you
    notifications, so those notifications can reach you.

  Sval contacts Kagi, encrypted DNS, DRM services for streaming video, and
  Sval's feedback server only once you choose to use them.
- **Ad and tracker blocker.** Choose No Blocking, Balanced Blocking, Strict
  Blocking, or Custom to make your own lists. Out of the box, Sval uses
  open-source lists.
- **A warning before sites that aren't secure.** HTTPS-Only Mode is on by
  default, so Sval opens the secure version of every site that has one. When
  a site has none, Sval warns you first, and you can let a site always open
  without the warning.
- **Tracking parameters are stripped.** At every level except No Blocking,
  Sval strips tracking parameters from the addresses you open.
- **Hidden trackers are blocked too.** Some sites disguise a tracker as part
  of their own site. When the blocker is on, Sval looks behind the disguise
  and blocks the tracker without contacting any extra server.
- **Fingerprinting protection** is on by default, and you can turn it off for
  individual sites.
- **Full protection on Google and Bing.** Sval leaves off Mozilla's fixes that
  weaken fingerprinting protection on Google's and Bing's sites. If you turn
  the fixes on in Settings › Privacy and protection › Fingerprinting ›
  Advanced, the Privacy and Security button can still turn full protection
  back on for any site they cover.
- **Privacy and Security button.** The button next to the address shows
  whether Sval is protecting the site and warns you when the connection isn't
  secure. A number on it shows how many trackers and ads Sval blocked, and
  fingerprinters it foiled, on the page. Click it to see the site's
  certificate, or find out whether the site had a recent data breach (from
  Have I Been Pwned).
- **Site controls.** With one click you can control a site's video and audio,
  turn its JavaScript on or off, or turn its camera and microphone access on
  or off. You can also clear the site's cookies and data in the site
  settings menu.
- **Choices for one address or the whole site.** On an address like
  `nas.example.com`, a choice in the site settings menu, the Privacy and
  Security button, or the extensions menu starts with that address alone. Pick
  "All of example.com" to make the choice for every address on the site. An
  address keeps the choices you made for it alone and takes everything else
  from its site. Removals, Colorshift, extension switches, and agent rules
  offer the same choice.
- **Camera and microphone.** When a site asks for your camera or microphone,
  choose Allow, Always allow, or Block. While a site uses them you can mute
  either one from the address bar or the site settings menu and unmute it
  without the site asking again.
- **Video and audio per site.** Choose Always allow, Ask first, or Always deny
  for every site or for a single site. Ask first plays nothing until you allow
  it or press a video's play button.
- **JavaScript per site.** Turn JavaScript on or off for individual sites, or
  turn it off everywhere and make exceptions.
- **Keep links in this tab.** The site settings menu can stop a site from
  opening its own pages in new tabs or windows. A link to another site still
  opens a new tab, and the choice syncs to your other devices, the iPhone app
  included.
- **Zoom per site.** The site settings menu shows the site's zoom level, with
  a slider to change it and Reset to put it back.
- **Location.** When a site asks for your location, you answer from a button
  next to the site controls, and you can click it later to change your mind.
- **Translate a page.** When a page is in a language other than yours, a
  Translate button shows next to the site controls. Click it to translate the
  page on your device.
- **Blocked embeds ask first.** When blocking stops an Instagram, TikTok, X,
  or Disqus embed, you see a placeholder. The embed loads only if you allow
  it.
- **Remove or snip part of a page.** Point at a cookie notice or a banner to
  remove it. Remove from this site keeps it gone on every visit and every
  device, even with ad blocking off, while Snip removes it only until you
  reload.
- **Colorshift.** Colorshift changes how a site looks every time you visit, on
  every device. Choose Colorshift This Site… in the site settings menu to tint
  the page or change the page's contrast, brightness, and saturation. You can
  also force the site's light or dark theme or swap its font. The color wheel
  comes from Zen Browser's Boosts.
- **Per-site controls.** Settings › Sites lists every site you've made choices
  for. Each site's page holds its permissions and JavaScript setting along
  with removals, Colorshift, extensions, and stored data. Forget this site
  clears everything Sval keeps for the site, and Defaults at the top sets what
  every other site gets.
- **Secure DNS** and **Global Privacy Control**, which tells sites not to sell
  or share your data.

## Search

- **Your search engine.** When you first set up Sval, you can keep DuckDuckGo
  or pick another engine such as Kagi or Brave Search. No search engine pays
  to be Sval's default.
- **Kagi support.** Sign in during setup or in Settings › Search and
  Launcher. Private windows search with Kagi's Privacy Pass, which proves
  you're a subscriber without revealing who you are.
- **Add your own.** Add your own search engine if the one you want isn't
  listed.
- **Remove any engine.** You can remove any search engine you don't use in
  Settings › Search and Launcher, and that includes the ones Sval comes
  with.

## Passwords

- **Your password manager.** Your passwords stay where you already keep them,
  and Sval never holds a copy. Pick your password manager during setup, or
  later in Settings › Privacy and protection › Password manager, and Sval
  installs its extension. Sval also shows you how to export your passwords
  from your old browser so you can import them into your password manager.
- **Desktop app connections.** Extensions that talk to a desktop app, like a
  password manager that unlocks with Touch ID, work in Sval
  ([how to connect one](native-messaging-hosts.md)).
- **Passkeys and security keys.** Sites can use passkeys and hardware security
  keys. On macOS and Linux you can set a key's PIN and manage its passkeys and
  fingerprints in Settings › Privacy and protection › Manage security keys.

## Extensions

- **Firefox extensions.** Sval runs extensions from addons.mozilla.org.
- **Full-strength ad blockers.** Sval runs Manifest V2 and V3 extensions, so
  uBlock Origin and other blockers work at full strength.
- **Settings › Extensions** lists every extension with an on/off switch. Each
  extension has a page for its permissions, private windows, and options.
- **Extension buttons for a page.** When an extension has a button for the
  page you're on, the extensions button shows a dot.
- **Extension updates wait a week**, so Mozilla has time to catch a harmful
  update. Change the wait in Settings › Extensions, or install an update at
  once with Update now.
- **Turn an extension off on a site.** Each extension in the extensions menu
  has a switch for the site you're on. An extension can also stay off
  everywhere except the sites you turn it on for, like a developer tool.
  Your switches sync.
- **Themes and container extensions.** Sval draws its own colors and has no
  containers, so it refuses to install themes and extensions that use
  containers.
- **Pin extensions from the extensions menu.** Pin an extension's button to
  the toolbar from the extensions menu, in the Workspaces you choose.
- **Keep an extension to some Workspaces.** On an extension's page in
  Settings, you choose the Workspaces the extension is available in.
  Anywhere else, the extension can't read or change your tabs' pages, and
  you won't see its button or menu items.

## Agents

- **Bring your own AI, or none.** Sval has no built-in AI. If you want an
  assistant, the one you already use can work with Sval, under your rules.
- **Let AI apps use the browser.** Turn on agent access in Settings and AI
  apps on your computer can drive Sval. Connect sets up any of these apps in
  one click: Claude Code and Claude Desktop, the ChatGPT desktop app and
  Codex, Cursor, and Mistral Vibe.
- **Approve an app once.** You allow an AI app like Claude Code one time, and
  every session of it can use Sval after that, from any folder.
- **Each session gets its own Workspace** in its own window. The window opens
  behind yours, so an agent never steals your focus, and the agent sees only
  its own tabs. When you resume a conversation, the agent can go back to the
  Workspace it used before, with its tabs still there.
- **Find each session's Workspace.** The switcher lists each agent's Workspace
  under its app, with the agent's task and folder and the icons of its app and
  model.
- **Unused agent Workspaces clean themselves up** after a while, and Settings
  › Agents sets how long. Unpairing an app offers to delete its Workspaces.
- **Your sign-ins, or none.** You decide how much of your online life an
  agent can reach. It can use your sign-ins, so it can work in your accounts
  for you without ever seeing your passwords. Or it can work in an isolated
  Workspace that starts signed out, so it can't reach your accounts at all.
- **Your approval on agent actions.** Sval asks before an agent visits a new
  site, sends what it typed, uploads or downloads a file, opens an app, or
  reaches a device on your network. Answer once or set a rule for the site,
  and review each agent's rules in Settings › Agents.
- **Choose how long an agent waits for you.** When Sval asks you about an
  agent's request, the agent waits for your answer. You choose how long it
  waits in Settings › Agents.
- **Let an agent read a site's console.** An agent can read a page's
  developer console messages to help debug a site. Sites sometimes write
  account details there, so Sval asks you the first time an agent wants a
  site's console.
- **Hand a tab to an agent** with Move to Workspace. Sval asks first and says
  whether the agent gets your sign-ins.
- **Take control.** Pause an agent, use its tabs yourself, and hand them back.
  Until you pause the agent, your typing and clicks don't reach its tabs.
- **Camera, microphone, screen, and location in agent tabs.** Sval always
  asks you before an agent's page uses your camera, microphone, screen, or
  location.
- **Stop an agent.** Stop agent in an agent's window keeps the agent stopped
  until you press Resume, even after a restart.
- **Agents close their windows.** When an agent finishes a task, its window
  closes and its Workspace keeps the tabs.
- **Show an agent a link.** When you open a Quick Peek in an agent's window,
  the agent can also read and use the Quick Peek.
- **Site tools for agents (WebMCP).** A website can offer agents direct
  actions, like searching its catalog or adding an item to a cart, so an
  agent calls the action instead of clicking through the page. Site tools are
  off until you turn them on, work only in an agent's Workspace, and each call
  needs the same approval as a click.
- **Known gaps.** An agent's screenshots show which links you've visited. For
  a few seconds after an agent acts, its page can still write to your
  clipboard.

## Keyboard shortcuts

Settings › Keyboard shortcuts lists every shortcut and lets you change most
of them. Websites can't take over Sval's shortcuts.

- **Show or hide the Workspace panel:** ⌃Z (Ctrl+Alt+Z on Windows and Linux).
- **Launcher:** ⌘L (Ctrl+L, or Alt+D on Windows and Linux).
- **New Peek Window:** ⌥⌘N (Ctrl+Alt+N).
- **Open a link in a Quick Peek:** ⌥-click (Alt+click). You can change it to
  ⌥⌘-click or ⇧⌥-click (Ctrl+Alt+click or Shift+Alt+click).
- **New private window:** ⇧⌘N or ⇧⌘P (Ctrl+Shift+N or Ctrl+Shift+P).
- **Copy Address:** ⇧⌘C (Ctrl+Shift+C) copies the address of the page
  you're viewing.
- **History:** ⇧⌘H (Ctrl+H) shows or hides History. **Show history:** ⌘Y
  (Ctrl+Shift+H).
- **Add to Favorites:** ⌘D (Ctrl+D). **Show Favorites:** ⇧⌘O (Ctrl+Shift+O).
- **Pins:** ⌘1 to ⌘9 (Ctrl+1 to Ctrl+9 on Windows, Alt+1 to Alt+9 on Linux).
  Hold ⌘ to see the numbers.
- **Split View:** ⌃+ (Ctrl+Shift+Plus on Windows and Linux).
- **Recent tabs:** ⌃Tab (Ctrl+Tab) switches to the tab you used last in this
  Workspace, or opens a carousel of your recent tabs while you keep holding
  ⌃ (Ctrl). Scrolling or swiping slides through the carousel. Settings ›
  Keyboard shortcuts switches ⌃Tab back to next-tab order.
- **Swipe to switch Workspaces:** swipe sideways with two fingers over the
  Workspace panel.
- **In the Workspace:** the arrow keys move between rows and open groups, and
  typing jumps to a name. F2 renames a row and Delete closes it, while Alt
  with an arrow moves it and Shift with an arrow selects more rows. Ctrl+Space
  selects or deselects a row and Escape clears the selection.
- **F6 and Shift+F6** move between the address bar, the Workspace panel, and
  the page.
- New Workspace, separating a Split, Remove from this site, Snip, and
  Colorshift this site have no key until you give them one.

## Developer experience

- **Labeled console messages.** The Web Console and Browser Console label
  each message as coming from the page, an extension, or Sval, and you can
  filter by each.

## Updates

- **Updates tell you once.** When an update is ready, Sval asks you to
  restart, and the notices button keeps the message until you do.
- **Another copy of Sval holds an update.** While another copy of Sval runs
  from the same place, the message asks you to close the other copy, or to
  update and restart anyway.

## Troubleshooting and data collection

- **A log that leaves out your browsing.** Sval writes warnings and errors to
  `sval-log.txt` in its data folder. The log never includes your Workspace and
  tab names, the addresses you visit, or a secret.
- **Send Feedback.** Click the chat button at the bottom of the Workspace
  panel, or choose Help › Send Feedback…, to open a form. It lists everything
  the report would include, and you can view or uncheck each part. Nothing in
  it identifies you unless you choose to add your email.
- **Record Performance.** When Sval is slow, select Help › Record Performance
  and keep using Sval until the slowness shows. Select Save Performance
  Recording, and Sval saves the last minute as a file in your downloads
  folder. Sval never sends the file anywhere. The file lists the web
  addresses of the pages you had open, so share it only with someone you
  trust.
- **Crash reports.** Sval sends a crash report only if you check a box,
  never with the page's address, and keeps none while a private window is
  open.

## License

Sval's own code is under the GNU Affero General Public License 3.0 with the
Sval App Store Permission. Mozilla's code is under the MPL 2.0.
`about:license` has the full texts. Sval and Ellm Tree, Inc. are not
associated with Mozilla.
