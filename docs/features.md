# What Sval does

<!--
For contributors: a pull request that adds, removes or changes a user-facing
feature updates this page. List what a person using Sval would notice and want
to know. Leave out visual polish, bug fixes and implementation details.
-->

Sval is a cross-platform browser (Linux, macOS, and Windows, with iOS and
Android coming soon) built around privacy and syncing Workspaces whose storage
you control. There is no account to create, no AI in your face (unless you add
it), no telemetry, and no personal data collection. Sval actively works against
common tracking, fingerprinting, and data-profiling methods. It puts you in
control of what you see and what is sent to websites.

## Setting up Sval

- **A quick tour first.** When you first set up Sval, it shows you
  Workspaces, the Launcher, and how Sval protects your privacy before it
  asks you anything. Select Skip to go straight to the questions.
- **New, or joining your other devices.** Sval asks whether this is your
  first time using Sval. If you use Sval on another device, Sval walks you
  through bringing your Workspaces to this computer.
- **Your first Workspace.** If you're new to Sval and don't import
  anything, you name your first Workspace and choose its color and emoji.
  The Workspace panel shows your choices as you make them.
- **Your answers.** Sval asks which search engine and password manager you
  want. If you're new to Sval, it also asks how much Sval should block.
  Then you choose the side the Workspace panel goes on, whether AI
  assistants can use Sval, and whether Sval is your default browser.
  Select Skip setup at any point to keep what you've chosen so far. Sval
  then installs nothing else.
- **Your welcome.** Setup ends with your Sval Card. If you're importing
  from another browser, the import runs while your card shows. You can
  select Start browsing once the import finishes. If you're new to Sval,
  your tabs stay on this computer until you set up sync. Select Set up sync
  to open Settings › Sync and devices.

## Workspaces

- **Workspaces.** Keep work, home, and other projects apart. You give each
  Workspace a name, a color, and an emoji. The Workspace's color tints the
  window and the home page. When a Workspace has a color, the home page
  shows a starry night sky, with that color rising over it from the bottom
  and glowing behind the Sval mark. A light color rises more faintly, so the
  page's text stays easy to read.
- **Workspace and group colors.** A Workspace offers ten colors, each in a
  dark and a light version. The dark versions are in the top row, and the
  light versions are in the row below. If you pick the version that matches
  your computer's current light or dark appearance, the color changes when
  the appearance does. If you pick the other version, the color stays as you
  see it. White takes Black's place in the light row. To make your own
  color, select Custom color. The color wheel starts at the color you
  picked, so you can adjust that color. With No color picked, the color wheel
  starts at Sval's own window color. On the color wheel, the direction
  from the center sets the hue, and the distance from the center sets how
  strong the color is. For a Workspace, Shade, next to the wheel, sets how
  light or dark the color is. When Shade passes from the dark shades to the
  light ones, the window's text switches between light and dark by itself. A
  group has one row of ten colors, and its color wheel has no Shade: the
  window sets how light the group's color is. Every color Sval offers keeps
  the text on it easy to read. On a Mac, when you turn on System
  Settings › Accessibility › Display › Increase contrast, Sval raises the
  contrast too. While you edit the Workspace your window shows, the window
  shows each color as you try it. Cancel goes back to the color you had, and
  Save keeps the new one.
- **See-through Workspaces.** Set a Workspace's Transparency to let your
  desktop show through the whole window around the page. Transparency works
  on a Mac, on Windows 11, and on Linux on Wayland, in GNOME 51 and later or
  KDE Plasma 6.7 and later. A Workspace with No color can be see-through
  too, in Sval's own window color. The window keeps at least a third of its
  color. Sval picks text that reads on the Workspace's color alone. A very
  light or very dark window behind Sval's window can make that text harder
  to read. On a Mac, when you turn on System Settings › Accessibility ›
  Display › Reduce transparency, the window is solid and Transparency is
  hidden. On Windows, turning off Settings › Personalization › Colors ›
  Transparency effects does the same. On Linux, turning on your desktop's
  high contrast setting does the same. On Windows 10, and on Linux desktops
  that can't blur what's behind a window, the window stays solid and
  Transparency isn't offered.
- **One Workspace per window.** Work and home can sit side by side in two
  windows without mixing. Use the switcher above your tabs to move the
  window to another Workspace. To open a Workspace in a new window,
  Shift-click it in the switcher. You can also
  swipe sideways over the Workspace panel to go to the next or previous
  Workspace. A
  Workspace opened in a new window shows the tab you last looked at there.
  To move a tab to another window, drag its row into that window's Workspace
  panel.
  Dragging moves one tab at a time. To move a group, a Split, or several
  selected rows, use Move to Workspace.
  The tab joins that window's Workspace where you drop it. A tab you move
  to another window in any other way, for example with an extension, also
  joins that window's Workspace.
- **Choose your Workspace switcher.** In Settings › Appearance › Workspace
  appearance, under Workspace switcher, choose Menu or Strip. The menu opens over the switcher's button.
  It lists every Workspace in your order and marks the one you're in. The
  strip shows all your Workspaces in a row above your tabs, so you can click
  one to go there. Click the Workspace you're in to see the full list. You
  also choose which names the strip shows, whether the names show under or
  next to the icons, and whether the mouse wheel slides the strip or switches
  Workspaces. Right-click a Workspace on the strip to show or hide the
  strip's names. Above the strip, the Workspaces row ends in a
  button that hides the strip. While the strip is hidden, the row shows the
  icon and name of the Workspace you're in.
  Sval keeps the strip hidden in every window until you show it again.
  In a narrow Workspace panel, the
  strip shows icons only. If you chose to see names, the current Workspace's
  name shows under the strip.
- **Put Workspaces in order.** Drag a Workspace up or down in the switcher's
  list, or along the strip. The new order syncs to your other devices.
  Swiping and the Launcher follow the new order.
- **Isolated Workspaces.** A Workspace can keep its own cookies and sign-ins,
  so you can be signed in to two accounts on the same site at once.
