import { describe, it, expect } from 'vitest'
import {
  COMPRESS_OVER_BYTES,
  MAX_EDGE_PX,
  base64Bytes,
  splitDataUrl,
  isAcceptedImageType,
  shouldCompress,
  scaledSize,
  toWire,
  fromWire,
  type SelectedImage,
} from './prompt-image'

function sel(over: Partial<SelectedImage> = {}): SelectedImage {
  return {
    id: 1,
    mediaType: 'image/png',
    data: 'AAAA',
    previewUrl: 'data:image/png;base64,AAAA',
    bytes: 3,
    name: 'a.png',
    ...over,
  }
}

describe('prompt-image — base64Bytes', () => {
  it('无填充:len*3/4', () => {
    expect(base64Bytes('AAAA')).toBe(3) // 4 chars → 3 bytes
    expect(base64Bytes('')).toBe(0)
  })
  it('单/双填充各扣 1/2 字节', () => {
    expect(base64Bytes('AAA=')).toBe(2)
    expect(base64Bytes('AA==')).toBe(1)
  })
})

describe('prompt-image — splitDataUrl', () => {
  it('拆分 base64 data URL 为 mediaType + data', () => {
    expect(splitDataUrl('data:image/png;base64,Zm9v')).toEqual({
      mediaType: 'image/png',
      data: 'Zm9v',
    })
  })
  it('非 base64 / 非 data URL 返回 null', () => {
    expect(splitDataUrl('data:image/png,raw')).toBeNull()
    expect(splitDataUrl('https://x/y.png')).toBeNull()
  })
})

describe('prompt-image — isAcceptedImageType', () => {
  it('接受 png/jpeg/gif/webp,拒绝其余', () => {
    expect(isAcceptedImageType('image/png')).toBe(true)
    expect(isAcceptedImageType('image/webp')).toBe(true)
    expect(isAcceptedImageType('application/pdf')).toBe(false)
    expect(isAcceptedImageType('text/plain')).toBe(false)
  })
})

describe('prompt-image — shouldCompress', () => {
  it('超阈值的非 gif 位图触发压缩', () => {
    expect(shouldCompress(COMPRESS_OVER_BYTES + 1, 'image/jpeg')).toBe(true)
  })
  it('阈值内不压缩', () => {
    expect(shouldCompress(COMPRESS_OVER_BYTES, 'image/jpeg')).toBe(false)
    expect(shouldCompress(1024, 'image/png')).toBe(false)
  })
  it('gif 永不压缩(避免压成单帧)', () => {
    expect(shouldCompress(COMPRESS_OVER_BYTES * 2, 'image/gif')).toBe(false)
  })
})

describe('prompt-image — scaledSize', () => {
  it('已在上限内:原样返回', () => {
    expect(scaledSize(800, 600, MAX_EDGE_PX)).toEqual({ width: 800, height: 600 })
  })
  it('超上限:等比缩放至最长边=maxEdge', () => {
    expect(scaledSize(4000, 2000, 2000)).toEqual({ width: 2000, height: 1000 })
    expect(scaledSize(1000, 5000, 2000)).toEqual({ width: 400, height: 2000 })
  })
  it('零尺寸不除零', () => {
    expect(scaledSize(0, 0, 2000)).toEqual({ width: 0, height: 0 })
  })
})

describe('prompt-image — toWire / fromWire', () => {
  it('toWire 仅保留 mediaType + data', () => {
    expect(toWire([sel(), sel({ id: 2, mediaType: 'image/jpeg', data: 'BBBB' })])).toEqual([
      { mediaType: 'image/png', data: 'AAAA' },
      { mediaType: 'image/jpeg', data: 'BBBB' },
    ])
  })
  it('fromWire 由 wire 重建预览与字节数', () => {
    const out = fromWire({ mediaType: 'image/jpeg', data: 'AAAA' }, 7)
    expect(out).toMatchObject({
      id: 7,
      mediaType: 'image/jpeg',
      data: 'AAAA',
      previewUrl: 'data:image/jpeg;base64,AAAA',
      bytes: 3,
    })
  })
})
