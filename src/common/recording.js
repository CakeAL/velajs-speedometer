import { fileCall, ensureDirectory, listTrackFiles, trackName, TRACK_DIR } from './files'

function ascii(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
  let text = ''
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i])
  return text
}

export const GPX_END = '</trkseg></trk></gpx>\n'
export const GPX_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<gpx version="1.1" creator="Speedometer" xmlns="http://www.topografix.com/GPX/1/1">\n'

export function isoTime(now) { return new Date(now).toISOString() }

export function trackPoint(fix, now) {
  if (!fix || typeof fix.latitude !== 'number' || !isFinite(fix.latitude) || Math.abs(fix.latitude) > 90 ||
      typeof fix.longitude !== 'number' || !isFinite(fix.longitude) || Math.abs(fix.longitude) > 180) return null
  const elevation = typeof fix.altitude === 'number' && isFinite(fix.altitude) ? '<ele>' + fix.altitude.toFixed(2) + '</ele>' : ''
  return '<trkpt lat="' + fix.latitude.toFixed(7) + '" lon="' + fix.longitude.toFixed(7) + '">' +
    elevation + '<time>' + isoTime(now) + '</time></trkpt>\n'
}

// Append each second, never keep an entire route in watch RAM. A .part remains
// recoverable if the app exits before the final closing tags have been written.
export function createRecorder(api, onChange) {
  let state = { recording: false, saving: false, points: 0, startedAt: null, uri: null, message: '' }
  let write = Promise.resolve()
  let busy = false
  let broken = false
  let lastSecond = null
  function emit() { onChange({ ...state }) }
  return {
    snapshot() { return { ...state } },
    async start(now) {
      if (state.recording || state.saving) return
      state = { ...state, saving: true, message: '正在创建轨迹' }; emit()
      try {
        await ensureDirectory(api)
        const name = trackName(now)
        const uri = TRACK_DIR + name + '.part'
        await fileCall(api, 'writeText', { uri, text: GPX_HEADER + '<metadata><time>' + isoTime(now) +
          '</time></metadata><trk><name>' + name + '</name><trkseg>\n' })
        state = { recording: true, saving: false, points: 0, startedAt: now, uri, message: '等待有效定位' }
        broken = false; busy = false; lastSecond = null; write = Promise.resolve(); emit()
      } catch (error) { state = { ...state, saving: false, message: error.message }; emit(); throw error }
    },
    sample(fix, now, fresh) {
      if (!state.recording || broken) return
      const second = Math.floor(now / 1000)
      if (second === lastSecond) return
      lastSecond = second
      const point = fresh ? trackPoint(fix, now) : null
      if (!point) { state.message = '等待定位，缺失时不补造轨迹'; emit(); return }
      if (busy) { state.message = '存储忙，已跳过这一秒'; emit(); return }
      busy = true
      const uri = state.uri
      write = fileCall(api, 'writeText', { uri, text: point, append: true }).then(() => {
        state.points += 1
        state.message = fix.altitude === null ? '记录中 · 设备未返回海拔' : '每秒记录 · 含海拔'
      }, error => {
        broken = true; state.recording = false
        state.message = '写入失败 · 请到轨迹页恢复'
      }).then(() => { busy = false; emit() })
    },
    async finish() {
      if (!state.uri || state.saving) return null
      state.recording = false; state.saving = true; emit()
      try {
        await write
        if (broken) throw new Error('请到轨迹页恢复未完成文件')
        await fileCall(api, 'writeText', { uri: state.uri, text: GPX_END, append: true })
        const uri = state.uri.replace(/\.part$/, '.gpx')
        await fileCall(api, 'move', { srcUri: state.uri, dstUri: uri })
        state = { ...state, uri: null, saving: false, message: '已保存 ' + state.points + ' 个轨迹点' }; emit()
        return uri
      } catch (error) { state = { ...state, uri: null, saving: false, message: error.message }; emit(); throw error }
    }
  }
}

export async function recoverTracks(api, activeUri) {
  const entries = await listTrackFiles(api)
  const pending = entries.filter(item => /\.part$/.test(item.uri) && item.uri !== activeUri)
  let failed = 0
  let recovered = 0
  for (const item of pending) {
    const repair = item.uri.replace(/\.part$/, '.repair')
    try {
      let position = 0
      let carry = ''
      let initialized = false
      // Repair a long interrupted recording using fixed-size chunks. Only
      // complete track points are copied; a partially written tail is discarded.
      for (;;) {
        const data = await fileCall(api, 'readArrayBuffer', { uri: item.uri, position, length: 4096 })
        const bytes = data.buffer instanceof ArrayBuffer ? new Uint8Array(data.buffer) : data.buffer
        if (!bytes || !bytes.length) break
        let text = carry + ascii(bytes)
        position += bytes.length
        if (!initialized) {
          const headerEnd = text.indexOf('<trkseg>')
          if (text.indexOf('<gpx ') < 0 || headerEnd < 0) throw new Error('文件头不完整')
          await fileCall(api, 'writeText', { uri: repair, text: text.slice(0, headerEnd + 8) + '\n' })
          text = text.slice(headerEnd + 8)
          initialized = true
        }
        const end = text.lastIndexOf('</trkpt>')
        if (end >= 0) await fileCall(api, 'writeText', { uri: repair, text: text.slice(0, end + 8) + '\n', append: true })
        carry = text.slice(end >= 0 ? end + 8 : 0).slice(-512)
        if (bytes.length < 4096) break
      }
      if (!initialized) throw new Error('文件为空')
      await fileCall(api, 'writeText', { uri: repair, text: GPX_END, append: true })
      await fileCall(api, 'move', { srcUri: repair, dstUri: item.uri.replace(/\.part$/, '.gpx') })
      await fileCall(api, 'delete', { uri: item.uri })
      recovered += 1
    } catch (error) { failed += 1 }
  }
  return { recovered, failed }
}
