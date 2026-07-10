# Unitree G1 rev 1.0 reference meshes

Source: `unitreerobotics/unitree_rl_gym`,
`resources/robots/g1_description`.

- Upstream repository: https://github.com/unitreerobotics/unitree_rl_gym
- Pinned upstream commit: `276801e46c5d433564f24658bac64f254b7d2d4b`
- Current snapshot model: `g1_29dof_rev_1_0.xml`
- License: BSD-3-Clause, retained verbatim in `LICENSE`
- Snapshot date: 2026-07-10

This directory contains the current rev 1.0 MJCF snapshot, its referenced STL
files, and the official `torso_link_23dof_rev_1_0.STL` from the same pinned
commit. The current exporter preserves the official `head_link`, 23-DOF torso,
and `left_rubber_hand` / `right_rubber_hand` geometry. The upstream full 23-DOF
model uses the exact hand mesh names `left_wrist_roll_rubber_hand` and
`right_wrist_roll_rubber_hand`; the GLB contract accepts either exact upstream
layout while rejecting the retired custom palm-shell contract.

`logo_link.STL` is retained as part of the source snapshot but intentionally
omitted from the office GLB. Provider/vendor logos are rendered by the
application at runtime rather than embedded in these third-party assets.
