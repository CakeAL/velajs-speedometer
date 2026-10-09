import test from 'node:test'
import assert from 'node:assert/strict'
import { load, fakeFiles, fakeClock, settle } from './helpers.mjs'
const { createTrackProtocol, PROTOCOL, VERSION, CHUNK_BYTES } = await load('../src/common/track-protocol.js')
const { createTrackSync } = await load('../src/common/track-sync.js')
const { base64, crc32, toBytes } = await load('../src/common/transfer-bytes.js')
const { TRACK_DIR } = await load('../src/common/files.js')

const request = (op, fields = {}) => ({ protocol: PROTOCOL, version: VERSION, id: 'test-1', op, ...fields })
function fixture() {
  const fs = fakeFiles(uri => uri.replace('/track-', '//track-'))
  fs.data.set(TRACK_DIR, null)
  for (let i = 0; i < 10; i++) fs.data.set(TRACK_DIR + 'track-' + i + '.gpx', '<gpx>' + i + '</gpx>')
  fs.data.set(TRACK_DIR + 'track-active.part', '<gpx>')
  return fs
}

test('byte encoding is portable and CRC32 matches the standard known vector', () => {
  assert.equal(crc32(new Uint8Array(Buffer.from('123456789'))), 'cbf43926')
  assert.equal(crc32(new Uint8Array(0)), '00000000')
  for (const size of [0, 1, 2, 3, 255, CHUNK_BYTES]) {
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256)
    assert.equal(base64(bytes), Buffer.from(bytes).toString('base64'))
    assert.deepEqual(toBytes(bytes.buffer), bytes)
  }
  assert.throws(() => toBytes('bad'))
})

test('hello and paginated lists expose completed GPX metadata without private filesystem paths', async () => {
  const fs = fixture(); const handle = createTrackProtocol(fs.api, () => TRACK_DIR + 'track-active.part')
  const hello = await handle(request('hello'))
  assert.equal(hello.result.chunkBytes, CHUNK_BYTES)
  let offset = 0; const names = []
  do {
    const response = await handle(request('list', { offset }))
    assert.equal(response.ok, true); assert.equal(response.result.total, 10)
    assert.ok(response.result.files.length <= 4)
    assert.ok(JSON.stringify(response).length < 2048)
    for (const entry of response.result.files) {
      assert.equal(entry.bytes, Buffer.byteLength(fs.data.get(TRACK_DIR + entry.name)))
      assert.equal(entry.etag, entry.bytes + ':100000')
      assert.equal(entry.uri, undefined); names.push(entry.name)
    }
    offset = response.result.nextOffset
  } while (offset !== null)
  assert.equal(new Set(names).size, 10)
})

test('a plugin can reconstruct a large GPX byte for byte, retry chunks and resume by offset', async () => {
  const fs = fixture(); const name = 'track-large.gpx'
  const content = '<gpx>' + '<trkpt lat="1" lon="2"><ele>-12.50</ele><time>2026-10-09T11:33:50Z</time></trkpt>\n'.repeat(300) + '</gpx>'
  fs.data.set(TRACK_DIR + name, content)
  const reads = []; const nativeRead = fs.api.readArrayBuffer
  fs.api.readArrayBuffer = options => { reads.push(options.length); nativeRead(options) }
  const handle = createTrackProtocol(fs.api, () => null)
  const etag = Buffer.byteLength(content) + ':100000'
  const parts = []; let offset = 0; let eof = false
  while (!eof) {
    const message = request('read', { name, etag, offset })
    const response = await handle(message)
    assert.equal(response.ok, true)
    const chunk = response.result
    if (!offset) assert.deepEqual(await handle(message), response, 'retry returns the same bytes')
    const bytes = Buffer.from(chunk.data, 'base64')
    assert.equal(chunk.crc32, crc32(bytes)); assert.equal(bytes.length, chunk.bytes)
    assert.equal(chunk.offset, offset); assert.equal(chunk.nextOffset, offset + bytes.length)
    assert.ok(JSON.stringify(response).length < 2048)
    parts.push(bytes); offset = chunk.nextOffset; eof = chunk.eof
  }
  assert.equal(Buffer.concat(parts).toString(), content)
  assert.ok(reads.every(length => length <= CHUNK_BYTES))
  const last = await handle(request('read', { name, etag, offset }))
  assert.equal(last.result.bytes, 0); assert.equal(last.result.eof, true)
})

