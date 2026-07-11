from __future__ import annotations

import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import bmesh
import bpy
from mathutils import Quaternion, Vector


REPO_ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = REPO_ROOT / "src/renderer/src/assets/robots"
GLB_PATH = ASSET_DIR / "reference-office-robot.glb"
BLEND_PATH = ASSET_DIR / "reference-office-robot.blend"
PREVIEW_DIR = REPO_ROOT / "test-results/reference-robot-blender"
REFERENCE_ORIGINAL = REPO_ROOT / "docs/visual-references/reference-robot-original.jpeg"
REFERENCE_SHEET = REPO_ROOT / "docs/visual-references/reference-robot-orthographic-sheet.png"
OFFICIAL_G1_DIR = REPO_ROOT / "third_party/unitree-g1-rev1"
OFFICIAL_G1_MESH_DIR = OFFICIAL_G1_DIR / "meshes"
OFFICIAL_G1_XML = OFFICIAL_G1_DIR / "g1_29dof_rev_1_0.xml"

JOINT_POSE_RADIANS = {
    # Keep the upper arms hanging from the shoulders. The source forearms point
    # forward at zero, so a near-right-angle elbow pose produces a relaxed,
    # almost straight arm without lifting the upper arm away from the torso.
    "left_elbow_joint": math.radians(80),
    "right_elbow_joint": math.radians(80),
}

