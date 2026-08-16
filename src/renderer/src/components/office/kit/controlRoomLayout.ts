export type ControlRoomVector = [number, number, number]

export interface ControlRoomZoneLayout {
  station: ControlRoomVector
  approach: ControlRoomVector
  lookAt: ControlRoomVector
  hit: ControlRoomVector
  cameraPosition: ControlRoomVector
  cameraTarget: ControlRoomVector
}

export const CONTROL_ROOM_LAYOUT = {
  overview: {
    position: [0.2, 7.1, 16.8] as ControlRoomVector,
    target: [0, 0.75, 0.15] as ControlRoomVector,
    fov: 48
  },
  zoneOverview: {
    position: [0, 6.35, 15.8] as ControlRoomVector,
    target: [0, 0.92, 0.1] as ControlRoomVector
  },
  assistant: {
    station: [-6.25, 0, 1.75],
    approach: [-4.82, 0, 1.75],
    lookAt: [-6.25, 0.95, 1.75],
    hit: [-6.25, 1.35, 1.75],
    cameraPosition: [-2.85, 3.35, 6.25],
    cameraTarget: [-6.15, 1.0, 1.68]
  } satisfies ControlRoomZoneLayout,
  project: {
    station: [0, 0, -6.15],
    approach: [0, 0, -4.72],
    lookAt: [0, 1.15, -6.15],
    hit: [-1.55, 2.12, -6.15],
    cameraPosition: [0, 3.65, -1.55],
    cameraTarget: [0, 1.15, -6.12]
  } satisfies ControlRoomZoneLayout,
  video: {
    station: [6.25, 0, 1.75],
    approach: [4.82, 0, 1.75],
    lookAt: [6.25, 1.0, 1.75],
    hit: [6.25, 1.4, 1.75],
    cameraPosition: [2.85, 3.35, 6.25],
    cameraTarget: [6.15, 1.0, 1.68]
  } satisfies ControlRoomZoneLayout,
  command: [0, 0, 4.55] as ControlRoomVector,
  approval: [2.45, 0, 4.55] as ControlRoomVector,
  approvalApproach: [2.45, 0, 3.35] as ControlRoomVector,
  artifact: [-8.35, 0, -4.55] as ControlRoomVector,
  infrastructure: [8.35, 0, -4.55] as ControlRoomVector
}
