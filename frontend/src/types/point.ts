/**
 * 点位状态机：
 * - 启用：正常进入新巡检
 * - 停用：不再进入新巡检，历史读数与泄漏依据保留可查
 * - 待确认：停用后申请恢复，须重新确认标准值才能再次进入巡检
 */
export type PointState = '启用' | '停用' | '待确认'

export const POINT_STATES: PointState[] = ['启用', '停用', '待确认']

/** 点位：设备上的巡检点位与标准值区间 */
export interface Point {
  id: string
  deviceId: string
  /** 冗余站点 id，便于按站点快速筛选 */
  stationId: string
  /** 点位名，如 出口压力 */
  name: string
  standardMin: number
  standardMax: number
  unit: string
  /** 是否关键点：关键点偏差超过 5% 即判严重超标 */
  isCritical: boolean
  /** 启用 / 停用 / 待确认（恢复时需重新确认标准） */
  state: PointState
  createdAt: number
  updatedAt: number
}

export const POINT_UNITS = ['MPa', '℃', 'ppm', 'kPa', 'm³/h']

export interface PointDraft {
  deviceId: string
  name: string
  standardMin: number
  standardMax: number
  unit: string
  isCritical: boolean
}

export const EMPTY_POINT_DRAFT: PointDraft = {
  deviceId: '',
  name: '',
  standardMin: 0,
  standardMax: 1,
  unit: 'MPa',
  isCritical: false
}

/** 标准值模板：批量复制用 */
export interface PointTemplate {
  name: string
  standardMin: number
  standardMax: number
  unit: string
  isCritical: boolean
}

export const POINT_TEMPLATES: PointTemplate[] = [
  { name: '进口压力', standardMin: 0.35, standardMax: 0.45, unit: 'MPa', isCritical: true },
  { name: '出口压力', standardMin: 0.18, standardMax: 0.25, unit: 'MPa', isCritical: true },
  { name: '出口温度', standardMin: -10, standardMax: 40, unit: '℃', isCritical: false },
  { name: '泄漏浓度', standardMin: 0, standardMax: 50, unit: 'ppm', isCritical: true }
]

/** 点位标准值编辑草稿：点位 id → 待提交的上下限 */
export interface StandardDraft {
  standardMin: number
  standardMax: number
  isCritical: boolean
}

/** 点位筛选条件（存于 patrolStore 之外的组合条件） */
export interface PointFilterState {
  keyword: string
  stationId: string
  deviceTypes: string[]
  onlyCritical: boolean
}

export function createEmptyPointFilter(): PointFilterState {
  return { keyword: '', stationId: '', deviceTypes: [], onlyCritical: false }
}