HAND_MESH_PARTS = {
    "palm",
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
}
FINGER_MESH_PARTS = HAND_MESH_PARTS - {"palm"}


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def srgb_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def rgba(hex_color: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    value = hex_color.lstrip("#")
    srgb = tuple(int(value[index:index + 2], 16) / 255 for index in (0, 2, 4))
    return tuple(srgb_to_linear(channel) for channel in srgb) + (alpha,)


def make_material(
    name: str,
    color: str,
    *,
    metallic: float,
    roughness: float,
    coat: float = 0.0,
    emission: str | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = rgba(color)
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba(color)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
    elif "Clearcoat" in bsdf.inputs:
        bsdf.inputs["Clearcoat"].default_value = coat
    if emission:
        emission_input = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
        if emission_input:
            emission_input.default_value = rgba(emission)
        strength_input = bsdf.inputs.get("Emission Strength")
        if strength_input:
            strength_input.default_value = emission_strength
    return material


def assign_material(obj: bpy.types.Object, material: bpy.types.Material) -> None:
    if obj.data and hasattr(obj.data, "materials"):
        obj.data.materials.append(material)


def parent_object(obj: bpy.types.Object, parent: bpy.types.Object | None) -> None:
    if parent is not None:
        obj.parent = parent


def smooth_mesh(obj: bpy.types.Object, *, angle: float | None = None) -> None:
    if not isinstance(obj.data, bpy.types.Mesh):
        return
    if angle is not None:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.shade_smooth_by_angle(angle=angle, keep_sharp_edges=True)
        obj.select_set(False)
        return
    for polygon in obj.data.polygons:
        polygon.use_smooth = True


def apply_bevel(obj: bpy.types.Object, width: float, segments: int = 4) -> None:
    if width <= 0:
        return
    bevel = obj.modifiers.new(name="PrecisionBevel", type="BEVEL")
    bevel.width = width
    bevel.segments = segments
    bevel.limit_method = "ANGLE"
    bevel.angle_limit = math.radians(28)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    obj.select_set(False)


def add_empty(
    name: str,
    location: tuple[float, float, float] = (0.0, 0.0, 0.0),
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.08
    obj.location = location
    bpy.context.collection.objects.link(obj)
    parent_object(obj, parent)
    return obj


def add_box(
    name: str,
    size: tuple[float, float, float],
    location: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    bevel: float = 0.0,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    apply_bevel(obj, bevel)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_cylinder(
    name: str,
    radius: float,
    depth: float,
    location: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    bevel: float = 0.0,
    vertices: int = 64,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    apply_bevel(obj, bevel)
    smooth_mesh(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_uv_sphere(
    name: str,
    radius: float,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=radius, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    smooth_mesh(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_uv_dome(
    name: str,
    radius: float,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    cutoff_z: float,
    material: bpy.types.Material,
    *,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, radius=radius, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    vertices_to_remove = [vertex for vertex in mesh.verts if vertex.co.z < cutoff_z]
    bmesh.ops.delete(mesh, geom=vertices_to_remove, context="VERTS")
    boundary = [edge for edge in mesh.edges if len(edge.link_faces) == 1]
    if boundary:
        bmesh.ops.holes_fill(mesh, edges=boundary)
    mesh.to_mesh(obj.data)
    mesh.free()
    smooth_mesh(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_torus(
    name: str,
    major_radius: float,
    minor_radius: float,
    location: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=72,
        minor_segments=16,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    smooth_mesh(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_frustum(
    name: str,
    bottom_size: tuple[float, float],
    top_size: tuple[float, float],
    height: float,
    location: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    bevel: float,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    bottom_x, bottom_y = bottom_size[0] / 2, bottom_size[1] / 2
    top_x, top_y = top_size[0] / 2, top_size[1] / 2
    z0, z1 = -height / 2, height / 2
    vertices = [
        (-bottom_x, -bottom_y, z0),
        (bottom_x, -bottom_y, z0),
        (bottom_x, bottom_y, z0),
        (-bottom_x, bottom_y, z0),
        (-top_x, -top_y, z1),
        (top_x, -top_y, z1),
        (top_x, top_y, z1),
        (-top_x, top_y, z1),
    ]
    faces = [
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    bpy.context.collection.objects.link(obj)
    apply_bevel(obj, bevel, 5)
    smooth_mesh(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_panel(
    name: str,
    outline_xz: list[tuple[float, float]],
    center_y: float,
    thickness: float,
    material: bpy.types.Material,
    *,
    bevel: float,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    half = thickness / 2
    vertices = [(x, center_y - half, z) for x, z in outline_xz] + [(x, center_y + half, z) for x, z in outline_xz]
    count = len(outline_xz)
    faces: list[tuple[int, ...]] = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((index, next_index, count + next_index, count + index))
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    apply_bevel(obj, bevel, 4)
    smooth_mesh(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_panel_yz(
    name: str,
    outline_yz: list[tuple[float, float]],
    center_x: float,
    thickness: float,
    material: bpy.types.Material,
    *,
    bevel: float,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    half = thickness / 2
    vertices = [(center_x - half, y, z) for y, z in outline_yz] + [(center_x + half, y, z) for y, z in outline_yz]
    count = len(outline_yz)
    faces: list[tuple[int, ...]] = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((index, next_index, count + next_index, count + index))
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    apply_bevel(obj, bevel, 4)
    smooth_mesh(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_profile_extrusion_x(
    name: str,
    profile_yz: list[tuple[float, float]],
    width: float,
    material: bpy.types.Material,
    *,
    bevel: float,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    half = width / 2
    vertices = [(-half, y, z) for y, z in profile_yz] + [(half, y, z) for y, z in profile_yz]
    count = len(profile_yz)
    faces: list[tuple[int, ...]] = [tuple(range(count - 1, -1, -1)), tuple(range(count, count * 2))]
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((index, next_index, count + next_index, count + index))
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    apply_bevel(obj, bevel, 6)
    smooth_mesh(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_bezier_profile_extrusion_x(
    name: str,
    profile_yz: list[tuple[float, float]],
    width: float,
    material: bpy.types.Material,
    *,
    edge_rounding: float,
    width_taper: float = 0.0,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    curve = bpy.data.curves.new(name=f"{name}_curve", type="CURVE")
    curve.dimensions = "2D"
    curve.resolution_u = 24
    curve.render_resolution_u = 32
    curve.fill_mode = "BOTH"
    curve.extrude = max(0.0, width / 2 - edge_rounding)
    curve.bevel_depth = edge_rounding
    curve.bevel_resolution = 6
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(profile_yz) - 1)
    spline.use_cyclic_u = True
    for point, (y, z) in zip(spline.bezier_points, profile_yz):
        point.co = (-y, z, 0.0)
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    assign_material(obj, material)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    for vertex in obj.data.vertices:
        x, y, z = vertex.co
        vertex.co = (z, -x, y)
    if width_taper > 0:
        z_values = [vertex.co.z for vertex in obj.data.vertices]
        z_min, z_max = min(z_values), max(z_values)
        z_span = max(0.0001, z_max - z_min)
        for vertex in obj.data.vertices:
            normalized = (vertex.co.z - z_min) / z_span
            center_weight = math.sin(math.pi * normalized) ** 0.8
            factor = 1.0 - width_taper * (1.0 - center_weight)
            vertex.co.x *= factor
    obj.data.update()
    smooth_mesh(obj)
    parent_object(obj, parent)
    return obj


def add_lofted_helmet_cowl(
    name: str,
    rings: list[tuple[float, float, float, float]],
    material: bpy.types.Material,
    *,
    segments: int = 96,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    vertices: list[tuple[float, float, float]] = []
    for z, center_y, radius_x, radius_y in rings:
        for index in range(segments):
            angle = math.tau * index / segments
            vertices.append((radius_x * math.cos(angle), center_y + radius_y * math.sin(angle), z))

    bottom_center_index = len(vertices)
    vertices.append((0.0, rings[0][1], rings[0][0]))
    top_center_index = len(vertices)
    vertices.append((0.0, rings[-1][1], rings[-1][0]))

    faces: list[tuple[int, ...]] = []
    for ring_index in range(len(rings) - 1):
        ring_start = ring_index * segments
        next_ring_start = (ring_index + 1) * segments
        for index in range(segments):
            next_index = (index + 1) % segments
            faces.append(
                (
                    ring_start + index,
                    ring_start + next_index,
                    next_ring_start + next_index,
                    next_ring_start + index,
                )
            )
    faces.extend(
        (bottom_center_index, (index + 1) % segments, index)
        for index in range(segments)
    )
    top_ring_start = (len(rings) - 1) * segments
    faces.extend(
        (top_center_index, top_ring_start + index, top_ring_start + (index + 1) % segments)
        for index in range(segments)
    )

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    smooth_mesh(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_superellipse_loft(
    name: str,
    rings: list[tuple[float, float, float, float, float]],
    material: bpy.types.Material,
    *,
    segments: int = 64,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    vertices: list[tuple[float, float, float]] = []
    for z, center_x, radius_x, radius_y, exponent in rings:
        power = 2.0 / exponent
        for index in range(segments):
            angle = math.tau * index / segments
            cos_angle = math.cos(angle)
            sin_angle = math.sin(angle)
            x = center_x + radius_x * math.copysign(abs(cos_angle) ** power, cos_angle)
            y = radius_y * math.copysign(abs(sin_angle) ** power, sin_angle)
            vertices.append((x, y, z))

    faces: list[tuple[int, ...]] = []
    for ring_index in range(len(rings) - 1):
        ring_start = ring_index * segments
        next_ring_start = (ring_index + 1) * segments
        for index in range(segments):
            next_index = (index + 1) % segments
            faces.append(
                (
                    ring_start + index,
                    ring_start + next_index,
                    next_ring_start + next_index,
                    next_ring_start + index,
                )
            )
    faces.append(tuple(range(segments - 1, -1, -1)))
    top_start = (len(rings) - 1) * segments
    faces.append(tuple(top_start + index for index in range(segments)))

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    smooth_mesh(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_curve_tube(
    name: str,
    points: list[tuple[float, float, float]],
    radius: float,
    material: bpy.types.Material,
    *,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    curve = bpy.data.curves.new(name=f"{name}_curve", type="CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 12
    curve.bevel_depth = radius
    curve.bevel_resolution = 5
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for point, coordinate in zip(spline.bezier_points, points):
        point.co = coordinate
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def add_reference_images() -> None:
    collection = bpy.data.collections.new("ModelingReferences")
    bpy.context.scene.collection.children.link(collection)
    for name, path, location in (
        ("Reference_Original", REFERENCE_ORIGINAL, (-2.4, 0.8, 1.1)),
        ("Reference_Orthographic_Sheet", REFERENCE_SHEET, (2.4, 0.8, 1.1)),
    ):
        if not path.exists():
            continue
        image = bpy.data.images.load(str(path), check_existing=True)
        obj = bpy.data.objects.new(name, None)
        obj.empty_display_type = "IMAGE"
        obj.data = image
        obj.empty_display_size = 1.9
        obj.location = location
        obj.rotation_euler = (math.radians(90), 0.0, 0.0)
        obj.hide_render = True
        collection.objects.link(obj)


def parse_floats(value: str | None, expected: int, default: tuple[float, ...]) -> tuple[float, ...]:
    if not value:
        return default
    parsed = tuple(float(item) for item in value.split())
    if len(parsed) != expected:
        raise ValueError(f"expected {expected} floats, got {len(parsed)} from {value!r}")
    return parsed


def import_official_mesh(
    mesh_name: str,
    path: Path,
    material: bpy.types.Material,
    parent: bpy.types.Object,
    *,
    location: tuple[float, float, float] = (0.0, 0.0, 0.0),
    rotation_quaternion: tuple[float, float, float, float] = (1.0, 0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.wm.stl_import(filepath=str(path))
    imported = list(bpy.context.selected_objects)
    if not imported:
        raise RuntimeError(f"Blender did not import {path}")
    if len(imported) > 1:
        bpy.context.view_layer.objects.active = imported[0]
        bpy.ops.object.join()
    obj = bpy.context.selected_objects[0]
    obj.name = f"official_{mesh_name}"
    obj.location = location
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Quaternion(rotation_quaternion)
    smooth_mesh(obj, angle=math.radians(38))
    assign_material(obj, material)
    parent_object(obj, parent)
    return obj


def reshape_reference_torso(obj: bpy.types.Object) -> None:
    vertices = obj.data.vertices
    if not vertices:
        return
    min_x = min(vertex.co.x for vertex in vertices)
    max_x = max(vertex.co.x for vertex in vertices)
    min_z = min(vertex.co.z for vertex in vertices)
    max_z = max(vertex.co.z for vertex in vertices)
    center_x = (min_x + max_x) / 2
    height = max(max_z - min_z, 1e-6)
    for vertex in vertices:
        height_ratio = (vertex.co.z - min_z) / height
        width_scale = 0.72 + height_ratio * 0.16
        depth_scale = 0.78 + height_ratio * 0.10
        vertex.co.x = center_x + (vertex.co.x - center_x) * depth_scale
        vertex.co.y *= width_scale
        vertex.co.z = max_z - (max_z - vertex.co.z) * 0.84
    obj.data.update()


def build_reference_helmet(
    root: bpy.types.Object,
    materials: dict[str, bpy.types.Material],
    base_z: float,
) -> bpy.types.Object:
    black = materials["black"]
    black_soft = materials["black_soft"]
    joint = materials["joint"]
    carbon = materials["carbon"]
    glass = materials["glass"]
    cyan = materials["cyan"]
    silver_shadow = materials["silver_shadow"]

    neck = add_empty("helmet_neck_assembly", (0, 0, base_z - 0.06), root)
    add_frustum(
        "black_tapered_neck_shroud",
        (0.15, 0.12),
        (0.085, 0.09),
        0.082,
        (0, -0.014, 0),
        black_soft,
        bevel=0.017,
        parent=neck,
    )
    add_box("rear_neck_service_channel", (0.04, 0.022, 0.075), (0, 0.047, -0.005), carbon, bevel=0.009, parent=neck)
    add_panel(
        "helmet_front_neck_bib",
        [
            (-0.078, -0.045),
            (-0.062, 0.0),
            (-0.038, 0.027),
            (0.038, 0.027),
            (0.062, 0.0),
            (0.078, -0.045),
        ],
        -0.078,
        0.02,
        black_soft,
        bevel=0.011,
        parent=neck,
    )

    head = add_empty("helmet_head", (0, 0, base_z), root)
    head.scale = (0.48, 0.56, 0.56)
    head["reference_head_scale"] = 0.56
    head["reference_head_scale_xyz"] = (0.48, 0.56, 0.56)
    add_lofted_helmet_cowl(
        "helmet_black_smooth_cowl",
        [
            (0.052, 0.008, 0.112, 0.112),
            (0.078, 0.008, 0.132, 0.138),
            (0.11, 0.012, 0.146, 0.16),
            (0.148, 0.02, 0.153, 0.178),
            (0.184, 0.03, 0.147, 0.187),
            (0.216, 0.038, 0.128, 0.176),
            (0.244, 0.04, 0.095, 0.137),
            (0.263, 0.034, 0.038, 0.06),
        ],
        black,
        parent=head,
    )
    add_box("helmet_low_forehead_brow_shell", (0.25, 0.038, 0.032), (0, -0.145, 0.147), black, bevel=0.014, parent=head)
    add_box("helmet_rear_service_cap", (0.145, 0.025, 0.028), (0, 0.176, 0.148), black_soft, bevel=0.01, rotation=(math.radians(-3), 0, 0), parent=head)
    for side in (-1, 1):
        label = "left" if side < 0 else "right"
        add_curve_tube(
            f"{label}_sculpted_helmet_side_shell",
            [
                (side * 0.116, -0.154, 0.158),
                (side * 0.121, -0.16, 0.075),
                (side * 0.116, -0.151, -0.014),
                (side * 0.102, -0.113, -0.072),
                (side * 0.074, -0.046, -0.099),
                (side * 0.09, 0.018, -0.078),
                (side * 0.11, 0.062, -0.018),
            ],
            0.018,
            black,
            parent=head,
        )
        add_box(f"{label}_silver_occipital_hinge", (0.022, 0.044, 0.10), (side * 0.132, 0.074, 0.066), silver_shadow, bevel=0.009, rotation=(0, 0, side * math.radians(5)), parent=head)
        add_cylinder(f"{label}_helmet_side_bearing", 0.023, 0.016, (side * 0.14, 0.015, 0.11), black_soft, rotation=(0, math.radians(90), 0), bevel=0.004, parent=head)
    visor_points = [
        (-0.112, -0.148, 0.154),
        (-0.122, -0.152, 0.09),
        (-0.108, -0.156, 0.018),
        (-0.066, -0.158, -0.048),
        (-0.035, -0.159, -0.068),
        (0.0, -0.159, -0.072),
        (0.035, -0.159, -0.068),
        (0.066, -0.158, -0.048),
        (0.108, -0.156, 0.018),
        (0.122, -0.152, 0.09),
        (0.112, -0.148, 0.154),
    ]
    add_curve_tube("black_u_visor_frame", visor_points, 0.013, joint, parent=head)
    add_curve_tube("cyan_u_visor_light", [(x, y - 0.009, z) for x, y, z in visor_points], 0.0044, cyan, parent=head)
    add_box("dark_glass_sensor_band", (0.224, 0.026, 0.044), (0, -0.164, 0.119), glass, bevel=0.011, parent=head)
    add_box("cyan_horizontal_sensor_slit", (0.205, 0.01, 0.013), (0, -0.181, 0.111), cyan, bevel=0.006, parent=head)
    add_box("bright_sensor_core", (0.142, 0.006, 0.006), (0, -0.188, 0.111), cyan, bevel=0.003, parent=head)
    for index, x in enumerate((-0.066, -0.022, 0.022, 0.066)):
        add_cylinder(f"front_sensor_camera_{index}", 0.0065, 0.006, (x, -0.178, 0.13), glass, rotation=(math.radians(90), 0, 0), bevel=0.0015, vertices=32, parent=head)
    add_box("rear_graphite_sensor_panel", (0.145, 0.022, 0.115), (0, 0.174, 0.102), carbon, bevel=0.022, parent=head)
    add_box("rear_silver_neck_yoke", (0.128, 0.048, 0.032), (0, 0.074, -0.008), silver_shadow, bevel=0.012, parent=head)
    add_box("rear_cyan_helmet_edge_rail", (0.09, 0.01, 0.01), (0, 0.191, 0.139), cyan, bevel=0.004, parent=head)
    add_box("black_open_lower_chin", (0.108, 0.07, 0.034), (0, -0.032, -0.052), joint, bevel=0.013, parent=head)
    return head


def add_reference_hand_fingers(
    parent: bpy.types.Object,
    side: int,
    materials: dict[str, bpy.types.Material],
) -> None:
    joint = materials["joint"]
    label = "left" if side < 0 else "right"
    add_box(
        f"{label}_reference_palm_shell",
        (0.105, 0.082, 0.06),
        (0.215, 0.0, 0.0),
        joint,
        bevel=0.017,
        parent=parent,
    )
    finger_specs = (
        (-0.017, 0.08, -4.0),
        (-0.006, 0.095, -1.5),
        (0.006, 0.09, 1.5),
        (0.017, 0.076, 4.0),
    )
    start_x = 0.245
    for index, (y_offset, upper_length, spread_degrees) in enumerate(finger_specs):
        spread = math.radians(spread_degrees)
        upper_center = (
            start_x + math.cos(spread) * upper_length / 2,
            y_offset + math.sin(spread) * upper_length / 2,
            0.0,
        )
        add_box(
            f"{label}_reference_finger_{index}_upper",
            (upper_length, 0.019, 0.023),
            upper_center,
            joint,
            bevel=0.006,
            rotation=(0, 0, spread),
            parent=parent,
        )
        lower_length = upper_length * 0.5
        lower_spread = spread + math.radians(spread_degrees * 0.4)
        upper_end_x = start_x + math.cos(spread) * upper_length
        upper_end_y = y_offset + math.sin(spread) * upper_length
        lower_center = (
            upper_end_x + math.cos(lower_spread) * lower_length / 2,
            upper_end_y + math.sin(lower_spread) * lower_length / 2,
            0.0,
        )
        add_box(
            f"{label}_reference_finger_{index}_lower",
            (lower_length, 0.018, 0.022),
            lower_center,
            joint,
            bevel=0.0055,
            rotation=(0, 0, lower_spread),
            parent=parent,
        )

    thumb_angle = side * math.radians(24)
    add_box(
        f"{label}_reference_thumb",
        (0.082, 0.024, 0.024),
        (0.22, side * 0.042, 0.0),
        joint,
        bevel=0.0065,
        rotation=(0, 0, thumb_angle),
        parent=parent,
    )


def decorate_reference_body(
    original_name: str,
    body: bpy.types.Object,
    materials: dict[str, bpy.types.Material],
) -> None:
    silver = materials["silver"]
    silver_hi = materials["silver_hi"]
    silver_shadow = materials["silver_shadow"]
    joint = materials["joint"]
    carbon = materials["carbon"]
    black_soft = materials["black_soft"]
    sole = materials["sole"]

    if original_name == "torso_link":
        add_superellipse_loft(
            "reference_torso_silver_shell",
            [
                (-0.01, 0.004, 0.07, 0.11, 3.2),
                (0.045, 0.008, 0.075, 0.12, 3.5),
                (0.115, 0.011, 0.08, 0.135, 3.8),
                (0.195, 0.014, 0.088, 0.145, 4.0),
                (0.26, 0.013, 0.09, 0.148, 3.8),
                (0.31, 0.008, 0.084, 0.14, 3.3),
            ],
            silver,
            parent=body,
        )
        add_box("reference_upper_chest_collar", (0.11, 0.23, 0.03), (0.01, 0, 0.292), silver_hi, bevel=0.012, parent=body)
        for index, y in enumerate((-0.042, 0.042)):
            add_cylinder(
                f"reference_lower_chest_fastener_{index}",
                0.007,
                0.005,
                (0.08, y * 1.45, 0.045),
                silver_shadow,
                rotation=(0, math.radians(90), 0),
                bevel=0.0015,
                vertices=32,
                parent=body,
            )
        return

    if original_name.endswith("shoulder_yaw_link"):
        label = "left" if original_name.startswith("left") else "right"
        add_frustum(
            f"{label}_reference_upper_arm_shell",
            (0.07, 0.066),
            (0.10, 0.096),
            0.145,
            (0, 0, -0.064),
            silver,
            bevel=0.018,
            parent=body,
        )
        return

    if original_name.endswith("elbow_roll_link"):
        label = "left" if original_name.startswith("left") else "right"
        side = -1 if label == "left" else 1
        shell_axis = add_empty(f"{label}_reference_forearm_axis", (0.085, 0, 0), body)
        shell_axis.rotation_euler = (0, math.radians(90), 0)
        add_frustum(
            f"{label}_reference_forearm_shell",
            (0.06, 0.058),
            (0.095, 0.09),
            0.175,
            (0, 0, 0),
            silver_hi,
            bevel=0.017,
            parent=shell_axis,
        )
        add_box(f"{label}_reference_wrist_cuff", (0.028, 0.064, 0.064), (0.17, 0, 0), joint, bevel=0.01, parent=body)
        add_reference_hand_fingers(body, side, materials)
        return

    if original_name.endswith("hip_yaw_link"):
        label = "left" if original_name.startswith("left") else "right"
        thigh = add_bezier_profile_extrusion_x(
            f"{label}_reference_thigh_shell",
            [
                (-0.038, -0.285),
                (-0.047, -0.245),
                (-0.055, -0.145),
                (-0.052, -0.045),
                (-0.043, 0.012),
                (0.043, 0.012),
                (0.052, -0.045),
                (0.055, -0.145),
                (0.047, -0.245),
                (0.038, -0.285),
            ],
            0.12,
            silver,
            edge_rounding=0.012,
            width_taper=0.05,
            parent=body,
        )
        thigh.location = (-0.026, 0, 0)
        add_box(f"{label}_thigh_black_insert", (0.014, 0.044, 0.12), (-0.071, 0, -0.15), carbon, bevel=0.005, parent=body)
        return

    if original_name.endswith("knee_link"):
        label = "left" if original_name.startswith("left") else "right"
        calf = add_bezier_profile_extrusion_x(
            f"{label}_reference_calf_shell",
            [
                (-0.03, -0.255),
                (-0.037, -0.218),
                (-0.043, -0.13),
                (-0.044, -0.06),
                (-0.038, 0.006),
                (0.038, 0.006),
                (0.044, -0.06),
                (0.043, -0.13),
                (0.037, -0.218),
                (0.03, -0.255),
            ],
            0.09,
            silver_hi,
            edge_rounding=0.009,
            width_taper=0.08,
            parent=body,
        )
        calf.location = (0.004, 0, 0)
        add_box(f"{label}_calf_black_insert", (0.012, 0.034, 0.12), (-0.043, 0, -0.16), carbon, bevel=0.004, parent=body)
        return

    if original_name.endswith("ankle_roll_link"):
        label = "left" if original_name.startswith("left") else "right"
        add_panel(
            f"{label}_reference_shoe_sole",
            [
                (-0.064, -0.068),
                (-0.058, -0.038),
                (-0.05, -0.012),
                (0.095, -0.002),
                (0.135, -0.008),
                (0.158, -0.025),
                (0.152, -0.055),
                (0.115, -0.065),
            ],
            0,
            0.11,
            sole,
            bevel=0.012,
            parent=body,
        )
        add_panel(
            f"{label}_reference_shoe_upper",
            [
                (-0.048, -0.045),
                (-0.05, -0.012),
                (-0.032, 0.022),
                (0.09, 0.027),
                (0.13, 0.014),
                (0.153, -0.014),
                (0.132, -0.046),
            ],
            0,
            0.105,
            black_soft,
            bevel=0.014,
            parent=body,
        )


def build_official_g1_robot(materials: dict[str, bpy.types.Material]) -> bpy.types.Object:
    if not OFFICIAL_G1_XML.exists():
        raise FileNotFoundError(f"missing official Unitree G1 XML: {OFFICIAL_G1_XML}")
    xml_root = ET.parse(OFFICIAL_G1_XML).getroot()
    mesh_files = {
        mesh.get("name"): OFFICIAL_G1_MESH_DIR / mesh.get("file")
        for mesh in xml_root.findall("./asset/mesh")
        if mesh.get("name") and mesh.get("file")
    }
    mesh_files["torso_link"] = OFFICIAL_G1_MESH_DIR / "torso_link_23dof_rev_1_0.STL"
    root = add_empty("reference_office_robot_unitree_style")
    root.scale = (1.08, 1.08, 1.08)
    root["source_model"] = "Unitree G1 official rev1: 23dof torso with 29dof articulated limbs"
    root["source_commit"] = "276801e46c5d433564f24658bac64f254b7d2d4b"
    root["source_license"] = "BSD-3-Clause"
    root["reference_style"] = "official silver Unitree G1 with restrained cyan sensor trim"
    official_frame = add_empty("official_unitree_g1_body", parent=root)
    official_frame.rotation_euler = (0.0, 0.0, math.radians(-90))

    body_name_map = {
        "pelvis": "official_pelvis",
        "torso_link": "torso_chest_armor",
        "left_hip_pitch_link": "left_leg",
        "right_hip_pitch_link": "right_leg",
        "left_shoulder_pitch_link": "left_arm",
        "right_shoulder_pitch_link": "right_arm",
    }
    head_control: bpy.types.Object | None = None
    head_pivot = Vector((0.0039635, 0.0, 0.29))

    def material_for_mesh(mesh_name: str, color: tuple[float, float, float, float]) -> bpy.types.Material:
        lowered = mesh_name.lower()
        if mesh_name == "head_link" or "rubber_hand" in lowered:
            return materials["black"]
        if "waist" in lowered:
            return materials["joint"]
        if mesh_name == "torso_link":
            return materials["silver_hi"]
        return materials["silver"] if color[0] >= 0.45 else materials["joint"]

    def build_body(element: ET.Element, parent: bpy.types.Object) -> bpy.types.Object:
        nonlocal head_control
        original_name = element.get("name", "official_body")
        body = add_empty(body_name_map.get(original_name, original_name), parent=parent)
        body["unitree_body_name"] = original_name
        body.location = parse_floats(element.get("pos"), 3, (0.0, 0.0, 0.0))
        body.rotation_mode = "QUATERNION"
        rotation = Quaternion(parse_floats(element.get("quat"), 4, (1.0, 0.0, 0.0, 0.0)))
        joint = element.find("joint")
        if joint is not None and joint.get("name"):
            joint_name = joint.get("name", "")
            pose_angle = JOINT_POSE_RADIANS.get(joint_name, 0.0)
            axis = Vector(parse_floats(joint.get("axis"), 3, (0.0, 0.0, 1.0)))
            if pose_angle and axis.length > 0:
                axis.normalize()
                rotation = rotation @ Quaternion(axis, pose_angle)
                body["reference_pose_radians"] = pose_angle
            body["unitree_joint_name"] = joint_name
        body.rotation_quaternion = rotation

        imported_meshes: set[str] = set()
        for geom in element.findall("geom"):
            mesh_name = geom.get("mesh")
            if not mesh_name or mesh_name in imported_meshes or mesh_name == "logo_link":
                continue
            mesh_path = mesh_files.get(mesh_name)
            if not mesh_path or not mesh_path.exists():
                raise FileNotFoundError(f"missing official Unitree mesh {mesh_name}: {mesh_path}")
            color = parse_floats(geom.get("rgba"), 4, (0.7, 0.7, 0.7, 1.0))
            mesh_parent = body
            mesh_location = Vector(parse_floats(geom.get("pos"), 3, (0.0, 0.0, 0.0)))
            if mesh_name == "torso_link":
                mesh_location += Vector((0.0039635, 0.0, -0.044))
            if mesh_name == "head_link":
                if head_control is None:
                    head_control = add_empty("helmet_head", tuple(head_pivot), body)
                    head_control.scale = (1.0, 0.88, 0.88)
                    head_control["unitree_mesh_name"] = "head_link"
                mesh_parent = head_control
                mesh_location -= head_pivot
            mesh_obj = import_official_mesh(
                mesh_name,
                mesh_path,
                material_for_mesh(mesh_name, color),
                mesh_parent,
                location=tuple(mesh_location),
                rotation_quaternion=parse_floats(geom.get("quat"), 4, (1.0, 0.0, 0.0, 0.0)),
            )
            mesh_obj["unitree_mesh_name"] = mesh_name
            if mesh_name == "torso_link":
                reshape_reference_torso(mesh_obj)
            elif mesh_name.endswith("knee_link"):
                mesh_obj.scale.x *= 0.88
                mesh_obj.scale.y *= 0.92
            elif mesh_name.endswith("ankle_roll_link"):
                mesh_obj.scale.x *= 0.86
            imported_meshes.add(mesh_name)

        if original_name.endswith("shoulder_pitch_link"):
            side = 1 if original_name.startswith("left") else -1
            add_cylinder(
                f"{original_name}_outer_joint_cover",
                0.034,
                0.026,
                (0.0, side * 0.04, -0.01),
                materials["silver_hi"],
                rotation=(0.0, math.radians(90), 0.0),
                bevel=0.004,
                parent=body,
            )
        elif original_name.endswith("shoulder_roll_link"):
            side = 1 if original_name.startswith("left") else -1
            add_cylinder(
                f"{original_name}_inner_joint_cover",
                0.03,
                0.03,
                (-0.004, side * 0.006, -0.053),
                materials["silver_shadow"],
                bevel=0.004,
                parent=body,
            )

        for child in element.findall("body"):
            build_body(child, body)
        return body

    worldbody = xml_root.find("worldbody")
    if worldbody is None:
        raise ValueError("official Unitree G1 XML has no worldbody")
    for body_element in worldbody.findall("body"):
        build_body(body_element, official_frame)

    if head_control is None:
        raise RuntimeError("official Unitree G1 model did not create helmet_head")
    add_box(
        "official_dark_sensor_band",
        (0.008, 0.108, 0.026),
        (0.067, 0.0, 0.116),
        materials["glass"],
        bevel=0.006,
        parent=head_control,
    )
    add_curve_tube(
        "official_cyan_u_visor_light",
        [
            (0.070, -0.052, 0.121),
            (0.072, -0.056, 0.092),
            (0.072, -0.050, 0.045),
            (0.071, -0.030, 0.012),
            (0.071, 0.0, 0.002),
            (0.071, 0.030, 0.012),
            (0.072, 0.050, 0.045),
            (0.072, 0.056, 0.092),
            (0.070, 0.052, 0.121),
        ],
        0.0023,
        materials["cyan"],
        parent=head_control,
    )
    add_box(
        "official_cyan_sensor_slit",
        (0.008, 0.104, 0.008),
        (0.071, 0.0, 0.117),
        materials["cyan"],
        bevel=0.003,
        parent=head_control,
    )
    add_panel_yz(
        "official_inner_face_diffuser",
        [
            (-0.044, 0.006),
            (-0.056, 0.036),
            (-0.050, 0.078),
            (-0.030, 0.094),
            (0.030, 0.094),
            (0.050, 0.078),
            (0.056, 0.036),
            (0.044, 0.006),
        ],
        0.034,
        0.008,
        materials["glass"],
        bevel=0.008,
        parent=head_control,
    )
    add_panel_yz(
        "official_rear_head_closeout",
        [
            (-0.060, -0.004),
            (-0.069, 0.035),
            (-0.066, 0.104),
            (-0.046, 0.151),
            (0.046, 0.151),
            (0.066, 0.104),
            (0.069, 0.035),
            (0.060, -0.004),
        ],
        -0.048,
        0.020,
        materials["black_soft"],
        bevel=0.012,
        parent=head_control,
    )

    nameplate = add_empty("provider_nameplate_mount", (0, -0.082, 1.09), root)
    nameplate["provider_logo_slot"] = True
    nameplate["provider_logo_renderer"] = "ProviderLogoBadge"

    rear_cover = add_empty("neutral_rear_identity_mount", (0, 0.085, 1.075), root)
    rear_cover["neutral_identity_surface"] = True
    return root


def add_preview_environment(materials: dict[str, bpy.types.Material]) -> bpy.types.Object:
    floor = add_box("PreviewFloor", (4.6, 4.6, 0.04), (0, 0, -0.04), materials["preview_floor"], bevel=0.02)
    for name, location, energy, size, color in (
        ("KeyLight", (3.2, -4.0, 5.0), 500.0, 3.2, "#f2f7fa"),
        ("FillLight", (-3.5, -1.6, 3.2), 90.0, 3.1, "#b9c9d3"),
        ("RimLight", (0.5, 3.6, 4.0), 350.0, 2.4, "#8fc8dc"),
    ):
        light_data = bpy.data.lights.new(name=name, type="AREA")
        light_data.energy = energy
        light_data.shape = "DISK"
        light_data.size = size
        light_data.color = rgba(color)[:3]
        light = bpy.data.objects.new(name, light_data)
        light.location = location
        bpy.context.collection.objects.link(light)
        point_camera(light, (0, 0, 0.9))
    return floor


def point_camera(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def align_model_to_floor(root: bpy.types.Object) -> None:
    bpy.context.view_layer.update()
    mesh_points = [
        child.matrix_world @ Vector(corner)
        for child in root.children_recursive
        if child.type == "MESH"
        for corner in child.bound_box
    ]
    if not mesh_points:
        return
    offset = -min(point.z for point in mesh_points)
    root.location.z += offset
    root["floor_alignment_offset"] = offset
    bpy.context.view_layer.update()


def render_views(root: bpy.types.Object, materials: dict[str, bpy.types.Material]) -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 800
    scene.render.resolution_y = 1066
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.world.color = rgba("#e3e8ec")[:3]
    if scene.world.use_nodes:
        background = scene.world.node_tree.nodes.get("Background")
        background.inputs["Color"].default_value = rgba("#e3e8ec")
        background.inputs["Strength"].default_value = 0.34
    add_preview_environment(materials)

    camera_data = bpy.data.cameras.new("OrthographicReferenceCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 1.86
    camera = bpy.data.objects.new("OrthographicReferenceCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera

    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    views = {
        "front": ((0.0, -5.2, 1.0), (0.0, 0.0, 0.88)),
        "side": ((5.2, 0.0, 1.0), (0.0, 0.0, 0.88)),
        "back": ((0.0, 5.2, 1.0), (0.0, 0.0, 0.88)),
    }
    for name, (position, target) in views.items():
        camera.location = position
        point_camera(camera, target)
        scene.render.filepath = str(PREVIEW_DIR / f"{name}.png")
        bpy.ops.render.render(write_still=True)


def export_model(root: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = root
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def main() -> None:
    clear_scene()
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0
    scene.world.use_nodes = True

    materials = {
        "silver": make_material("SilverBrushed", "#aeb7bf", metallic=0.58, roughness=0.42, coat=0.16),
        "silver_hi": make_material("SilverHighlight", "#c5ccd2", metallic=0.54, roughness=0.36, coat=0.18),
        "silver_shadow": make_material("SilverShadow", "#7b8791", metallic=0.5, roughness=0.44, coat=0.12),
        "black": make_material("HelmetBlack", "#0c1117", metallic=0.2, roughness=0.44, coat=0.14),
        "black_soft": make_material("GraphiteBlack", "#171d24", metallic=0.22, roughness=0.48, coat=0.1),
        "joint": make_material("JointBlack", "#080c11", metallic=0.5, roughness=0.38),
        "carbon": make_material("CarbonInsert", "#242c34", metallic=0.28, roughness=0.46),
        "glass": make_material("SensorGlass", "#03080d", metallic=0.12, roughness=0.16, coat=0.42),
        "cyan": make_material("SensorCyan", "#43c8e6", metallic=0.04, roughness=0.3, emission="#43c8e6", emission_strength=0.62),
        "seam": make_material("MechanicalSeam", "#73808b", metallic=0.48, roughness=0.4),
        "sole": make_material("ShoePolymer", "#05080c", metallic=0.18, roughness=0.52),
        "preview_floor": make_material("PreviewFloorMaterial", "#d8dde1", metallic=0.0, roughness=0.78),
    }

    add_reference_images()
    root = build_official_g1_robot(materials)
    align_model_to_floor(root)
    export_model(root)
    render_views(root, materials)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), compress=True)
    print(f"generated GLB: {GLB_PATH}")
    print(f"saved Blender source: {BLEND_PATH}")
    print(f"rendered orthographic previews: {PREVIEW_DIR}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"reference robot Blender generation failed: {exc}", file=sys.stderr)
        raise
