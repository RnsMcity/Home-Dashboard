# Parametric display frame + Raspberry Pi 3 mount for HomeDashboard.
#
# Regenerate (blend + STLs + renders):   blender -b -P case/display_frame.py
# Or Blender GUI: Scripting workspace > Open > Run Script.
#
# Parts modelled Z-up (print axis), exported at origin in print orientation.
#   frame.stl         pocket retains LCD glass; cavity holds driver board;
#                     tray bosses + pilots moulded on the back.
#   driver-plate.stl  universal zip-tie tie-down grid for the HDMI board.
#   pi-tray.stl       Pi 3 B carrier; standoffs clear the SD card.
#
# Screws: 4x M3x16 (plate), 6x M3x25 (tray), 4x M2.5x10 self-tap (Pi).

import bpy
import bmesh
import math
import os

P = {
    # --- LCD glass: MEASURE YOUR PANEL AND UPDATE THESE ---
    "panel_w": 164.9,      # glass width (6-7/16in assumed)  <-- measure
    "panel_h": 97.0,       # glass height (96 + 1mm fit clearance)
    # visible area is inset ~1mm from the top metal tab and ~7mm from the
    # bottom (FPC) edge; the retention lip grips the glass edge, never the
    # visible area, so this asymmetry needs no compensation.
    "panel_t": 2.0,
    "conn_w": 45.0,        # flex connector width, bottom edge
    "conn_bay": 5.0,       # relief bay depth behind that edge
    # --- frame ---
    "border_w": 16.0, "frame_depth": 20.0, "wall": 3.0,
    "pocket_clear": 0.3,   # slide clearance per side
    "ledge": 0.8,          # retention lip overlap behind glass
    "corner_relief": 2.0,  # square notch at pocket corners
    "corner_r": 2.0, "cavity_inset": 3.0,
    # --- driver board tie-down plate ---
    "plate_w": 70.0, "plate_h": 88.0, "plate_t": 1.8,
    "plate_x_off": 42.0, "plate_screw_inset": 5.0,
    "plate_screw_pilot": 2.4,
    # --- Raspberry Pi 3 B: 85x56, holes at (+/-41, +/-24.5) ---
    "pi_x_off": -30.0, "pi_y_off": 5.0,   # board centre on the back
    "pi_standoff_h": 5.0, "pi_standoff_d": 6.0, "pi_pilot": 2.0,
    "tray_t": 2.0, "tray_margin": 8.0, "tray_corner_r": 3.0,
    "tray_screw_inset": 4.5, "tray_screw_clear": 1.65,
    "tray_boss_h": 4.0, "tray_boss_d": 7.0, "tray_screw_pilot": 2.4,
    # False: perfectly flat back; glue/tape the tray on, optionally 6x M3x10
    # self-tap into 1.5mm pilot dimples. True: raised bosses for full M3 grip.
    "back_bosses": False,
    # --- cable pass-throughs (driver HDMI -> Pi; panel FPC -> Pi/board) ----
    "hdmi_hole": (36.0, -38.0, 17.0, 12.0),     # x, y, w, h
    "ribbon_slot": (0.0, -45.5, 40.0, 15.0),    # floor channel below the bay
}

def new_obj(name, me):
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob

def box(name, x0, x1, y0, y1, z0, z1):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts:
        v.co.x = x0 if v.co.x < 0 else x1
        v.co.y = y0 if v.co.y < 0 else y1
        v.co.z = z0 if v.co.z < 0 else z1
    bm.to_mesh(me); bm.free()
    return new_obj(name, me)

def cyl(name, cx, cy, z0, z1, r, seg=48):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False,
                          segments=seg, radius1=r, radius2=r,
                          depth=z1 - z0)
    bmesh.ops.translate(bm, verts=bm.verts[:], vec=(cx, cy, (z0 + z1) / 2))
    bm.to_mesh(me); bm.free()
    return new_obj(name, me)

def cut(target, *cutters):
    for c in cutters:
        m = target.modifiers.new("cut", 'BOOLEAN')
        m.operation = 'DIFFERENCE'; m.object = c
        bpy.context.view_layer.objects.active = target
        bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.data.objects.remove(c, do_unlink=True)

def fillet_z(obj, r):
    """Fillet the vertical edges of an extruded profile."""
    prev = bpy.context.view_layer.objects.active
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True); bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(obj.data)
    edges = [e for e in bm.edges
             if abs(e.verts[0].co.x - e.verts[1].co.x) < 1e-4
             and abs(e.verts[0].co.y - e.verts[1].co.y) < 1e-4]
    if edges:
        bmesh.ops.bevel(bm, geom=edges + [v for e in edges for v in e.verts],
                        offset=r, segments=4, profile=0.5, affect='EDGES')
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.object.mode_set(mode='OBJECT')
    if prev: bpy.context.view_layer.objects.active = prev

