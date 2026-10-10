import device from '@system.device'
import router from '@system.router'
import { screenLayout } from './layout'

export function createReadingPage() {
  return {
    private: {
      pageClass: 'round-page', narrow: false, speed: '--', speedFont: 76, speedHeight: 54, unitHeight: 22, metricsHeight: 44, summaryHeight: 32, unit: 'km/h',
      altitude: '--', accuracy: '--', average: '--', maximum: '--',
      latitudeNumber: '--', latitudeDirection: '纬度', longitudeNumber: '--', longitudeDirection: '经度',
      statusText: 'GPS 搜星中', statusColor: '#f2bf68', tone: 'warning',
      hint: '请在室外等待 GPS 定位', detailNote: '尚未获取位置',
      recording: false, saving: false, recordText: '记录', recordInfo: '', recordNotice: '', recordDuration: '0:00', recordPoints: 0
    },
    onInit() {
      this._destroyed = false
      this._listening = false
      this._screenHeight = 240
      this._session = this.$app.$def.session
      this._listener = current => {
        if (this._destroyed) return
        Object.keys(current).forEach(key => { this[key] = current[key] })
        const width = this.narrow ? 208 : (this.pageClass === 'rect-page' ? 208 : 192)
        const available = this._screenHeight - (this.narrow ? 72 + 34 + 148 :
          (this.pageClass === 'rect-page' ? 32 : 40) + 18 + 30)
        this.unitHeight = this.narrow ? 38 : 22
        this.metricsHeight = this.narrow ? 78 : (available >= 190 ? 54 : 44)
        this.speedHeight = this.narrow ? 112 : Math.max(50, Math.min(86,
          available - this.unitHeight - this.metricsHeight - 32))
        this.summaryHeight = Math.max(this.narrow ? 116 : 32,
          available - this.speedHeight - this.unitHeight - this.metricsHeight)
        this.speedFont = Math.min(this.narrow ? 100 : this.speedHeight - 6,
          Math.floor(width / (Math.max(3, current.speed.length) * 0.65)))
      }
      device.getInfo({ success: info => {
        if (this._destroyed) return
        const layout = screenLayout(info)
        this.pageClass = layout.pageClass; this.narrow = layout.narrow
        if (info.screenWidth > 0 && info.screenHeight > 0) this._screenHeight = info.screenHeight / info.screenWidth * 240
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
    openPosition() { router.push({ uri: '/pages/position' }) },
    openTracks() { router.push({ uri: '/pages/tracks' }) },
    back() { router.back() },
    async toggleRecording() {
      try { await this._session.toggleRecording() }
      catch (error) { this.recordInfo = error.message }
    }
  }
}
