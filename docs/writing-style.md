# Writing style

Sval has two kinds of writing, with different readers and different rules.

- **User-facing writing** is anything a person using Sval reads: UI strings
  (`.ftl`), `docs/features.md`, the README, release notes, error messages and
  dialogs. Its readers are technical and non-technical.
- **Internal writing** is comments, specs, decision records and other docs
  for people working on Sval. `CONTRIBUTING.md`'s "Comments" section holds its
  rules, and `scripts/check-comments.py` enforces the mechanical ones.

The rest of this page is about user-facing writing.

## Write the way people talk

Use plain US English, the way a person would explain the feature to a
friend.

- **Lead with who does what.** Start a sentence with its subject and verb.
  Don't put a list of nouns first and say what happens to them after a comma.

  | Instead of | Write |
  |---|---|
  | Workspaces, their tabs and groups sync to your other devices. | Your workspaces sync to your other devices, along with their tabs and groups. |
  | Tabs in a group, playing sound or holding typed text stay. | Sval never archives a tab that's in a group, playing sound, or holding text you typed. |

- **Write full sentences.** A bullet's bold label can be a short name, and
  the text after it is made of sentences.

  | Instead of | Write |
  |---|---|
  | **Favorites.** Your bookmarks, in the panel's Favorites menu. | **Favorites.** Your bookmarks are in the Favorites menu, at the top of the Workspace panel. |
  | **Video and audio per site.** Always allow, Ask first or Always deny, for one site or every site. | **Video and audio per site.** Choose Always allow, Ask first, or Always deny for a single site or for every site. |

- **Address the reader as "you"**, and use contractions: "you're", "don't",
  "can't".
- **Use everyday words.** "Next to" over "beside", "bottom" over "foot",
  "when you first set up Sval" over "first run", "check" over "tick",
  "use" over "utilize" or "leverage", "lets you" over "allows you to".
- **US spelling and punctuation:** color, favorite, license, labeled,
  organize. Use the Oxford comma: "work, home, and other projects".
