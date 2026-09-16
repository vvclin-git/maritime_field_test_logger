import { withMutationLock } from './storage'

export type EnvironmentRecord = {
  id: string
  voyageId: string
  version: number
  observedAt: string
  createdAt: string
  weather: string
  windDirection: string
  windSpeedKt: number | null
  waveHeightM: number | null
  visibilityKm: number | null
  seaState: string
  note: string
  forecast?: {
    source: 'Windy Testing'
    fetchedAt: string
    forecastAt: string
    lat: number
    lon: number
    windSpeedMs?: number
    windDirectionDeg?: number
    waveHeightM?: number
    wavePeriodS?: number
    waveDirectionDeg?: number
  }
}

type WindySettings = { key: string; lat: number; lon: number }
let sessionKey = ''
const SETTINGS_KEY = 'sea-trial-windy-settings'

function loadSettings(): WindySettings | null {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') } catch { return null }
}

function saveSettings(settings: WindySettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  sessionKey = settings.key
}

const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('sea-trial-environments', 1)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('environments')) request.result.createObjectStore('environments', { keyPath: 'id' })
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

async function records(): Promise<EnvironmentRecord[]> {
  const db = await dbPromise
  return new Promise<EnvironmentRecord[]>((resolve, reject) => {
    const request = db.transaction('environments').objectStore('environments').getAll()
    request.onsuccess = () => resolve(request.result as EnvironmentRecord[])
    request.onerror = () => reject(request.error)
  })
}

async function save(record: EnvironmentRecord, notify = true): Promise<void> {
  const db = await dbPromise
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('environments', 'readwrite')
    transaction.objectStore('environments').put(record)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('環境資料寫入中止'))
  })
  if (notify) localStorage.setItem('lastSaved', new Date().toISOString())
}

export async function getEnvironments(voyageId: string) {
  return (await records()).filter(record => record.voyageId === voyageId).sort((a, b) => a.version - b.version)
}

export async function currentEnvironment(voyageId: string) {
  return (await getEnvironments(voyageId)).at(-1) || null
}

export async function importEnvironments(items: EnvironmentRecord[]) {
  for (const item of items) await save(item, false)
}

export async function replaceEnvironments(items: EnvironmentRecord[]) {
  const db = await dbPromise
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('environments', 'readwrite')
    const store = transaction.objectStore('environments')
    store.clear()
    items.forEach(item => store.put(item))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('環境資料匯入中止'))
  })
  localStorage.setItem('lastSaved', new Date().toISOString())
}

export async function clearEnvironmentRecords() {
  const db = await dbPromise
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('environments', 'readwrite')
    transaction.objectStore('environments').clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error || new Error('環境資料清除中止'))
  })
}

const esc = (s = '') => s.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]!))

function nearest(data: any) {
  const timestamps = data.ts as number[]
  let index = 0
  let best = Infinity
  timestamps.forEach((timestamp, candidate) => {
    const distance = Math.abs(timestamp - Date.now())
    if (distance < best) { best = distance; index = candidate }
  })
  return { i: index, at: new Date(timestamps[index]).toISOString() }
}

function direction(u: number, v: number) { return (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 }
function windLabel(deg: number) {
  const names = ['北風', '東北風', '東風', '東南風', '南風', '西南風', '西風', '西北風']
  return `${Math.round(deg).toString().padStart(3, '0')}°（${names[Math.round(deg / 45) % 8]}）`
}

async function windy(model: 'gfs' | 'gfsWave', lat: number, lon: number) {
  if (!sessionKey) throw Error('請先輸入 Windy Testing key')
  const parameters = model === 'gfs' ? ['wind'] : ['waves']
  const response = await fetch('https://api.windy.com/api/point-forecast/v2', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lat, lon, model, parameters, levels: ['surface'], key: sessionKey }),
  })
  if (!response.ok) throw Error(`Windy 查詢失敗（HTTP ${response.status}）`)
  return response.json()
}

