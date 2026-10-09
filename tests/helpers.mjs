import { readFile } from 'node:fs/promises'
const cache = new Map()
export async function moduleUrl(path) {
  const url = path instanceof URL ? path : new URL(path, import.meta.url)
  if (cache.has(url.href)) return cache.get(url.href)
  let code = await readFile(url, 'utf8')
  const imports = [...code.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)]
  for (const match of imports) {
    const dep = new URL(match[1].endsWith('.js') ? match[1] : match[1] + '.js', url)
    code = code.replace(match[0], 'from ' + JSON.stringify(await moduleUrl(dep)))
  }
  const result = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  cache.set(url.href, result)
  return result
}
export async function load(path) { return import(await moduleUrl(path)) }
export const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
export function fakeClock() {
  let now = 100000
  let id = 0
  const tasks = new Map()
  return {
    now: () => now,
    setInterval(fn, ms) { tasks.set(++id, { fn, at: now + ms, ms }); return id },
    clearInterval(id) { tasks.delete(id) },
    setTimeout(fn, ms) { tasks.set(++id, { fn, at: now + ms }); return id },
    clearTimeout(id) { tasks.delete(id) },
    advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [key, task] = next
        now = task.at
        if (task.ms) task.at += task.ms
        else tasks.delete(key)
        task.fn()
      }
      now = end
    },
    get tasks() { return tasks.size }
  }
}
export function fakeFiles(listUri = uri => uri) {
  const data = new Map()
  const writes = []
  let failWrite = false
  const api = {
    access(o) { data.has(o.uri) ? o.success({}) : o.fail('', 301) },
    mkdir(o) { data.set(o.uri, null); o.success({}) },
    writeText(o) {
      writes.push(o)
      if (failWrite) { failWrite = false; o.fail('', 300); return }
      data.set(o.uri, (o.append ? data.get(o.uri) || '' : '') + o.text); o.success({})
    },
    readText(o) { data.has(o.uri) ? o.success({ text: data.get(o.uri) }) : o.fail('', 301) },
    readArrayBuffer(o) {
      if (!data.has(o.uri)) { o.fail('', 301); return }
      const bytes = Buffer.from(data.get(o.uri))
      o.success({ buffer: new Uint8Array(bytes.subarray(o.position || 0, (o.position || 0) + (o.length || bytes.length))) })
    },
    list(o) { o.success({ fileList: [...data].filter(([uri, text]) => uri.startsWith(o.uri) && text !== null)
      .map(([uri, text]) => ({ uri: listUri(uri), length: Buffer.byteLength(text), lastModifiedTime: 100000 })) }) },
    move(o) { if (!data.has(o.srcUri)) { o.fail('', 301); return } data.set(o.dstUri, data.get(o.srcUri)); data.delete(o.srcUri); o.success(o.dstUri) },
    delete(o) { if (!data.has(o.uri)) { o.fail('', 301); return } data.delete(o.uri); o.success({}) }
  }
  return { api, data, writes, failNextWrite() { failWrite = true } }
}
