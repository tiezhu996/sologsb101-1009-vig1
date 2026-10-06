/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号 + upgrade 迁移
 * - 级联删除、整库导入导出、首屏幂等播种
 */
import Dexie, { type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Device } from '@/types/device'
import type { Point } from '@/types/point'
import type { Patrol } from '@/types/patrol'
import type { Reading } from '@/types/reading'
import type { Leak } from '@/types/leak'
import { deviationPctOf, judgeReading } from '@/utils/range'

export const DB_NAME = 'gbgaspress'
export const DB_VERSION = 3

export const LS_KEYS = {
  dbVersion: 'gbgaspress:db-version',
  lastBackupAt: 'gbgaspress:last-backup-at',
  uiPrefs: 'gbgaspress:ui-prefs'
} as const

export interface UiPrefs {
  lastStationId: string | null
  onlyAbnormal: boolean
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStationId: null, onlyAbnormal: false }

export interface BackupPayload {
  app: 'gbgaspress'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  devices: Device[]
  points: Point[]
  patrols: Patrol[]
  readings: Reading[]
  leaks: Leak[]
}

export interface Revisioned {
  revision?: number
}

export const ROW_REVISION = 3

export type StationRow = Station & Revisioned
export type DeviceRow = Device & Revisioned
export type PointRow = Point & Revisioned
export type PatrolRow = Patrol & Revisioned
export type ReadingRow = Reading & Revisioned
export type LeakRow = Leak & Revisioned