export async function fetchCurrentWindy(voyageId: string) {
  const settings = loadSettings()
  if (!settings?.key || !Number.isFinite(settings.lat) || !Number.isFinite(settings.lon)) throw Error('請先到「環境」保存 Windy key 與經緯度')
  sessionKey = settings.key
  const last = await currentEnvironment(voyageId)
  const [windData, waveData] = await Promise.all([windy('gfs', settings.lat, settings.lon), windy('gfsWave', settings.lat, settings.lon)])
  const windPoint = nearest(windData)
  const wavePoint = nearest(waveData)
  const u = windData['wind_u-surface']?.[windPoint.i]
  const v = windData['wind_v-surface']?.[windPoint.i]
  const speed = u != null && v != null ? Math.hypot(u, v) : undefined
  const degrees = u != null && v != null ? direction(u, v) : undefined
  const record: EnvironmentRecord = {
    id: crypto.randomUUID(), voyageId, version: (last?.version || 0) + 1,
    observedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    weather: last?.weather || '其他', windDirection: degrees != null ? windLabel(degrees) : (last?.windDirection || ''),
    windSpeedKt: speed != null ? +(speed * 1.943844).toFixed(1) : (last?.windSpeedKt ?? null),
    waveHeightM: waveData['waves_height-surface']?.[wavePoint.i] ?? last?.waveHeightM ?? null,
    visibilityKm: last?.visibilityKm ?? null, seaState: last?.seaState || '', note: last?.note || '',
    forecast: {
      source: 'Windy Testing', fetchedAt: new Date().toISOString(), forecastAt: windPoint.at,
      lat: settings.lat, lon: settings.lon, windSpeedMs: speed, windDirectionDeg: degrees,
      waveHeightM: waveData['waves_height-surface']?.[wavePoint.i], wavePeriodS: waveData['waves_period-surface']?.[wavePoint.i],
      waveDirectionDeg: waveData['waves_direction-surface']?.[wavePoint.i],
    },
  }
  await withMutationLock('environment', async () => {
    record.version = ((await currentEnvironment(voyageId))?.version || 0) + 1
    await save(record)
  })
  return record
}

