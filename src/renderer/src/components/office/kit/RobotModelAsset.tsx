import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import { useLoader } from '@react-three/fiber'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Box3, Group, Quaternion, Vector3 } from 'three'
import type { Object3D } from 'three'
import referenceRobotGlbUrl from '../../../assets/robots/reference-office-robot.glb?url'
import referenceRobotLodGlbUrl from '../../../assets/robots/reference-office-robot-lod.glb?url'
import ProviderLogoBadge from './ProviderLogoBadge'
import type { AvatarRefs, OfficeProp } from './AvatarRig'
import type { ProviderLogoSpec } from './ProviderLogos'

export const REFERENCE_ROBOT_GLB_URL = referenceRobotGlbUrl
export const REFERENCE_ROBOT_LOD_GLB_URL = referenceRobotLodGlbUrl
export type ReferenceRobotDetailLevel = 'full' | 'low'

const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderPath('./draco/')

function configureReferenceRobotLoader(loader: GLTFLoader): void {
  loader.setDRACOLoader(dracoLoader)
}

type ReferenceRobotModelAssetProps = OfficeProp & {
  modelUrl: string
  sessionId?: string
  accentColor?: string
  providerLogo?: ProviderLogoSpec
  refs?: AvatarRefs
  modelScale?: number
  detailLevel?: ReferenceRobotDetailLevel
}

type GltfScene = {
  scene: Group
}

const EMPTY_REFS = (): AvatarRefs => ({
  root: null,
  head: null,
  armL: null,
  armR: null,
  elbowL: null,
  elbowR: null,
  wristL: null,
  wristR: null,
  handL: null,
  handR: null,
  waistYaw: null,
  waistRoll: null,
  legL: null,
  legR: null,
  kneeL: null,
  kneeR: null,
  anklePitchL: null,
  anklePitchR: null,
  ankleRollL: null,
  ankleRollR: null,
  footL: null,
  footR: null
})

export function hasReferenceRobotModelAsset(modelUrl = REFERENCE_ROBOT_GLB_URL): boolean {
  return modelUrl.trim().length > 0
}

export function preloadReferenceRobotModel(modelUrl = REFERENCE_ROBOT_GLB_URL): void {
  if (hasReferenceRobotModelAsset(modelUrl)) {
    useLoader.preload(GLTFLoader, modelUrl, configureReferenceRobotLoader)
  }
}

export function referenceRobotModelUrl(detailLevel: ReferenceRobotDetailLevel): string {
  return detailLevel === 'low' ? REFERENCE_ROBOT_LOD_GLB_URL : REFERENCE_ROBOT_GLB_URL
}

function modelAssetDetailLevel(scene: Group): ReferenceRobotDetailLevel | 'unknown' {
  const value = scene.getObjectByName('reference_office_robot_unitree_style')?.userData.office_lod_level
  return value === 'full' || value === 'low' ? value : 'unknown'
}

function createAnimationControl(node: Object3D | undefined, controlName: string, axisRoot: Group): Object3D | null {
  if (!node?.parent) return null

  const parent = node.parent
  axisRoot.updateWorldMatrix(true, true)
  const rootWorldRotation = axisRoot.getWorldQuaternion(new Quaternion())
  const parentWorldRotation = parent.getWorldQuaternion(new Quaternion())
  const parentInRootRotation = rootWorldRotation.invert().multiply(parentWorldRotation)

  // 官方骨架位于坐标转换层下。先抵消父级休息朝向,让动画轴继续遵循机器人本地 +Z 正面约定。
  const axisBasis = new Group()
  axisBasis.name = `${controlName}_animation_axis_basis`
  axisBasis.position.copy(node.position)
  axisBasis.quaternion.copy(parentInRootRotation).invert()

  const control = new Group()
  control.name = `${controlName}_animation_control`

  const restPose = new Group()
  restPose.name = `${controlName}_rest_pose`
  restPose.quaternion.copy(parentInRootRotation).multiply(node.quaternion)
  restPose.scale.copy(node.scale)

  parent.add(axisBasis)
  axisBasis.add(control)
  control.add(restPose)
  restPose.add(node)
  node.position.set(0, 0, 0)
  node.quaternion.identity()
  node.scale.set(1, 1, 1)
  axisBasis.updateMatrix()
  restPose.updateMatrix()
  node.updateMatrix()
  return control
}

