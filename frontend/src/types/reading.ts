/** 读数：某次巡检中某个点位的实测读数 */
export interface Reading {
  id: string
  patrolId: string
  pointId: string
  value: number
  isAbnormal: boolean
  /** 偏差率（%），区间内为 0 */
  deviationPct: number
  /**
   * 保存读数时的标准留档：当时的上下限、关键点标记与单位。
   * 异常清单、泄漏派单依据与导出一律以留档为准，不随点位现标准变更。
   */
  standardMin: number
  standardMax: number
  isCritical: boolean
  unit: string
  note: string
  createdAt: number
  updatedAt: number
}

export interface ReadingDraft {
  patrolId: string
  pointId: string
  value: number
  note: string
}

export const EMPTY_READING_DRAFT: ReadingDraft = {
  patrolId: '',
  pointId: '',
  value: 0,
  note: ''
}

/** 读数草稿表：`${patrolId}:${pointId}` → 输入值 */
export type ReadingDraftMap = Record<string, number>
