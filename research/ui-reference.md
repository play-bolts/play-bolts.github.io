# Original Call of Duty (2003) UI reference

Inspected on 2026-10-13. The reference is the original PC game, not later Call of Duty interfaces.

- [Contemporaneous main-menu screenshot, contributed November 2003](https://www.mobygames.com/game/10826/call-of-duty/screenshots/windows/53918/): directly opened and visually inspected. Mixed-case traditional serif links appear in a right-hand column, with light gray/cream lettering, dark offset shadows, and a thin pale vertical divider. Menu items are plain text rather than large filled cards. The background depicts khaki cloth, a wooden rifle and a steel helmet. The large original logo is a separate condensed display treatment, not the menu typeface.
- [Official manual, printed pages 5–7](https://cdn.cloudflare.steamstatic.com/steam/apps/2620/manuals/COD.pdf): corroborates the menu layout and compact compass/ammunition/health HUD. The manual's own printed body font is not evidence for the game's UI font.
- The WaWa gameplay links in `wawa-reference.md` show pale serif-like HUD text, a round lower-left compass and compact lower-right ammunition/health indicators.

## Font decision

The exact original game font family has not been established from an authoritative font inventory. Its observed letterforms support a Times-style serif substitute. Bolts uses the browser stack `"Times New Roman", Times, Georgia, serif`; these are referenced from the user's device, not redistributed as copied font files. There is no Barlow, Bank Gothic or modern condensed UI font in the new stylesheet.

If a bundled font is wanted, [Liberation Serif](https://github.com/liberationfonts/liberation-fonts) is a defensible Times-compatible alternative. Its upstream [SIL Open Font License 1.1](https://github.com/liberationfonts/liberation-fonts/blob/main/LICENSE) permits bundling with software when its notice/license is included. This is an alternative, not a claim that CoD1 used Liberation Serif.

## Applied style

Bolts uses mixed-case serif text, cream highlights, dark text shadows, restrained olive translucent panels, thin dividers and text-based selections. The setup menu remains one step from starting a round. Scoreboard, options, controls, pause, killcam and in-game HUD all use the same period-appropriate typography. The exact palette is an approximation, not sampled proprietary UI assets.

The mobile stance and rifle buttons carry that treatment into compact, square
faces with original cream soldier, iron-sight and cartridge silhouettes. Short
serif labels remain visible, and active stances/aim use a pale gold highlight.
At the default control size, the faces are 42×40 CSS pixels inside 48×44 touch
targets; the targets never shrink below 44×44. The original PC HUD is the style
reference, not evidence that the original game had these touch buttons.

Touch sensitivity defaults to 4.0 (previously 1.0), giving approximately 83° of
hip-fire rotation for a 200 CSS-pixel swipe. Options allow 0.5–6.0. Unversioned
saved values at the old 1.0 default migrate to 4.0; other saved values remain,
and choosing 1.0 explicitly in the new release persists normally.

## Model reference pointers

- [Lee-Enfield Association No.4/No.5 illustrated sight picture, page 39](https://lee-enfield.org/images/Training/BYSA_Lee_Enfield_instructors_manual_v61.pdf): rear aperture and front post. No.4 geometry should not be confused with SMLE open rear sights.
- [Mosin Museum, original rifle identification photos](https://www.mosinmuseum.com/model-identification): 91/30 silhouette, sight base and original rifle photographs.
- [Danish National Museum M36 field tunic](https://samlinger.natmus.dk/khs/object/23176).
- [National Army Museum British 1937 webbing waistbelt](https://collection.nam.ac.uk/detail.php?acc=1998-02-259--1).
- [Australian War Memorial 1937 pattern pack](https://www.awm.gov.au/collection/C1005479).
- [Museum Fund of Ukraine, wartime gymnastiorka](https://museum.mincult.gov.ua/collections/gimnasterka-94700).
- [Victory Museum SSh-40 helmet](https://ar.culture.ru/en/subject/ssh-40-i-osenniy-maskhalat).

These are visual references for original procedural models. Images and original game assets have not been copied into the app.
