/** 点位状态：停用后不再进入新巡检，历史读数与泄漏依据保留可查 */
export type PointState = '启用' | '停用'

export const POINT_STATES: PointState[] = ['启用', '停用']

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
  state: PointState
  /** 停用时间戳，启用时为 0 */
  disabledAt: number
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
  /** 点位状态过滤，空数组表示不限 */
  states: PointState[]
}

export function createEmptyPointFilter(): PointFilterState {
  return { keyword: '', stationId: '', deviceTypes: [], onlyCritical: false, states: [] }
}

/** 停用前置检查的输入：点位相关的未决草稿与待处置泄漏 */
export interface PointDisableContext {
  /** 未提交的标准值草稿条数 */
  standardDraftCount: number
  /** 未保存的读数草稿条数 */
  readingDraftCount: number
  /** 关联（按点位或所属设备）的待处置泄漏单数 */
  pendingLeakCount: number
}

/**
 * 停用拦截：存在点位相关草稿或待处置泄漏时返回阻止原因列表，空数组表示可停用。
 * 历史读数与已闭环泄漏不构成阻止——停用后它们保留可查。
 */
export function pointDisableBlockers(ctx: PointDisableContext): string[] {
  const blockers: string[] = []
  if (ctx.standardDraftCount > 0) blockers.push(`有 ${ctx.standardDraftCount} 条标准值草稿未提交，请先保存或还原`)
  if (ctx.readingDraftCount > 0) blockers.push(`有 ${ctx.readingDraftCount} 条巡检读数草稿未保存，请先保存或清空`)
  if (ctx.pendingLeakCount > 0) blockers.push(`关联 ${ctx.pendingLeakCount} 张待处置泄漏单，请先处置闭环`)
  return blockers
}
