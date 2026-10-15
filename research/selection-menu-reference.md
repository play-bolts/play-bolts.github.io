# CoD1 team and weapon selection reference

Inspected 2026-10-13. These observations concern the original PC game's selection windows, not later Call of Duty titles.

## Direct screenshot evidence

[Robert Banister's own multiplayer connection guide](https://www.robertbanister.com/GamingMain/COD1/COD1.php) shows team selection followed by weapon selection. The original screenshots were downloaded and viewed directly:

- [Team screenshot](https://www.robertbanister.com/GamingMain/COD1/Webpage/Img6.jpg): 633 × 475 pixels; window approximately x=95–543, y=60–380. Thus about 71% of viewport width and 67% of height, centered horizontally and slightly above vertical center.
- [Weapon screenshot](https://www.robertbanister.com/GamingMain/COD1/Webpage/Img7.jpg): 623 × 472 pixels; a similar window, approximately x=84–533, y=60–380.

Both use a translucent near-black rectangular body, thin double gray edging, square tabs, and a narrow monochrome picture strip immediately below the tabs. The map remains visible through and around the window. There are no rounded cards or oversized headings.

Tabs read “Main Menu”, “Team”, “Weapon”, “View Map”, and “Call Vote”. The active tab is lighter charcoal; the weapon tab is absent before joining a team. Team choices form a small, numbered, left-aligned white serif list near the upper-left: American, German, Auto-Assign, Spectate. Weapon choices occupy the left column; an image, short description, and three horizontal attribute bars occupy the right.

The captured list has approximately 24-pixel row spacing and a 24-pixel left inset. Letterforms are mixed-case serif with a subtle dark shadow. Exact font, alpha, source coordinates, and hover colors are not established from these JPEGs.

Local read-only QA copies: `/tmp/bolts-cod1-team-menu.jpg` and `/tmp/bolts-cod1-weapon-menu.jpg`. They are references, not shipped app assets.

## Official manual check

[Activision/Infinity Ward manual hosted by Steam](https://cdn.cloudflare.steamstatic.com/steam/apps/2620/manuals/COD.pdf), PDF pages 13–15 / printed pages 24–29, was rendered and visually inspected. It documents joining/hosting multiplayer, player-name settings, and server options. Its screenshots show the main menu, multiplayer options, and server browser; these pages do **not** establish the team-to-weapon panel layout. The recorder's screenshots above provide that visual evidence.

## Application to Bolts

Use the observed centered black window, restrained serif type, numbered text rows, square tabs and thin borders. Keep team selection and rifle selection as successive screens. Adapt the roster to the user's three nationalities; each weapon screen offers only that nationality's required rifle. An original rifle preview can occupy the right side. Do not add the original game's unrelated weapons, map picker, voting, or spectator functionality solely to reproduce tabs.

A near-black body around 85–90% opacity and off-white lettering are practical starting estimates; opacity cannot be recovered exactly from a composited screenshot. The existing Times/Georgia system-font stack remains an approximation. Any responsive dimensions, difficulty placement and reduced rifle-only details are Bolts design choices, not verified original menu data.

No authenticated original CoD1 `.menu` source file was located in this bounded search. A seemingly relevant public rifle-menu tutorial was confirmed to discuss CoD2 `.iwd` files and was excluded.
