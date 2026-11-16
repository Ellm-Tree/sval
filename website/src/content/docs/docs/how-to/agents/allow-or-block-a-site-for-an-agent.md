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
3. Under Site rules, select **Add site**.
4. Type the site, or paste an address from the agent's tab.
5. Choose a level: **Blocked**, **Read only**, **Ask before writes**, or
   **Full**.
6. Select **Add**.

## Change or remove a rule

1. Open the agent's **Permissions** page.
2. In the site's row, choose another level under Access.

To remove a rule, select **Remove rule** at the end of the rule's row. A site
then follows the default for sites with no rule. An address follows the
rule for its whole site, or that default when the site has no rule. If you change your mind, select **Undo**.

## Details

- Each level does this:
  - **Blocked.** The agent can't open the site.
  - **Read only.** The agent reads pages. It never clicks, types, or
    submits.
  - **Ask before writes.** The agent reads freely. Sval asks you before the
    agent clicks, types, or submits.
  - **Full.** The agent clicks, types, and submits on its own, without
    asking.
- **Default for sites with no rule.** This setting starts at **Ask on
  first visit**. You can change the default to any level. Sites with no rule then get that
  level without Sval asking you.
- Even with a default level set, Sval asks you before an agent opens a
  service on this computer or a device on your local network.
- On an address like nas.example.com, you choose what the rule covers.
  It can cover that address alone or all of example.com. A rule for one
  address wins over the rule for its whole site.
- When Sval asks before writes, it lists what the page is about to send.
  To set the site to Full, choose **Always allow writes**. To set the site
  to Read only, choose **Always deny writes**.
- Downloads, Uploads, Console, and Apps each have their own column in the
  rules table. Each column starts at Ask. Sval asks you the first time an
  agent needs to download, upload, use the console, or open an app on a
  site.
- When Sval asks about a download or an upload, **Allow** and **Deny**
  answer only that once. The **Always** choices save a rule for the site.
- Sval remembers your answer about a site's console.
- An upload rule allows files only from the folders you approved when Sval
  asked. You choose **This folder only** or **This folder and the folders
  inside it**.
- An upload rule never covers a hidden file, or any file inside a hidden
  folder, such as the keys and passwords your home folder keeps. Sval asks
  you about each of those files every time.
- Once a site asks to open an app, the Apps column lists that app.
- Rules belong to the app, so every session of the app follows them.
- Sval keeps the rules on this device.

## If something goes wrong

- **already has a rule.** The site has a rule already. Select **Show it**
  to find it in the table.
- **Enter a site like ebay.co.uk, or paste an address.** Sval couldn't read
  what you typed as a site.

## Related pages

- [What an agent can and can't reach](/docs/explanation/agents/)
- [Watch and stop an agent](/docs/how-to/agents/watch-and-stop-an-agent/)
- [Agent settings and controls](/docs/reference/agents/)
