---
title: Add a filter list
description: Switch on a list Sval knows, or add any filter list by its address.
---

Sval knows more filter lists than its blocking levels use. Under Custom, you
can switch on any list Sval knows. You can also add other lists by their
address.

You read sites in Swedish and want the Swedish list, or a friend shared a
list that blocks a site's pop-ups.

## Switch on a list Sval knows

1. Open Settings › Privacy and protection.
2. Under Ad and tracker blocking, select **Customize lists**.
3. Under Lists, turn on the switch next to the list.

Your level changes to Custom, starting from the lists you had. Once you're
on Custom, every list has its own switch, so you can skip step 2. To go
back, select **Undo** in the message under the lists.

## Add a list by its address

1. Open Settings › Privacy and protection.
2. Under Ad and tracker blocking, select **Add list**.
3. In **List address**, paste the list's address.
4. In the menu next to it, choose what the list blocks.
5. Select **Add**.

Sval downloads the list and keeps it updated. Sval names the list from the
title inside it. The list shows **Added by you**.

## Details

- A list's address has to start with https://.
- The menu files the list under Ads, Trackers, Annoyances, Scams and malware,
  Site fixes, or Other.
- If you add a list while you're on another level, Sval switches you to
  **Custom**.
- Under Custom, you can remove a list you added. Select the × at the end of
  the list's row. The message under the lists then offers **Undo**.
- Lists you add sync to your other devices. On each of those devices, select
  **Allow on this device** next to the list. Until you do, that device
  doesn't download the list.
- **Trust this list.** A list you added can then run trusted scriptlets.
  Trusted scriptlets can set cookies, click buttons, and rewrite responses
  on any site. Sval asks before it trusts a list. You trust a list on each
  device separately, and trust doesn't sync.
- uBlock Origin's own lists run trusted scriptlets unless you turn off
  **Use trusted scriptlets from uBlock Origin's lists and the lists you
  trust** under Advanced.

## If something goes wrong

- **Enter a list address starting with https://.** Sval only downloads
  lists over a secure connection.
- **Sval already knows this list. Switch it on below.** Find the list among
  the others and turn on its switch.
- **That address isn't a list Sval can add.** The address didn't give Sval
  a filter list.

## Related pages

- [Choose how much Sval blocks](/docs/how-to/privacy/choose-how-much-sval-blocks/)
- [Write your own filter rules](/docs/how-to/privacy/write-your-own-filter-rules/)
- [Privacy and protection settings](/docs/reference/privacy/)