def build_frame():
    pw, ph, D, t = P["panel_w"], P["panel_h"], P["frame_depth"], P["wall"]
    ow, oh = pw + 2 * P["border_w"], ph + 2 * P["border_w"]
    f = box("frame", -ow / 2, ow / 2, -oh / 2, oh / 2, 0, D)
    fillet_z(f, P["corner_r"])
    xw = (pw + 2 * P["pocket_clear"]) / 2
    yw = (ph + 2 * P["pocket_clear"]) / 2
    cut(f, box("pocket", -xw, xw, -yw, yw, -0.5, 2.7))
    xl, yl = (pw - 2 * P["ledge"]) / 2, (ph - 2 * P["ledge"]) / 2
    rim = box("rim", -xl, xl, -yl, yl, 2.7, 3.0)
    notch = []
    for sx in (1, -1):
        for sy in (1, -1):
            x0, x1 = sorted((sx * (xl - 0.5), sx * (xl + P["corner_relief"])))
            y0, y1 = sorted((sy * (yl - 0.5), sy * (yl + P["corner_relief"])))
            notch.append(box("cr", x0, x1, y0, y1, 2.6, 3.05))
    cut(rim, *notch)
    cut(f, rim)
    xc, yc = (pw - 2 * P["cavity_inset"]) / 2, (ph - 2 * P["cavity_inset"]) / 2
    cut(f, box("cavity", -xc, xc, -yc, yc, 3.0, D - t))
    b = P["conn_bay"]
    y1 = -(ph / 2 - P["ledge"]) - b
    y2 = -(ph / 2 - P["cavity_inset"]) + 2
    cut(f, box("bay", -(P["conn_w"] / 2 + 3), P["conn_w"] / 2 + 3,
               y1, y2, 0.5, D - t - 0.1))
    hx, hy, hw, hh = P["hdmi_hole"]
    cut(f, box("hdmi", hx - hw / 2, hx + hw / 2,
               hy - hh / 2, hy + hh / 2, D - t - 0.5, D - t + 0.5))
    rx, ry, rw, rh = P["ribbon_slot"]
    cut(f, box("ribbon", rx - rw / 2, rx + rw / 2,
               ry - rh / 2, ry + rh / 2, D - t - 0.5, D + 0.5))
    pts = tray_screw_pts()
    for i, (bx, by) in enumerate(pts):
        if P["back_bosses"]:
            f2 = cyl("boss", bx, by, D, D + P["tray_boss_h"], P["tray_boss_d"] / 2)
            m = f.modifiers.new("j", 'BOOLEAN'); m.operation = 'UNION'; m.object = f2
            bpy.context.view_layer.objects.active = f
            bpy.ops.object.modifier_apply(modifier=m.name)
            bpy.data.objects.remove(f2, do_unlink=True)
            cut(f, cyl("pilot", bx, by, D + P["tray_boss_h"] + 0.1,
                       D - 2.0, P["tray_screw_pilot"] / 2))
        else:
            cut(f, cyl("dimple", bx, by, D - 1.5, D + 0.1, 1.2))
    return f

def tray_screw_pts():
    tl = (85 + 2 * P["tray_margin"]) / 2 - P["tray_screw_inset"]
    tw = (56 + 2 * P["tray_margin"]) / 2 - P["tray_screw_inset"]
    xs = [P["pi_x_off"] - tl, P["pi_x_off"], P["pi_x_off"] + tl]
    ys = [P["pi_y_off"] - tw, P["pi_y_off"] + tw]
    return [(x, y) for x in xs for y in ys]

def build_plate():
    w, h, t = P["plate_w"], P["plate_h"], P["plate_t"]
    p = box("driver-plate", -w / 2, w / 2, -h / 2, h / 2, 0, t)
    fillet_z(p, 2.0)
    holes = []
    ix, iy = w / 2 - P["plate_screw_inset"], h / 2 - P["plate_screw_inset"]
    for sx in (1, -1):
        for sy in (1, -1):
            holes.append(cyl("ps", sx * ix, sy * iy, -0.5, t + 0.5,
                             P["plate_screw_pilot"] / 2))
    for cx in (-24, -8, 8, 24):
        for cy in (-28, -9.5, 9.5, 28):
            holes.append(box("slot", cx - 6, cx + 6, cy - 1, cy + 1, -0.5, t + 0.5))
    cut(p, *holes)
    return p