class GasPressDatabase extends Dexie {
  stations!: Table<StationRow, string>
  devices!: Table<DeviceRow, string>
  points!: Table<PointRow, string>
  patrols!: Table<PatrolRow, string>
  readings!: Table<ReadingRow, string>
  leaks!: Table<LeakRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1).stores({
      stations: 'id, name, grade',
      devices: 'id, stationId, type, state',
      points: 'id, deviceId, name, isCritical',
      patrols: 'id, stationId, planDate, state',
      readings: 'id, patrolId, pointId',
      leaks: 'id, deviceId, state'
    })

    // v2：点位/泄漏补 stationId 冗余列（按站点筛选免联表）；读数补 revision 与 note
    this.version(2)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        // 迁移：点位缺少 stationId 时用所属设备回填
        const devices = (await tx.table('devices').toArray()) as Array<{ id: string; stationId: string }>
        const stationOfDevice = new Map(devices.map((device) => [device.id, device.stationId]))
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (typeof point.stationId !== 'string' || point.stationId.length === 0) {
              point.stationId = stationOfDevice.get(String(point.deviceId)) ?? ''
            }
            if (typeof point.isCritical !== 'boolean') point.isCritical = false
          })

        // 迁移：泄漏处置补 stationId、复检值与病态状态
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.stationId !== 'string' || leak.stationId.length === 0) {
              leak.stationId = stationOfDevice.get(String(leak.deviceId)) ?? ''
            }
            if (typeof leak.retestValuePpm !== 'number' || !Number.isFinite(leak.retestValuePpm)) {
              leak.retestValuePpm = 0
            }
            if (leak.state !== '待处置' && leak.state !== '已处置' && leak.state !== '已复检') {
              leak.state = '待处置'
            }
          })

        // 迁移：读数补 note，并按偏差率重算 isAbnormal / deviationPct
        const points = (await tx.table('points').toArray()) as Array<{
          id: string
          standardMin: number
          standardMax: number
          isCritical: boolean
        }>
        const pointMap = new Map(points.map((point) => [point.id, point]))
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            if (typeof reading.note !== 'string') reading.note = ''
            const point = pointMap.get(String(reading.pointId))
            const value = Number(reading.value)
            if (point && Number.isFinite(value)) {
              const judgement = judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
              reading.isAbnormal = judgement.isAbnormal
              reading.deviationPct = judgement.deviationPct
            } else {
              if (typeof reading.deviationPct !== 'number') reading.deviationPct = 0
              if (typeof reading.isAbnormal !== 'boolean') reading.isAbnormal = false
            }
          })
      })

    // v3：点位启用/停用/待确认；读数留档保存时的上下限与关键点标记；泄漏单派单依据留档
    this.version(3)
      .stores({
        stations: 'id, name, grade, updatedAt',
        devices: 'id, stationId, type, state, updatedAt',
        points: 'id, deviceId, stationId, name, isCritical, state, updatedAt',
        patrols: 'id, stationId, planDate, state, updatedAt',
        readings: 'id, patrolId, pointId, isAbnormal, updatedAt',
        leaks: 'id, deviceId, stationId, state, handler, updatedAt'
      })
      .upgrade(async (tx) => {
        for (const name of ['stations', 'devices', 'points', 'patrols', 'readings', 'leaks']) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
            })
        }

        const pointsV3 = (await tx.table('points').toArray()) as Array<{
          id: string
          deviceId: string
          name?: unknown
          unit?: unknown
          standardMin: number
          standardMax: number
          isCritical: boolean
          state?: unknown
        }>
        const pointV3Map = new Map(pointsV3.map((point) => [point.id, point]))

        // 迁移：点位补状态（旧数据一律视为启用）
        await tx
          .table('points')
          .toCollection()
          .modify((point: Record<string, unknown>) => {
            if (point.state !== '启用' && point.state !== '停用' && point.state !== '待确认') {
              point.state = '启用'
            }
          })

        // 迁移：读数按保存时点位标准补留档（旧读数留档即迁移时点的现行标准）
        await tx
          .table('readings')
          .toCollection()
          .modify((reading: Record<string, unknown>) => {
            const point = pointV3Map.get(String(reading.pointId))
            if (point) {
              if (typeof reading.snapshotMin !== 'number') reading.snapshotMin = point.standardMin
              if (typeof reading.snapshotMax !== 'number') reading.snapshotMax = point.standardMax
              if (typeof reading.snapshotCritical !== 'boolean') reading.snapshotCritical = point.isCritical
            }
            if (typeof reading.snapshotMin !== 'number') reading.snapshotMin = 0
            if (typeof reading.snapshotMax !== 'number') reading.snapshotMax = 1
            if (typeof reading.snapshotCritical !== 'boolean') reading.snapshotCritical = false
          })

        // 迁移：泄漏处置单补派单依据，优先回填来源读数的留档，其次按设备 ppm 点位现行标准
        const readingsV3 = (await tx.table('readings').toArray()) as Array<{
          id: string
          pointId: string
          value: number
          deviationPct: number
          snapshotMin?: number
          snapshotMax?: number
        }>
        const ppmPointOfDevice = new Map<string, (typeof pointsV3)[number]>()
        pointsV3.forEach((point) => {
          if (point.unit === 'ppm' && !ppmPointOfDevice.has(point.deviceId)) ppmPointOfDevice.set(point.deviceId, point)
        })
        await tx
          .table('leaks')
          .toCollection()
          .modify((leak: Record<string, unknown>) => {
            if (typeof leak.sourceReadingId !== 'string') leak.sourceReadingId = ''
            if (typeof leak.sourcePointName !== 'string') leak.sourcePointName = ''
            if (typeof leak.basisMin !== 'number') leak.basisMin = 0
            if (typeof leak.basisMax !== 'number') leak.basisMax = 50
            if (typeof leak.basisDeviationPct !== 'number') {
              const fallback = ppmPointOfDevice.get(String(leak.deviceId))
              let source = readingsV3.find((row) => row.id === leak.sourceReadingId)
              // 旧单没有来源 id：同设备 ppm 点位且浓度精确匹配的读数唯一时，保守关联
              if (!source && fallback) {
                const candidates = readingsV3.filter(
                  (row) => row.pointId === fallback.id && Number(row.value) === Number(leak.concentrationPpm)
                )
                if (candidates.length === 1) {
                  source = candidates[0]
                  leak.sourceReadingId = source.id
                }
              }
              leak.basisMax = source && Number.isFinite(source.snapshotMax) ? source.snapshotMax : fallback ? fallback.standardMax : 50
              leak.basisMin = source && Number.isFinite(source.snapshotMin) ? source.snapshotMin : 0
              leak.basisDeviationPct = source
                ? source.deviationPct
                : deviationPctOf(Number(leak.concentrationPpm), 0, Number(leak.basisMax))
              if (!leak.sourcePointName && fallback && typeof fallback.name === 'string') leak.sourcePointName = fallback.name
            }
          })
      })
  }
}

