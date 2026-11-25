---
title: Use Battery Saver
description: Make your laptop's battery last longer by having Sval draw fewer frames on a fast screen and do less in the background.
since: 0.1.0-rc.11
---

Battery Saver makes your battery last longer. While it's on, Sval draws
fewer frames on a fast screen, slows tabs in the background, and puts a
Workspace to sleep 30 minutes after you leave it.

You're working from a train on your laptop's battery, and want it to last
until you're home.

## Steps

To choose when Battery Saver turns on:

1. Open Settings › General.
2. Under **Battery Saver**, choose **When your computer is on battery**,
   **Always**, or **Never**.

To turn Battery Saver off until you next plug in or unplug:

1. Next to the address bar, select the leaf button, **Battery Saver**.
2. Select **Turn Off for Now**.

You can also choose Tools › **Battery Saver**, which turns Battery Saver
off or on until you next plug in or unplug.

## Details

- Sval turns Battery Saver on when you unplug your computer and off when
  you plug it back in, unless you choose **Always** or **Never**. A leaf
  button shows next to the address bar while Battery Saver is on.
- On a screen of 120 Hz or faster, Sval draws pages at close to 60 frames a
  second, such as 72 on a 144 Hz screen. A slower screen keeps its frame
  rate.
- A page in the background that uses up its time for running timers gets
  that time back at a fifth of the usual rate.
- A Workspace no window shows goes to sleep after 30 minutes in place of
  three hours. A tab playing sound, holding text you typed, or set to Keep
  Awake stays awake.
- A desktop computer without a battery is never on battery, so there
  Battery Saver turns on only when you choose **Always**.
- When Sval restarts, or when you change the setting, Battery Saver follows
  your setting again.

## Related pages

- [When Sval puts tabs to sleep](/docs/explanation/sleeping-tabs/)
- [Keep a tab awake](/docs/how-to/tabs/keep-a-tab-awake/)