function createHandEndpointMarker(scene: Group, nodeNames: string[], markerName: string): Object3D | null {
  const handNode = nodeNames.map((name) => scene.getObjectByName(name)).find(Boolean)
  if (!handNode) return null

  scene.updateWorldMatrix(true, true)
  const bounds = new Box3().setFromObject(handNode)
  if (bounds.isEmpty()) return handNode

  const center = bounds.getCenter(new Vector3())
  handNode.worldToLocal(center)
  const marker = new Group()
  marker.name = markerName
  marker.position.copy(center)
  handNode.add(marker)
  return marker
}

function createFootContactMarker(scene: Group, nodeNames: string[], markerName: string): Object3D | null {
  const footNode = nodeNames.map((name) => scene.getObjectByName(name)).find(Boolean)
  if (!footNode) return null

  scene.updateWorldMatrix(true, true)
  const bounds = new Box3().setFromObject(footNode)
  if (bounds.isEmpty()) return footNode

  const contact = new Vector3(
    (bounds.min.x + bounds.max.x) / 2,
    bounds.min.y + 0.002,
    (bounds.min.z + bounds.max.z) / 2
  )
  footNode.worldToLocal(contact)
  const marker = new Group()
  marker.name = markerName
  marker.position.copy(contact)
  footNode.add(marker)
  return marker
}

function prepareModelScene(source: Group): { scene: Group; controls: Omit<AvatarRefs, 'root'> } {
  const scene = source.clone(true)
  const handL = createHandEndpointMarker(
    scene,
    ['official_left_rubber_hand', 'official_left_wrist_roll_rubber_hand', 'left_rubber_hand'],
    'left_hand_ik_endpoint'
  )
  const handR = createHandEndpointMarker(
    scene,
    ['official_right_rubber_hand', 'official_right_wrist_roll_rubber_hand', 'right_rubber_hand'],
    'right_hand_ik_endpoint'
  )
  const footL = createFootContactMarker(
    scene,
    ['official_left_ankle_roll_link', 'left_ankle_roll_link'],
    'left_foot_contact_endpoint'
  )
  const footR = createFootContactMarker(
    scene,
    ['official_right_ankle_roll_link', 'right_ankle_roll_link'],
    'right_foot_contact_endpoint'
  )
  return {
    scene,
    controls: {
      waistYaw: createAnimationControl(scene.getObjectByName('waist_yaw_link'), 'waist_yaw_link', scene),
      waistRoll: createAnimationControl(scene.getObjectByName('waist_roll_link'), 'waist_roll_link', scene),
      head: createAnimationControl(scene.getObjectByName('helmet_head'), 'helmet_head', scene),
      armL: createAnimationControl(scene.getObjectByName('left_arm'), 'left_arm', scene),
      armR: createAnimationControl(scene.getObjectByName('right_arm'), 'right_arm', scene),
      elbowL: createAnimationControl(scene.getObjectByName('left_elbow_link'), 'left_elbow_link', scene),
      elbowR: createAnimationControl(scene.getObjectByName('right_elbow_link'), 'right_elbow_link', scene),
      wristL: createAnimationControl(scene.getObjectByName('left_wrist_roll_link'), 'left_wrist_roll_link', scene),
      wristR: createAnimationControl(scene.getObjectByName('right_wrist_roll_link'), 'right_wrist_roll_link', scene),
      handL,
      handR,
      legL: createAnimationControl(scene.getObjectByName('left_leg'), 'left_leg', scene),
      legR: createAnimationControl(scene.getObjectByName('right_leg'), 'right_leg', scene),
      kneeL: createAnimationControl(scene.getObjectByName('left_knee_link'), 'left_knee_link', scene),
      kneeR: createAnimationControl(scene.getObjectByName('right_knee_link'), 'right_knee_link', scene),
      anklePitchL: createAnimationControl(scene.getObjectByName('left_ankle_pitch_link'), 'left_ankle_pitch_link', scene),
      anklePitchR: createAnimationControl(scene.getObjectByName('right_ankle_pitch_link'), 'right_ankle_pitch_link', scene),
      ankleRollL: createAnimationControl(scene.getObjectByName('left_ankle_roll_link'), 'left_ankle_roll_link', scene),
      ankleRollR: createAnimationControl(scene.getObjectByName('right_ankle_roll_link'), 'right_ankle_roll_link', scene),
      footL,
      footR
    }
  }
}