export const db = new GasPressDatabase()

export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/* ============================ 演示数据播种 ============================ */

const SEED_STAMP = Date.parse('2024-06-20T09:00:00+08:00')
const stamp = (offsetDays = 0): number => SEED_STAMP + offsetDays * 86400000

const SEED_STATIONS: StationRow[] = [
  { id: 'st-1', name: '城东高中压调压站', location: '城东工业园区 A 区', designFlowM3h: 8000, inletPressureMpa: 0.4, grade: '高中压', commissionDate: '2016-05-20', createdAt: stamp(-300), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'st-2', name: '西城新区调压站', location: '西城新区纬三路', designFlowM3h: 5000, inletPressureMpa: 0.2, grade: '中中压', commissionDate: '2019-08-12', createdAt: stamp(-280), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_DEVICES: DeviceRow[] = [
  { id: 'dv-1', stationId: 'st-1', type: '调压器', model: 'RTZ-80/0.4', serialNo: 'SN20160520-01', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-2', stationId: 'st-1', type: '过滤器', model: 'GL-80', serialNo: 'SN20160520-02', installDate: '2016-05-20', state: '运行', createdAt: stamp(-290), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'dv-3', stationId: 'st-1', type: '切断阀', model: 'QT-80', serialNo: 'SN20160520-03', installDate: '2016-05-20', state: '检修', createdAt: stamp(-289), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'dv-4', stationId: 'st-2', type: '调压器', model: 'RTZ-50/0.2', serialNo: 'SN20190812-01', installDate: '2019-08-12', state: '运行', createdAt: stamp(-270), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'dv-5', stationId: 'st-2', type: '放散阀', model: 'FS-50', serialNo: 'SN20190812-02', installDate: '2019-08-12', state: '运行', createdAt: stamp(-269), updatedAt: stamp(-1), revision: ROW_REVISION }
]

const SEED_POINTS: PointRow[] = [
  { id: 'pt-1', deviceId: 'dv-1', stationId: 'st-1', name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true, state: '启用', createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-2', deviceId: 'dv-1', stationId: 'st-1', name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true, state: '启用', createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-3', deviceId: 'dv-1', stationId: 'st-1', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, state: '启用', createdAt: stamp(-280), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-4', deviceId: 'dv-2', stationId: 'st-1', name: '过滤器压差', standardMin: 0, standardMax: 0.03, unit: 'MPa', isCritical: false, state: '启用', createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-5', deviceId: 'dv-2', stationId: 'st-1', name: '法兰泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: false, state: '启用', createdAt: stamp(-279), updatedAt: stamp(-2), revision: ROW_REVISION },
  { id: 'pt-6', deviceId: 'dv-3', stationId: 'st-1', name: '切断动作压力', standardMin: 0.25, standardMax: 0.35, unit: 'MPa', isCritical: true, state: '停用', createdAt: stamp(-278), updatedAt: stamp(-4), revision: ROW_REVISION },
  { id: 'pt-7', deviceId: 'dv-4', stationId: 'st-2', name: '进口压力', standardMin: 0.15, standardMax: 0.25, unit: 'MPa', isCritical: true, state: '启用', createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-8', deviceId: 'dv-4', stationId: 'st-2', name: '出口压力', standardMin: 0.08, standardMax: 0.15, unit: 'MPa', isCritical: true, state: '启用', createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-9', deviceId: 'dv-4', stationId: 'st-2', name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false, state: '启用', createdAt: stamp(-260), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-10', deviceId: 'dv-4', stationId: 'st-2', name: '阀体泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true, state: '启用', createdAt: stamp(-259), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pt-11', deviceId: 'dv-5', stationId: 'st-2', name: '放散压力', standardMin: 0.18, standardMax: 0.3, unit: 'MPa', isCritical: true, state: '待确认', createdAt: stamp(-259), updatedAt: stamp(-3), revision: ROW_REVISION }
]

const SEED_PATROLS: PatrolRow[] = [
  { id: 'pa-1', stationId: 'st-1', planDate: '2024-06-05', patrolDate: '2024-06-05', patrolman: '张伟', envNote: '晴，气温 26℃', state: '已完成', createdAt: stamp(-15), updatedAt: stamp(-15), revision: ROW_REVISION },
  { id: 'pa-2', stationId: 'st-1', planDate: '2024-06-12', patrolDate: '2024-06-12', patrolman: '张伟', envNote: '多云，风力 3 级', state: '已完成', createdAt: stamp(-8), updatedAt: stamp(-8), revision: ROW_REVISION },
  { id: 'pa-3', stationId: 'st-1', planDate: '2024-06-19', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION },
  { id: 'pa-4', stationId: 'st-2', planDate: '2024-06-06', patrolDate: '2024-06-08', patrolman: '李娜', envNote: '中雨，到场延迟 2 天', state: '已完成', createdAt: stamp(-14), updatedAt: stamp(-12), revision: ROW_REVISION },
  { id: 'pa-5', stationId: 'st-2', planDate: '2024-06-13', patrolDate: '', patrolman: '李娜', envNote: '计划未执行，人员调休', state: '漏检', createdAt: stamp(-7), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'pa-6', stationId: 'st-2', planDate: '2024-06-20', patrolDate: '', patrolman: '', envNote: '', state: '待巡检', createdAt: stamp(-1), updatedAt: stamp(-1), revision: ROW_REVISION }
]

/** 播种用的读数原始行：[巡检, 点位, 读数, 备注] */
const SEED_READING_ROWS: Array<[string, string, number, string]> = [
  ['pa-1', 'pt-1', 0.41, ''],
  ['pa-1', 'pt-2', 0.23, ''],
  ['pa-1', 'pt-3', 68, '便携式检漏仪测得，有轻微气味'],
  ['pa-2', 'pt-1', 0.38, ''],
  ['pa-2', 'pt-2', 0.28, '出口压力偏高，已通知调度'],
  ['pa-2', 'pt-4', 0.041, '过滤器压差超限，建议反吹'],
  ['pa-2', 'pt-5', 55, '法兰处检出微量泄漏'],
  ['pa-4', 'pt-7', 0.21, ''],
  ['pa-4', 'pt-8', 0.145, ''],
  ['pa-4', 'pt-9', 12, ''],
  ['pa-4', 'pt-10', 88, '阀体密封处浓度偏高']
]

const SEED_LEAKS: LeakRow[] = [
  { id: 'lk-1', deviceId: 'dv-1', stationId: 'st-1', concentrationPpm: 68, foundTime: '2024-06-05', measure: '更换调压器阀体密封垫并做气密试验', state: '已复检', retestValuePpm: 32, handler: '张伟', sourceReadingId: 'rd-3', sourcePointName: '阀体泄漏浓度', basisMin: 0, basisMax: 50, basisDeviationPct: 36, createdAt: stamp(-15), updatedAt: stamp(-10), revision: ROW_REVISION },
  { id: 'lk-2', deviceId: 'dv-2', stationId: 'st-1', concentrationPpm: 55, foundTime: '2024-06-12', measure: '紧固法兰螺栓并涂抹检漏液复测', state: '已处置', retestValuePpm: 0, handler: '张伟', sourceReadingId: 'rd-7', sourcePointName: '法兰泄漏浓度', basisMin: 0, basisMax: 50, basisDeviationPct: 10, createdAt: stamp(-8), updatedAt: stamp(-6), revision: ROW_REVISION },
  { id: 'lk-3', deviceId: 'dv-4', stationId: 'st-2', concentrationPpm: 88, foundTime: '2024-06-08', measure: '', state: '待处置', retestValuePpm: 0, handler: '', sourceReadingId: 'rd-11', sourcePointName: '阀体泄漏浓度', basisMin: 0, basisMax: 50, basisDeviationPct: 76, createdAt: stamp(-12), updatedAt: stamp(-12), revision: ROW_REVISION }
]

/** 由原始行派生偏差率与异常标记，并按当时点位标准生成读数留档 */
function buildSeedReadings(): ReadingRow[] {
  return SEED_READING_ROWS.map(([patrolId, pointId, value, note], index) => {
    const point = SEED_POINTS.find((item) => item.id === pointId)
    const judgement = point
      ? judgeReading(value, point.standardMin, point.standardMax, point.isCritical)
      : { isAbnormal: false, deviationPct: deviationPctOf(value, 0, 1) }
    return {
      id: `rd-${index + 1}`,
      patrolId,
      pointId,
      value,
      isAbnormal: judgement.isAbnormal,
      deviationPct: judgement.deviationPct,
      note,
      snapshotMin: point ? point.standardMin : 0,
      snapshotMax: point ? point.standardMax : 1,
      snapshotCritical: point ? point.isCritical : false,
      createdAt: stamp(-200 + index),
      updatedAt: stamp(-200 + index),
      revision: ROW_REVISION
    }
  })
}

export async function seedDatabase(): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks],
      async () => {
    await db.stations.bulkPut(SEED_STATIONS)
    await db.devices.bulkPut(SEED_DEVICES)
    await db.points.bulkPut(SEED_POINTS)
    await db.patrols.bulkPut(SEED_PATROLS)
    await db.readings.bulkPut(buildSeedReadings())
    await db.leaks.bulkPut(SEED_LEAKS)
  })
}

/** 首屏调用：打开数据库并在主表为空时播种演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.stations.count()) === 0) {
    await seedDatabase()
  }
}

/* ============================== 级联删除 ============================== */

export async function deleteStationCascade(stationId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks],
      async () => {
    const devices = await db.devices.where('stationId').equals(stationId).toArray()
    await deleteDevicesInternal(devices.map((device) => device.id))
    if (devices.length > 0) await db.devices.bulkDelete(devices.map((device) => device.id))
    await db.patrols.where('stationId').equals(stationId).delete()
    await db.stations.delete(stationId)
  })
}

