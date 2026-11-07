# Shubh Deepawali

Live at **https://shubh-deepawali-gilt.vercel.app**: every push to `main` deploys automatically.

A Diwali courtyard at dusk with glowing diyas and fairy lights, where you can:

- **Draw a rangoli**: freehand white powder, mirrored into all four quarters, with optional guide dots and undo.
- **Color a rangoli**: pick a stencil (lotus, peacock, star); its outline is drawn in white powder, then you fill the shapes from a brass tray of colours.
- **Add diyas**: once a rangoli is finished, set small lit diyas on and around it.
- **Download** the scene as a picture.

It's a static site: open `index.html`, or serve the folder (`python3 -m http.server`).

## Regenerating assets

- `build_stencils.py`: turns `stencils/<name>.webp` line art into `stencils/stencils.js` (stroke order and fillable shapes).
- `build_tray.py`: cuts the colour tray out of `tray-photo.webp` into `tray.webp`.
- `build_diya.py`: cuts the clay diya from the courtyard photo into `diya-bowl.png`.