function writeRefs(target: AvatarRefs | undefined, value: AvatarRefs): void {
  if (!target) return
  target.root = value.root
  target.head = value.head
  target.armL = value.armL
  target.armR = value.armR
  target.elbowL = value.elbowL
  target.elbowR = value.elbowR
  target.wristL = value.wristL
  target.wristR = value.wristR
  target.handL = value.handL
  target.handR = value.handR
  target.waistYaw = value.waistYaw
  target.waistRoll = value.waistRoll
  target.legL = value.legL
  target.legR = value.legR
  target.kneeL = value.kneeL
  target.kneeR = value.kneeR
  target.anklePitchL = value.anklePitchL
  target.anklePitchR = value.anklePitchR
  target.ankleRollL = value.ankleRollL
  target.ankleRollR = value.ankleRollR
  target.footL = value.footL
  target.footR = value.footR
}

const ReferenceRobotModelAsset = forwardRef<AvatarRefs, ReferenceRobotModelAssetProps>(
  function ReferenceRobotModelAsset(
    {
      modelUrl,
      sessionId,
      position,
      rotation,
      scale = 1,
      modelScale = 1,
      accentColor = '#59dcff',
      providerLogo,
      refs,
      detailLevel = 'full'
    },
    ref
  ): React.JSX.Element {
    const gltf = useLoader(GLTFLoader, modelUrl, configureReferenceRobotLoader) as unknown as GltfScene
    const model = useMemo(() => prepareModelScene(gltf.scene), [gltf.scene])
    const scene = model.scene
    const assetDetailLevel = modelAssetDetailLevel(scene)
    const rootRef = useRef<Group>(null)
    const headFallbackRef = useRef<Group>(null)
    const armLFallbackRef = useRef<Group>(null)
    const armRFallbackRef = useRef<Group>(null)
    const legLFallbackRef = useRef<Group>(null)
    const legRFallbackRef = useRef<Group>(null)

    const modelControls = model.controls

    const collect = (): AvatarRefs => {
      const bag: AvatarRefs = {
        root: rootRef.current,
        head: modelControls.head ?? headFallbackRef.current,
        armL: modelControls.armL ?? armLFallbackRef.current,
        armR: modelControls.armR ?? armRFallbackRef.current,
        elbowL: modelControls.elbowL,
        elbowR: modelControls.elbowR,
        wristL: modelControls.wristL,
        wristR: modelControls.wristR,
        handL: modelControls.handL,
        handR: modelControls.handR,
        waistYaw: modelControls.waistYaw,
        waistRoll: modelControls.waistRoll,
        legL: modelControls.legL ?? legLFallbackRef.current,
        legR: modelControls.legR ?? legRFallbackRef.current,
        kneeL: modelControls.kneeL,
        kneeR: modelControls.kneeR,
        anklePitchL: modelControls.anklePitchL,
        anklePitchR: modelControls.anklePitchR,
        ankleRollL: modelControls.ankleRollL,
        ankleRollR: modelControls.ankleRollR,
        footL: modelControls.footL,
        footR: modelControls.footR
      }
      writeRefs(refs, bag)
      return bag
    }

    useImperativeHandle(ref, collect, [refs, modelControls])
    useLayoutEffect(() => {
      writeRefs(refs, collect())
    })

    return (
      <group
        ref={rootRef}
        position={position}
        rotation={rotation}
        scale={scale}
        userData={{
          officeRobotLod: detailLevel,
          officeRobotAssetLod: assetDetailLevel,
          officeRobotModelUrl: modelUrl,
          officeRobotSessionId: sessionId ?? ''
        }}
      >
        <group scale={modelScale}>
          <primitive object={scene} />
          <group ref={headFallbackRef} position={[0, 1.36, 0]} />
          <group ref={armLFallbackRef} position={[-0.24, 1.05, 0]} />
          <group ref={armRFallbackRef} position={[0.24, 1.05, 0]} />
          <group ref={legLFallbackRef} position={[-0.1, 0.62, 0]} />
          <group ref={legRFallbackRef} position={[0.1, 0.62, 0]} />
          {providerLogo && (
            <ProviderLogoBadge
              logo={providerLogo}
              position={[0, 1.09, 0.062]}
              width={0.145}
              height={0.038}
              depth={0.005}
              maxChars={3}
              compact
            />
          )}
          <mesh position={[0, 1.108, 0.064]}>
            <boxGeometry args={[0.128, 0.006, 0.006]} />
            <meshStandardMaterial color={accentColor} emissive={accentColor} emissiveIntensity={0.24} toneMapped={false} />
          </mesh>
        </group>
      </group>
    )
  }
)

ReferenceRobotModelAsset.displayName = 'ReferenceRobotModelAsset'

export const createEmptyAvatarRefs = EMPTY_REFS

export default ReferenceRobotModelAsset