export async function deleteDeviceCascade(deviceId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks],
      async () => {
    await deleteDevicesInternal([deviceId])
    await db.devices.delete(deviceId)
  })
}

/**
 * 删除点位：仅允许删除从未产生过读数的点位；
 * 已有历史读数的点位请走「停用」，避免历史读数与泄漏依据被一并丢弃。
 */
export async function deletePointCascade(pointId: string): Promise<void> {
  const historyCount = await db.readings.where('pointId').equals(pointId).count()
  if (historyCount > 0) {
    throw new Error('该点位存在历史读数，不能直接删除；请改用「停用」，停用后历史仍可查询')
  }
  await db.transaction('rw', [db.points, db.readings], async () => {
    await db.readings.where('pointId').equals(pointId).delete()
    await db.points.delete(pointId)
  })
}

export async function deletePatrolCascade(patrolId: string): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks],
      async () => {
    await db.readings.where('patrolId').equals(patrolId).delete()
    await db.patrols.delete(patrolId)
  })
}

async function deleteDevicesInternal(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return
  await db.points.where('deviceId').anyOf(deviceIds).delete()
  await db.leaks.where('deviceId').anyOf(deviceIds).delete()
}

/* ============================ 读数写入 ============================ */

/**
 * 写入读数：按点位当前标准判定异常，同时把当时的上下限与关键点标记
 * 随读数一并留档（snapshot*），此后点位标准再变更也不会改写历史判定。
 */
