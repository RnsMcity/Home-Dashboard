# Display frame + Raspberry Pi 3 case

Parametric 3D-printable "thick IKEA picture frame" for the bare ~7" LCD panel
(6-7/16in) and the Pi 3 running HomeDashboard. All parts print flat on a
Bambu P1S — no supports, no bridges.

## ⚠ Measure your panel before printing

`case/display_frame.py` defaults assume **164.9 × 97.0 × 2.0mm** glass
(96mm measured + 1mm fit clearance) with the connector on the bottom edge.
Open the script, update the top of the `P` dict (especially `panel_w`,
`panel_h`, `conn_w`), then regenerate:

    blender -b -P case/display_frame.py

That rebuilds `case/out/display_frame.blend`, the three STLs, and preview
renders. You can also open the .blend and re-run the script from the
Scripting workspace after tweaking.

## Parts

| File               | Qty | Notes                                          |
|--------------------|-----|------------------------------------------------|
| `frame.stl`        | 1   | 196.9 × 129 × 20mm, prints front-face down     |
| `bezel.stl`        | 1   | front overlay hiding the panel's metal border  |
| `driver-plate.stl` | 1   | zip-tie tie-down grid for the HDMI driver board|
| `pi-tray.stl`      | 1   | Pi 3 B carrier, prints flat                    |

`case/out/preview_section.png` shows the whole sandwich in cutaway: glass in
the front pocket, cavity, floor, tray, Pi.

## Ribbon / cable routing

- **Panel flex ribbon**: exits the bottom edge of the glass into the bay
  behind it, then drops through the 40×15mm **ribbon slot** in the cavity
  floor and out the back — either to the driver board (if you mount it on
  the tray side) or around to the Pi area. Sized via `conn_w` / `conn_bay` /
  `ribbon_slot`.
- **Driver HDMI → Pi**: short cable through the 17×12mm floor hole beside
  the ribbon slot.
- **Power / USB devices**: run around the tray edge from behind.

## Assembly

1. Push the LCD glass into the front pocket (connector toward the notch in
   the bottom edge). The 0.8mm ledge behind the glass retains it; a strip of
   foam tape between glass and ledge is recommended. The retention lip sits
   *behind* the glass edge, so the 1mm/3mm dead-border asymmetry never clips
   pixels.
2. Zip-tie the HDMI driver board to the tie-down plate; screw the plate into
   the cavity floor with 4× M3×16 through the corner pilots (self-tap).
3. Route the driver HDMI through the floor pass-hole to the Pi.
4. Attach the pi-tray to the flat back of the frame: clean both faces and
   bond with strong double-sided tape (3M VHB) or glue at the 6 marked
   screw spots; optionally add 6× M3×10 self-tapping screws into the pilot
   dimples. (If you prefer full screw grip, set `"back_bosses": True` in the
   script and regenerate — you get 4mm bosses with deep pilots, which still
   print fine since they grow upward.
   Stand the Pi on the tray's standoffs (58×49mm hole pattern, Pi 3 B),
   component side out, micro-SD edge toward the tray's short edge — 5mm
   standoffs clear the card, and all ports stay reachable. Feed the panel
   ribbon through the bottom ribbon slot first! Fix the board with 4× M2.5×10
   self-tapping into the standoff pilots.
 5. Power + micro-USB supply enter from behind; the Pi sits in free air off
    the back, so it runs unthrottled.
 6. Last, with the glass cleaned: lay two small strips of double-sided tape
    on the frame front (outside the pocket) and press the bezel on — its
    four pins drop into the dimples at the corners. The bezel window is cut
    to the visible area, so the panel's metal border (2/5/6mm) disappears.
    Glue is the permanent alternative; IPA removes the tape if the glass
    ever needs to come out.

Screws: 4× M3×16, 4× M2.5×10, optional 6× M3×10, plus small zip ties and
double-sided tape / glue for the tray and bezel.

## Print settings (Bambu P1S / Bambu Studio)

- **No supports needed for any part.** Bambu Studio only generates supports
  if you tick Settings > Support > Enable supports — leave it off, nothing
  here has a real overhang. The 0.8mm pocket ledge prints as a self-
  supporting micro-shelf.
- **Just import the STLs and hit slice**: all four are exported sitting on
  Z=0, so they land in the correct print orientation automatically.
  - `frame.stl`: front face down (first layer = the visible face); the flat
    back sits on the plate, everything grows upward
  - `pi-tray.stl` and `driver-plate.stl`: flat as exported
- 0.2mm layer, 3 walls, 15% infill, PLA or PETG
- Frame is a big part (envelope 197 × 129 × 20mm); expect roughly 150–200g
  of filament at 15% infill — one print, no supports

## Fit notes

- Pocket clearance 0.3mm/side; if the glass is tight, sand the pocket or drop
  `pocket_clear` to 0.2 after measuring.
- Connector bay behind the bottom edge: 45mm wide × 5mm deep — resize via
  `conn_w` / `conn_bay`.
- The Pi position on the back is `pi_x_off` / `pi_y_off`; nothing else
  references it except the screw pattern, so it is freely repositionable.
- The bezel window is sized from `glass_h` (true glass, not the padded
  `panel_h`) minus `bez_top` / `bez_bottom` / `bez_side` — the metal-border
  measurements — plus 0.2mm print-tolerance bite (`bez_overlap`).