- **Capitalize Sval's feature names** in the UI and the docs: Workspace,
  Peek, Quick Peek, Launcher, and Split. Capitalize the noun that names the
  feature or the thing ("a Split", "this Workspace", "open in a Quick
  Peek"). The verb stays lowercase ("split them").
- **Peek and Quick Peek are two features.** A Peek is the small window a
  link from another app opens in. A Quick Peek shows a link over the page,
  inside a window of Sval's. Name the one you mean, and never use "peek" as
  a verb, since it doesn't say which: "open a link in a Quick Peek".
- **Name things the way the UI names them**, and give the path to a setting:
  Settings › Links.
- **Say exactly what you mean.** No "this" or "them" without a clear noun
  before it, and no internal names, pref names or jargon a user wouldn't
  know.
- **Repeat the noun only when "it" is unclear.** When "it" could point to
  two things, or a sentence piles them up, name the thing again. Don't chain possessives either: "the
  pin's saved page's address" is two sentences.

  | Instead of | Write |
  |---|---|
  | Its parts are listed here from top to bottom, then its menus and settings. | This page goes through the Workspace panel from top to bottom, then its menus and settings. |
  | **Save current page as this pin** makes the page it shows its saved page. | **Save current page as this pin.** From now on, the pin goes back to this page. |

- **Make the reader's thing the subject.** Start a page with what the
  reader works with, like a Workspace, a tab, or a site. The control that
  shows it comes second.

  | Instead of | Write |
  |---|---|
  | The panel runs down one side of the window and holds the tabs of the Workspace the window shows. | Your tabs, groups, and Splits live in a Workspace, listed down one side of the window. |

- **Tabs live in the Workspace.** Tabs, groups, Splits, and pins are in
  the Workspace, and the writing says so: "in the Workspace", "your
  Workspace's tabs". "Panel" is the Workspace's sidebar itself, for its
  edge, its side, or hiding it. Call it the Workspace panel, and never use
  "panel" in place of "Workspace".

  | Instead of | Write |
  |---|---|
  | A group keeps tabs together under one name in the panel. | A group keeps tabs together under one name in the Workspace. |
  | Drag the panel's edge to make it wider. | Drag the Workspace panel's edge to make it wider. |

- **Give a control's name as a label, then say what happens.** In a list
  of buttons or menu items, bold the name and end it with a period. The
  sentence after it says what changes for you. Don't run the name into the
  sentence as its subject.

## Lead with what the reader gets

- **The first sentence is the pitch.** Before any step or setting, say what
  the feature does for the reader in the one breath you'd use to tell a
  friend. On a feature's page, that's the "What it is" part.
- **Leave out what the reader will see anyway.** Sval's UI already shows what
  Cancel and Undo do, so the text doesn't say it. Give the detail a reader needs to act, and link to the page that
  holds the rest.
- **Leave out the edge cases** outside a page's Details, and put a limit
  where a reader would hit it.

## Let sentences flow

- **Join what belongs together.** Two facts about one thing make one
  sentence, joined with "and", "so", "which" or "because". Readers hear a run
  of short sentences as a list read aloud, and as generated text.
- **Vary the length.** Mix long and short sentences, so no four in a row
  share one length.
- **Make every comma and period earn its place.** A pause like the one in
  "Snip, the scissors button, removes" does no work, so write "The
  scissors button snips". A paragraph stopped every few words
  is tiring to read.
- **Keep a sentence to 30 words or fewer**, with no semicolon.
- **Cut words that add nothing:** "simply", "just", "actually", "really",
  "in order to", "please note that".
- **Say what happens, then stop.** Don't end a paragraph by summing up what
  it said.

| Instead of | Write |
|---|---|
| A cookie banner on every visit? Point at it with Sval's Remove from this site. A slider widens the choice from a link to the whole box. Sval saves a rule, so it stays gone. Undo brings it back. | Sval can wipe a cookie banner off a site for good. Choose Remove from this site, click the banner and slide to grab the whole box, and the banner stays gone on every visit and every device you sync. |

## Check before anyone reads it

- **Vale.** `scripts/check-prose.sh` checks the docs site, `docs/features.md`,
  and the README for the rules a pattern can catch. The rules are in
  `website/vale/Sval/`. `lint.sh` and CI run the check, and a Claude Code hook
  runs it on each of those files an agent edits.
- **Rhythm.** `scripts/check-rhythm.py` flags runs of clipped sentences,
  paragraphs whose sentences share one length, and paragraphs heavy with
  commas and periods. The script checks only the paragraphs a change
  touches, because the docs written before the script don't pass. `check-prose.sh` runs it on the files it's given and in the website
  build on a pull request.
- **Drafts.** Write a post or other text for users in the worktree's
  `.scratch/posts/` as a `.md` file, where the hook checks it the way it
  checks the docs.
- **A prose review.** Vale can't tell when "it" has no clear noun, a list is
  padded for rhythm, or a page describes the docs instead of Sval. Before you
  show new text to anyone, run the `prose-reviewer` agent on it. A UI string
  gets the review too, because Vale doesn't read the code that holds it.

## Avoid the tells of AI writing

Readers notice these, and they make text sound generated. Wikipedia's
[Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)
lists more.

- **Slogans and puffery:** "seamless", "effortless", "powerful", "robust",
  "unlock", "elevate", "a testament to". Say what the feature does.
- **"X, not Y" contrasts:** "Your password manager, not ours." State the
  thing itself: "Your passwords stay where you already keep them."
- **Em-dash asides.** Use a period or a comma.
- **Lists of three for rhythm.** List what is there, however many items that
  is. Don't end a list with "and more".
- **Hedges and intensifiers:** "may help", "can potentially", "critically",
  "truly".
- **Stiff transitions:** "Moreover", "Furthermore", "Additionally".
- **Set-ups and reveals:** a question as the opening line ("A cookie banner
  on every visit?"), and a colon or question that holds back the point
  ("Here's the thing:", "The result?"). Say the point.
- **One-line paragraphs** for drama, and a closing line that ties a bow on
  the paragraph.
- **Over-explaining:** steps for what the UI makes plain, and caveats the
  reader didn't need.

## Posts and announcements

A post on Bluesky, Reddit or Mastodon sells one feature to someone
scrolling past, and the docs page it links to does the explaining.

- **One feature per post**, led by what the feature does for the reader.
- **No steps and no settings paths.** Name where the feature lives at
  most once, and link to its docs page.
- **Two or three sentences** that flow, with a clip or a screenshot that
  shows the feature working.
- **A release post** is the one exception, and carries the release notes'
  entries as they are.

## Docs pages

The docs site's pages follow Diátaxis (decision 2023). Each page is one of
four kinds, and stays that kind from top to bottom.

- **Tutorial:** teaches a newcomer by doing, start to finish. "Set up Sval
  on two computers." Every step works on every platform, and the page never
  stops to explain.
- **How-to guide:** finishes one task for someone who knows what they want.
  "Move a tab to another Workspace." Its title is the task.
- **Reference:** describes what each setting or control does, in the order
  the UI shows them. It gives no instructions and no reasons.
- **Explanation:** says why Sval works as it does. "What Sval keeps on your
  computer." It links to the how-to guides and gives no steps.

### The docs' home page

The home page tells a newcomer what Sval is and where to start.

1. **What Sval is,** in one or two sentences.
2. **Get started:** numbered steps for the first day, each a link to its
   page.
3. **Features:** one bullet per sidebar section. The bold label links to the
   feature's first page, and one or two sentences say what the feature does
   for you.

Don't describe the docs' own layout, on the home page or anywhere else. Link
to the page the reader needs.

| Instead of | Write |
|---|---|
| Start with **Get started** to set up Sval. Each feature after it has its own section in the sidebar: the tasks you can do with it, how it works, and what each of its settings and controls does. | Begin with [Set up Sval on two computers](/docs/tutorials/set-up-sval-on-two-computers/). |

### A feature's pages

A how-to guide or a reference page about a feature has these parts, in this
order, and leaves out any it has nothing for:

1. **What it is,** in one or two sentences.
2. **When you'd use it,** as a real situation: "You're comparing two
   laptops and want both pages side by side."
3. **Steps.**
4. **Details:** options, limits, and what happens at the edges.
5. **If something goes wrong:** what the reader sees, and what to do.
6. **Related pages.**

### Steps

- Number the steps. Keep a procedure to seven steps or fewer, and split a
  longer one into two pages.
- Put one action in each step. Start with where, then what: "In the Workspace,
  right-click the tab, then choose **Move to Workspace**."
- Bold a control's name, and spell it exactly as Sval shows it.
  `scripts/check-ui-labels.py` fails on a bold name in a step, or a part of
  a Settings path, that Sval doesn't show.
- Give a setting's path with ›: Settings › Links.
- Write "select" for a control that you can click, tap or reach from the
  keyboard. Write "click" only when a mouse is the only way.
- Say what the reader sees when a step works, if it isn't obvious.

### Show what the feature does

The marketing site persuades. The docs show what happens, and a reader
trusts a page that says exactly that.

- Show the feature in a real situation, with a screenshot or a short clip.
- Back each claim with what Sval does. Write "Sval encrypts everything in
  your sync folder with a key only your devices have" in place of "private
  by design".
- State the limits. A page that says what a feature doesn't do is believed
  about what it does.
- Leave out comparisons with other browsers.

## Website text for an unreleased feature

Write a feature's docs and website text in the pull request that adds it,
and gate them on the release that will ship it. The site stays as it is
until that release is published, and the release's rebuild opens the gate.
The gates are in `website/src/lib/`.

- **A new docs page** gets `since: 1.0.0-rc.9` in its frontmatter. The
  page, its sidebar entry and its Markdown stay out of the site until then.
- **A new website page** starts its frontmatter script with
  `const gate = await pageGate("1.0.0-rc.9", Astro.url); if (gate) return gate;`.
  The build writes no file for it, and the sitemap leaves it out.
- **Changed text in a live page** goes in `<Since v="1.0.0-rc.9">`, and the
  text it replaces in `<Until v="1.0.0-rc.9">`. Both are components in
  `website/src/components/docs/`. A docs page that uses them is `.mdx`, and
  a website page imports them like any component.
- **A link in the header or footer** to gated text or a gated page gets
  `since: "1.0.0-rc.9"` in its entry in the nav config, in
  `website/src/config/`.
- **Preview** with `npm run dev` in `website/`. It shows every gate, marked.
- **A gate whose release is out** fails the pull request's website build.
  Take the gate out, and the `<Until>` text with it.

## Release notes

Each version's notes are one file,
`website/src/content/releases/<version>.md`, written before the release is
tagged. The notes are a list of entries and nothing else. The website takes
the release's date and Firefox ESR version from the release itself, so the
file holds neither. `scripts/release-notes-draft.py` lists the change to
`docs/features.md` and every pull request merged since the last release,
grouped by the type each title starts with. Pick from it the changes most
people using Sval will notice.

- **One entry per change, and each change in one entry.** A headline or a
  summary above the list repeats the entries, so the notes have neither.
  Merge related changes into the entry for the feature they belong to.
- **Each entry stands on its own.** A reader who sees one line, in a feed or
  an email, understands it without the rest.
- **Mark each entry** as new, fixed, security, or removed. List new entries
  first and the biggest change first.
- **Say what's different for you, then how to use it.** Name where the
  control is, or what to press: "To move a tab to another window, drag the
  tab into that window's Workspace."
- **Describe a fix as the user saw the bug.** Name what went wrong on
  screen, then what happens now. Give the numbers when there are numbers:
  "With a screen reader running, Settings and site pages took 5 to 15
  seconds to open. They now open straight away."
- **Describe the whole problem a fix solves.** When one site is the example
  of a wider cause, say so: name the kind of site, then the example.
- **List only substantial changes, about ten.** A big new feature, or a
  fix to something many people hit, earns an entry. Renames, moved
  buttons, visual polish and fixes to rare cases stay out, as do test
  fixes, CI, refactors and internal names. Group Firefox's security fixes
  into one entry.

| Instead of | Write |
|---|---|
| Pause or play a tab from its media button. (under a headline saying the same) | Music and video keep playing when you switch Workspaces. To pause, skip, or seek, use the controls at the bottom of the Workspace panel. |
| Fixed ad blocking lost when it is turned off and straight back on. | Ads stay blocked after you turn ad blocking off and back on. |
| Agents wait for every call up to the user's limit. | Agents gave up waiting for your answer after 50 seconds. Agents now wait as long as you set in Settings › Agents. |

## What belongs in `docs/features.md`

List what a person using Sval would notice and want to know. Leave out
visual polish, bug fixes, edge cases and implementation details. A change
that only makes something look or work better than before needs no entry
unless it changes what the user can do.