export async function putReading(row: {
  id: string
  patrolId: string
  pointId: string
  value: number
  note: string
  createdAt: number
  updatedAt: number
}): Promise<ReadingRow> {
  const point = await db.points.get(row.pointId)
  const judgement = point
    ? judgeReading(row.value, point.standardMin, point.standardMax, point.isCritical)
    : { isAbnormal: false, deviationPct: 0 }
  const next: ReadingRow = {
    ...row,
    isAbnormal: judgement.isAbnormal,
    deviationPct: judgement.deviationPct,
    snapshotMin: point ? point.standardMin : 0,
    snapshotMax: point ? point.standardMax : 1,
    snapshotCritical: point ? point.isCritical : false,
    revision: ROW_REVISION
  }
  await db.readings.put(next)
  return next
}

/* ============================ 整库导入导出 ============================ */

export async function countAll(): Promise<Record<string, number>> {
  const [stations, devices, points, patrols, readings, leaks] = await Promise.all([
    db.stations.count(),
    db.devices.count(),
    db.points.count(),
    db.patrols.count(),
    db.readings.count(),
    db.leaks.count()
  ])
  return { stations, devices, points, patrols, readings, leaks }
}

export async function exportSnapshot(): Promise<BackupPayload> {
  const [stations, devices, points, patrols, readings, leaks] = await Promise.all([
    db.stations.toArray(),
    db.devices.toArray(),
    db.points.toArray(),
    db.patrols.toArray(),
    db.readings.toArray(),
    db.leaks.toArray()
  ])
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row
    return rest
  }
  return {
    app: 'gbgaspress',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations: stations.map(strip),
    devices: devices.map(strip),
    points: points.map(strip),
    patrols: patrols.map(strip),
    readings: readings.map(strip),
    leaks: leaks.map(strip)
  }
}

