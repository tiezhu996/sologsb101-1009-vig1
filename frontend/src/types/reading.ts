/** 读数：某次巡检中某个点位的实测读数 */
export interface Reading {
  id: string
  patrolId: string
  pointId: string
  value: number
  isAbnormal: boolean
  /** 偏差率（%），区间内为 0 */
  deviationPct: number
  note: string
  /** 保存读数时点位的标准下限（留档，后台改标准不影响历史判定） */
  snapshotMin: number
  /** 保存读数时点位的标准上限（留档） */
  snapshotMax: number
  /** 保存读数时点位是否为关键点（留档，决定分级阈值 5%/10%） */
  snapshotCritical: boolean
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
