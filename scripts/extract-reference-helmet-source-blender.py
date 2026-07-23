from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix


REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = REPO_ROOT / "src/renderer/src/assets/robots/reference-helmet-source.blend"
MOUNT_NAME = "reference_helmet_axis_mount"
SOURCE_COLLECTION_NAME = "ReferenceHelmetSource"

SHELL_PART_NAMES = [
    "helmet_black_smooth_cowl",
    "black_u_visor_frame",
    "black_tapered_neck_shroud",
]

DETAIL_ROLES = {
    "black_u_visor_frame": "joint",
    "cyan_u_visor_light": "cyan",
    "dark_glass_sensor_band": "glass",
    "cyan_horizontal_sensor_slit": "cyan",
    "bright_sensor_core": "cyan",
    "front_sensor_camera_0": "glass",
    "front_sensor_camera_1": "glass",
    "front_sensor_camera_2": "glass",
    "front_sensor_camera_3": "glass",
    "lower_sensor_puck": "joint",
    "rear_neck_service_channel": "carbon",
}


def build_authoring_geometry() -> None:
    generator_path = REPO_ROOT / "scripts/generate-reference-robot-blender.py"
    spec = importlib.util.spec_from_file_location("reference_robot_generator", generator_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load reference robot generator: {generator_path}")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    generator.clear_scene()
    authoring_material = generator.make_material(
        "HelmetAuthoringMaterial",
        "#111820",
        metallic=0.2,
        roughness=0.45,
    )
    materials = {
        role: authoring_material
        for role in ("black", "black_soft", "joint", "carbon", "glass", "cyan")
    }
    mount = generator.add_empty(MOUNT_NAME)
    generator.build_reference_helmet_authoring_geometry(mount, materials, 0.025)
    bpy.context.view_layer.update()


def object_by_name(name: str) -> bpy.types.Object:
    obj = bpy.data.objects.get(name)
    if obj is None:
        raise RuntimeError(f"source blend is missing required object {name!r}")
    return obj


def activate(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def duplicate_as_baked_mesh(
    source: bpy.types.Object,
    collection: bpy.types.Collection,
    mount_inverse: Matrix,
) -> bpy.types.Object:
    duplicate = source.copy()
    duplicate.data = source.data.copy()
    duplicate.parent = None
    collection.objects.link(duplicate)
    duplicate.matrix_world = source.matrix_world.copy()
    if duplicate.type != "MESH":
        activate(duplicate)
        bpy.ops.object.convert(target="MESH")
        duplicate = bpy.context.object
    relative_matrix = mount_inverse @ duplicate.matrix_world
    duplicate.data.transform(relative_matrix)
    duplicate.matrix_world = Matrix.Identity(4)
    duplicate.data.update()
    return duplicate


def create_profile_extrusion_x(
    name: str,
    collection: bpy.types.Collection,
    center_x: float,
    width: float,
    profile_yz: list[tuple[float, float]],
) -> bpy.types.Object:
    half_width = width / 2
    vertices = [(center_x - half_width, y, z) for y, z in profile_yz]
    vertices.extend((center_x + half_width, y, z) for y, z in profile_yz)
    count = len(profile_yz)
    faces: list[tuple[int, ...]] = [
        tuple(range(count - 1, -1, -1)),
        tuple(range(count, count * 2)),
    ]
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((index, next_index, count + next_index, count + index))
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def create_shoulder_mount_loop(
    name: str,
    collection: bpy.types.Collection,
    center_x: float,
) -> bpy.types.Object:
    curve = bpy.data.curves.new(name=f"{name}_curve", type="CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 16
    curve.render_resolution_u = 24
    curve.bevel_depth = 0.0015
    curve.bevel_resolution = 4
    spline = curve.splines.new("BEZIER")
    points = [
        (center_x - 0.006, -0.045, -0.035),
        (center_x - 0.006, -0.045, -0.020),
        (center_x, -0.045, -0.012),
        (center_x + 0.006, -0.045, -0.020),
        (center_x + 0.006, -0.045, -0.035),
    ]
    spline.bezier_points.add(len(points) - 1)
    for point, coordinate in zip(spline.bezier_points, points):
        point.co = coordinate
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    collection.objects.link(obj)
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    obj.name = name
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def merge_shell_parts(parts: list[bpy.types.Object]) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    shell = bpy.context.object
    shell.name = "helmet_black_smooth_cowl"
    shell.data.name = "helmet_black_subd_shell_mesh"

    mesh = bmesh.new()
    mesh.from_mesh(shell.data)
    bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=1e-5)
    mesh.normal_update()
    mesh.to_mesh(shell.data)
    mesh.free()

    remesh = shell.modifiers.new(name="QuadSurfaceRemesh", type="REMESH")
    remesh.mode = "SMOOTH"
    remesh.octree_depth = 6
    remesh.scale = 0.92
    remesh.use_remove_disconnected = False
    remesh.use_smooth_shade = True
    activate(shell)
    bpy.ops.object.modifier_apply(modifier=remesh.name)

    shell.data.remesh_voxel_size = 0.0055
    shell.data.remesh_voxel_adaptivity = 0.0
    activate(shell)
    bpy.ops.object.voxel_remesh()

    smooth = shell.modifiers.new(name="SurfaceRelax", type="SMOOTH")
    smooth.factor = 0.20
    smooth.iterations = 2
    bpy.context.view_layer.objects.active = shell
    bpy.ops.object.modifier_apply(modifier=smooth.name)

    topology = bmesh.new()
    topology.from_mesh(shell.data)
    remaining = set(topology.verts)
    island_count = 0
    island_diagnostics: list[dict[str, object]] = []
    while remaining:
        island_count += 1
        island_vertices = [remaining.pop()]
        stack = list(island_vertices)
        while stack:
            vertex = stack.pop()
            for edge in vertex.link_edges:
                neighbor = edge.other_vert(vertex)
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    island_vertices.append(neighbor)
                    stack.append(neighbor)
        island_diagnostics.append(
            {
                "vertices": len(island_vertices),
                "x": (
                    round(min(vertex.co.x for vertex in island_vertices), 4),
                    round(max(vertex.co.x for vertex in island_vertices), 4),
                ),
                "y": (
                    round(min(vertex.co.y for vertex in island_vertices), 4),
                    round(max(vertex.co.y for vertex in island_vertices), 4),
                ),
                "z": (
                    round(min(vertex.co.z for vertex in island_vertices), 4),
                    round(max(vertex.co.z for vertex in island_vertices), 4),
                ),
            }
        )

    non_manifold_edges = sum(1 for edge in topology.edges if not edge.is_manifold)
    degenerate_faces = sum(1 for face in topology.faces if face.calc_area() <= 1e-10)
    non_quad_faces = sum(1 for face in topology.faces if len(face.verts) != 4)
    topology.free()

    face_count = len(shell.data.polygons)
    if face_count > 15000:
        raise RuntimeError(
            f"quad remesh did not reach the face budget: {face_count} faces"
        )
    if non_manifold_edges:
        raise RuntimeError(f"helmet shell contains {non_manifold_edges} non-manifold edges")
    if degenerate_faces:
        raise RuntimeError(f"helmet shell contains {degenerate_faces} degenerate faces")
    if non_quad_faces:
        raise RuntimeError(f"helmet shell contains {non_quad_faces} non-quad faces")
    if island_count != 1:
        raise RuntimeError(
            f"helmet shell must be one connected island, found {island_count}: "
            f"{island_diagnostics}"
        )

    subdivision = shell.modifiers.new(name="HelmetSubdivision", type="SUBSURF")
    subdivision.subdivision_type = "CATMULL_CLARK"
    subdivision.levels = 1
    subdivision.render_levels = 1
    for polygon in shell.data.polygons:
        polygon.use_smooth = True

    shell["helmet_material_role"] = "black"
    shell["reference_component"] = "single_continuous_subd_shell"
    shell["reference_silhouette"] = "orthographic_single_shell_source_asset"
    shell["source_asset"] = "reference-helmet-source.blend"
    shell["source_topology"] = "classic_remesh_voxel_quad_subdivision"
    shell["source_vertex_count"] = len(shell.data.vertices)
    shell["source_face_count"] = face_count
    shell["source_island_count"] = island_count
    shell["source_non_manifold_edges"] = non_manifold_edges
    shell["source_degenerate_faces"] = degenerate_faces
    shell["source_non_quad_faces"] = non_quad_faces
    print(
        "helmet source topology: "
        f"vertices={len(shell.data.vertices)}, faces={face_count}, islands={island_count}, "
        f"non_manifold={non_manifold_edges}, degenerate={degenerate_faces}, "
        f"non_quad={non_quad_faces}"
    )
    return shell


def clear_materials(obj: bpy.types.Object) -> None:
    if obj.data and hasattr(obj.data, "materials"):
        obj.data.materials.clear()


def create_source_asset() -> None:
    build_authoring_geometry()
    mount = object_by_name(MOUNT_NAME)
    bpy.context.view_layer.update()
    mount_inverse = mount.matrix_world.inverted()

    source_collection = bpy.data.collections.new(SOURCE_COLLECTION_NAME)
    bpy.context.scene.collection.children.link(source_collection)
    head_root = bpy.data.objects.new("helmet_head", None)
    head_root.empty_display_type = "PLAIN_AXES"
    head_root.empty_display_size = 0.05
    source_collection.objects.link(head_root)
    head_root["reference_style"] = "orthographic single-shell service helmet"
    head_root["reference_source"] = "docs/visual-references/reference-robot-orthographic-sheet.png"

    shell_parts = [
        duplicate_as_baked_mesh(object_by_name(name), source_collection, mount_inverse)
        for name in SHELL_PART_NAMES
    ]
    cowl = shell_parts[0]
    for vertex in cowl.data.vertices:
        vertex.co.x *= 0.93
        if vertex.co.y > 0:
            vertex.co.y *= 1.30
            rear_ratio = min(1.0, vertex.co.y / 0.145)
            underside_weight = max(0.0, min(1.0, (0.220 - vertex.co.z) / 0.070))
            vertex.co.z -= 0.045 * rear_ratio ** 1.4 * underside_weight
    cowl.data.update()

    frame_shell = shell_parts[1]
    for vertex in frame_shell.data.vertices:
        vertex.co.x *= 0.96
    frame_shell.data.update()

    neck_shroud = shell_parts[2]
    for vertex in neck_shroud.data.vertices:
        upper_ratio = max(0.0, min(1.0, (vertex.co.z - 0.005) / 0.053))
        vertex.co.x *= 1.0 + 0.28 * upper_ratio
        vertex.co.y -= 0.022 * upper_ratio
        lower_ratio = 1.0 - max(0.0, min(1.0, (vertex.co.z + 0.020) / 0.078))
        if vertex.co.y > 0:
            vertex.co.y = vertex.co.y * (1.0 + 0.35 * lower_ratio) + 0.008 * lower_ratio
        vertex.co.y += 0.009 * lower_ratio
        vertex.co.x *= 1.0 + 0.30 * lower_ratio
    neck_shroud.data.update()

    front_bridge_profile = [
        (-0.069, 0.078),
        (-0.052, 0.096),
        (-0.035, 0.070),
        (-0.022, 0.052),
        (-0.024, 0.028),
        (-0.048, 0.020),
        (-0.067, 0.034),
    ]
    shell_parts.extend(
        create_profile_extrusion_x(
            f"helmet_front_neck_bridge_{label}",
            source_collection,
            center_x=side * 0.061,
            width=0.016,
            profile_yz=front_bridge_profile,
        )
        for side, label in ((-1, "left"), (1, "right"))
    )
    shell = merge_shell_parts(shell_parts)
    clear_materials(shell)
    shell.parent = head_root

    details: dict[str, bpy.types.Object] = {}
    for name, material_role in DETAIL_ROLES.items():
        detail = duplicate_as_baked_mesh(object_by_name(name), source_collection, mount_inverse)
        detail.name = name
        clear_materials(detail)
        detail["helmet_material_role"] = material_role
        detail.parent = head_root
        if name in {
            "black_u_visor_frame",
            "cyan_u_visor_light",
            "dark_glass_sensor_band",
            "cyan_horizontal_sensor_slit",
            "bright_sensor_core",
            "front_sensor_camera_0",
            "front_sensor_camera_1",
            "front_sensor_camera_2",
            "front_sensor_camera_3",
            "lower_sensor_puck",
        }:
            for vertex in detail.data.vertices:
                vertex.co.x *= 0.96
            detail.data.update()
        details[name] = detail

    for side, label in ((-1, "left"), (1, "right")):
        mount = create_shoulder_mount_loop(
            f"helmet_shoulder_mount_{label}",
            source_collection,
            center_x=side * 0.114,
        )
        mount["helmet_material_role"] = "joint"
        mount["reference_component"] = "shoulder_mount_loop"
        mount.parent = head_root
        details[mount.name] = mount

    visor_frame = details["black_u_visor_frame"]
    visor_frame.parent = shell
    visor_frame["visor_attachment"] = shell.name
    visor_frame["reference_component"] = "beveled_annular_face_shell"
    visor_light = details["cyan_u_visor_light"]
    visor_light.parent = visor_frame
    visor_light["visor_attachment"] = visor_frame.name
    visor_light["reference_component"] = "flush_inset_light_tube"
    visor_light["surface_offset_m"] = 0.0008

    head_root["source_mesh_topology"] = "classic_remesh_voxel_quad_subdivision"
    head_root["authoring_subdivision_levels"] = 1
    head_root["production_subdivision_levels"] = 0
    head_root["source_asset_version"] = 2

    keep_objects = {head_root, shell, *details.values()}
    for obj in list(bpy.data.objects):
        if obj not in keep_objects:
            bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(bpy.data.collections):
        if collection != source_collection:
            bpy.data.collections.remove(collection)

    head_root.name = "helmet_head"
    shell.name = "helmet_black_smooth_cowl"
    for expected_name, detail in details.items():
        detail.name = expected_name
    visor_frame["visor_attachment"] = "helmet_black_smooth_cowl"
    visor_light["visor_attachment"] = "black_u_visor_frame"

    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.length_unit = "METERS"
    bpy.context.scene.unit_settings.scale_length = 1.0
    bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT_PATH), compress=True)
    print(f"saved reference helmet source: {OUTPUT_PATH}")


if __name__ == "__main__":
    try:
        create_source_asset()
    except Exception as exc:
        print(f"reference helmet source extraction failed: {exc}", file=sys.stderr)
        raise