export async function openEnvironment(voyageId: string, onSaved: (record: EnvironmentRecord) => void) {
  const list = await getEnvironments(voyageId)
  const last = list.at(-1)
  const settings = loadSettings()
  document.body.insertAdjacentHTML('beforeend', `<div class="modal"><form class="modal-card environment-form" id="environment-form"><button type="button" class="btn modal-close" data-env-close>關閉</button><div class="eyebrow">ENVIRONMENT · VERSION ${(list.at(-1)?.version || 0) + 1}</div><h2>更新現場環境</h2><p class="sub">儲存後建立新版本；既有 Run 保留原版本。</p><div class="setup-grid"><div class="field"><label>觀測時間</label><input name="observedAt" type="datetime-local" required value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}"></div><div class="field"><label>天氣</label><select name="weather" required>${['晴', '多雲', '陰', '小雨', '雨', '霧', '其他'].map(x => `<option ${last?.weather === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div><div class="field"><label>風向</label><input name="windDirection" placeholder="例如：東北風／045°（選填）" value="${esc(last?.windDirection || '')}"></div><div class="field"><label>風速（kt）</label><input name="windSpeedKt" type="number" min="0" step="any" value="${last?.windSpeedKt ?? ''}"></div><div class="field"><label>浪高（m）</label><input name="waveHeightM" type="number" min="0" step="any" value="${last?.waveHeightM ?? ''}"></div><div class="field"><label>能見度（km）</label><input name="visibilityKm" type="number" min="0" step="any" value="${last?.visibilityKm ?? ''}"></div><div class="field"><label>海況</label><input name="seaState" placeholder="例如：長浪、短浪、艉流明顯" value="${esc(last?.seaState || '')}"></div><div class="field"><label>備註</label><input name="note" value="${esc(last?.note || '')}"></div></div><details><summary>Windy 預報（選用）</summary><p class="notice">Testing 資料會隨機擾動，僅供測試參考。Key 與座標會保存在這台裝置，不會包含在 JSON／CSV 備份。</p><div class="setup-grid"><div class="field wide"><label>Windy Testing key</label><input id="windy-key" type="password" autocomplete="off"></div><div class="field"><label>緯度</label><input id="windy-lat" type="number" min="-90" max="90" step="any"></div><div class="field"><label>經度</label><input id="windy-lon" type="number" min="-180" max="180" step="any"></div></div><button type="button" class="btn" data-windy>查詢 GFS／GFS Wave</button><div id="windy-result" class="forecast-box">尚未查詢</div></details><div class="actionbar"><button class="btn primary" type="submit">儲存為新環境版本</button></div></form></div>`)
  const modal = document.querySelector('.modal') as HTMLElement
  const form = document.querySelector('#environment-form') as HTMLFormElement
  const result = document.querySelector('#windy-result') as HTMLElement
  let forecast: EnvironmentRecord['forecast'] = last?.forecast
  if (settings) {
    ;(document.querySelector('#windy-key') as HTMLInputElement).value = settings.key
    ;(document.querySelector('#windy-lat') as HTMLInputElement).value = String(settings.lat)
    ;(document.querySelector('#windy-lon') as HTMLInputElement).value = String(settings.lon)
    sessionKey = settings.key
  }
  ;(document.querySelector('[data-env-close]') as HTMLButtonElement).onclick = () => modal.remove()
  ;(document.querySelector('[data-windy]') as HTMLButtonElement).onclick = async () => {
    try {
      sessionKey = (document.querySelector('#windy-key') as HTMLInputElement).value
      const lat = (document.querySelector('#windy-lat') as HTMLInputElement).valueAsNumber
      const lon = (document.querySelector('#windy-lon') as HTMLInputElement).valueAsNumber
      if (!sessionKey || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) throw Error('請輸入有效 key 與經緯度')
      saveSettings({ key: sessionKey, lat, lon })
      result.textContent = '查詢中…'
      const [windData, waveData] = await Promise.all([windy('gfs', lat, lon), windy('gfsWave', lat, lon)])
      const windPoint = nearest(windData)
      const wavePoint = nearest(waveData)
      const u = windData['wind_u-surface']?.[windPoint.i]
      const v = windData['wind_v-surface']?.[windPoint.i]
      forecast = {
        source: 'Windy Testing', fetchedAt: new Date().toISOString(), forecastAt: windPoint.at, lat, lon,
        windSpeedMs: u != null && v != null ? Math.hypot(u, v) : undefined,
        windDirectionDeg: u != null && v != null ? direction(u, v) : undefined,
        waveHeightM: waveData['waves_height-surface']?.[wavePoint.i], wavePeriodS: waveData['waves_period-surface']?.[wavePoint.i],
        waveDirectionDeg: waveData['waves_direction-surface']?.[wavePoint.i],
      }
      const windDirectionInput = form.elements.namedItem('windDirection') as HTMLInputElement
      const windSpeedInput = form.elements.namedItem('windSpeedKt') as HTMLInputElement
      if (forecast.windDirectionDeg != null) windDirectionInput.value = windLabel(forecast.windDirectionDeg)
      if (forecast.windSpeedMs != null) windSpeedInput.value = (forecast.windSpeedMs * 1.943844).toFixed(1)
      if (forecast.waveHeightM != null) (form.elements.namedItem('waveHeightM') as HTMLInputElement).value = String(forecast.waveHeightM)
      result.innerHTML = `<b>已填入上方欄位，可修改後儲存。測試參考</b> · 預報 ${new Date(forecast.forecastAt).toLocaleString('zh-TW')}<br>風 ${forecast.windSpeedMs?.toFixed(1) ?? '—'} m/s（${forecast.windSpeedMs != null ? (forecast.windSpeedMs * 1.943844).toFixed(1) : '—'} kt）· ${forecast.windDirectionDeg?.toFixed(0) ?? '—'}°｜浪 ${forecast.waveHeightM?.toFixed(1) ?? '—'} m · ${forecast.wavePeriodS?.toFixed(1) ?? '—'} s`
    } catch (error) { result.textContent = error instanceof Error ? error.message : '查詢失敗' }
  }
  form.onsubmit = async event => {
    event.preventDefault()
    const formData = new FormData(form)
    const numberOrNull = (name: string) => formData.get(name) === '' ? null : Number(formData.get(name))
    const record: EnvironmentRecord = {
      id: crypto.randomUUID(), voyageId, version: (list.at(-1)?.version || 0) + 1,
      observedAt: new Date(String(formData.get('observedAt'))).toISOString(), createdAt: new Date().toISOString(),
      weather: String(formData.get('weather')), windDirection: String(formData.get('windDirection')),
      windSpeedKt: numberOrNull('windSpeedKt'), waveHeightM: numberOrNull('waveHeightM'), visibilityKm: numberOrNull('visibilityKm'),
      seaState: String(formData.get('seaState')), note: String(formData.get('note')), forecast,
    }
    try {
      await withMutationLock('environment', async () => {
        record.version = ((await currentEnvironment(voyageId))?.version || 0) + 1
        await save(record)
      })
      modal.remove()
      onSaved(record)
    } catch (error) { result.textContent = error instanceof Error ? error.message : '無法儲存環境資料' }
  }
}
