/**
 * /points 巡检点位与标准值配置
 * 维护点位上下限、单位与关键点标记，支持模板批量复制；标准值改动先进草稿再提交。
 * 消费 Point、Device；复用 <FilterBar>、<EmptyPanel>、<StatBadge>、<AbnormalTag>。
 */
import { useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag
} from '@arco-design/web-react'
import type { TableColumnProps } from '@arco-design/web-react'
import AbnormalTag from '@/components/common/AbnormalTag'
import EmptyPanel from '@/components/common/EmptyPanel'
import FilterBar, { type FilterModel } from '@/components/common/FilterBar'
import StatBadge from '@/components/common/StatBadge'
import { useStationStore } from '@/stores/stationStore'
import { usePatrolStore } from '@/stores/patrolStore'
import { useLeakStore } from '@/stores/leakStore'
import { useIdbTable } from '@/hooks/useIdbTable'
import { db, type ReadingRow } from '@/utils/db'
import {
  EMPTY_POINT_DRAFT,
  POINT_TEMPLATES,
  POINT_UNITS,
  type Point,
  type PointDraft,
  type PointState,
  type PointTemplate
} from '@/types/point'
import { DEVICE_TYPES } from '@/types/device'
import { abnormalLevelOf, deviationPctOf, rangeText } from '@/utils/range'

const POINT_STATE_COLOR: Record<PointState, 'green' | 'gray' | 'orange'> = {
  启用: 'green',
  停用: 'gray',
  待确认: 'orange'
}