def build_tray():
    tl = 85 + 2 * P["tray_margin"]
    tw = 56 + 2 * P["tray_margin"]
    t = P["tray_t"]
    tr = box("pi-tray", -tl / 2, tl / 2, -tw / 2, tw / 2, 0, t)
    fillet_z(tr, P["tray_corner_r"])
    # Pi 3 B mounting holes: 58x49 pattern -> (+/-29, +/-24.5)
    offs = [(29, 24.5), (29, -24.5), (-29, 24.5), (-29, -24.5)]
    offs = [(ox, oy + P["pi_y_off"]) for ox, oy in offs]
    cuts = []
    for (ox, oy) in offs:
        cuts.append(cyl("so", ox, oy, 0, t + P["pi_standoff_h"],
                        P["pi_standoff_d"] / 2))
    for c in cuts:
        m = tr.modifiers.new("u", 'BOOLEAN'); m.operation = 'UNION'; m.object = c
        bpy.context.view_layer.objects.active = tr
        bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.data.objects.remove(c, do_unlink=True)
    cuts = [cyl("pp", ox, oy, t + P["pi_standoff_h"] - 4,
                t + P["pi_standoff_h"] + 0.5, P["pi_pilot"] / 2)
            for (ox, oy) in offs]
    tl2, tw2 = tl / 2 - P["tray_screw_inset"], tw / 2 - P["tray_screw_inset"]
    for x in (-tl2, 0, tl2):
        for y in (-tw2, tw2):
            cuts.append(cyl("cs", x, y, -0.5, t + 0.5, P["tray_screw_clear"]))
    cut(tr, *cuts)
    return tr

def export_stl(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    try:
        bpy.ops.wm.stl_export(filepath=path, export_selected_objects=True)
    except AttributeError:
        bpy.ops.export_mesh.stl(filepath=path, use_selection=True)

def ghost(name, x0, x1, y0, y1, z0, z1, color, alpha=0.35):
    g = box(name, x0, x1, y0, y1, z0, z1)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Alpha"].default_value = alpha
    g.data.materials.append(mat)
    g.display_type = 'SOLID'
    g.visible_shadow = False
    return g

def look_at(cam, target):
    d = mathutils.Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

def paint(o, rgb):
    mat = bpy.data.materials.new(o.name + "_mat")
    mat.diffuse_color = (*rgb, 1)
    o.data.materials.append(mat)

def set_workbench_color(scene):
    try:
        scene.display.shading.color_type = 'MATERIAL'
    except (AttributeError, TypeError):
        pass

def sectionize():
    """Cut away everything with x>0 so the layer stack is visible."""
    for o in [o for o in bpy.data.objects
              if o.type == 'MESH' and not o.hide_render]:
        cut(o, box("cutbox", 0, 400, -400, 400, -400, 400))

def render(out, ghosts):
    import mathutils
    cam_d = bpy.data.cameras.new("cam")
    cam = new_obj("cam", cam_d)
    cam_d.lens = 45; cam.data.clip_end = 3000
    sun_d = bpy.data.lights.new("sun", 'SUN')
    sun_d.energy = 3
    sun = new_obj("sun", sun_d)
    sun.rotation_euler = (math.radians(50), math.radians(-15), math.radians(30))
    sc = bpy.context.scene
    sc.camera = cam
    sc.render.engine = 'BLENDER_WORKBENCH'
    set_workbench_color(sc)
    sc.render.resolution_x, sc.render.resolution_y = 1280, 960
    view = [o for o in bpy.data.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='SELECT')
    bpy.context.view_layer.objects.active = view[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    rot = mathutils.Matrix.Rotation(math.radians(90), 4, 'X')
    for o in view:
        o.data.transform(rot)

    def shot(name, pos, target=(0, 0, 0), show_ghosts=True):
        for g in ghosts:
            g.hide_render = not show_ghosts
        cam.location = pos
        look_at(cam, target)
        sc.render.filepath = os.path.join(out, name + ".png")
        bpy.ops.render.render(write_still=True)

    shot("preview_iso", (280, -320, 180))
    shot("preview_front", (0, 400, 40), show_ghosts=False)
    shot("preview_back", (-160, -400, 160))
    sectionize()
    shot("preview_section", (300, 230, 60))

def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
    os.makedirs(out, exist_ok=True)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    frame = build_frame()
    plate = build_plate()
    tray = build_tray()
    paint(frame, (0.25, 0.25, 0.27))
    paint(plate, (0.55, 0.42, 0.15))
    paint(tray, (0.15, 0.35, 0.55))
    export_stl([frame], os.path.join(out, "frame.stl"))
    export_stl([plate], os.path.join(out, "driver-plate.stl"))
    export_stl([tray], os.path.join(out, "pi-tray.stl"))
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "display_frame.blend"))
    plate.location = (P["plate_x_off"], 0, P["frame_depth"] - P["wall"])
    tray.location = (P["pi_x_off"], P["pi_y_off"], P["frame_depth"])
    pw, ph = P["panel_w"], P["panel_h"]
    g1 = ghost("ghost-glass", -pw / 2, pw / 2, -ph / 2, ph / 2,
               0.2, 0.2 + P["panel_t"], (0.05, 0.05, 0.06))
    z = P["frame_depth"] + P["tray_t"] + P["pi_standoff_h"]
    g2 = ghost("ghost-pi", P["pi_x_off"] - 42.5, P["pi_x_off"] + 42.5,
               P["pi_y_off"] - 28, P["pi_y_off"] + 28, z, z + 1.6, (0.1, 0.4, 0.15))
    render(out, [g1, g2])
    print("DONE ->", out)

import mathutils
main()
