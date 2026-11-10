/**
 * 统一的 HTTP 取数工具：超时、重试、编码、错峰。
 *
 * 所有数据源都走这里，避免每个 source 各自实现重试导致行为不一致。
 * 失败会抛出带 url 的错误，由调用方决定"记缺口"还是"中止"。
 *
 * @module dsh-basis-watch/lib/http
 */

/** 默认 UA：部分站点（生意社/交易所）会拒绝空 UA。 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/**
 * 把 GB18030 字节解码成字符串（新浪行情用这个编码）。
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {string}
 */
export function decodeGb18030(buf) {
  try {
    return new TextDecoder('gb18030').decode(buf)
  } catch {
    return Buffer.from(buf).toString('utf8')
  }
}

/**
 * 请求一个 URL 并返回原始字节。
 * @param {string} url
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]
 * @returns {Promise<Uint8Array>}
 */
export async function getBytes(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000
  const retries = opts.retries ?? 2
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, ...(opts.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(300 * (attempt + 1))
    }
  }
  throw new Error(`请求失败 ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * 请求文本（默认按 UTF-8 解码；新浪行情传 encoding:'gb18030'）。
 * @param {string} url
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]
 * @param {'utf8'|'gb18030'} [opts.encoding]
 * @returns {Promise<string>}
 */
export async function getText(url, opts = {}) {
  const bytes = await getBytes(url, opts)
  return opts.encoding === 'gb18030' ? decodeGb18030(bytes) : Buffer.from(bytes).toString('utf8')
}

/**
 * 请求 JSON。
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<any>}
 */
export async function getJson(url, opts = {}) {
  const text = await getText(url, opts)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`返回不是 JSON: ${url} :: ${text.slice(0, 120)}`)
  }
}

/**
 * 睡眠（用于抓取限速，避免把人家站点打挂）。
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