test('deletion requires a matching etag and is safe to retry after losing its reply', async () => {
  const fs = fixture(); const deleted = []
  const handle = createTrackProtocol(fs.api, () => null, name => deleted.push(name))
  const entry = (await handle(request('list'))).result.files[0]
  assert.equal((await handle(request('delete', { name: entry.name, etag: 'old' }))).error.code, 'FILE_CHANGED')
  assert.equal(fs.data.has(TRACK_DIR + entry.name), true)
  const message = request('delete', { name: entry.name, etag: entry.etag })
  assert.equal((await handle(message)).result.deleted, true)
  assert.equal((await handle(message)).result.deleted, false)
  assert.deepEqual(deleted, [entry.name]); assert.equal(fs.data.has(TRACK_DIR + 'track-1.gpx'), true)
})

test('rejects traversal, active recordings, stale metadata, invalid ranges and incompatible versions', async () => {
  const fs = fixture(); const active = TRACK_DIR + 'track-active.part'
  fs.data.set(active.replace('.part', '.gpx'), 'saving')
  const handle = createTrackProtocol(fs.api, () => active)
  for (const name of ['../track-0.gpx', TRACK_DIR + 'track-0.gpx', 'track-0.part', 'track-a\\b.gpx', 'track-%2e%2e.gpx']) {
    assert.equal((await handle(request('delete', { name, etag: 'x' }))).error.code, 'BAD_REQUEST')
  }
  assert.equal((await handle(request('read', { name: 'track-active.gpx', etag: 'x' }))).error.code, 'RECORDING_ACTIVE')
  assert.equal((await handle(request('list'))).result.total, 10)
  assert.equal((await handle(request('hello', { version: 99 }))).error.code, 'UNSUPPORTED_VERSION')
  assert.equal((await handle(request('write'))).error.code, 'UNKNOWN_OPERATION')
  const entry = (await handle(request('list'))).result.files[0]
  for (const fields of [{ offset: -1 }, { offset: 999 }, { length: CHUNK_BYTES + 1 }, { length: 0 }, { offset: 0.5 }]) {
    assert.equal((await handle(request('read', { name: entry.name, etag: entry.etag, ...fields }))).error.code, 'BAD_REQUEST')
  }
  assert.equal((await handle(request('read', { name: entry.name, etag: 'x' }))).error.code, 'FILE_CHANGED')
  assert.equal((await handle(request('read', { name: 'track-missing.gpx', etag: 'x' }))).error.code, 'NOT_FOUND')
})

test('does not silently report a complete download when a native read is truncated', async () => {
  const fs = fixture(); const handle = createTrackProtocol(fs.api, () => null)
  const entry = (await handle(request('list'))).result.files[0]
  fs.api.readArrayBuffer = options => options.success({ buffer: new Uint8Array(1) })
  const response = await handle(request('read', { name: entry.name, etag: entry.etag }))
  assert.equal(response.ok, false); assert.equal(response.error.code, 'FILE_CHANGED')
})

function transport(autoReply = true) {
  const fs = fixture(); const sent = []; const clock = fakeClock()
  const connection = { send(options) { sent.push(options); if (autoReply) options.success() } }
  let instances = 0
  const sync = createTrackSync({ instance() { instances++; return connection } }, fs.api,
    { activeUri: () => null }, clock)
  sync.start(); sync.start()
  assert.equal(instances, 1)
  return { fs, sent, clock, connection, sync }
}

