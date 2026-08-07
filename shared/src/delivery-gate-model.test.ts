import { describe, expect, it } from 'vitest'
import {
  DELIVERY_WRITE_BLOCKING_STATUSES,
  findWriteBlockingDelivery,
  isDeliveryWriteBlocked,
  type DeliveryGateFact,
} from './delivery-gate-model.js'

const del = (over: Partial<DeliveryGateFact> = {}): DeliveryGateFact => ({
  id: 'del-1',
  title: '交付 X',
  status: 'planned',
  ...over,
})

describe('isDeliveryWriteBlocked', () => {
  it('verifying/verified/delivered/cancelled 禁止新写入', () => {
    for (const s of DELIVERY_WRITE_BLOCKING_STATUSES) expect(isDeliveryWriteBlocked(s)).toBe(true)
  })

  it('planned/integrating 是可写窗口', () => {
    expect(isDeliveryWriteBlocked('planned')).toBe(false)
    expect(isDeliveryWriteBlocked('integrating')).toBe(false)
  })
})

describe('findWriteBlockingDelivery', () => {
  it('无关联 → null', () => {
    expect(findWriteBlockingDelivery([], [del()])).toBeNull()
  })

  it('全部可写 → null', () => {
    expect(
      findWriteBlockingDelivery(
        ['a', 'b'],
        [del({ id: 'a' }), del({ id: 'b', status: 'integrating' })],
      ),
    ).toBeNull()
  })

  it('多关联取最严:任一禁止即阻塞', () => {
    const blocking = findWriteBlockingDelivery(
      ['a', 'b'],
      [
        del({ id: 'a', status: 'integrating' }),
        del({ id: 'b', title: '交付 Y', status: 'verifying' }),
      ],
    )
    expect(blocking).toEqual({ id: 'b', title: '交付 Y', status: 'verifying' })
  })

  it('快照里没有的交付 id 不作数', () => {
    expect(findWriteBlockingDelivery(['ghost'], [])).toBeNull()
  })
})
