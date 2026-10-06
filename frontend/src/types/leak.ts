/** 泄漏处置：由异常读数派发的处置单，复检合格后闭环 */
export type LeakState = '待处置' | '已处置' | '已复检'

export interface Leak {
  id: string
  deviceId: string
  /** 冗余站点 id */
  stationId: string
  /** 泄漏浓度（ppm） */
  concentrationPpm: number
  /** 发现时间 YYYY-MM-DD */
  foundTime: string
  measure: string
  state: LeakState
  /** 复检浓度（ppm） */
  retestValuePpm: number
  handler: string
  /** 派单来源读数（留档），手工新建的处置单为空串 */
  sourceReadingId: string
  /** 派单时的点位名（依据留档） */
  sourcePointName: string
  /** 派单依据：当时读数对应的标准下限（留档） */
  basisMin: number
  /** 派单依据：当时读数对应的标准上限（留档） */
  basisMax: number
  /** 派单依据：当时读数的偏差率（%，留档） */
  basisDeviationPct: number
  createdAt: number
  updatedAt: number
}

export const LEAK_STATES: LeakState[] = ['待处置', '已处置', '已复检']

/** 泄漏处置状态机：待处置 → 已处置 → 已复检 */
export const LEAK_STATE_FLOW: Record<LeakState, LeakState | null> = {
  待处置: '已处置',
  已处置: '已复检',
  已复检: null
}

/** 复检合格阈值（ppm） */
export const LEAK_RETEST_PASS_PPM = 50

export interface LeakDraft {
  deviceId: string
  concentrationPpm: number
  foundTime: string
  measure: string
  state: LeakState
  retestValuePpm: number
  handler: string
  /** 派单依据（由异常读数派发时带入，手工新建可缺省） */
  sourceReadingId?: string
  sourcePointName?: string
  basisMin?: number
  basisMax?: number
  basisDeviationPct?: number
}

export const EMPTY_LEAK_DRAFT: LeakDraft = {
  deviceId: '',
  concentrationPpm: 0,
  foundTime: '',
  measure: '',
  state: '待处置',
  retestValuePpm: 0,
  handler: '',
  sourceReadingId: '',
  sourcePointName: '',
  basisMin: 0,
  basisMax: 50,
  basisDeviationPct: 0
}

export function createEmptyLeakDraft(): LeakDraft {
  return { ...EMPTY_LEAK_DRAFT }
}

export function retestPassed(value: number): boolean {
  return value > 0 && value <= LEAK_RETEST_PASS_PPM
}

/** 处置单依据：区间文案，手工新建或旧数据无依据时返回空串 */
export function leakBasisText(leak: Pick<Leak, 'basisMax' | 'sourcePointName'>): string {
  if (!leak.sourcePointName) return ''
  return `依据「${leak.sourcePointName}」留档标准 0 ~ ${leak.basisMax} ppm`
}
