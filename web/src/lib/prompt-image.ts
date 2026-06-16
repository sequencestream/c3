/*
 * prompt-image.ts — 输入框附加图片的客户端处理（选取 / 解码 / 压缩 / 预览 / 上线）。
 *
 * c3 只接受图片(见 shared 的 IMAGE_MEDIA_TYPES);本模块把用户从「点击/粘贴/拖拽」
 * 拿到的 File 列表正规化为可预览、可发送的 PromptImage。非图片被忽略并计数,超阈值的
 * 位图在前端经 canvas 等比缩小并重编码以控制体积(动图 gif 不压,避免压成单帧)。
 *
 * 纯函数(base64Bytes / splitDataUrl / shouldCompress / scaledSize / isAcceptedImageType /
 * toWire)无 DOM 依赖,可在 Node 下单测;readImageFiles 走 FileReader/Image/canvas,
 * 仅在浏览器(或 happy-dom 组件测试)中调用。
 */
import { isImageMediaType, type PromptImage } from '@ccc/shared/protocol'

/** 单图解码体积超过此阈值(5MB)才触发前端压缩。 */
export const COMPRESS_OVER_BYTES = 5 * 1024 * 1024
/** 压缩时最长边的上限(px),等比缩放。 */
export const MAX_EDGE_PX = 2000
/** 压缩重编码质量(jpeg/webp 生效,png 忽略但仍受益于降分辨率)。 */
export const COMPRESS_QUALITY = 0.82

/** 已选中、待发送的一张图片:PromptImage(上线字段)+ 预览/展示用元数据。 */
export interface ProcessedImage {
  mediaType: string
  /** 去掉 `data:` 前缀的纯 base64(上线给服务端的字段)。 */
  data: string
  /** 缩略图 <img> 用的完整 data: URL。 */
  previewUrl: string
  /** 解码后字节数(压缩后的最终值),用于展示/调试。 */
  bytes: number
  /** 原始文件名,用于 alt / 标题。 */
  name: string
}

/** 带稳定 id 的已选图片(组件按 id 渲染列表与删除)。 */
export interface SelectedImage extends ProcessedImage {
  id: number
}

/** readImageFiles 的结果:正规化后的图片 + 被忽略的非图片数量(供提示)。 */
export interface ImageIntakeResult {
  images: ProcessedImage[]
  rejectedCount: number
}

/** base64 字符串(无 `data:` 前缀)解码后的字节数。 */
export function base64Bytes(data: string): number {
  const len = data.length
  if (len === 0) return 0
  let padding = 0
  if (data.endsWith('==')) padding = 2
  else if (data.endsWith('=')) padding = 1
  return Math.floor((len * 3) / 4) - padding
}

/** 拆分 `data:<mediaType>;base64,<data>` 为 {mediaType, data};非 base64 data URL 返回 null。 */
export function splitDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!m) return null
  return { mediaType: m[1], data: m[2] }
}

/** File/Blob 的 MIME 是否为 c3 接受的图片类型。 */
export function isAcceptedImageType(type: string): boolean {
  return isImageMediaType(type)
}

/**
 * 是否应在前端压缩:仅当解码体积超阈值且不是 gif(压缩会丢动画,属编辑范畴的非目标)。
 */
export function shouldCompress(bytes: number, mediaType: string): boolean {
  if (mediaType === 'image/gif') return false
  return bytes > COMPRESS_OVER_BYTES
}

/** 等比把 (w,h) 缩到最长边不超过 maxEdge;已在范围内则原样返回(整数像素)。 */
export function scaledSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest === 0) return { width, height }
  const ratio = maxEdge / longest
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) }
}

/** 取已选图片的上线字段(剥离 id/preview/bytes/name),即随 user_prompt 发送的负载。 */
export function toWire(images: SelectedImage[]): PromptImage[] {
  return images.map(({ mediaType, data }) => ({ mediaType, data }))
}

/**
 * 从 wire 形态(仅 mediaType+data,如待发队列回填)重建可预览的 SelectedImage:
 * previewUrl 由 base64 还原为 data URL,bytes 重新计算,name 缺省占位。
 */
export function fromWire(image: PromptImage, id: number): SelectedImage {
  return {
    id,
    mediaType: image.mediaType,
    data: image.data,
    previewUrl: `data:${image.mediaType};base64,${image.data}`,
    bytes: base64Bytes(image.data),
    name: 'image',
  }
}

// ---- 以下走 DOM(FileReader / Image / canvas),仅浏览器/happy-dom 调用 ----

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = dataUrl
  })
}

/**
 * 把超阈值位图经 canvas 等比缩小并按 mediaType 重编码;失败或没减小则原样退回。
 */
async function compressDataUrl(dataUrl: string, mediaType: string): Promise<string> {
  try {
    const img = await loadImage(dataUrl)
    const srcW = img.naturalWidth || img.width
    const srcH = img.naturalHeight || img.height
    const { width, height } = scaledSize(srcW, srcH, MAX_EDGE_PX)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const cx = canvas.getContext('2d')
    if (!cx) return dataUrl
    cx.drawImage(img, 0, 0, width, height)
    const out = canvas.toDataURL(mediaType, COMPRESS_QUALITY)
    return out && out.length > 0 && out.length < dataUrl.length ? out : dataUrl
  } catch {
    return dataUrl
  }
}

/**
 * 把一批 File 正规化为待发送图片:非图片忽略并计入 rejectedCount,超阈位图压缩。
 * 顺序保持与输入一致。
 */
export async function readImageFiles(files: File[]): Promise<ImageIntakeResult> {
  const images: ProcessedImage[] = []
  let rejectedCount = 0
  for (const file of files) {
    if (!isAcceptedImageType(file.type)) {
      rejectedCount++
      continue
    }
    let dataUrl: string
    try {
      dataUrl = await readAsDataUrl(file)
    } catch {
      rejectedCount++
      continue
    }
    let parsed = splitDataUrl(dataUrl)
    if (!parsed) {
      rejectedCount++
      continue
    }
    if (shouldCompress(base64Bytes(parsed.data), parsed.mediaType)) {
      dataUrl = await compressDataUrl(dataUrl, parsed.mediaType)
      parsed = splitDataUrl(dataUrl) ?? parsed
    }
    images.push({
      mediaType: parsed.mediaType,
      data: parsed.data,
      previewUrl: dataUrl,
      bytes: base64Bytes(parsed.data),
      name: file.name,
    })
  }
  return { images, rejectedCount }
}