- **Workspace Sync.** Your Workspaces sync to your other devices, along with
  their tabs and groups. See [Sync](#sync).
- **Device Workspaces.** Each phone or tablet that syncs with Sval keeps a
  Workspace of its own for the tabs you open on it. A phone's Workspace
  shows a phone icon and a tablet's shows a tablet icon, on your computer
  and on your phone. On your computer, the switcher lists the device
  Workspaces under Devices, after your own Workspaces, each with the number
  of tabs in it. The strip shows the device Workspaces after a line of their
  own. While you have Workspaces of your own, a new window never opens in a
  device Workspace. You can open, rename, recolor, or delete a device
  Workspace like any other Workspace, or close every tab in it. A device that stops syncing keeps its Workspace until you
  delete it.
- **Archive idle tabs (if you want).** Turn on Archive idle tabs in Settings ›
  Workspaces › Idle tabs, or for one Workspace in its Edit Workspace dialog.
  Sval then moves tabs you haven't used in a while to History › Archived
  tabs. A tab counts as used when you go to the tab, click in it, or type in
  it, then stay on the tab for a few seconds. Using the tab on any of your
  devices counts. One click puts a tab back where it was. Sval never
  archives the tab you're looking at. It also never archives a tab that's in
  a group, playing sound, in picture-in-picture or a call, set to Keep Awake,
  or holding text you typed. This is off by default.
- **Light or dark themes.** Choose Automatic, Light, or Dark in Settings ›
  Appearance › Theme. Websites that support both follow your choice.
  Settings, error pages, dialogs, and the rest of Sval's built-in pages
  share one look.
  Websites that don't style their own scrollbars get the same thin
  scrollbar as the Workspace panel.

## Tabs in a Workspace

- **Nested groups.** Your tabs live in the Workspace, down one side of
  the window, where you can put them in groups and put groups inside other groups. Drag one row onto
  another to reorder, group, or split them. Over the middle of a tab's row,
  the row shows two halves: New group on the left and Create Split on the
  right. Drop on the half you want. Right-click a tab and choose
  Move to group › New group… to put the tab in a new group. You can put the Workspace panel on
  either side of the window and make it any width you like.
- **Tab previews.** Point at a tab in the Workspace, or move to it with the
  keyboard, and a preview shows next to the Workspace panel. The preview shows
  the tab's title, the site, and a picture of the page. The picture is the
  same one Recent tabs shows. A tab whose page hasn't loaded since Sval
  started has none. You can turn previews off in Settings › Appearance. With
  previews off, pointing at a tab shows the tab's title and address in a
  tooltip.
- **Hide the Workspace panel.** Press ⌃Z (Ctrl+Alt+Z on Windows and Linux)
  to hide the Workspace panel and give the page the whole window. While the
  Workspace panel is hidden, hold the pointer at the edge of the window on
  the Workspace panel's side. The Workspace panel slides in over the page.
  It slides away when you select a tab or move the pointer off the
  Workspace panel. To stop the Workspace panel sliding in at the edge, go
  to Settings › Appearance › Workspace appearance. Turn off Show the hidden
  Workspace panel when you hold the pointer at the edge of the window.
- **Put the toolbar in the Workspace panel.** To give the page the full
  height of the window, choose In the Workspace panel in Settings ›
  Appearance › Workspace appearance. The address bar and its buttons move to
  the top of the Workspace panel, and Downloads, History, and notices move to
  the bottom next to Favorites. Clicking the address opens the Launcher.
  As you narrow the Workspace panel, buttons that no longer fit move into
  the More tools button, and you reach the site controls from the site
  settings menu. At the narrowest width, the Workspace panel shows one
  column of buttons with the window's buttons stacked at the top. While the
  Workspace panel is hidden, the page's top corner keeps the
  window's buttons and a Workspaces button that shows the Workspace panel
  again. An icon appears next to the Workspaces button while a site uses
  your camera, microphone, or screen. A line along the top edge shows the
  page loading, and a site that asks for a permission slides the Workspace
  panel in until you answer. Press Tab to reach the toolbar's buttons, and
  the arrow keys to move between them.
- **Select several rows.** ⌘-click (Ctrl-click on Windows and Linux) rows to
  select them, or Shift-click to select every row in between. You can then
  close the selected tabs, move them to a group or a Workspace, make a new
  group from them, or drag them all at once.
- **Closing a tab goes back.** When you close the tab you're looking at,
  Sval shows the tab or pin in the same Workspace that you looked at
  before. Close that tab too, and Sval goes back one more step through the
  tabs and pins you've looked at in that Workspace.
- **Back from a new tab.** When a link opens a page in a new tab, Back
  closes the new tab and takes you to the tab or pin that holds the link.
  If you've followed links in the new tab, Back goes through those pages
  first.
- **Undo.** The bottom of the Workspace panel offers Undo for 8 seconds
  when you close several tabs or move a pin to Favorites. It does the same
  when you delete a group, a pin, or a Workspace. Undo puts back what you
  closed, deleted, or moved. ⌘Z (Ctrl+Z) does the same while neither the
  page nor a text field has focus. Closing a single tab shows no Undo.
- **Pins.** Pinned sites appear as a row of icons above your tabs.
  A pin keeps its page while you work elsewhere. When you close the pin,
  the pin goes back to its saved page, like a traditional bookmark. If a pin was
  the last thing you looked at in a Workspace, Sval opens on the pin when
  you go back to
  that Workspace or restart. Each Workspace has its
  own copy of a pin's page, signed in as that Workspace, and you can choose
  which Workspaces show a pin. Pin to This Workspace pins a tab to the
  Workspace you're in alone. To keep pins together, drag one pin onto
  another to make a pin folder, or right-click the pins row and choose New
  Pin Folder. A pin folder made from two pins shows in every Workspace
  either pin showed in. When you move a pin out of a pin folder and one pin or none
  is left, Sval removes the pin folder. A pin left over takes the pin
  folder's place. Move to Favorites in a pin's menu turns the pin into a
  Favorite.
  If the pin's page is open, the page becomes a tab at the top of your tabs.
  Undo puts the pin back in its old place, and the tab becomes the pin's
  page again. When you click a link
  in a pin that goes to another site, the link opens in a Quick Peek. You can preview the page there
  before deciding to open it.
- **Favorites.** Your bookmarks are in the Favorites menu, which opens
  from the Favorites button at the bottom of the Workspace panel. Pins are kept
  apart from Favorites, so a site can be a pin, a Favorite, both, or
  neither. Your pins also appear as tiles on the home page. To pin a
  Favorite, choose Pin in its menu. The pin is a copy, and the Favorite
  stays in your Favorites. On a pin's page, the Favorite button in the
  toolbar shows whether the page is in Favorites. Pressing the button
  never changes the pin. To add a tab's page
  to Favorites, or remove it, right-click the tab in the Workspace. Pins and
  Favorites sync along with your Workspaces and groups.
- **Split View.** Show up to four tabs side by side in a Split. To split, use
  a link's or a tab's menu, Alt-click (Option-click on a Mac) a second tab,
  or press ⌃+
  (Ctrl+Shift+Plus on Windows and Linux).
  Splits keep their sizes after a restart and sync to your other devices.
- **Quick Peek.** ⌥-click (Alt+click on Windows and Linux) a link to open
  it in a Quick Peek on top of the page. You can also choose Open Link in
  Quick Peek from the link's menu. A Quick Peek stays inside the window
  you're in. Press
  Escape or ⌘W (Ctrl+W on Windows and Linux) to close it, or keep it as a tab
  or a Split. To copy the page's address, select the Copy address button next
  to the address. You can keep a Quick Peek you opened from a pin only as a
  tab. To use ⌥⌘-click or ⇧⌥-click (Ctrl+Alt+click or Shift+Alt+click on
  Windows and Linux) instead, go to Settings › Keyboard shortcuts. You can
  turn Quick Peek off there or in Settings › Links.
- **Email an address on a page.** Select an email address that isn't a
  link, right-click it, and choose Email followed by the address. A new
  message to that address opens in the app or site you've chosen for email.
- **Rename a tab.** Choose Rename from a tab's menu, press F2, or
  double-click its name. The tab keeps your name as you browse, on every
  device. To show the page's title again, choose Remove Name from the tab's
  menu, or rename it with an empty name. The Launcher has Rename this tab
  and Remove this tab’s name for the tab you're on.
- **Copy a Markdown link.** Choose Copy Markdown Link from a tab's menu to
  copy its title and address as a link you can paste into notes or chat.
- **Copy a clean address.** Choose Copy Clean Address in the site settings
  menu to copy the page's address without the tracking parameters that
  sites add to links, like `utm_source`. Sval takes out only the
  parameters its tracking lists name and leaves the rest of the address
  alone. The pin next to Copy Clean Address puts its button in the address
  bar, and the Launcher has Copy clean address too. Press ⌘L (Ctrl+L) on a
  page, and the two buttons at the end of the Launcher's field copy the
  page's whole address or its clean one.
- **Put tabs to sleep.** Choose Put to Sleep from a tab's or a group's menu
  to free the memory its pages use. Sleeping tabs stay in the Workspace, dimmed,
  and wake when you select them.
- **Switch Workspaces without reloading.** The Workspace you leave keeps
  running, so when you come back its pages are where you left them. Sval
  puts its tabs to sleep once you've been away for three hours, or sooner if
  your computer runs low on memory. It doesn't put a tab to sleep while it's
  playing sound or holding text you typed.
- **Battery Saver.** When you unplug your laptop, Sval draws fewer frames
  on a fast screen, slows tabs in the background, and puts a Workspace to
  sleep 30 minutes after you leave it. While Battery Saver is on, a leaf
  button next to the address bar offers Turn Off for Now, which lasts until
  you next plug in or unplug. Tools › Battery Saver switches Battery Saver
  off or on the same way, and Settings › General sets when Battery Saver
  turns on.
- **Pause what's playing.** A pause button shows next to a tab, a collapsed
  group, or a Workspace in the switcher while it's playing sound. Click it
  to pause the video or music, and click again to play it. Point at it to
  see what's playing. Sound that can't be paused gets a mute button instead.
- **Media controls.** While anything plays, controls sit at the bottom of
  the Workspace panel. They control whatever played last in any of the
  window's Workspaces. The controls are back and forward 10 seconds,
  play/pause, and previous and next track on sites that have tracks.
- **Keep watching in Picture-in-Picture.** When you switch to another tab or
  Workspace while a video plays, the video keeps playing in a
  Picture-in-Picture window. Go back to the video's tab, and the window
  closes. This works for a video with sound that's at least 45 seconds long
  or live, and at least 140 pixels wide and tall. To turn it off, go to
  Settings › General and turn off "Keep playing videos in Picture-in-Picture
  when switching tabs".
- **Keep a tab awake.** Choose Keep Awake from a tab's menu, and Sval never
  puts it to sleep, however long you're away from its Workspace. Choose it
  again to let the tab sleep.
- **Downloads and History per Workspace.** Downloads and History show what
  belongs to the current Workspace, or everything. History opens next to the
  page. Remove a download
  from the Downloads list with its Remove from list button, or choose Clear
  list to remove every finished download it shows. A private window lists
  only the downloads you started in that window. When the window closes, Sval
  clears that list and cancels any download that hasn't finished, and the
  files you downloaded stay on your computer. To have
  Sval delete those files as the window closes, go to Settings › Privacy and
  protection and turn on "Delete files downloaded in a private window when
  that window closes".
- **Private windows.** Press Cmd+Shift+N (Ctrl+Shift+N). Each private window
  is its own session. A private window can't see another private window's
  cookies or site data. Nothing about its tabs is saved to disk, and Sval
  deletes the window's data when you close the window. Choices made there for a site last until the window
  closes, and Settings opened there can't change anything Sval keeps. When a
  tab showing a website crashes in a private window, Sval keeps no crash
  report of that crash.
- **Private window titles and notifications.** A private window's title
  never includes the page's title, so your taskbar or Dock and other apps
  don't show what you have open. Websites can't show notifications from a
  private window because a notification stays on your screen after the window
  closes. To allow notifications, go to Settings › Privacy and protection and
  turn on "Show website notifications from private windows".

## Address bar and Launcher

- **The Launcher.** Press ⌘L (Ctrl+L) to open the Launcher. As you type, it
  lists matching open tabs from every Workspace, pins and Favorites, Sval's
  commands, history, and search suggestions. A tab from another Workspace
  shows that Workspace's name and emoji in its color. You can reorder the
  sections and choose how many results each shows in Settings › Search and
  Launcher.
  With nothing typed, the Launcher and the home page's search field list the
  tabs you used most recently under Recent tabs. The sites you visit most
  follow under Frequent sites, except any you already have open in a tab.
  The address bar shows the Launcher's key at its right end when there's
  room.
- **Commands.** Type a few letters like "new wor" or "split" to run one of
  Sval's commands. Commands act on your Workspaces and the tabs and Splits
  in them, as well as the Workspace panel, site settings, and agents. Others
  open a Settings page or one of Sval's own pages like Downloads or
  Passwords, and some print or translate the page or restart Sval.
- **Choose where a page opens.** Enter opens it in this tab, and Shift+Enter
  opens it in a new tab. ⌘⇧Enter (Ctrl+Shift+Enter) opens it in a new
  window, and ⌥Enter (Alt+Enter) opens it in a Split next to this tab.
- **Open another Workspace in a new window.** In the Launcher, press
  Shift+Enter or Shift-click a tab from another Workspace to open that
  Workspace in a new window, showing the tab. If a window already shows
  that Workspace, Sval brings that window to the front with the tab
  selected. On a Workspace's "Go to" command, Shift+Enter or Shift-click
  opens that Workspace in a new window, as Shift-click does in the
  switcher.
- **Choose what the address bar shows.** In Settings › Appearance, you can
  show the site name, the site with its path, or the full address. The part
  after the site name is dimmed. When it doesn't fit, it drops whole parts
  from the left, so the end of the address, like a page number, stays in
  view. Some sites, like the Azure portal, put the page's path after a `#`.
  With Site and path chosen, the address bar shows that path too. Settings
  shows an example of each choice. When a site's name is too
  long to fit, the address bar and the Quick Peek bar cut it from the left too.
  The end of a site's name says whose site it is, like `google.com` in
  `accounts.google.com`. When a site's name starts with another site's
  name, the address bar still shows the real ending, so you can tell whose
  site you're on.
- **Your search on its results page.** On the results page of a search you
  made, the address bar shows what you searched for. Click the link button
  at its end to see the page's address, and click the search button there to
  bring your search back. The address bar turns over as it switches.
- **Loading line.** While a page loads, a line grows along the bottom of the
  address bar as the page comes in. Once the page has loaded, the line
  reaches the end and fades. Peek windows and the Quick Peek bar show the same line.
- **One search everywhere.** The search field on the home page, the address
  bar, and the Launcher all work the same way, whichever you start from.
- **Search with another engine once.** Your default engine's icon is at the
  start of the Launcher, the address bar, and the home page's search field.
  Select the icon to open a list of your engines, then pick an engine to
  search with it this time. The list also has Favorites, Tabs, History, and
  Actions. ⌥↓ (Alt+Down) in the field opens the list too.
- **Search with a keyword.** In the Launcher, the address bar, or the home
  page's search field, type a keyword, a space, and your search. For
  example, `@yt cats` searches YouTube for cats, and `@gh sval` searches
  GitHub. The engine's name shows at the start of the field, and Enter
  searches with that engine. Press Backspace in the empty field to search
  with your default engine again. Every search engine Sval comes with has a
  keyword that starts with `@`, so an ordinary search like "b vitamins"
  never picks an engine. Four of them search one site: `@yt` YouTube, `@gh`
  GitHub, `@w` Wikipedia, and `@maps` OpenStreetMap. The rest search the
  web: `@ddg` DuckDuckGo, `@sp` Startpage, `@br` Brave Search, `@kagi` Kagi,
  `@g` Google, `@b` Bing, `@eco` Ecosia, `@qw` Qwant, and `@pplx`
  Perplexity. You can also type the start of a keyword and press Space or
  Tab, so `@k` picks Kagi. Type `@` alone to see them all. You can also give an engine a
  keyword of your own, without the `@`, in Settings › Search and Launcher.
- **Reader View.** On an article, click the book button next to the address
  bar, or press ⌥⌘R (F9 on Windows, Ctrl+Alt+R on Linux), to read it in
  Reader View.
- **Reload menu.** Right-click the Reload button to reload, hard reload past
  the cache, or clear the site's cache and reload.
- **Narrow windows.** You can make a window narrow. As it narrows, the
  toolbar moves its buttons into the » menu one at a time, and they work the
  same from there. Split View goes first, then History, Downloads, Reader
  View, Favorite, the site controls, Home, Reload, and Forward. The
  Workspace panel button, Back, the address bar, and the privacy shield always stay.

## Links from other apps

- **Peeks.** When you open a link from another app, like Slack, Mail, or a
  terminal, the link opens in a Peek: a small window that isn't part of
  any Workspace. Read the page and close the Peek, or open the page as a tab
  in a Workspace. A
  Workspace you don't have open can open in a new window, so the window
  you're in stays on its Workspace. To open the page in a new window,
  Shift-click the Workspace in the Peek's menu.
  Installers and other files go straight to your downloads folder. When a
  page in a Peek downloads a file, a downloads button shows in the Peek, with
  a ring that fills in as the file downloads. In a
  Peek, the Launcher opens its tabs in your main window. The Launcher's
  commands for Settings, Downloads, History, Extensions, and Passwords open
  in your main window too. To reopen the Peek you closed last, press ⇧⌘T
  (Ctrl+Shift+T on Windows and Linux) in another Peek. A Peek you don't
  use closes after six hours. You can turn Peeks off, or change how long
  they stay open, in Settings › Links.
- **New Peek Window.** Press ⌥⌘N (Ctrl+Alt+N on Windows and Linux), or choose
  File › New Peek Window, to open an empty Peek for something you won't keep,
  like a video call. It's signed in as the Workspace you opened it from.
  Close it when you're done, and nothing is added to your Workspaces. Its
  page stays in History. A new Peek opens where you last closed one, at the
  same size.
- **Private Peeks.** A Peek you open from a private window is private and
  belongs to that window, so the Peek shares the window's sign-ins and saves
  nothing. You can open the Peek's page as a tab in that private window and
  nowhere else. When you close the private window, its Peeks close too.
- **Link Docking.** Dock a site's links in a Workspace. Add a rule in
  Settings › Links › Link Docking, and links to that site from other apps
  open as a tab in the Workspace you choose. Rules sync.

## Sval for iPhone

- **Tabs keep their history.** A tab you come back to still has its
  Back and Forward history and its place on the page, even after Sval
  ends. That holds whether you closed Sval from the app switcher, Sval
  crashed, or iOS closed Sval in the background. The iPhone app keeps your
  most recently used tabs and pins loaded, and saves every tab's history
  and place on your phone. Clear Browsing Data deletes that saved history.
  A private tab's history and place never reach your phone.
- **Switch tabs from the address bar.** Hold the address bar and slide to
  move through your tabs. The iPhone app shows a picture of each tab's page
  and of each pin's page you've opened.
- **Pull to refresh.** Pull down from the top of a page to reload the
  page.
- **Search suggestions.** As you type in the address bar, the iPhone app
  shows suggestions from your search engine, following the search settings
  you chose on your computer. A private tab gets no suggestions.
- **A page that keeps crashing.** When a page crashes three times within a
  minute, the iPhone app stops reloading it and shows Page cannot load.
- **Private tabs.** A link you tap in a private tab opens in Sval, even when
  another app on your iPhone could open that link.
- **Rearrange tabs in the grid.** You can drag a card in the Workspace
  sheet's grid at any time: hold the card and start moving before the
  card's menu opens. Drop the card on another card's middle to make a group
  or a Split with that card. Rest still at a card's side, between two rows,
  or at the screen's edge next to a card, and the cards move apart to make
  room.

## Sync

- **No account.** Sval syncs through any folder you choose. That can be a
  cloud folder like iCloud Drive, Dropbox, or OneDrive, a network drive, or
  even a USB drive. Sval doesn't run a sync service, so your data stays yours.
  You can choose the folder you sync through or the "sval" folder inside it.
  Sval finds the same files either way.
- **End-to-end encrypted.** Everything in the folder is encrypted with a key
  that only your devices have. Your cloud provider can't read any of it.
- **What syncs.** Sval syncs your tabs, Workspaces, groups, Favorites,
  history, and settings, including your choices for each site and your
  blocking setup. Sval sends new history to your sync folder at most once
  every 10 minutes, so new history reaches your other devices later than your
  tabs do. When you delete history, Sval removes it from your sync folder at
  the next sync.
- **Calls stay on one device.** While a tab is in a call, using your
  camera, microphone, or screen, Sval keeps that tab off your other devices,
  so you can't end the call from another device. The tab syncs again when
  the call ends.
- **The tab you're looking at stays open.** If you close a tab on one device
  while another device shows it, the other device keeps the tab open. The
  tab then comes back on the device where you closed it. The same goes for a
  tab with a video in picture-in-picture.
- **Adding a device.** When you first set up Sval, it asks whether this is
  your first time using Sval. If you use Sval on another device, choose the
  folder that device syncs to. If Sval asks for a code, type the code that
  device shows. To add a device later, go to Settings › Sync and devices ›
  "Sync with another device", which walks you through a one-time code. While Sval waits for the other device, you can
  cancel and type the code again.
- **Back up your sync key.** Sval offers to back up the key when it makes
  it. If you lose every device, set up Sval on a new one, choose your sync
  folder, and select "Restore with your backup key". Your Workspaces come
  back from the folder.

## Import and export

- **Keep Firefox.** You can run Sval and Firefox at the same time. Sval keeps
  its own data, settings, and extensions. Sval doesn't read or change
  Firefox's unless you import from Firefox. Sval's program file is `sval`
  (`sval.exe` on Windows). The name of each of Sval's helper programs starts
  with `sval-`. These names let Task Manager, `ps`, and `killall` tell Sval
  apart from Firefox.
- **Import** from Chrome, Edge, Brave, Vivaldi, Arc, Dia, Safari, Orion,
  Firefox, Zen, or any bookmarks file. Sval brings over your open tabs,
  bookmarks (as Favorites), and history. From Dia it brings bookmarks and
  history only, because Dia encrypts its open tabs.
- **Quit a browser first.** Sval can't import from Arc while Arc is open. On
  Windows, it also can't read the tabs open in Chrome, Edge, Brave, or Vivaldi
  while that browser is running. The import page tells you which browser to
  quit, then you try again.
- **Profiles become Workspaces.** Each browser profile you import becomes its
  own Workspace, and you can make any of them an isolated Workspace with its
  own sign-ins. Arc and Zen Spaces, Vivaldi and Edge Workspaces, and Safari
  Tab Groups each become a Workspace too. Arc and Zen Spaces keep their color
  and emoji, Vivaldi Workspaces keep their emoji, and Edge Workspaces keep
  their name and color.
- **Tab groups stay grouped.** Tab groups from Chrome, Edge, Brave, Vivaldi,
  Firefox, and Zen become groups with their colors. So do Vivaldi's tab
  stacks. Arc and Zen folders become groups too.
- **Arc's export file.** If you no longer have Arc installed, choose
  "Import a bookmarks file…" and pick the `Arc Data Export.md` file Arc
  exported. Each Space arrives as a Workspace with its folders and tabs.
- **Arc and Zen pins and Splits.** Arc's Favorites and Zen's Essentials become
  pins, and their splits become Splits.
- **Arc's archived tabs.** Tabs Arc archived appear in History › Archived
  tabs, where you can restore them. A tab whose Space you imported goes back
  to that Workspace, and the rest go to the Workspace you're in. A tab you
  gave an emoji in Arc keeps it.
- **Your Sval Card.** To see your card, choose View › Your Sval Card,
  select Your Sval Card at the bottom of the Settings sidebar, or select your
  card in About Sval. Your card has
  a title and a star for every year you've browsed with Sval. The card shows
  the day you started with Sval and the date of your next star. Next to your
  card, Sval shows how many Workspaces, open tabs, Favorites, pins, and rules
  in My filters you have. Sval also shows how many devices have synced, and
  how many trackers and ads Sval has blocked on this computer. To keep a
  copy, select Save image, and Sval saves your card as a PNG in your
  downloads folder. Your card is the same on every device you sync. When you
  import from Arc and Arc gave you a card, your card keeps the title Arc gave
  you. Your Arc years come first, each drawn in your Arc card's shape. Sval
  mentions Arc on your card only when you have an Arc card.
- **Passwords.** Sval isn't a password manager, because there are better tools
  for that. Sval works with common password manager extensions, and it shows
  you how to export your passwords from your old browser so you can import
  them into one.
- **Export.** You're in full control of your data. If you want to leave Sval,
  you can export your Workspaces and Favorites in a format your new browser
  imports, including Opera. Safari can take your history too. You can also save everything Sval holds as one plain JSON file.

## Privacy and blocking

- **No telemetry.** Sval sends no usage data and runs no studies or
  experiments. It never contacts advertisers, trackers, or account servers. A
  new install contacts only these services, each for a reason:
  - **Sval's update server** (`download.sval.app`), once a day, to check for
    updates. It sends only your release channel and platform.
  - **The publishers of your blocking lists**, to keep ad and tracker blocking
    up to date.
  - **Mozilla's Remote Settings**, for security and compatibility data: revoked
    certificates, blocked malicious extensions, tracking protection lists,
    cookie banner rules, and fixes for sites that break.
  - **addons.mozilla.org**, to check for updates to your extensions.
  - **Google Safe Browsing**, to warn you before you open a phishing or
    malware site. Sval downloads lists of dangerous sites and checks
    addresses on your device. When an address matches, Sval sends Google a
    short fragment of a hash to confirm it, never the address itself.
  - **Your search engine**, for suggestions as you type in the address bar.
    DuckDuckGo is the default.
  - **Cisco's OpenH264 codec**, once per release, so video calls work on sites
    that use H.264. Cisco has to distribute it for licensing reasons.
  - **Mozilla's Web Push service**, only if you allow a site to send you
    notifications, so those notifications can reach you.

  Sval contacts Kagi, encrypted DNS, DRM services for streaming video, and
  Sval's feedback server only once you choose to use them.
- **Ad and tracker blocker.** Choose No Blocking, Balanced Blocking, Strict
  Blocking, or Custom to make your own lists. Out of the box, Sval uses open-source lists.
- **A warning before sites that aren't secure.** HTTPS-Only Mode is on by
  default. Sval opens the secure version of every site that has one. When a
  site has none, Sval shows a warning first, and you choose whether to open
  it. From the Privacy and Security button, you can let a site always open
  without the warning, and that choice syncs to your other devices.
- **Tracking parameters are stripped.** At every level except No Blocking,
  Sval strips tracking parameters from the addresses you open. Sval takes
  the parameters from Mozilla's list and from the parameters the blocking
  lists in use strip on every site, so the parameters change when those
  lists update.
- **Hidden trackers are blocked too.** Some sites load a tracker from an
  address on their own domain, with a DNS record called a CNAME that points
  the address to the tracker's servers. Hiding a tracker this way is called
  CNAME cloaking. Blocking lists match a request by its address, so they miss
  a cloaked tracker. When the blocker is on, Sval looks up the DNS record of
  each request that your lists didn't already block. Sval skips the page
  itself and requests to the page's own address. If the address points to
  another site, Sval checks that site against your lists before it
  connects. Sval needs that lookup to connect anyway, so the check contacts
  no extra servers. This check is called CNAME uncloaking. When you use a
  proxy, Sval skips this check.
- **Fingerprinting protection** is on by default, and you can turn it off for
  individual sites.
- **Mozilla's fixes are off.** Mozilla publishes a list that weakens
  protection on Google's and Bing's sites, so they can recognize your device
  more easily. Sval keeps full protection on those sites too. To use
  Mozilla's fixes, turn on Mozilla's compatibility fixes in Settings ›
  Privacy and protection › Fingerprinting › Advanced › Compatibility.
- **You decide where Mozilla's fixes apply.** When you turn on Mozilla's
  fixes, the Privacy and Security button shows fingerprinting protection as
  off on a site they cover. Turn it on to keep full protection on that site,
  on all your devices. While the fixes are on, private windows use them on
  every site they cover.
- **Privacy and Security button.** The button next to the address shows
  whether Sval is protecting the site and warns you when the connection isn't
  secure. A number on it shows how many trackers and ads Sval blocked, and
  fingerprinters it foiled, on the page. Click it to see the site's
  certificate, or find out whether the site had a recent data breach (from
  Have I Been Pwned).
- **Site controls.** With one click you can control a site's video and audio,
  turn its JavaScript on or off, or turn its camera and microphone access on
  or off. Change a permission there, and the page reloads when you close the
  menu so the change takes effect. You can also clear the site's cookies
  and data in the site settings menu.
- **Camera and microphone.** When a site asks to use them, choose Allow,
  Always allow, or Block. While a site uses them, you can mute either one
  from the address bar or the site settings menu, and unmute it without
  the site asking again.
- **Choices for one address or the whole site.** On an address like
  `nas.example.com`, the site menu, the Privacy and Security button, and the
  extensions menu start with choices for that address alone. Pick "All of
  example.com" at the top to make the choice for every address on the site.
  An address keeps the choices it made for itself. The JavaScript button and
  the Launcher's JavaScript commands change the address you're on.
- **Video and audio per site.** Choose Always allow, Ask first, or Always
  deny, for every site or for individual sites. On Ask first, nothing plays
  until you allow it. When a page tries to play, Sval asks once a visit.
  You can choose Allow for this visit, Always allow, or Don't allow for this
  visit. If you close the question, the media button stays lit, and a click
  on it plays the page's video and audio for this visit.
  On Ask first, you can also press the video's play button. The video
  plays, and Sval allows the page's video and audio for this visit. That
  works with the play buttons on YouTube, Vimeo and a video's own
  controls. A click that starts a video later, like a click on a
  thumbnail, doesn't allow media.
- **JavaScript per site.** Turn JavaScript on or off for individual sites, or
  turn it off everywhere and make exceptions.
- **Keep links in this tab.** In the site settings menu, stop a site from
  opening its own pages in new tabs or windows. A link to another site still
  opens a new tab, and so does a Command-click or Ctrl-click. The choice
  syncs, the iPhone app included.
- **Zoom per site.** The site settings menu shows the site's zoom level. A
  slider sets it one step at a time, and Reset puts it back.
- **Location.** When a site asks for your location, a location button
  shows next to the site controls, and you answer from there. While the site
  uses your location, the button stays lit. Click it to block location on
  that site. If the site is blocked from your location, or you choose Block,
  the button stays crossed out until you leave the page. Click it to allow
  location on that site. Either click reloads the page.
- **Translate a page.** When a page is in a language other than yours, a
  Translate button shows next to the site controls. Click it to translate the
  page on your device. The button shows your language's code while the page
  is translated.
- **Blocked embeds ask first.** When blocking stops an Instagram, TikTok, X,
  or Disqus embed, you see a placeholder. The embed loads only if you allow
  it.
- **Remove or snip part of a page.** Point at something on a page, like a
  cookie notice or an annoying ad banner, and remove it. "Remove from this
  site" saves a rule that keeps it hidden on that site. "Snip" removes it
  until you reload. On an address like `nas.example.com`, you choose whether
  to remove it there or on all of `example.com`. If the box that asks covers
  what you want to see, drag it by its edge. On an address, the site menu
  lists the removal rules for the whole site too. You can turn off a rule
  for the whole site on that address alone, or turn it back on. When you
  change a rule, the tab reloads.
  Removals are yours, so they stay removed even when you turn off ad blocking
  or a site's protections. You decide what shows up on your screen. A number on
  the eraser counts the rules removing something on the page right now. A
  number on the scissors counts what you snipped. If you haven't pinned them,
  the number shows on the Site settings button.
- **Colorshift.** Colorshift changes how a site looks for you, and the
  site looks that way every time you visit. Your changes are kept per site
  and sync to all your devices. Choose Colorshift This Site… in the site
  settings menu or on the menu you get when you right-click the page or a
  tab, or Colorshift this site in the Launcher. You can also give
  Colorshift this site a key in Settings › Keyboard shortcuts. Colorshift
  opens over the page, and you can drag it by its title.
  The page shows each change as you make it.
  - **Color wheel.** Drag the big dot to tint the page: its direction picks
    the color, and its distance from the middle sets how strong the tint
    is. Light colors, like the background, take the big dot's color. The
    small dot picks the color the page's text and other dark colors take.
    The tint keeps text readable against its background. With the big dot
    in the middle, the page has no tint.
  - **Contrast, Brightness, and Saturation.** Each slider changes the
    page's colors, and its middle leaves them as they are.
  - **Theme.** Automatic lets the site follow Sval's own light or dark
    theme. Light and Dark ask the site for its own light or dark theme.
    When the site has none, Sval turns the page light or dark and leaves
    pictures and videos as they are.
  - **Font.** Pick a system font, serif, monospace, or an easy-to-read
    font installed on your computer. Original keeps the site's own font.
  - **Save.** Sval keeps your changes for the site and closes Colorshift.
  - **Cancel.** The page goes back to how it looked when you opened
    Colorshift, and Colorshift closes. Close and Escape do the same.
  - **Reset.** Every control goes back to the setting that leaves the
    site as it is, and the page shows the site's own look. Colorshift
    stays open. When the site has a saved Colorshift, Save then removes
    it, and Cancel keeps it.

  You can open the site settings menu while Colorshift is open. On an
  address like `nas.example.com`, you choose whether the changes cover that
  address or all of `example.com`. The pin on the Colorshift row in the
  site settings menu puts a Colorshift button in the address bar. The
  button opens Colorshift, and it stays lit while Colorshift is open. When
  a site has a saved Colorshift, a dot shows on the Colorshift button if
  you pinned it. Otherwise the dot shows on the Site settings button,
  unless that button shows a count. The Colorshift row in the site settings menu carries the same
  dot and lists what the Colorshift changes, such as "Blue tint, dark
  theme, serif font". Private windows show your changes, but you can't open
  Colorshift there. The color wheel comes from Zen Browser's Boosts.
- **Per-site controls.** Settings › Sites lists every site you've made choices
  for, including the extensions you turned off or on for a site and a site's
  saved Colorshift. Each site has its own page for its permissions,
  JavaScript, removed elements, Colorshift, and stored data. The Colorshift
  card says what the saved Colorshift changes, and Remove deletes that
  Colorshift. Reset on a site's row clears the site's choices, extension switches and Colorshift included.
  Forget this site clears everything Sval keeps for the site. In Defaults,
  at the top of Settings › Sites, you set what every site gets until you
  make a choice for that site. Defaults covers JavaScript, video and audio,
  and each permission, with the same choices and controls as the site menu.
- **Choices for one address on a site.** A choice can cover one address,
  like `nas.example.com`, or all of `example.com`. Settings › Sites lists an
  address with its own choices under its site. The address's Reset puts
  back only that address's choices. On the site's page, "Choices for" picks which
  address you're changing, and Add an address adds another. An address takes
  everything else from its site.
- **Secure DNS** and **Global Privacy Control**, which tells sites not to sell
  or share your data.

## Search

- **Your search engine.** Pick one when you first set up Sval. DuckDuckGo is
  the default. You can also choose Kagi, Startpage, Brave Search, Ecosia,
  Qwant, Google, Bing, and others. No search engine pays to be Sval's default.
- **Kagi support.** Sign in during setup or in Settings › Search and
  Launcher. Private windows search with Kagi's Privacy Pass, which proves
  you're a subscriber without revealing who you are. The iPhone app's
  private tabs search with Privacy Pass too, once you've signed in to Kagi
  in a normal tab on the iPhone.
- **Add your own.** Add your own search engine if the one you want isn't
  listed.

## Passwords

- **Your password manager.** Your passwords stay where you already keep them,
  and Sval never holds a copy. Pick your password manager during setup, or
  later in Settings › Privacy and protection › Password manager, and Sval
  installs its extension. Your choice stays on that device and doesn't sync.
- **Desktop app connections.** Some extensions talk to an app on your
  computer, such as a password manager's desktop app that unlocks with Touch
  ID or Windows Hello. Sval keeps these connections in its own folders, apart
  from Firefox's. If an app only sets itself up for Firefox, you can copy its
  connection file to Sval
  ([how to connect an extension to a desktop app](native-messaging-hosts.md)).
- **Passkeys and security keys.** Sites can use passkeys and hardware security
  keys. On macOS and Linux, Settings › Privacy and protection › Manage
  security keys opens the security key manager, where you can set a
  key's PIN, manage its passkeys, and add fingerprints.

## Extensions

- **Firefox extensions.** Sval runs extensions from addons.mozilla.org.
- **Full-strength ad blockers.** Chrome has turned off Manifest V2 extensions,
  and its Manifest V3 takes away an extension's ability to inspect and block
  each request before it's sent. Blockers there are limited to a fixed set of
  rules the browser applies for them, so uBlock Origin no longer runs on
  Chrome. Sval, like Firefox, runs both Manifest V2 and V3 extensions and
  keeps that ability in both, so uBlock Origin and other blockers work at
  full strength.
- **Settings › Extensions** lists every extension with an on/off switch. Each
  extension has a page for its permissions, private windows, and options.
- **Extension buttons for a page.** Some extensions offer a button only on
  pages they can act on, like a feed reader on a page with a feed. The
  extensions button shows a dot when a page has one, and the button is on
  that extension's row in the extensions menu.
- **Extension updates wait a week.** An extension you trust can change hands
  or start doing harm through an update. Sval waits 7 days before installing an
  extension update. The wait gives Mozilla time to find a harmful update and
  turn it off before it reaches you. You choose the number of days in
  Settings › Extensions, and 0 installs updates right away. Your other
  devices use the same number. An extension's page shows an update that's
  waiting, and you can install it at once with Update now.
- **Turn an extension off on a site.** Each extension in the extensions menu
  says what the extension can do on the site you're on, such as read and
  change the site's pages. Each extension also has a switch for that site. On an address like
  `app.fastmail.com`, the switch starts on that address alone, and the "Run
  on" line at the top of the menu lets you pick the whole site. When you turn
  it off, the extension
  can't read or change the pages in tabs showing that site. It can't read or
  change that site's cookies either. An extension allowed to see your tabs
  still sees the addresses you visit on that site. When the switch covers
  one address, like `app.fastmail.com`, the extension can still read and
  change the cookies the whole site shares, such as a sign-in to
  `fastmail.com`. It can also still see and change the requests sent by
  that address's background workers. It works as before everywhere else. An extension's page in Settings lists the sites
  where it's off, and you can add one there. A site's page lists the
  extensions that can reach it, each with its switch. Your switches reach
  your other devices. Private windows don't show the switch, and Settings
  opened in one shows it without a way to change it.
- **Themes and container extensions.** Sval draws its own colors and has no
  containers, so it refuses to install themes and extensions that use
  containers. It turns off any container extension you already have.
- **Pin extensions from the extensions menu.** Each extension in the menu
  has a pin. Pin an extension to put its button on the toolbar. The
  extension stays listed in the menu, where you can unpin it.

## Agents

- **Bring your own AI, or none.** Sval has no built-in AI. If you want an
  assistant, the one you already use
  can work with Sval, under your rules.
- **Let AI apps use the browser.** Turn on agent access in Settings. AI apps
  on your computer can then drive Sval: Claude Code, Claude Desktop, the
  ChatGPT desktop app and Codex, Cursor, and Mistral Vibe. Connect sets an app up in one click. When an
  app points to a Sval that isn't on your computer anymore, Settings › Agents
  says so, and Fix points the app to the Sval you're using.
- **Approve an app once.** You allow an AI app like Claude Code one time, and
  every session of it can use Sval after that, from any folder. If Sval asks
  you to approve the app again, the question says that the app keeps the
  permissions and Workspaces you gave it.
- **Each session gets its own Workspace** in its own window. The window opens
  behind yours, so an agent never steals your focus, and the agent sees only
  its own tabs. When you resume a conversation, the agent can go back to the
  Workspace it used before, with its tabs still there. Deleting an agent's
  Workspace leaves the app approved.
- **Find each session's Workspace.** Sval lists agent Workspaces under each
  app in the switcher above your tabs, the Workspaces menu in the menu bar,
  and Move to Workspace. Each app's list starts with the Workspace used most
  recently. Each agent Workspace shows its task, the folder the agent ran
  in, the model, and when the Workspace was last used. An agent's window
  shows the agent's task as the Workspace's name. From the Workspace's menu,
  you can stop or resume the agent there, open the app's permissions in
  Settings › Agents, or delete the Workspace.
- **See which app and model each agent uses.** An agent Workspace on your
  computer or phone shows its app's icon, for apps like Claude Code, Codex,
  and LM Studio. Sval shows a robot for an app it doesn't know. The switcher,
  the Workspaces menu, Move to Workspace, and the strip list each app's
  Workspaces with the icon of the model its agent named, like Claude, GPT,
  or Llama. A Workspace whose agent named no model Sval knows shows no
  model icon. On the strip, an app with more than one Workspace has one
  icon with a count that you click to choose one of the app's Workspaces.
- **Unused agent Workspaces clean themselves up.** Sval deletes an agent's
  Workspace once no session has used it for 30 days. You can choose 7 or 90
  days, or Never, in Settings › Agents.
- **Unpair an app, and its Workspaces with it.** When you unpair an app in
  Settings › Agents, Sval offers to delete its Workspaces and their tabs too.
  A Workspace you keep is cleaned up like any other agent Workspace.
- **Your sign-ins, or none.** You decide how much of your online life an
  agent can reach. It can use your sign-ins, so it can work in your accounts
  for you without ever seeing your passwords. Or it can work in an isolated
  Workspace that starts signed out, so it can't reach your accounts at all.
- **Your approval on agent actions.** Sval asks you before an agent visits a
  new site, sends something it typed, or uploads or downloads a file. Sval
  also asks before an agent opens an app or connects to a device on your
  local network. Answer once, or set a
  rule for the site. A rule for uploads covers the folders you choose. Sval
  always asks before it uploads a hidden file from those folders, or any
  file inside a hidden folder, like the keys and passwords your home folder
  keeps. On an address like `nas.example.com`, you choose
  what the rule covers. It can cover only that address or all of
  `example.com`. Each
  agent has a page with its rules in Settings › Agents. The page lists each
  site with a rule and says what the rule changes, and selecting a site
  opens its settings. Sval knows a device
  is local from its address, or from a name like `localhost`,
  `printer.local`, or `nas`. A public name that points to your network
  counts as a site on the internet.
- **Choose how long an agent waits for you.** When Sval asks you about an
  agent's request, the agent waits for your answer. You choose how long it
  waits in Settings › Agents.
- **Let an agent read a site's console.** An agent can read the messages a
  page writes to its developer console, including its errors, to help debug a
  site. Sites sometimes write account details or what you type there, so Sval
  asks you the first time an agent wants a site's console. Sval remembers
  your answer for that site and that agent, and you can change it in
  Settings › Agents.
- **Hand a tab to an agent.** Right-click a tab or a group, and choose Move
  to Workspace. Under Agent Workspaces, choose the agent's app, then the
  agent's Workspace. Sval asks first, and says whether the agent gets your
  sign-ins with the tab. Once you agree, the tab moves to the agent's
  Workspace, and the agent can read it and act in it. The agent can't go
  back to pages you visited earlier in the tab unless you choose to include
  them.
- **Take control.** Pause an agent at any time, use its tabs yourself, then
  hand them back. Until you take control, your input stays out of the
  agent's tabs. Your media keys play and pause your own media, and the
  agent's pages get no input from a game controller and open no
  Picture-in-Picture window. Settings opens in one of your own windows, even
  from the menu bar of the agent's window.
- **Camera, microphone, screen, and location in agent tabs.** When a page in
  an agent's tab wants your camera, microphone, screen, or location, Sval asks
  you, even on a site you always allow. The question waits until you press
  Take control. It offers no answer for Sval to remember. A site you blocked
  stays blocked.
- **Leave an agent's window.** While an agent is in control of its window,
  choose one of your Workspaces from the Workspaces menu in the menu bar, and
  it opens in a new window. The agent keeps its window.
- **Agents close their windows.** When an agent finishes a task, Sval asks
  the agent to close its window. The agent's Workspace keeps its tabs. The
  window opens again when the agent opens a tab or acts in one.
- **Stop an agent.** Press Stop agent in the agent's window, and the agent
  can't do anything in that Workspace until you press Resume. The app's other
  sessions keep working. Sval tells the agent that you stopped it, and ends
  what it was doing. The agent stays stopped after you restart Sval.
- **Show an agent a link.** When you open a Quick Peek in an agent's window,
  the agent can also read and use the Quick Peek.
- **Site tools for agents (WebMCP).** A website can offer agents direct
  actions, like searching its catalog or adding an item to a cart. An agent
  calls the action instead of clicking through the page. Calling the action
  is more reliable and faster than clicking. Site tools are off until you turn them on, work only in an
  agent's Workspace, and each call needs the same approval as a click.
- **Known gaps.** An agent's screenshots show links you've visited in their
  visited color, as your own screen does. A page can show an agent a list of
  links and tell it to type back the ones its screenshot shows as visited.
  That includes sites you visited in your other Workspaces. For up to 5
  seconds after an agent's last click or key press, a page in the agent's
  tab can still write to your clipboard. The page can do this even if you
  take control or turn off agent access in those 5 seconds.

## Keyboard shortcuts

Settings › Keyboard shortcuts lists every shortcut. You can change a
shortcut there when its row has a Change button. Menus show the shortcut
next to each command that has
one, including the menus you open by right-clicking a tab, a page, or a text
field. A website can't take over Sval's own shortcuts, even one you changed.
Websites still get copy, paste, cut, undo, select all, find, and save, because
web apps like editors handle those themselves. On a Mac, websites also get ⌃Z,
so a terminal in a web page can use it.

- **Show or hide the Workspace panel:** ⌃Z (Ctrl+Alt+Z on Windows and Linux).
  When the hidden Workspace panel has slid in from the edge of the window,
  the same keys keep the Workspace panel showing.
- **Launcher:** ⌘L (Ctrl+L, or Alt+D on Windows and Linux).
- **New Peek Window:** ⌥⌘N (Ctrl+Alt+N).
- **Open a link in a Quick Peek:** ⌥-click (Alt+click). You can change it to
  ⌥⌘-click or ⇧⌥-click (Ctrl+Alt+click or Shift+Alt+click). Either click
  then opens a Quick Peek where it would otherwise open a new tab or window.
  ⌘-click, ⇧-click, and middle-click can't open a Quick Peek, because they open
  new tabs and windows. On Windows and Linux, those clicks are Ctrl+click,
  Shift+click, and middle-click.
- **New private window:** ⇧⌘N or ⇧⌘P (Ctrl+Shift+N or Ctrl+Shift+P).
- **Copy Address:** ⇧⌘C (Ctrl+Shift+C) copies the address of the page
  you're viewing. The Inspector in the developer tools opens with ⌥⌘C on
  macOS, and with Ctrl+Shift+I on Windows and Linux.
- **History:** ⇧⌘H (Ctrl+H) shows or hides History. **Show history:** ⌘Y
  (Ctrl+Shift+H).
- **Add to Favorites:** ⌘D (Ctrl+D). **Show Favorites:** ⇧⌘O (Ctrl+Shift+O).
- **Pins:** ⌘1 to ⌘9 (Ctrl+1 to Ctrl+9 on Windows, Alt+1 to Alt+9 on Linux).
  Hold ⌘ to see the numbers.
- **Split View:** ⌃+ (Ctrl+Shift+Plus on Windows and Linux). When a Split's
  row in the Workspace has focus, Alt+← and Alt+→ move its pane.
- **Recent tabs:** ⌃Tab (Ctrl+Tab) switches to the tab you used last in this
  Workspace. With three or more tabs and opened pins in the Workspace, keep
  holding ⌃ (Ctrl) and a grid opens over the page with all of them, the most
  recently used first. Sval remembers that order when it restarts.
  The grid has a heading that names the Workspace, and a footer that shows
  some of the keys you can press and what each one does. Each tab whose page
  has loaded since Sval started shows a picture of that page, even once Sval
  puts the tab to sleep. A tab whose page hasn't loaded since then shows its
  icon and site. A pin's page shows the pin icon, and a tab in a group shows
  the group's name in its color. Press Tab or the arrow keys to choose a tab,
  then let go of ⌃ (Ctrl) to switch to it. Clicking a tab in the grid switches
  to it too. While the grid is open, ⌃\` (Ctrl+\`) moves the choice back one
  tab, as ⌃⇧Tab (Ctrl+Shift+Tab) does. Here \` means the key above Tab,
  whatever character that key shows. With the grid closed, the page gets ⌃\`
  (Ctrl+\`). Escape closes the grid and keeps you on the tab you're on. ⌃W
  (Ctrl+W) or Delete closes the chosen tab. Sval keeps the pictures in memory
  and never saves them to disk. While the grid isn't open, ⌃⇧Tab
  (Ctrl+Shift+Tab) goes to the previous tab in the Workspace. You can turn off
  recently used order in Settings › Keyboard shortcuts, and ⌃Tab (Ctrl+Tab)
  then goes to the next tab in the Workspace.
- **Swipe to switch Workspaces:** swipe sideways with two fingers over the
  Workspace panel, or scroll sideways with your mouse. The window goes to the
  next or previous Workspace in the switcher's list. Hold Shift to scroll sideways
  with your mouse's main wheel. Each swipe moves the window by one
  Workspace. A swipe skips device Workspaces and Agent Workspaces. If another window already shows
  the Workspace you swipe to, Sval brings that window to the front. Past
  your last Workspace, a swipe goes to your first, and before the first it
  goes to the last. A swipe over the page still goes back or forward. You
  can turn off swiping between Workspaces in Settings › Keyboard shortcuts.
- **In the Workspace:** the arrow keys move between rows and open groups. Type to
  jump to a name, F2 renames, Delete closes, and Alt with an arrow moves a
  row. Shift with an arrow selects more rows, Ctrl+Space selects or deselects
  a row, and Escape clears the selection.
- **F6 and Shift+F6** move between the address bar, the Workspace panel, and the page.
- New Workspace, separating a Split, Remove from this site, Snip, and
  Colorshift this site have no key until you give them one.

## Developer experience

- **Labeled console messages.** The Web Console and Browser Console label
  each message as coming from the page, an extension, or Sval, and you can
  filter by each.

## Updates

- **Updates tell you once.** When an update is ready, Sval opens a message
  under the header's notices button asking you to restart. The message
  stays open until you click the notices button or one of the message's
  buttons. It won't open again by itself for that update. The notices button stays until you
  restart, so you can find the message later.
- **Another copy of Sval holds an update.** While another copy of Sval
  runs from the same place, the message asks you to close the other copy, or
  to update and restart anyway. Once the other copy quits, the message
  turns into the usual restart message within 10 seconds.

## Troubleshooting and data collection

- **A log that leaves out your browsing.** Sval writes warnings and errors to
  `sval-log.txt` in its data folder. The log never includes a Workspace,
  group, or tab name, a URL, or a secret.
- **Send Feedback.** Click the chat button at the bottom of the Workspace
  panel, choose Help › Send Feedback…, or click Send Feedback… in About Sval
  to open a form. It lists everything the
  report would include, and you can view or uncheck each part. Nothing in it
  identifies you unless you choose to add your email.
- **Record Performance.** When Sval is slow, select Help › Record
  Performance or the Record Performance button in `about:support`. Keep
  using Sval until the slowness shows. Select Save Performance Recording,
  and Sval saves the last minute as a file in your download folder. The
  button next to each process in `about:processes` records only that
  process for five seconds. Sval never sends the file anywhere. The file
  lists the web addresses of the pages you had open, so share the file
  only with someone you trust.
- **Crash reports.** Sval sends a crash report only if you check a box to
  send it. Sval doesn't add the address of the page you were on to a crash
  report. When a tab showing a website crashes in a private window, Sval
  keeps no crash report of that crash. While a private window is open, Sval
  also keeps no crash report when Sval itself or one of its background
  processes crashes. If Sval itself crashes while a private window is open,
  Sval closes without opening the Sval Crash Reporter dialog and doesn't
  restart.

## License

Sval's own code is under the GNU Affero General Public License 3.0 with the
Sval App Store Permission. Mozilla's code is under the MPL 2.0.
`about:license` has the full texts. Sval and Ellm Tree, Inc. are not
associated with Mozilla.
