import device from '@system.device'
import router from '@system.router'
import { screenLayout, dashboardLayout } from './layout'

export function createReadingPage() {
  return {
    private: {
      pageClass: 'round-page', narrow: false, speed: '--', speedFont: 76, speedHeight: 54, unitHeight: 22, metricsHeight: 44, summaryHeight: 32, unit: 'km/h',
      altitude: '--', accuracy: '--', average: '--', maximum: '--',
      latitudeNumber: '--', latitudeDirection: '纬度', longitudeNumber: '--', longitudeDirection: '经度',
      statusText: 'GPS 搜星中', statusColor: '#f2bf68', tone: 'warning',
      detailNote: '尚未获取位置',
      gpsRequest: '单次定位：未启动', gpsCallbacks: '订阅尚未启动', gpsError: '', gpsAltitude: '尚未收到海拔',
      recording: false, saving: false, recordText: '记录', recordNotice: '', recordDuration: '0:00', recordPoints: 0
    },
    onInit() {
      this._destroyed = false
      this._listening = false
      this._layout = screenLayout()
      this._session = this.$app.$def.session
      this._listener = current => {
        if (this._destroyed) return
        const values = { ...current, ...dashboardLayout(this._layout, current.speed) }
        Object.keys(values).forEach(key => { this[key] = values[key] })
      }
      device.getInfo({ success: info => {
        if (this._destroyed) return
        this._layout = screenLayout(info)
        this.pageClass = this._layout.pageClass; this.narrow = this._layout.narrow
        this._listener(this._session.snapshot())
      }, fail() {} })
    },
    onShow() { this._listening = true; this._session.acquire(this._listener) },
    onHide() { this._listening = false; this._session.release(this._listener) },
    onDestroy() {
      this._destroyed = true
      if (this._listening) this._session.release(this._listener)
      this._listening = false
    },
    changeUnit() { this._session.changeUnit() },
    refreshLocation() { this._session.refreshLocation() },
    openPosition() { router.push({ uri: '/pages/position' }) },
    openTracks() { router.push({ uri: '/pages/tracks' }) },
    back() { router.back() },
    async toggleRecording() {
      try { await this._session.toggleRecording() }
      catch (error) { if (!this._destroyed) this.recordNotice = error.message }
    }
  }
}