export default function PointConfig() {
  const stationStore = useStationStore()
  const patrolStore = usePatrolStore()
  const leakStore = useLeakStore()
  const readingTable = useIdbTable<ReadingRow>(db.readings, { sortByUpdatedAt: false })

  const [pointForm] = Form.useForm<PointDraft>()
  const [templateForm] = Form.useForm<{ deviceId: string }>()
  const [pointOpen, setPointOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [checkedTemplates, setCheckedTemplates] = useState<string[]>(POINT_TEMPLATES.map((item) => item.name))

  const filter = stationStore.pointFilter
  const filterSelects = useMemo(
    () => [
      {
        key: 'stationId',
        label: '调压站',
        multiple: false,
        options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
      },
      { key: 'deviceTypes', label: '设备类型', options: DEVICE_TYPES.map((item) => ({ label: item, value: item })) }
    ],
    [stationStore.stations]
  )

  const model: FilterModel = {
    keyword: filter.keyword,
    stationId: filter.stationId,
    deviceTypes: filter.deviceTypes
  }

  const onModelChange = (next: FilterModel): void => {
    stationStore.patchPointFilter({
      keyword: String(next.keyword ?? ''),
      stationId: typeof next.stationId === 'string' ? next.stationId : '',
      deviceTypes: (Array.isArray(next.deviceTypes) ? next.deviceTypes : []) as string[]
    })
  }

  const rows = stationStore.points.filter((point) => {
    if (filter.stationId && point.stationId !== filter.stationId) return false
    if (filter.onlyCritical && !point.isCritical) return false
    if (filter.deviceTypes.length > 0) {
      const device = stationStore.devices.find((item) => item.id === point.deviceId)
      if (!device || !filter.deviceTypes.includes(device.type)) return false
    }
    const text = filter.keyword.trim().toLowerCase()
    if (text.length === 0) return true
    const device = stationStore.devices.find((item) => item.id === point.deviceId)
    return point.name.toLowerCase().includes(text) || (device ? device.model.toLowerCase().includes(text) : false)
  })

  const deviceOptions = stationStore.devices
    .filter((device) => !filter.stationId || device.stationId === filter.stationId)
    .map((device) => {
      const station = stationStore.stations.find((item) => item.id === device.stationId)
      return { label: `${station ? station.name : '未知站'} · ${device.type} ${device.model}`, value: device.id }
    })

  const openCreate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先在调压站台账登记设备')
      return
    }
    setEditingId(null)
    pointForm.setFieldsValue({ ...EMPTY_POINT_DRAFT, deviceId: deviceOptions[0].value })
    setPointOpen(true)
  }

  const openEdit = (point: Point): void => {
    setEditingId(point.id)
    pointForm.setFieldsValue({
      deviceId: point.deviceId,
      name: point.name,
      standardMin: point.standardMin,
      standardMax: point.standardMax,
      unit: point.unit,
      isCritical: point.isCritical
    })
    setPointOpen(true)
  }

  const submit = async (): Promise<void> => {
    const values = await pointForm.validate().catch(() => null)
    if (!values) return
    const payload: PointDraft = {
      ...values,
      standardMin: Math.min(values.standardMin, values.standardMax),
      standardMax: Math.max(values.standardMin, values.standardMax)
    }
    if (editingId) {
      await stationStore.updatePoint(editingId, payload)
      Message.success('点位已更新；新标准只影响此后保存的读数，历史读数按留档保留')
    } else {
      await stationStore.createPoint(payload)
      Message.success('点位已创建')
    }
    setPointOpen(false)
  }

  const remove = async (point: Point): Promise<void> => {
    const historyCount = readingTable.rows.filter((row) => row.pointId === point.id).length
    if (historyCount > 0) {
      Message.error(`该点位有 ${historyCount} 条历史读数，不能删除；请改用「停用」，停用后历史仍可查询`)
      return
    }
    try {
      await stationStore.removePoint(point.id)
      Message.success('点位已删除（无历史读数）')
    } catch (error) {
      Message.error(error instanceof Error ? error.message : '点位删除失败')
    }
  }

  /** 停用前置校验：未提交标准草稿、未保存录入草稿、待处置泄漏任一存在即挡住 */
  const deactivateBlockers = (point: Point): string[] => {
    const blockers: string[] = []
    if (stationStore.standardDraft[point.id]) blockers.push('存在未提交的标准值草稿')
    const hasPendingDraft = Object.keys(patrolStore.readingDraft).some((key) => {
      const sep = key.indexOf(':')
      if (key.slice(sep + 1) !== point.id) return false
      const patrolId = key.slice(0, sep)
      const draftValue = patrolStore.readingDraft[key]
      const saved = patrolStore.readingsOfPatrol(patrolId).find((reading) => reading.pointId === point.id)
      // 无对应已保存读数，或草稿值与已存档读数不一致，才算未保存草稿
      return !saved || saved.value !== draftValue
    })
    if (hasPendingDraft) blockers.push('巡检录入页存在该点位未保存的读数草稿')
    if (point.unit === 'ppm' && leakStore.hasOpenLeakOfDevice(point.deviceId)) {
      blockers.push('所属设备存在待处置/处置中泄漏单，闭环后再停用')
    }
    return blockers
  }

  const deactivate = async (point: Point): Promise<void> => {
    const blockers = deactivateBlockers(point)
    if (blockers.length > 0) {
      Message.warning(`无法停用：${blockers.join('；')}`)
      return
    }
    await stationStore.deactivatePoint(point.id)
    Message.success(`点位「${point.name}」已停用，不再进入新巡检，历史读数与泄漏依据保留可查`)
  }

  const requestReactivate = async (point: Point): Promise<void> => {
    await stationStore.requestReactivatePoint(point.id)
    Message.info('已提交恢复申请，请核对并确认现行标准区间后重新启用')
  }

  const confirmReactivate = async (point: Point): Promise<void> => {
    await stationStore.confirmReactivatePoint(point.id)
    Message.success(`已按现行标准 ${rangeText(point.standardMin, point.standardMax, point.unit)} 重新启用，恢复进入巡检`)
  }

  const commitAll = async (): Promise<void> => {
    const count = await stationStore.commitAllStandardDrafts()
    if (count === 0) {
      Message.warning('没有待提交的标准值草稿')
      return
    }
    Message.success(`已提交 ${count} 个点位的标准值；新标准只影响此后新读数，历史读数按留档保留`)
  }

  const openTemplate = (): void => {
    if (deviceOptions.length === 0) {
      Message.warning('请先登记设备')
      return
    }
    templateForm.setFieldsValue({ deviceId: deviceOptions[0].value })
    setCheckedTemplates(POINT_TEMPLATES.map((item) => item.name))
    setTemplateOpen(true)
  }

  const submitTemplate = async (): Promise<void> => {
    const values = await templateForm.validate().catch(() => null)
    if (!values) return
    const chosen: PointTemplate[] = POINT_TEMPLATES.filter((item) => checkedTemplates.includes(item.name))
    if (chosen.length === 0) {
      Message.warning('请至少选择一个模板点位')
      return
    }
    const created = await stationStore.applyTemplate(values.deviceId, chosen)
    Message.success(created === 0 ? '所选模板点位均已存在' : `已按模板复制 ${created} 个点位`)
    setTemplateOpen(false)
  }

  const columns: TableColumnProps<Point>[] = [
    { title: '点位名', dataIndex: 'name', width: 140, render: (value: string) => <strong>{value}</strong> },
    {
      title: '调压站 / 设备',
      width: 220,
      render: (_value, record) => {
        const device = stationStore.devices.find((item) => item.id === record.deviceId)
        const station = stationStore.stations.find((item) => item.id === record.stationId)
        return `${station ? station.name : '—'} / ${device ? `${device.type} ${device.model}` : '—'}`
      }
    },
    {
      title: '标准区间（可编辑）',
      width: 330,
      render: (_value, record) => {
        const draft = stationStore.standardDraft[record.id]
        const min = draft ? draft.standardMin : record.standardMin
        const max = draft ? draft.standardMax : record.standardMax
        const critical = draft ? draft.isCritical : record.isCritical
        const readOnly = record.state !== '启用'
        return (
          <Space size={4}>
            <InputNumber
              size="small"
              style={{ width: 92 }}
              value={min}
              step={0.01}
              disabled={readOnly}
              onChange={(value: number | undefined) =>
                stationStore.setStandardDraft(record.id, {
                  standardMin: Number(value ?? 0),
                  standardMax: max,
                  isCritical: critical
                })
              }
            />
            <span>~</span>
            <InputNumber
              size="small"
              style={{ width: 92 }}
              value={max}
              step={0.01}
              disabled={readOnly}
              onChange={(value: number | undefined) =>
                stationStore.setStandardDraft(record.id, {
                  standardMin: min,
                  standardMax: Number(value ?? 0),
                  isCritical: critical
                })
              }
            />
            <span className="muted">{record.unit}</span>
            <Button
              type="text"
              size="small"
              disabled={!draft}
              onClick={async () => {
                await stationStore.commitStandardDraft(record.id)
                Message.success(`${record.name} 标准值已保存（只影响此后新读数，历史读数按留档保留）`)
              }}
            >
              保存
            </Button>
          </Space>
        )
      }
    },
    {
      title: '关键点',
      width: 110,
      render: (_value, record) => {
        const draft = stationStore.standardDraft[record.id]
        const critical = draft ? draft.isCritical : record.isCritical
        return (
          <Switch
            size="small"
            checked={critical}
            disabled={record.state !== '启用'}
            onChange={(checked: boolean) =>
              stationStore.setStandardDraft(record.id, {
                standardMin: draft ? draft.standardMin : record.standardMin,
                standardMax: draft ? draft.standardMax : record.standardMax,
                isCritical: checked
              })
            }
          />
        )
      }
    },
    {
      title: '状态',
      width: 100,
      render: (_value, record) => <Tag color={POINT_STATE_COLOR[record.state]}>{record.state}</Tag>
    },
    {
      title: '标准区间',
      width: 160,
      render: (_value, record) => rangeText(record.standardMin, record.standardMax, record.unit)
    },
    {
      title: '异常读数',
      width: 170,
      render: (_value, record) => {
        const abnormal = readingTable.rows.filter((row) => row.pointId === record.id && row.isAbnormal)
        if (abnormal.length === 0) return <Tag color="green">无异常</Tag>
        // 级别按每条读数自己留档的关键点标记，不跟随点位现标准
        const worst = abnormal.reduce((max, row) => {
          const level = abnormalLevelOf(row.deviationPct, row.snapshotCritical)
          const rank = level === '严重超标' ? 2 : 1
          return rank > max.rank ? { rank, deviationPct: row.deviationPct, critical: row.snapshotCritical } : max
        }, { rank: 0, deviationPct: 0, critical: false })
        return <AbnormalTag level={abnormalLevelOf(worst.deviationPct, worst.critical)} deviationPct={worst.deviationPct} size="small" />
      }
    },
    {
      title: '操作',
      width: 230,
      render: (_value, record) => (
        <Space size={4}>
          <Button type="text" size="small" onClick={() => openEdit(record)}>
            编辑
          </Button>
          {record.state === '启用' ? (
            <Popconfirm
              title="停用后该点位不再进入新巡检，历史读数仍保留可查。确认停用？"
              onOk={() => deactivate(record)}
            >
              <Button type="text" size="small">
                停用
              </Button>
            </Popconfirm>
          ) : record.state === '停用' ? (
            <Button type="text" size="small" onClick={() => requestReactivate(record)}>
              申请恢复
            </Button>
          ) : (
            <Popconfirm
              title={`恢复前请确认现行标准：${rangeText(record.standardMin, record.standardMax, record.unit)}${
                record.isCritical ? '（关键点）' : ''
              }。确认按此标准重新启用？`}
              onOk={() => confirmReactivate(record)}
            >
              <Button type="text" size="small" status="warning">
                确认标准并启用
              </Button>
            </Popconfirm>
          )}
          <Popconfirm
            title="仅从未产生过读数的点位可删除；有历史读数请改用停用。"
            onOk={() => remove(record)}
          >
            <Button type="text" size="small" status="danger">
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  const stats = stationStore.pointStats()
  const activeCount = stationStore.points.filter((point) => point.state === '启用').length
  const disabledCount = stationStore.points.filter((point) => point.state !== '启用').length

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">巡检点位与标准值配置</h2>
          <p className="page-head__desc">
            维护点位上下限、单位与关键点标记；关键点偏差率超过 5% 即判严重超标，普通点为 10%。停用点位不再进入新巡检，历史读数与派单依据仍可查；恢复时须重新确认标准。
          </p>
        </div>
        <div className="page-head__actions">
          <Button onClick={openTemplate}>按模板批量复制</Button>
          <Button disabled={Object.keys(stationStore.standardDraft).length === 0} onClick={commitAll}>
            提交标准值草稿（{Object.keys(stationStore.standardDraft).length}）
          </Button>
          <Button type="primary" onClick={openCreate}>
            新增点位
          </Button>
        </div>
      </div>

      <div className="stat-row">
        <StatBadge label="点位总数" value={stats.total} suffix="个" tone="primary" />
        <StatBadge label="启用中" value={activeCount} suffix="个" tone="success" />
        <StatBadge label="停用 / 待确认" value={disabledCount} suffix="个" tone="default" />
        <StatBadge
          label="异常读数占比"
          value={readingTable.rows.filter((row) => row.isAbnormal).length}
          percent={
            readingTable.rows.length === 0
              ? 0
              : Math.round((readingTable.rows.filter((row) => row.isAbnormal).length / readingTable.rows.length) * 100)
          }
          tone="danger"
        />
      </div>

      <FilterBar
        model={model}
        selects={filterSelects}
        keywordPlaceholder="搜索点位名 / 设备型号"
        switchLabel="仅看关键点"
        switchValue={filter.onlyCritical}
        hasSwitch
        onModelChange={onModelChange}
        onSwitchChange={(value: boolean) => stationStore.patchPointFilter({ onlyCritical: value })}
      />

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3 className="panel-title" style={{ margin: 0 }}>
            点位清单（{rows.length} / {stats.total}）
          </h3>
          <span className="muted">标准值改动先进入草稿；保存只影响此后新读数，历史异常与已派单依据按读数留档锁定。有待处置泄漏或录入草稿时无法停用</span>
        </div>
        {rows.length === 0 ? (
          <EmptyPanel
            title="没有匹配的点位"
            description="先到调压站台账登记设备，再按模板批量复制或手工新增点位。"
            actionText="新增点位"
            secondaryText="重置筛选"
            onAction={openCreate}
            onSecondary={() => stationStore.resetPointFilter()}
            compact
          />
        ) : (
          <Table<Point>
            rowKey="id"
            size="small"
            border
            data={rows}
            columns={columns}
            pagination={false}
            scroll={{ x: 1700 }}
          />
        )}
      </div>

      <Modal
        visible={pointOpen}
        title={editingId ? '编辑点位' : '新增点位'}
        onCancel={() => setPointOpen(false)}
        onOk={submit}
        okText="保存"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={pointForm} layout="vertical" initialValues={EMPTY_POINT_DRAFT}>
          <Form.Item field="deviceId" label="所属设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
          <Form.Item field="name" label="点位名" rules={[{ required: true, message: '请填写点位名' }]}>
            <Input placeholder="如 出口压力 / 阀体泄漏浓度" />
          </Form.Item>
          <Form.Item field="standardMin" label="标准下限" rules={[{ required: true, message: '请填写标准下限' }]}>
            <InputNumber step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="standardMax" label="标准上限" rules={[{ required: true, message: '请填写标准上限' }]}>
            <InputNumber step={0.01} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item field="unit" label="单位" rules={[{ required: true, message: '请选择单位' }]}>
            <Select options={POINT_UNITS.map((item) => ({ label: item, value: item }))} />
          </Form.Item>
          <Form.Item field="isCritical" label="是否关键点" triggerPropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        visible={templateOpen}
        title="按模板批量复制标准值"
        onCancel={() => setTemplateOpen(false)}
        onOk={submitTemplate}
        okText="复制点位"
        cancelText="取消"
        unmountOnExit
      >
        <Form form={templateForm} layout="vertical">
          <Form.Item field="deviceId" label="目标设备" rules={[{ required: true, message: '请选择设备' }]}>
            <Select options={deviceOptions} showSearch />
          </Form.Item>
        </Form>
        <div className="muted" style={{ marginBottom: 8 }}>
          已存在的同名点位会自动跳过：
        </div>
        <Checkbox.Group
          value={checkedTemplates}
          onChange={(values: string[]) => setCheckedTemplates(values)}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {POINT_TEMPLATES.map((item) => (
            <Checkbox key={item.name} value={item.name}>
              {item.name}（{rangeText(item.standardMin, item.standardMax, item.unit)}
              {item.isCritical ? ' · 关键点' : ''}）
            </Checkbox>
          ))}
        </Checkbox.Group>
        <div className="muted" style={{ marginTop: 10 }}>
          当前读数平均偏差参考：{deviationPctOf(0.3, 0.18, 0.25).toFixed(2)}%（示例计算）
        </div>
      </Modal>
    </div>
  )
}