export async function importSnapshot(payload: BackupPayload): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear()
    ])
    // 兼容旧备份：点位补状态、读数补留档、泄漏补依据
    const withRev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION })
    const points = (payload.points ?? []).map((point) =>
      withRev({ ...point, state: (point as { state?: unknown }).state === undefined ? '启用' : point.state })
    )
    const pointById = new Map(points.map((point) => [point.id, point]))
    const readings = (payload.readings ?? []).map((reading) => {
      const point = pointById.get(reading.pointId)
      const snap = reading as {
        snapshotMin?: number
        snapshotMax?: number
        snapshotCritical?: boolean
      }
      return withRev({
        ...reading,
        snapshotMin: typeof snap.snapshotMin === 'number' ? snap.snapshotMin : point ? point.standardMin : 0,
        snapshotMax: typeof snap.snapshotMax === 'number' ? snap.snapshotMax : point ? point.standardMax : 1,
        snapshotCritical:
          typeof snap.snapshotCritical === 'boolean' ? snap.snapshotCritical : point ? point.isCritical : false
      })
    })
    const readingById = new Map(readings.map((reading) => [reading.id, reading]))
    const leaks = (payload.leaks ?? []).map((leak) => {
      const legacy = leak as {
        sourceReadingId?: string
        sourcePointName?: string
        basisMin?: number
        basisMax?: number
        basisDeviationPct?: number
      }
      const source = legacy.sourceReadingId ? readingById.get(legacy.sourceReadingId) : undefined
      const basisMax =
        typeof legacy.basisMax === 'number'
          ? legacy.basisMax
          : source
            ? source.snapshotMax
            : 50
      return withRev({
        ...leak,
        sourceReadingId: legacy.sourceReadingId ?? '',
        sourcePointName: legacy.sourcePointName ?? '',
        basisMin: typeof legacy.basisMin === 'number' ? legacy.basisMin : source ? source.snapshotMin : 0,
        basisMax,
        basisDeviationPct:
          typeof legacy.basisDeviationPct === 'number'
            ? legacy.basisDeviationPct
            : source
              ? source.deviationPct
              : deviationPctOf(Number(leak.concentrationPpm) || 0, 0, basisMax)
      })
    })
    await db.stations.bulkPut((payload.stations ?? []).map(withRev))
    await db.devices.bulkPut((payload.devices ?? []).map(withRev))
    await db.points.bulkPut(points)
    await db.patrols.bulkPut((payload.patrols ?? []).map(withRev))
    await db.readings.bulkPut(readings)
    await db.leaks.bulkPut(leaks)
  })
}

export async function clearAllTables(): Promise<void> {
  await db.transaction(
      'rw',
      [db.stations, db.devices, db.points, db.patrols, db.readings, db.leaks],
      async () => {
    await Promise.all([
      db.stations.clear(),
      db.devices.clear(),
      db.points.clear(),
      db.patrols.clear(),
      db.readings.clear(),
      db.leaks.clear()
    ])
  })
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/* ============================ 本地 UI 偏好 ============================ */

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastStationId: typeof parsed.lastStationId === 'string' ? parsed.lastStationId : null,
      onlyAbnormal: parsed.onlyAbnormal === true
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const parsed = Number(localStorage.getItem(LS_KEYS.dbVersion))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}