test('native onmessage accepts JSON strings and data envelopes and replies with send({data: object})', async () => {
  const { connection, sent, sync, clock } = transport()
  await connection.onmessage({ data: JSON.stringify(request('hello')) })
  await connection.onmessage(JSON.stringify(request('list', { id: 'list' })))
  await connection.onmessage({ data: request('hello', { id: 'object' }) })
  assert.deepEqual(sent.map(options => options.data.id), ['test-1', 'list', 'object'])
  assert.equal(sent[0].data.protocol, PROTOCOL); assert.equal(sent[0].data.ok, true)
  assert.equal(clock.tasks, 0)
  sync.dispose(); assert.equal(connection.onmessage, null)
})

test('ignores other protocols, response echoes, malformed JSON and oversized messages', async () => {
  const { connection, sent, sync } = transport()
  for (const event of ['{', JSON.stringify(request('hello', { protocol: 'other' })),
    request('hello', { id: '' }), request('hello', { ok: true }),
    { data: JSON.stringify(request('hello', { payload: 'x'.repeat(5000) })) }]) {
    await connection.onmessage(event)
  }
  assert.equal(sent.length, 0); sync.dispose()
})

test('send timeout, failure and disconnect do not leave timers or replay queued commands', async () => {
  const { connection, sent, sync, clock, fs } = transport(false)
  const first = connection.onmessage(request('hello'))
  await settle(); assert.equal(sent.length, 1)
  const deletion = connection.onmessage(request('delete', { name: 'track-0.gpx', etag: '12:100000' }))
  connection.onclose()
  await first; await deletion
  assert.equal(fs.data.has(TRACK_DIR + 'track-0.gpx'), true)
  const timed = connection.onmessage(request('hello'))
  await settle(); clock.advance(10000); await timed
  const failed = connection.onmessage(request('hello'))
  await settle(); sent.at(-1).fail('', 1006); await failed
  assert.equal(clock.tasks, 0)
  sync.dispose()
})

test('remote delete notifies the visible page and unsubscribes cleanly', async () => {
  const { connection, sent, sync } = transport()
  const changes = []; const unsubscribe = sync.subscribe(name => changes.push(name))
  await connection.onmessage(request('delete', { name: 'track-0.gpx', etag: '12:100000' }))
  assert.equal(sent.at(-1).data.ok, true)
  assert.deepEqual(changes, ['track-0.gpx'])
  unsubscribe()
  await connection.onmessage(request('delete', { name: 'track-1.gpx', etag: '12:100000' }))
  assert.deepEqual(changes, ['track-0.gpx']); sync.dispose()
})

test('unsupported interconnect cannot prevent the local application from running', () => {
  const sync = createTrackSync({ instance() { throw new Error('unsupported') } }, fixture().api,
    { activeUri: () => null }, fakeClock())
  assert.doesNotThrow(() => sync.start()); assert.doesNotThrow(() => sync.dispose())
})

test('a broken UI subscriber cannot turn a successful remote deletion into an error', async () => {
  const { connection, sent, sync } = transport()
  sync.subscribe(() => { throw new Error('page error') })
  await connection.onmessage(request('delete', { name: 'track-0.gpx', etag: '12:100000' }))
  assert.equal(sent.at(-1).data.ok, true); assert.equal(sent.at(-1).data.result.deleted, true)
  sync.dispose()
})

test('bounds queued requests and releases pending sends when disposed', async () => {
  const { connection, sent, sync, clock } = transport(false)
  const receive = connection.onmessage
  const operations = Array.from({ length: 12 }, (_, i) => receive(request('hello', { id: String(i) })))
  await settle(); assert.equal(sent.length, 1)
  sent[0].success(); await settle(); assert.equal(sent.length, 2)
  sync.dispose(); await Promise.all(operations)
  assert.equal(sent.length, 2); assert.equal(clock.tasks, 0)
})
