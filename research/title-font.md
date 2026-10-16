# Bolts title font and Credits menu

Reviewed 2026-10-16.

The [official Call of Duty manual, printed page 5](https://cdn.cloudflare.steamstatic.com/steam/apps/2620/manuals/COD.pdf) shows the original main menu and lists Credits as its own main-menu item. Bolts now has the same direct entry; Options and Controls contain only their own settings and key bindings.

The title uses locally served **Alfa Slab One Regular**, by **JM Solé**. Its heavy slab serifs, tight spacing, horizontal condensation and cream beveled shadow give the Bolts wordmark an older military-game appearance. It is a stylistic substitute, not a claim to reproduce the exact proprietary CoD logo font. The existing Times-style menu/HUD text stays unchanged.

Primary font sources:

- [Google Fonts distribution and original binary](https://github.com/google/fonts/tree/main/ofl/alfaslabone)
- [Designer and upstream metadata](https://raw.githubusercontent.com/google/fonts/main/ofl/alfaslabone/METADATA.pb)
- [SIL Open Font License 1.1](https://raw.githubusercontent.com/google/fonts/main/ofl/alfaslabone/OFL.txt)

The original 97,376-byte TTF is bundled unmodified under `public/assets/fonts/alfa-slab-one/`, together with the complete copyright/license and source notice. CSS performs the visual condensation; no font outlines or metadata were modified. The Credits dialog includes the designer and license link. Loading does not contact a third-party font service.
