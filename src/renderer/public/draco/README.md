# Local Draco decoder

These files are copied from `three/examples/jsm/libs/draco/gltf` in the pinned
`three` dependency. `RobotModelAsset.tsx` loads them from `./draco/`, keeping GLB
decoding local in both the Electron development server and packaged renderer.
The decoder is distributed under the [Apache License 2.0](https://github.com/google/draco/blob/master/LICENSE).

Refresh them after upgrading `three`:

```sh
cp node_modules/three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js \
  src/renderer/public/draco/draco_wasm_wrapper.js
cp node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.wasm \
  src/renderer/public/draco/draco_decoder.wasm
```
