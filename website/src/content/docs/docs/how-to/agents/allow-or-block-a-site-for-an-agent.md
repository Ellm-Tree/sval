---
title: Allow or block a site for an agent
description: Answer Sval when an agent wants a new site, or set a rule for a site in the agent's permissions.
---

Each agent has its own rules for sites. Sval asks you the first time an
agent opens a site, and your answer becomes a rule for that site. You can
also set rules yourself before the agent gets there.

Your agent is researching flights. You want it to read any travel site, and
you never want it on your bank's site.

## Answer when an agent opens a new site

Sval brings the agent's window forward and asks you there.

1. Read which site the agent wants to open.
2. Optional: where the alert shows **Remember for**, choose the address
   alone or the whole site.
3. Select **Allow**, **Allow all sites, read only**, or **Deny**.

If you haven't changed the agent's default, each answer does this:

- **Allow.** The agent can read the site. Sval asks you before the agent
  sends anything there.
- **Deny.** Sval blocks the site for this agent.
- **Allow all sites, read only.** The agent can open any site that has no
  rule, but only to read it.

## Add a rule in Settings

1. Open Settings › Agents.
2. Under Paired agents, select **Permissions** next to the agent.
3. Under Sites with their own rules, select **Add site**.
4. Type the site, or paste an address from the agent's tab.
5. Choose a level: **Blocked**, **Read only**, **Ask before writes**, or
   **Full**.
6. Select **Add**.

## Change or remove a rule

1. Open the agent's **Permissions** page.
2. Select the site's row. The row opens to show the rule's settings.
3. Choose another level under Access.

To remove a rule, open the site's row and select **Remove rule**, and the
site then follows Every site. An address follows the rule for its whole
site, or Every site when the site has no rule of its own. If you change
your mind, **Undo** puts the rule back.

## Details

- Each level does this:
  - **Blocked.** The agent can't open the site.
  - **Read only.** The agent reads pages. It never clicks, types, or
    submits.
  - **Ask before writes.** The agent reads freely. Sval asks you before the
    agent clicks, types, or submits.
  - **Full.** The agent clicks, types, and submits on its own, without
    asking.
- **Every site.** This setting starts at **Ask on first visit**, and you
  can change it to any level. Sites with no rule of their own then get that
  level without Sval asking you.
- A site's rule changes only the settings you set in it, so a site whose
  Access is **Same as every site** keeps the level that Every site sets.
- Even with a default level set, Sval asks you before an agent opens a
  service on this computer or a device on your local network.
- On an address like `nas.example.com`, you choose whether the rule
  covers that address alone or all of `example.com`. A rule for one address
  wins over the rule for its whole site.
- When Sval asks before writes, it lists what the page is about to send.
  Choose **Always allow writes** to set the site to Full, or **Always deny
  writes** to set the site to Read only.
- Each site's rule has a setting for downloads, one for uploads, one for
  the console, and one for apps. Each of them starts at Ask, so Sval asks
  you the first time an agent needs that permission on the site.
- When Sval asks about a download or an upload, **Allow** and **Deny**
  answer only that once. The **Always** choices save a rule for the site.
- Sval remembers your answer about a site's console.
- An upload rule allows files only from the folders you approved when Sval
  asked. You choose **This folder only** or **This folder and the folders
  inside it**.
- An upload rule never covers a hidden file, or any file inside a hidden
  folder, such as the keys and passwords your home folder keeps. Sval asks
  you about each of those files every time.
- Once a site asks to open an app, the site's rule lists that app under Apps.
- Rules belong to the app, so every session of the app follows them.
- Sval keeps the rules on this device.

## If something goes wrong

- **already has a rule.** The site has a rule already. Select **Show it**
  to find it in the list.
- **Enter a site like ebay.co.uk, or paste an address.** Sval couldn't read
  what you typed as a site.

## Related pages

- [What an agent can and can't reach](/docs/explanation/agents/)
- [Watch and stop an agent](/docs/how-to/agents/watch-and-stop-an-agent/)
- [Agent settings and controls](/docs/reference/agents/)
