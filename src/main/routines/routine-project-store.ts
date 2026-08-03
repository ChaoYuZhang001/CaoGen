import type { ProjectAggregateAutomation } from '../../shared/project-aggregate-types'
import type { Routine, RoutineRunRecord } from '../../shared/types'
import {
  countProjectRoutineDefinitions,
  importProjectRoutineDefinitions,
  listRoutines,
  purgeProjectRoutineDefinitions
} from '../routineStore'
import { projectAggregateCanonicalJson } from '../project-aggregate/codec'
import {
  countProjectRoutineRuns,
  importProjectRoutineRuns,
  listRoutineRuns,
  purgeProjectRoutineRuns
} from './routine-runner'

export async function readProjectRoutineSlice(
  routineRoot: string,
  projectId: string
): Promise<ProjectAggregateAutomation> {
  const id = requiredProjectId(projectId)
  const routines = (await listRoutines(routineRoot))
    .filter((routine) => routine.projectId === id)
    .map((routine) => structuredClone(routine) as Routine)
    .sort(byId)
  const routineIds = new Set(routines.map((routine) => routine.id))
  const runs = (await listRoutineRuns(routineRoot))
    .filter((run) => run.projectId === id || routineIds.has(run.routineId))
    .map((run) => {
      if (run.projectId && run.projectId !== id) {
        throw new Error(`Routine Run ${run.id} has conflicting Project ownership`)
      }
      return { ...structuredClone(run), projectId: id } as RoutineRunRecord
    })
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
  return { routines, runs }
}

export function validateProjectRoutineSlice(
  projectId: string,
  automation: ProjectAggregateAutomation | undefined
): void {
  normalizeProjectRoutineSlice(projectId, automation)
}

export async function assertProjectRoutineSliceImportable(
  routineRoot: string,
  projectId: string,
  automation: ProjectAggregateAutomation | undefined
): Promise<void> {
  const slice = normalizeProjectRoutineSlice(projectId, automation)
  const [existingRoutines, existingRuns] = await Promise.all([
    listRoutines(routineRoot),
    listRoutineRuns(routineRoot)
  ])
  const routineIds = new Set(existingRoutines.map((routine) => routine.id))
  const runIds = new Set(existingRuns.map((run) => run.id))
  const conflicts = [
    ...slice.routines.filter((routine) => routineIds.has(routine.id)).map((routine) => `routine:${routine.id}`),
    ...slice.runs.filter((run) => runIds.has(run.id)).map((run) => `routine_run:${run.id}`)
  ]
  if (conflicts.length > 0) throw new Error(`Project import Routine identity conflict: ${conflicts.sort().join(', ')}`)
}

export async function importProjectRoutineSlice(
  routineRoot: string,
  projectId: string,
  automation: ProjectAggregateAutomation | undefined
): Promise<{ routines: number; runs: number }> {
  const slice = normalizeProjectRoutineSlice(projectId, automation)
  const routines = await importProjectRoutineDefinitions(routineRoot, projectId, slice.routines)
  const runs = await importProjectRoutineRuns(routineRoot, projectId, slice.runs)
  return { routines, runs }
}

export async function verifyProjectRoutineSlice(
  routineRoot: string,
  projectId: string,
  automation: ProjectAggregateAutomation | undefined
): Promise<void> {
  const expected = normalizeProjectRoutineSlice(projectId, automation)
  const actual = await readProjectRoutineSlice(routineRoot, projectId)
  if (projectAggregateCanonicalJson(actual) !== projectAggregateCanonicalJson(expected)) {
    throw new Error(`Project import Routine readback mismatch: ${projectId}`)
  }
}

export async function purgeProjectRoutineSlice(
  routineRoot: string,
  projectId: string
): Promise<{ routines: number; runs: number }> {
  const id = requiredProjectId(projectId)
  const routineIds = new Set(
    (await listRoutines(routineRoot)).filter((routine) => routine.projectId === id).map((routine) => routine.id)
  )
  const runs = await purgeProjectRoutineRuns(routineRoot, id, routineIds)
  const routines = await purgeProjectRoutineDefinitions(routineRoot, id)
  return { routines, runs }
}

export async function scanProjectRoutineResiduals(
  routineRoot: string,
  projectId: string
): Promise<{ routines: number; runs: number }> {
  const id = requiredProjectId(projectId)
  const routineIds = new Set(
    (await listRoutines(routineRoot)).filter((routine) => routine.projectId === id).map((routine) => routine.id)
  )
  const [routines, directRuns, allRuns] = await Promise.all([
    countProjectRoutineDefinitions(routineRoot, id),
    countProjectRoutineRuns(routineRoot, id),
    listRoutineRuns(routineRoot)
  ])
  const inheritedRuns = allRuns.filter((run) => !run.projectId && routineIds.has(run.routineId)).length
  return { routines, runs: directRuns + inheritedRuns }
}

function normalizeProjectRoutineSlice(
  projectId: string,
  automation: ProjectAggregateAutomation | undefined
): ProjectAggregateAutomation {
  const id = requiredProjectId(projectId)
  const routines = [...(automation?.routines ?? [])]
    .map((routine) => structuredClone(routine))
    .sort(byId)
  const runs = [...(automation?.runs ?? [])]
    .map((run) => structuredClone(run))
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
  const routineIds = new Set<string>()
  const runIds = new Set<string>()
  for (const routine of routines) {
    if (!routine.id?.trim() || routine.projectId !== id || routineIds.has(routine.id)) {
      throw new Error('Project automation contains an invalid or duplicate Routine')
    }
    routineIds.add(routine.id)
  }
  for (const run of runs) {
    if (!run.id?.trim() || run.projectId !== id || runIds.has(run.id)) {
      throw new Error('Project automation contains an invalid or duplicate Routine Run')
    }
    runIds.add(run.id)
  }
  return { routines, runs }
}

function requiredProjectId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error('projectId is required')
  }
  return value.trim()
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id)
}
