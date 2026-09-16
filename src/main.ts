import { offlineStatusHTML, refreshConnection, startOffline } from './offline'
import './style.css'
import {
  clearEnvironmentRecords, currentEnvironment, fetchCurrentWindy, getEnvironments, openEnvironment,
  replaceEnvironments, type EnvironmentRecord,
} from './environment'
import {
  clearResetOperation, clearVoyageStores, getResetOperation, readAll, replaceVoyageAndRuns,
  setResetOperation, withMutationLock, writeStore, type ResetOperation,
} from './storage'

type Angle = 'A' | 'B'
const PHASES = ['P1', 'P2', 'P3', 'P4'] as const
type Phase = typeof PHASES[number]
type SpeedPair = [number, number]
type Speeds = Record<Phase, SpeedPair | null>
type Light = '順光' | '側光' | '逆光' | '混合'
type View = 'progress' | 'prepare' | 'running' | 'result' | 'summary' | 'history'
type Scenario = { scenario_id: number; angle: Angle; title_zh: string; start_distance_m: number; filename: string }
type Run = {
  id: string; voyageId: string; scenarioId: number; angle: Angle; phase: Phase; startedAt: string; endedAt?: string
  confirmedAt: string; light: Light; completed?: boolean; tags: string[]; note: string; videoFile: string
  ecuFile: string; updatedAt: string
  snapshot: { own: number; target: number; distance: number; environmentVersion: number; environment?: EnvironmentRecord }
}
type Voyage = {
  id: string; date: string; location: string; model: string; fps: string; recorder: string; reviewer: string
  timezone: string; vessel: string; device: string; speeds: Speeds; plans: Record<string, number>; createdAt: string
}

const scenarios: Scenario[] = [
  [1, 'A', '向浮標靠近', 250, 'S01_A_buoy_approach.png'], [1, 'B', '向浮標靠近', 250, 'S01_B_buoy_approach.png'],
  [2, 'A', '他船直線移動（兩船同向）', 500, 'S02_A_same_direction.png'], [2, 'B', '他船直線移動（兩船同向）', 500, 'S02_B_same_direction.png'],
  [3, 'A', '他船直線移動（兩船對向）', 500, 'S03_A_opposite_direction.png'], [3, 'B', '他船直線移動（兩船對向）', 500, 'S03_B_opposite_direction.png'],
  [4, 'A', '他船橫線移動（遠離自船）', 500, 'S04_A_crossing_away.png'], [4, 'B', '他船橫線移動（遠離自船）', 500, 'S04_B_crossing_away.png'],
  [5, 'A', '他船橫線移動（靠近自船）', 500, 'S05_A_crossing_toward.png'], [5, 'B', '他船橫線移動（靠近自船）', 500, 'S05_B_crossing_toward.png'],
  [6, 'A', '他船斜切移動（遠離自船）', 500, 'S06_A_diagonal_away.png'], [6, 'B', '他船斜切移動（遠離自船）', 500, 'S06_B_diagonal_away.png'],
  [7, 'A', '他船斜切移動（靠近自船）', 500, 'S07_A_diagonal_toward.png'], [7, 'B', '他船斜切移動（靠近自船）', 500, 'S07_B_diagonal_toward.png'],
].map(x => ({ scenario_id: x[0], angle: x[1], title_zh: x[2], start_distance_m: x[3], filename: x[4] }) as Scenario)
const tags = ['眩光', '遮擋', '多目標', '強浪／艉流', '非預期船舶', '光照變化', '航線問題', '船速問題', '錄影問題', '其他']
const ANGLES: Angle[] = ['A', 'B']
const SCENARIO_IDS = [1, 2, 3, 4, 5, 6, 7]
const $ = (selector: string) => document.querySelector(selector) as HTMLElement | null
const esc = (value = '') => value.replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!))
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)

let voyage: Voyage | null = null
let runs: Run[] = []
let selected = { scenarioId: 1, angle: 'A' as Angle, phase: 'P1' as Phase }
let view: View = 'progress'
let active: Run | null = null
let environment: EnvironmentRecord | null = null
let busy = false
let resetPending = false
let wake: WakeLockSentinel | null = null
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('sea-trial-logger') : null

function uuid() { return crypto.randomUUID() }
function now() { return new Date().toISOString() }
function key(scenarioId: number, angle: Angle, phase: Phase) { return `${scenarioId}-${angle}-${phase}` }
function route(scenarioId = selected.scenarioId, angle = selected.angle) { return scenarios.find(item => item.scenario_id === scenarioId && item.angle === angle)! }
function cellRuns(scenarioId: number, angle: Angle, phase: Phase) { return runs.filter(run => run.scenarioId === scenarioId && run.angle === angle && run.phase === phase) }
function phaseHasRuns(phase: Phase) { return runs.some(run => run.phase === phase) }
function speedText(speed: SpeedPair | null | undefined) { return speed ? `${speed[0]} / ${speed[1]}` : '待設定' }
function speedReady(speed: SpeedPair | null | undefined): speed is SpeedPair { return !!speed && speed.length === 2 && speed.every(value => Number.isFinite(value) && value >= 0) }
function plansForNew() {
  return Object.fromEntries(SCENARIO_IDS.flatMap(scenarioId => PHASES.flatMap(phase => ANGLES.map(angle => [key(scenarioId, angle, phase), 2])))) as Record<string, number>
}
function plansForVoyage(raw: any) {
  const plans: Record<string, number> = {}
  SCENARIO_IDS.forEach(scenarioId => PHASES.forEach(phase => ANGLES.forEach(angle => {
    const value = raw?.[key(scenarioId, angle, phase)]
    plans[key(scenarioId, angle, phase)] = Number.isInteger(value) && value >= 0 && value <= 99 ? value : 0
  })))
  return plans
}

function normalizeVoyage(raw: any): Voyage {
  const speeds = {} as Speeds
  PHASES.forEach(phase => {
    const pair = raw?.speeds?.[phase]
    speeds[phase] = Array.isArray(pair) && pair.length === 2 && pair.every((value: any) => Number.isFinite(value) && value >= 0)
      ? [Number(pair[0]), Number(pair[1])] : null
  })
  const plans = plansForVoyage(raw?.plans)
  PHASES.filter(phase => phase === 'P3' || phase === 'P4').forEach(phase => {
    if (!raw?.speeds || !hasOwn(raw.speeds, phase)) SCENARIO_IDS.forEach(scenarioId => ANGLES.forEach(angle => { plans[key(scenarioId, angle, phase)] = 0 }))
  })
  return {
    id: String(raw?.id || ''), date: String(raw?.date || ''), location: String(raw?.location || ''), model: String(raw?.model || ''),
    fps: String(raw?.fps || ''), recorder: String(raw?.recorder || ''), reviewer: String(raw?.reviewer || ''),
    timezone: String(raw?.timezone || 'Asia/Taipei'), vessel: String(raw?.vessel || ''), device: String(raw?.device || ''),
    speeds, plans, createdAt: String(raw?.createdAt || now()),
  }
}

function progress(scenarioId: number, angle: Angle, phase: Phase) {
  const records = cellRuns(scenarioId, angle, phase)
  const plan = voyage?.plans[key(scenarioId, angle, phase)] ?? 0
  return { done: records.filter(run => run.completed === true).length, attempts: records.length, plan }
}
function fmt(timestamp: string) {
  return new Intl.DateTimeFormat('zh-TW', { timeZone: voyage?.timezone || 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(timestamp))
}
function toast(message: string) {
  $('.toast')?.remove()
  document.body.insertAdjacentHTML('beforeend', `<div class="toast">${esc(message)}</div>`)
  setTimeout(() => $('.toast')?.remove(), 2200)
}
function savedToast() { toast('已儲存至此裝置') }

function environmentPanel(record: EnvironmentRecord | null | undefined) {
  if (!record) return '<div class="notice">尚未設定現場環境與 Windy 預報。</div>'
  const forecast = record.forecast
  return `<div class="forecast-box"><b>環境 #${record.version}</b> · ${esc(record.weather)} · ${esc(record.windDirection)} · ${record.windSpeedKt ?? '—'} kt · 浪高 ${record.waveHeightM ?? '—'} m${forecast ? `<br><b>Windy Testing</b> · 預報 ${fmt(forecast.forecastAt)} · 風 ${forecast.windSpeedMs != null ? (forecast.windSpeedMs * 1.943844).toFixed(1) : '—'} kt／${forecast.windDirectionDeg?.toFixed(0) ?? '—'}° · 浪 ${forecast.waveHeightM?.toFixed(1) ?? '—'} m` : '<br><span class="sub">尚無 Windy 預報</span>'}</div>`
}
function header() {
  const complete = runs.filter(run => run.completed === true).length
  const planned = voyage ? Object.values(voyage.plans).reduce((sum, value) => sum + value, 0) : 0
  return `<header class="topbar"><div class="brand"><span>◈</span> SEA TRIAL LOGGER</div><div class="top-stats"><div id="connection-status" class="status-pill ${navigator.onLine ? 'good' : ''}">${navigator.onLine ? '線上' : '離線'}</div>${offlineStatusHTML()}<div class="status-pill">${complete}/${planned} 完成</div></div></header>`
}
function pageTitle(title: string, subtitle: string, actions = '') {
  return `<div class="title-row"><div><div class="eyebrow">${voyage ? esc(`${voyage.date} · ${voyage.location}`) : 'DEVICE-LOCAL RECORD'}</div><h1>${title}</h1><div class="sub">${subtitle}</div></div><div class="title-actions">${actions}</div></div>`
}
function render() {
  const app = $('#app')
  if (!app) return
  const body = resetPending ? resetRecoveryView() : !voyage ? empty() : view === 'progress' ? progressView() : view === 'prepare' ? prepareView() : view === 'running' ? runningView() : view === 'result' ? resultView() : view === 'summary' ? summaryView() : historyView()
  app.innerHTML = `<div class="app">${header()}<main class="shell">${body}${voyage && !resetPending ? `<div class="footerline"><span>裝置獨立保存 · 時區 ${esc(voyage.timezone)}</span><span>最近備份：${localStorage.getItem('lastBackup') ? fmt(localStorage.getItem('lastBackup')!) : '尚未備份'}</span></div>` : ''}</main></div>`
  bind()
  refreshConnection()
}
function resetRecoveryView() {
  return `${pageTitle('正在恢復重置','偵測到尚未完成的重置，舊航次暫時不可操作。')}${`<section class="panel empty"><h2>重置尚未完成</h2><p>完成前不會建立新航次，也不會刪除 Windy API Key、緯度與經度。</p><button class="btn primary" data-action="reset-retry" ${busy ? 'disabled' : ''}>${busy ? '處理中…' : '重試重置'}</button></section>`}`
}
function empty() {
  return `${pageTitle('航次紀錄', '先建立或還原一個航次，即可開始離線紀錄。')}<section class="panel empty"><h2>尚未開啟航次</h2><p>資料只保存在這台裝置；跨裝置請使用 JSON 備份。</p><button class="btn primary" data-action="setup">建立新航次</button> <button class="btn" data-action="import">還原 JSON</button><input id="import-file" type="file" accept="application/json" hidden></section>`
}
function progressView() {
  const planned = Object.values(voyage!.plans).reduce((sum, value) => sum + value, 0)
  const done = runs.filter(run => run.completed === true).length
  return `${pageTitle('航次進度', '選擇一個條件，先核對航跡再開始。', `<button class="btn" data-action="environment">環境 ${environment ? `#${environment.version}` : '未設定'}</button><button class="btn" data-action="history">紀錄</button><button class="btn" data-action="backup">備份</button><button class="btn primary" data-action="setup">航次設定</button>`)}<section class="panel"><div class="summary"><div class="metric"><b>${done}/${planned}</b><span>完成／計畫</span></div><div class="metric"><b>${runs.length}</b><span>嘗試次數</span></div>${PHASES.map(phase => `<div class="metric"><b>${speedText(voyage!.speeds[phase])}</b><span>${phase} 本船／他船 kt</span></div>`).join('')}</div>${matrix()}${cards()}</section>`
}
function cell(scenarioId: number, angle: Angle, phase: Phase) {
  const value = progress(scenarioId, angle, phase)
  return `<button class="run-cell ${value.done >= value.plan && value.plan > 0 ? 'done' : ''}" data-pick="${scenarioId}|${angle}|${phase}" ${value.plan === 0 ? 'disabled' : ''}><strong>${value.plan === 0 ? '停用' : `${value.done}/${value.plan}`}</strong><div class="scenario-meta">${value.attempts} 次嘗試</div></button>`
}
function conditionButtons(scenarioId: number) {
  return PHASES.flatMap(phase => ANGLES.map(angle => {
    const value = progress(scenarioId, angle, phase)
    return `<button data-pick="${scenarioId}|${angle}|${phase}" ${value.plan === 0 ? 'disabled' : ''}><b>${phase}-${angle}</b><small>${value.plan === 0 ? '停用' : `${value.done}/${value.plan} 完成`} · ${value.attempts} 嘗試</small></button>`
  })).join('')
}
function matrix() {
  return `<div class="matrix-scroll"><table class="matrix"><thead><tr><th>情境</th>${PHASES.flatMap(phase => ANGLES.map(angle => `<th>${phase}-${angle}</th>`)).join('')}</tr></thead><tbody>${SCENARIO_IDS.map(scenarioId => { const scenario = route(scenarioId, 'A'); return `<tr><td><div class="scenario-title">S${String(scenarioId).padStart(2, '0')} · ${scenario.title_zh}</div><div class="scenario-meta">起始 ${scenario.start_distance_m} m${scenarioId === 1 ? ' · 靜止浮標' : ''}</div></td>${PHASES.flatMap(phase => ANGLES.map(angle => `<td>${cell(scenarioId, angle, phase)}</td>`)).join('')}</tr>` }).join('')}</tbody></table></div>`
}
function cards() {
  return `<div class="cards">${SCENARIO_IDS.map(scenarioId => { const scenario = route(scenarioId, 'A'); return `<article class="scenario-card"><div class="scenario-head"><b>S${String(scenarioId).padStart(2, '0')} · ${scenario.title_zh}</b><span>${scenario.start_distance_m} m</span></div><div class="cell-grid">${conditionButtons(scenarioId)}</div></article>` }).join('')}</div>`
}
function imagePanel(scenario: Scenario) {
  return `<section class="panel image-panel"><div class="image-wrap" id="image-wrap"><span class="image-badge">航跡示意圖 · 非即時定位</span><img id="route-img" src="${import.meta.env.BASE_URL}routes/${scenario.filename}" alt="S${String(scenario.scenario_id).padStart(2, '0')} ${scenario.angle} ${esc(scenario.title_zh)}航跡示意圖"></div><div class="image-tools"><button class="btn" data-action="zoom-out" aria-label="縮小">−</button><button class="btn" data-action="reset-zoom">重設</button><button class="btn" data-action="zoom-in" aria-label="放大">＋</button><button class="btn" data-action="fullscreen">滿版</button></div></section>`
}
function prepareView() {
  const scenario = route()
  const speed = voyage!.speeds[selected.phase]
  const previous = [...runs].reverse().find(run => run.light)?.light || ''
  const plan = voyage!.plans[key(selected.scenarioId, selected.angle, selected.phase)] ?? 0
  const speedMessage = speedReady(speed) ? '' : '<div class="notice danger">本速度組尚未設定，請先到航次設定填寫兩個速度。</div>'
  const planMessage = plan === 0 ? '<div class="notice danger">此條件計畫次數為 0，已停用，不能開始測試。</div>' : ''
  return `${pageTitle(`S${String(scenario.scenario_id).padStart(2, '0')} · ${scenario.title_zh}`, `${selected.phase}-${selected.angle}｜開始前與船長共同核對`, '<button class="btn" data-action="progress">回進度</button>')}<div class="prep">${imagePanel(scenario)}<section class="panel details"><div class="eyebrow">RUN PREPARATION</div><h2>${selected.phase}-${selected.angle}</h2><div class="condition-grid"><div class="condition"><span>本船計畫速度</span><b>${speed?.[0] ?? '待設定'} kt</b></div><div class="condition"><span>${scenario.scenario_id === 1 ? '目標' : '他船計畫速度'}</span><b>${scenario.scenario_id === 1 ? '靜止浮標' : speed?.[1] != null ? `${speed[1]} kt` : '待設定'}</b></div><div class="condition"><span>起始距離</span><b>${scenario.start_distance_m} m</b></div><div class="condition"><span>計畫次數</span><b>${plan}</b></div><div class="condition"><span>環境版本</span><b>${environment ? `#${environment.version} · ${esc(environment.weather)}` : '尚未設定'}</b></div></div>${speedMessage}${planMessage}${environmentPanel(environment)}<button class="btn" data-action="fetch-weather">取得當下 Windy</button> <button class="btn" data-action="environment">編輯環境</button><div class="field"><label for="light">光照</label><select id="light"><option value="">請選擇</option>${(['順光', '側光', '逆光', '混合'] as Light[]).map(value => `<option ${value === previous ? 'selected' : ''}>${value}</option>`).join('')}</select></div><label class="check"><input id="confirmed" type="checkbox"><span><b>已與船長確認</b><br><span class="sub">本船、目標位置及行進方向皆已確認。</span></span></label><div class="actionbar"><button class="btn start" data-action="start" disabled>START</button></div></section></div><div class="mobile-action"><button class="btn start" data-action="start" disabled>START</button></div>`
}
function runningView() {
  const scenario = route(active!.scenarioId, active!.angle)
  return `${pageTitle('Run 進行中', `S${String(scenario.scenario_id).padStart(2, '0')} · ${scenario.title_zh} · ${active!.phase}-${active!.angle}`)}<div class="prep">${imagePanel(scenario)}<section class="panel details"><div class="eyebrow">RECORDING</div><h2>已開始</h2><div class="timer" id="timer">00:00:00</div><div class="condition-grid"><div class="condition"><span>開始時間</span><b>${fmt(active!.startedAt)}</b></div><div class="condition"><span>光照</span><b>${active!.light}</b></div><div class="condition"><span>本船／目標快照</span><b>${active!.snapshot.own} / ${active!.snapshot.target} kt</b></div></div>${environmentPanel(active!.snapshot.environment || environment)}<p class="sub">切換 App 或鎖屏不影響計時；結束時間只會在按下 END 時記錄。</p><div class="actionbar"><button class="btn end" data-action="end">END</button></div></section></div><div class="mobile-action"><button class="btn end" data-action="end">END</button></div>`
}
function resultView() {
  const run = active!
  return `${pageTitle('填寫結果', `Run ${fmt(run.startedAt)} 已結束；完成填寫後才計入進度。`)}<section class="panel details">${environmentPanel(run.snapshot.environment || environment)}<div class="field"><label>Completed</label><div class="result-choice"><button class="yes ${run.completed === true ? 'selected' : ''}" data-completed="yes">Yes</button><button class="no ${run.completed === false ? 'selected' : ''}" data-completed="no">No</button></div></div><div class="field"><label>Event Tags</label><div class="tags">${tags.map(tag => `<button class="tag ${run.tags.includes(tag) ? 'selected' : ''}" data-tag="${esc(tag)}">${esc(tag)}</button>`).join('')}</div></div><div class="field"><label for="note">備註</label><textarea id="note" placeholder="現場觀察、異常或補充說明">${esc(run.note)}</textarea></div><div class="setup-grid"><div class="field"><label for="video">影片檔名（選填）</label><input id="video" value="${esc(run.videoFile)}"></div><div class="field"><label for="ecu">ECU 檔名（選填）</label><input id="ecu" value="${esc(run.ecuFile)}"></div></div><div class="actionbar"><button class="btn dark" data-action="save-result" ${run.completed === undefined ? 'disabled' : ''}>SAVE</button></div></section><div class="mobile-action"><button class="btn dark" data-action="save-result" ${run.completed === undefined ? 'disabled' : ''}>SAVE</button></div>`
}
function summaryView() {
  const run = active!
  const scenario = route(run.scenarioId, run.angle)
  return `${pageTitle('結果已儲存', `S${String(scenario.scenario_id).padStart(2, '0')} · ${run.phase}-${run.angle}`)}<section class="panel details"><div class="summary"><div class="metric"><b>${run.completed ? 'YES' : 'NO'}</b><span>Completed</span></div><div class="metric"><b>${duration(run)}</b><span>經過時間</span></div><div class="metric"><b>${run.tags.length}</b><span>Event Tags</span></div><div class="metric"><b>${run.light}</b><span>光照</span></div></div>${environmentPanel(run.snapshot.environment || environment)}<div class="field"><label>摘要</label><p>${run.tags.length ? esc(run.tags.join('、')) : '無標籤'}${run.note ? ` · ${esc(run.note)}` : ''}</p></div><div class="actionbar"><button class="btn" data-action="repeat">再跑同條件</button><button class="btn" data-action="toggle-angle">切換 A/B</button><button class="btn primary" data-action="progress">回進度表</button></div></section><div class="mobile-action"><button class="btn" data-action="repeat">再跑同條件</button><button class="btn" data-action="toggle-angle">切換 A/B</button><button class="btn primary" data-action="progress">回進度表</button></div>`
}
function historyEnvironment(run: Run) {
  const record = run.snapshot.environment
  return record ? `#${record.version} · ${esc(record.weather)} · ${esc(record.windDirection) || '風向未填'} · ${record.windSpeedKt ?? '—'} kt · 浪 ${record.waveHeightM ?? '—'} m` : `#${run.snapshot.environmentVersion ?? '—'}`
}
function historyDetails(run: Run) {
  return `<div class="history-detail"><p>開始：${fmt(run.startedAt)}<br>結束：${run.endedAt ? fmt(run.endedAt) : '進行中'} · ${duration(run)}</p><p>光照：${esc(run.light)}<br>事件：${esc(run.tags.join('、')) || '—'}<br>備註：${esc(run.note) || '—'}</p><p>影片：${esc(run.videoFile) || '—'}<br>ECU：${esc(run.ecuFile) || '—'}</p><p>環境：${historyEnvironment(run)}</p><button class="btn" data-edit="${run.id}">編輯</button></div>`
}
function historyView() {
  return `${pageTitle('歷史紀錄', '可修改結果欄位；進度會依最新內容重算。', '<button class="btn primary" data-action="progress">回進度</button>')}<section class="panel">${runs.length ? `<div class="history-scroll"><table class="matrix history-table"><thead><tr><th>條件</th><th>開始／結束</th><th>時間</th><th>Completed</th><th>光照</th><th>事件標籤</th><th>備註</th><th>影片／ECU</th><th>環境</th><th></th></tr></thead><tbody>${[...runs].reverse().map(run => `<tr><td>S${String(run.scenarioId).padStart(2, '0')} ${run.phase}-${run.angle}</td><td>${fmt(run.startedAt)}<br>${run.endedAt ? fmt(run.endedAt) : '進行中'}</td><td>${duration(run)}</td><td>${run.completed === true ? 'Yes' : run.completed === false ? 'No' : '未填'}</td><td>${esc(run.light)}</td><td>${esc(run.tags.join('、')) || '—'}</td><td>${esc(run.note) || '—'}</td><td>${esc(run.videoFile) || '—'}<br>${esc(run.ecuFile) || '—'}</td><td>${historyEnvironment(run)}</td><td><button class="btn" data-edit="${run.id}">編輯</button></td></tr>`).join('')}</tbody></table></div><div class="cards">${[...runs].reverse().map(run => `<article class="scenario-card"><div class="scenario-head"><b>S${String(run.scenarioId).padStart(2, '0')} · ${run.phase}-${run.angle}</b><span>${run.completed === true ? 'Yes' : run.completed === false ? 'No' : '未填'}</span></div>${historyDetails(run)}</article>`).join('')}</div>` : '<div class="empty">尚無紀錄</div>'}</section>`
}
function duration(run: Run) {
  if (!run.endedAt) return '進行中'
  const seconds = Math.max(0, Math.floor((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000))
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function syncResultDraft() {
  if (!active || view !== 'result') return
  active.note = ($('#note') as HTMLTextAreaElement | null)?.value ?? active.note
  active.videoFile = ($('#video') as HTMLInputElement | null)?.value ?? active.videoFile
  active.ecuFile = ($('#ecu') as HTMLInputElement | null)?.value ?? active.ecuFile
  active.updatedAt = now()
}
async function persistRun(run: Run) {
  await withMutationLock('run', async () => {
    if (await getResetOperation()) throw Error('重置正在進行，無法寫入舊航次')
    await writeStore('runs', run)
  })
  savedToast()
}
async function persistVoyage(nextVoyage: Voyage) {
  const savedVoyage = await withMutationLock('voyage', async () => {
    if (await getResetOperation()) throw Error('重置正在進行，無法寫入舊航次')
    const storedRuns = await readAll<Run>('runs')
    const storedVoyage = (await readAll<any>('voyages')).find(item => item.id === nextVoyage.id)
    const lockedPhases = new Set(storedRuns.filter(run => run.voyageId === nextVoyage.id).map(run => run.phase))
    const savedSpeeds = { ...nextVoyage.speeds } as Speeds
    if (storedVoyage) {
      const currentSpeeds = normalizeVoyage(storedVoyage).speeds
      PHASES.forEach(phase => { if (lockedPhases.has(phase)) savedSpeeds[phase] = currentSpeeds[phase] })
    }
    const savedVoyage = { ...nextVoyage, speeds: savedSpeeds }
    await writeStore('voyages', savedVoyage)
    return savedVoyage
  })
  savedToast()
  return savedVoyage
}
function bind() {
  document.querySelectorAll<HTMLElement>('[data-action]').forEach(button => { button.onclick = () => void action(button.dataset.action!) })
  document.querySelectorAll<HTMLElement>('[data-pick]').forEach(button => {
    button.onclick = () => {
      if (resetPending) return
      const [scenarioId, angle, phase] = button.dataset.pick!.split('|')
      selected = { scenarioId: +scenarioId, angle: angle as Angle, phase: phase as Phase }
      view = 'prepare'; render()
    }
  })
  document.querySelectorAll<HTMLElement>('[data-completed]').forEach(button => {
    button.onclick = async () => {
      if (!active || resetPending) return
      syncResultDraft(); active.completed = button.dataset.completed === 'yes'
      try { await persistRun(active); render() } catch (error) { toast(error instanceof Error ? error.message : '無法儲存結果') }
    }
  })
  document.querySelectorAll<HTMLElement>('[data-tag]').forEach(button => {
    button.onclick = async () => {
      if (!active || resetPending) return
      syncResultDraft(); const tag = button.dataset.tag!
      active.tags = active.tags.includes(tag) ? active.tags.filter(item => item !== tag) : [...active.tags, tag]
      try { await persistRun(active); render() } catch (error) { toast(error instanceof Error ? error.message : '無法儲存標籤') }
    }
  })
  document.querySelectorAll<HTMLElement>('[data-edit]').forEach(button => {
    button.onclick = () => { active = runs.find(run => run.id === button.dataset.edit) || null; if (active) { selected = { scenarioId: active.scenarioId, angle: active.angle, phase: active.phase }; view = 'result'; render() } }
  })
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('#note,#video,#ecu').forEach(input => {
    input.onchange = () => { syncResultDraft(); if (active) void persistRun(active).catch(error => toast(error instanceof Error ? error.message : '無法儲存結果')) }
  })
  const confirmed = $('#confirmed') as HTMLInputElement | null
  const light = $('#light') as HTMLSelectElement | null
  if (confirmed && light) {
    const validate = () => {
      const speed = voyage?.speeds[selected.phase]
      const plan = voyage?.plans[key(selected.scenarioId, selected.angle, selected.phase)] ?? 0
      const imageReady = ($('#route-img') as HTMLImageElement | null)?.complete === true
      document.querySelectorAll<HTMLButtonElement>('[data-action="start"]').forEach(button => { button.disabled = !(confirmed.checked && !!light.value && imageReady && speedReady(speed) && plan > 0 && !!environment) })
    }
    confirmed.onchange = validate; light.onchange = validate; ($('#route-img') as HTMLImageElement | null)?.addEventListener('load', validate); validate()
  }
  if (view === 'running') tick()
  if (view === 'prepare' || view === 'running') enableZoom()
}

async function action(actionName: string) {
  if (actionName === 'reset-retry') return void attemptReset(true)
  if (busy) return
  if (resetPending) { toast('重置正在進行，請稍候') ; return }
  if (actionName === 'setup') return setupModal()
  if (actionName === 'import') return ($('#import-file') as HTMLInputElement | null)?.click()
  if (actionName === 'progress') { view = 'progress'; active = null; render(); return }
  if (actionName === 'history') { view = 'history'; render(); return }
  if (actionName === 'environment' && voyage) return openEnvironment(voyage.id, record => { environment = record; toast(`環境版本 #${record.version} 已儲存`); render() })
  if (actionName === 'fetch-weather' && voyage) {
    busy = true
    try { environment = await fetchCurrentWindy(voyage.id); render(); toast(`已取得 Windy，環境版本 #${environment.version} 已儲存`) }
    catch (error) { toast(error instanceof Error ? error.message : 'Windy 查詢失敗') }
    finally { busy = false }
    return
  }
  if (actionName === 'start') return void startRun()
  if (actionName === 'end') return void endRun()
  if (actionName === 'save-result') return void saveResult()
  if (actionName === 'repeat') { view = 'prepare'; active = null; render(); return }
  if (actionName === 'toggle-angle') { selected.angle = selected.angle === 'A' ? 'B' : 'A'; view = 'prepare'; active = null; render(); return }
  if (actionName === 'backup') return void downloadBackup()
  if (actionName === 'reset-request') return void resetFirstModal()
  if (actionName === 'zoom-in') zoomBy(.2)
  if (actionName === 'zoom-out') zoomBy(-.2)
  if (actionName === 'reset-zoom') resetZoom()
  if (actionName === 'fullscreen') fullscreen()
}

async function startRun() {
  if (!voyage || !environment || resetPending) return
  const speed = voyage.speeds[selected.phase]
  const plan = voyage.plans[key(selected.scenarioId, selected.angle, selected.phase)] ?? 0
  const light = ($('#light') as HTMLSelectElement).value as Light
  const confirmed = ($('#confirmed') as HTMLInputElement).checked
  if (!speedReady(speed)) { toast('請先設定此速度組的本船與他船速度'); return }
  if (plan === 0) { toast('此條件計畫次數為 0，不能開始測試'); return }
  if (!light || !confirmed || !(($('#route-img') as HTMLImageElement)?.complete)) return
  busy = true
  try {
    const created = await withMutationLock('run', async () => {
      if (await getResetOperation()) throw Error('重置正在進行，無法開始舊航次')
      const storedRuns = await readAll<Run>('runs')
      if (storedRuns.some(run => !run.endedAt)) throw Error('另一分頁已有進行中的 Run，請先結束測試')
      const scenario = route()
      const timestamp = now()
      const run: Run = {
        id: uuid(), voyageId: voyage!.id, ...selected, startedAt: timestamp, confirmedAt: timestamp, light,
        tags: [], note: '', videoFile: '', ecuFile: '', updatedAt: timestamp,
        snapshot: { own: speed![0], target: scenario.scenario_id === 1 ? 0 : speed![1], distance: scenario.start_distance_m, environmentVersion: environment!.version, environment: structuredClone(environment!) },
      }
      await writeStore('runs', run)
      return run
    })
    active = created; runs = [...runs, created]; view = 'running'; channel?.postMessage({ type: 'run-started', id: created.id }); savedToast()
    try { wake = await navigator.wakeLock?.request('screen') } catch { /* optional */ }
    render()
  } catch (error) { toast(error instanceof Error ? error.message : '無法開始 Run') }
  finally { busy = false }
}
async function endRun() {
  if (!active || active.endedAt || resetPending) return
  busy = true
  try { active.endedAt = now(); active.updatedAt = now(); await persistRun(active); wake?.release(); wake = null; view = 'result'; render() }
  catch (error) { toast(error instanceof Error ? error.message : '無法結束 Run') }
  finally { busy = false }
}
async function saveResult() {
  if (!active || active.completed === undefined || resetPending) return
  busy = true; syncResultDraft()
  try { await persistRun(active); const index = runs.findIndex(run => run.id === active!.id); if (index >= 0) runs[index] = { ...active }; view = 'summary'; render() }
  catch (error) { toast(error instanceof Error ? error.message : '無法儲存結果') }
  finally { busy = false }
}
function tick() {
  const element = $('#timer')
  if (!element || !active) return
  element.textContent = duration({ ...active, endedAt: now() })
  setTimeout(tick, 500)
}

function speedInputValue(speed: SpeedPair | null, side: 0 | 1) { return speed ? String(speed[side]) : '' }
function uniformPlanValue(scenarioId: number, plans: Record<string, number>) {
  const values = PHASES.flatMap(phase => ANGLES.map(angle => plans[key(scenarioId, angle, phase)]))
  return new Set(values).size === 1 ? String(values[0]) : ''
}
function setupModal() {
  const editing = !!voyage
  const plans = voyage?.plans || plansForNew()
  const runLockNote = PHASES.some(phase => phaseHasRuns(phase)) ? '<span class="sub">（已有 Run 的組別速度已鎖定）</span>' : ''
  document.body.insertAdjacentHTML('beforeend', `<div class="modal"><form class="modal-card" id="setup-form"><button type="button" class="btn modal-close" data-close>關閉</button><div class="eyebrow">VOYAGE SETUP</div><h2>${editing ? '航次設定' : '建立新航次'}</h2><div class="setup-grid"><div class="field"><label>日期 *</label><input name="date" type="date" required value="${voyage?.date || new Date().toISOString().slice(0, 10)}"></div><div class="field"><label>地點 *</label><input name="location" required value="${esc(voyage?.location || '')}"></div><div class="field"><label>模型版本 *</label><input name="model" required value="${esc(voyage?.model || '')}"></div><div class="field"><label>ECU FPS *</label><input name="fps" required inputmode="numeric" value="${esc(voyage?.fps || '')}"></div><div class="field"><label>紀錄人員 *</label><input name="recorder" required value="${esc(voyage?.recorder || '')}"></div><div class="field"><label>審核人員 *</label><input name="reviewer" required value="${esc(voyage?.reviewer || '')}"></div><div class="field"><label>船舶資訊</label><input name="vessel" value="${esc(voyage?.vessel || '')}"></div><div class="field"><label>設備資訊</label><input name="device" value="${esc(voyage?.device || '')}"></div></div><h3>速度設定 ${runLockNote}</h3><p class="sub">速度單位 kt；可填 0 或一位小數。未設定的組別不能開始 Run。</p><div class="setup-grid speed-grid">${PHASES.map(phase => `<div class="field"><label>${phase} 本船 kt${phaseHasRuns(phase) ? '（已鎖定）' : ''}</label><input name="${phase}own" type="number" min="0" step="0.1" value="${speedInputValue(voyage?.speeds[phase] || null, 0)}" ${phaseHasRuns(phase) ? 'disabled' : ''}></div><div class="field"><label>${phase} 他船 kt${phaseHasRuns(phase) ? '（已鎖定）' : ''}</label><input name="${phase}target" type="number" min="0" step="0.1" value="${speedInputValue(voyage?.speeds[phase] || null, 1)}" ${phaseHasRuns(phase) ? 'disabled' : ''}></div>`).join('')}</div><h3>各情境計畫次數</h3><p class="sub">每情境統一次數套用至全部 8 個條件；可展開個別調整。次數 0 代表停用。</p><div class="setup-grid plan-settings">${SCENARIO_IDS.map(scenarioId => `<div class="field wide"><label for="uniform-${scenarioId}">S${String(scenarioId).padStart(2, '0')} · ${esc(route(scenarioId, 'A').title_zh)} 統一次數</label><input id="uniform-${scenarioId}" data-uniform="${scenarioId}" type="number" min="0" max="99" step="1" value="${uniformPlanValue(scenarioId, plans)}" placeholder="各條件不同時留白"><span class="sub" data-plan-hint="${scenarioId}">${uniformPlanValue(scenarioId, plans) === '' ? '各條件目前不同，請展開查看' : '目前 8 個條件一致'}</span><details><summary>個別調整 8 個條件</summary><div class="plan-labels">${PHASES.flatMap(phase => ANGLES.map(angle => `<span>${phase}-${angle}</span>`)).join('')}</div><div class="plan-inputs">${PHASES.flatMap(phase => ANGLES.map(angle => `<input aria-label="S${scenarioId} ${phase}-${angle}" name="plan-${key(scenarioId, angle, phase)}" type="number" min="0" max="99" step="1" value="${plans[key(scenarioId, angle, phase)]}">`)).join('')}</div></details></div>`).join('')}</div><div class="actionbar"><button class="btn primary" type="submit">儲存設定</button>${editing ? '<button class="btn danger-button" type="button" data-reset-request>重置 App／開始新任務</button>' : ''}</div></form></div>`)
  const modal = $('.modal') as HTMLElement
  ;(modal.querySelector('[data-close]') as HTMLButtonElement).onclick = () => modal.remove()
  modal.querySelectorAll<HTMLInputElement>('[data-uniform]').forEach(input => input.oninput = () => {
    if (input.value === '' || !input.checkValidity()) return
    const scenarioId = +input.dataset.uniform!
    PHASES.forEach(phase => ANGLES.forEach(angle => { (modal.querySelector(`[name="plan-${key(scenarioId, angle, phase)}"]`) as HTMLInputElement).value = input.value }))
    const hint = modal.querySelector(`[data-plan-hint="${scenarioId}"]`); if (hint) hint.textContent = '已套用至全部 8 個條件'
  })
  modal.querySelectorAll<HTMLInputElement>('[name^="plan-"]').forEach(input => input.oninput = () => {
    const scenarioId = input.name.split('-')[1]
    const uniform = modal.querySelector(`#uniform-${scenarioId}`) as HTMLInputElement
    if (uniform) {
      const values = PHASES.flatMap(phase => ANGLES.map(angle => Number((modal.querySelector(`[name="plan-${key(+scenarioId, angle, phase)}"]`) as HTMLInputElement).value)))
      const same = values.every(value => value === values[0])
      uniform.value = same ? String(values[0]) : ''
      const hint = modal.querySelector(`[data-plan-hint="${scenarioId}"]`)
      if (hint) hint.textContent = same ? '目前 8 個條件一致' : '各條件目前不同，請展開查看'
    }
  })
  ;(modal.querySelector('[data-reset-request]') as HTMLButtonElement | null)?.addEventListener('click', () => void resetFirstModal())
  ;(modal.querySelector('#setup-form') as HTMLFormElement).onsubmit = async event => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    if (!form.reportValidity()) return
    const data = new FormData(form)
    try {
      const nextSpeeds = {} as Speeds
      PHASES.forEach(phase => {
        if (phaseHasRuns(phase)) { nextSpeeds[phase] = voyage!.speeds[phase]; return }
        const ownRaw = String(data.get(`${phase}own`) || '').trim()
        const targetRaw = String(data.get(`${phase}target`) || '').trim()
        nextSpeeds[phase] = ownRaw === '' && targetRaw === '' ? null : [parseSpeed(ownRaw), parseSpeed(targetRaw)]
      })
      const nextPlans: Record<string, number> = {}
      SCENARIO_IDS.forEach(scenarioId => PHASES.forEach(phase => ANGLES.forEach(angle => { nextPlans[key(scenarioId, angle, phase)] = parsePlan(String(data.get(`plan-${key(scenarioId, angle, phase)}`) ?? '')) })))
      const nextVoyage: Voyage = { id: voyage?.id || uuid(), date: String(data.get('date')), location: String(data.get('location')), model: String(data.get('model')), fps: String(data.get('fps')), recorder: String(data.get('recorder')), reviewer: String(data.get('reviewer')), timezone: voyage?.timezone || 'Asia/Taipei', vessel: String(data.get('vessel') || ''), device: String(data.get('device') || ''), speeds: nextSpeeds, plans: nextPlans, createdAt: voyage?.createdAt || now() }
      voyage = await persistVoyage(nextVoyage); modal.remove(); view = 'progress'; render()
    } catch (error) { toast(error instanceof Error ? error.message : '設定格式不正確') }
  }
}
function parseSpeed(raw: string): number {
  const value = raw.trim()
  if (!value) return 0
  if (!/^\d+(?:\.\d)?$/.test(value)) throw Error('速度必須是 0 或非負、最多一位小數的數值')
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw Error('速度必須是有限的非負數')
  return number
}
function parsePlan(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) throw Error('計畫次數必須是 0～99 的整數')
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > 99) throw Error('計畫次數必須是 0～99 的整數')
  return value
}

async function downloadBackup() {
  if (!voyage) return
  try {
    const environmentVersions = await getEnvironments(voyage.id)
    const data = { schemaVersion: 2, exportedAt: now(), voyages: [structuredClone(voyage)], runs: structuredClone(runs), environmentVersions: structuredClone(environmentVersions) }
    download(`sea-trial-${voyage.date}.json`, JSON.stringify(data, null, 2), 'application/json')
    const csv = ['run_id,scenario,phase,angle,start_utc,end_utc,duration,completed,light,environment_version,weather,wind_direction,wind_speed_kt,wave_height_m,visibility_km,forecast_source,forecast_at,tags,note,video_file,ecu_file', ...runs.map(run => { const record = environmentVersions.find(item => item.version === run.snapshot.environmentVersion); return [run.id, run.scenarioId, run.phase, run.angle, run.startedAt, run.endedAt || '', duration(run), run.completed ?? '', run.light, run.snapshot.environmentVersion, record?.weather || '', record?.windDirection || '', record?.windSpeedKt ?? '', record?.waveHeightM ?? '', record?.visibilityKm ?? '', record?.forecast?.source || '', record?.forecast?.forecastAt || '', run.tags.join('|'), run.note, run.videoFile, run.ecuFile].map(value => `"${String(value).replaceAll('"', '""')}"`).join(',') })].join('\n')
    download(`sea-trial-${voyage.date}.csv`, csv, 'text/csv;charset=utf-8')
    localStorage.setItem('lastBackup', now()); toast('JSON 與 CSV 已下載')
  } catch (error) { toast(error instanceof Error ? error.message : '無法建立備份') }
}
function download(name: string, text: string, type: string) {
  const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([text], { type })); anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(anchor.href), 1000)
}

function isTimestamp(value: any) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function validEnvironment(record: any, voyageId: string): record is EnvironmentRecord {
  if (!record || typeof record !== 'object' || record.voyageId !== voyageId || typeof record.id !== 'string' || !record.id || !Number.isInteger(record.version) || record.version < 1 || !isTimestamp(record.observedAt) || !isTimestamp(record.createdAt)) return false
  if (typeof record.weather !== 'string' || typeof record.windDirection !== 'string' || typeof record.seaState !== 'string' || typeof record.note !== 'string') return false
  return [record.windSpeedKt, record.waveHeightM, record.visibilityKm].every(value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0))
}
function normalizeRun(raw: any): Run {
  return { id: raw.id, voyageId: raw.voyageId, scenarioId: raw.scenarioId, angle: raw.angle, phase: raw.phase, startedAt: raw.startedAt, endedAt: raw.endedAt, confirmedAt: raw.confirmedAt, light: raw.light, completed: raw.completed, tags: [...raw.tags], note: raw.note, videoFile: raw.videoFile, ecuFile: raw.ecuFile, updatedAt: raw.updatedAt, snapshot: { ...raw.snapshot, environment: raw.snapshot.environment ? structuredClone(raw.snapshot.environment) : undefined } }
}
function validateImportedRun(raw: any, voyageId: string, environments: EnvironmentRecord[], ids: Set<string>) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || ids.has(raw.id) || raw.voyageId !== voyageId || !SCENARIO_IDS.includes(raw.scenarioId) || !ANGLES.includes(raw.angle) || !PHASES.includes(raw.phase) || !isTimestamp(raw.startedAt) || !isTimestamp(raw.confirmedAt) || (raw.endedAt !== undefined && !isTimestamp(raw.endedAt)) || !['順光', '側光', '逆光', '混合'].includes(raw.light)) throw Error('備份中的 Run 欄位或資料關聯無效')
  if ((raw.completed !== undefined && typeof raw.completed !== 'boolean') || !Array.isArray(raw.tags) || raw.tags.some((tag: any) => typeof tag !== 'string') || typeof raw.note !== 'string' || typeof raw.videoFile !== 'string' || typeof raw.ecuFile !== 'string' || typeof raw.updatedAt !== 'string' || !raw.snapshot || !Number.isFinite(raw.snapshot.own) || raw.snapshot.own < 0 || !Number.isFinite(raw.snapshot.target) || raw.snapshot.target < 0 || !Number.isFinite(raw.snapshot.distance) || raw.snapshot.distance < 0 || !Number.isInteger(raw.snapshot.environmentVersion) || raw.snapshot.environmentVersion < 0) throw Error('備份中的 Run 快照無效')
  if (raw.snapshot.environmentVersion > 0 && !environments.some(record => record.version === raw.snapshot.environmentVersion)) throw Error('備份中的 Run 找不到對應環境版本')
  ids.add(raw.id)
}
function validateImportedVoyage(raw: any, schemaVersion: number) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || typeof raw.date !== 'string' || typeof raw.location !== 'string' || typeof raw.model !== 'string' || typeof raw.fps !== 'string' || typeof raw.recorder !== 'string' || typeof raw.reviewer !== 'string' || typeof raw.timezone !== 'string' || typeof raw.createdAt !== 'string' || !raw.speeds || !raw.plans) throw Error('備份中的航次欄位不完整')
  PHASES.forEach(phase => {
    if (schemaVersion === 1 && (phase === 'P3' || phase === 'P4') && !hasOwn(raw.speeds, phase)) return
    if (!hasOwn(raw.speeds, phase)) throw Error(`備份缺少 ${phase} 速度設定`)
    const speed = raw.speeds[phase]
    if (speed !== null && (!Array.isArray(speed) || speed.length !== 2 || speed.some((value: any) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.round(value * 10) !== value * 10))) throw Error(`${phase} 速度設定無效`)
  })
  SCENARIO_IDS.forEach(scenarioId => PHASES.forEach(phase => ANGLES.forEach(angle => { const plan = raw.plans[key(scenarioId, angle, phase)]; if (plan !== undefined && (!Number.isInteger(plan) || plan < 0 || plan > 99)) throw Error('備份中的計畫次數無效') })))
}
function validateImportedEnvironmentList(items: any, voyageId: string) {
  if (!Array.isArray(items)) throw Error('備份缺少環境版本')
  const ids = new Set<string>(); const versions = new Set<number>()
  items.forEach(record => { if (!validEnvironment(record, voyageId) || ids.has(record.id) || versions.has(record.version)) throw Error('備份中的環境版本無效或重複'); ids.add(record.id); versions.add(record.version) })
}
async function importFile(file: File) {
  try {
    const data = JSON.parse(await file.text())
    if ((data.schemaVersion !== 1 && data.schemaVersion !== 2) || !Array.isArray(data.voyages) || data.voyages.length !== 1 || !Array.isArray(data.runs) || !Array.isArray(data.environmentVersions)) throw Error('備份格式或版本不符（支援 schemaVersion 1、2）')
    const schemaVersion = data.schemaVersion as number
    const rawVoyage = data.voyages[0]
    validateImportedVoyage(rawVoyage, schemaVersion)
    const incoming = normalizeVoyage(rawVoyage)
    validateImportedEnvironmentList(data.environmentVersions, incoming.id)
    const environments = data.environmentVersions as EnvironmentRecord[]
    const ids = new Set<string>(); data.runs.forEach((run: any) => validateImportedRun(run, incoming.id, environments, ids))
    const incomingRuns = data.runs.map(normalizeRun)
    if (voyage && !window.confirm(`目前已有航次 ${voyage.date}，現有 ${runs.length} 筆 Run。確定以匯入航次取代？`)) return
    busy = true
    await withMutationLock('import', async () => { if (await getResetOperation()) throw Error('重置正在進行，無法匯入'); await replaceVoyageAndRuns(incoming, incomingRuns); await replaceEnvironments(environments) })
    voyage = incoming; runs = incomingRuns; environment = await currentEnvironment(incoming.id); active = runs.find(run => !run.endedAt) || runs.find(run => run.endedAt && run.completed === undefined) || null; view = active ? active.endedAt ? 'result' : 'running' : 'progress'; savedToast(); render()
  } catch (error) { window.alert(error instanceof Error ? error.message : '無法還原備份') }
  finally { busy = false }
}

async function resetFirstModal() {
  if (!voyage || resetPending || busy) return
  const storedRuns = await readAll<Run>('runs')
  if (storedRuns.some(run => !run.endedAt)) { toast('仍有計時中的 Run，請先結束測試後再重置'); return }
  document.body.insertAdjacentHTML('beforeend', `<div class="modal" data-reset-modal="first"><div class="modal-card"><button type="button" class="btn modal-close" data-reset-cancel>取消</button><div class="eyebrow">RESET APP / NEW TASK</div><h2>重置 App／開始新任務</h2><p>即將清除此裝置在本網站保存的所有航次、測試紀錄與環境紀錄。</p><div class="notice"><b>會清除：</b>所有航次、船速、計畫次數、Run、結果、備註、檔名參照、環境版本、Windy 預報紀錄與進度狀態。<br><b>會保留：</b>Windy API Key、緯度、經度、離線快取、Service Worker、航跡圖，以及已下載的檔案。</div><p class="sub">建議先下載備份；備份是選用，取消分享不會被視為備份成功。</p><div class="actionbar"><button class="btn" type="button" data-reset-backup>下載備份</button><button class="btn" type="button" data-reset-continue>繼續重置</button></div></div></div>`)
  const modal = document.querySelector('[data-reset-modal="first"]') as HTMLElement
  ;(modal.querySelector('[data-reset-cancel]') as HTMLButtonElement).onclick = () => modal.remove()
  ;(modal.querySelector('[data-reset-backup]') as HTMLButtonElement).onclick = () => void downloadBackup()
  ;(modal.querySelector('[data-reset-continue]') as HTMLButtonElement).onclick = () => { modal.remove(); resetSecondModal() }
}
function resetSecondModal() {
  document.body.insertAdjacentHTML('beforeend', `<div class="modal" data-reset-modal="second"><div class="modal-card"><button type="button" class="btn modal-close" data-reset-cancel>取消</button><div class="eyebrow">FINAL CONFIRMATION</div><h2>確認開始新任務？</h2><p>即將永久清除此瀏覽器目前網站來源保存的航次與環境紀錄。</p><p><b>Windy API Key、緯度、經度與離線功能會保留。</b></p><div class="actionbar"><button class="btn" type="button" data-reset-cancel>取消</button><button class="btn primary" type="button" data-reset-confirm>確認清除並開始新任務</button></div></div></div>`)
  const modal = document.querySelector('[data-reset-modal="second"]') as HTMLElement
  modal.querySelectorAll('[data-reset-cancel]').forEach(button => (button as HTMLButtonElement).onclick = () => modal.remove())
  ;(modal.querySelector('[data-reset-confirm]') as HTMLButtonElement).onclick = () => void attemptReset(false, modal)
}
async function attemptReset(recovery: boolean, modal?: HTMLElement) {
  if (busy) return
  if (modal) modal.remove()
  document.querySelectorAll('.modal').forEach(item => item.remove())
  resetPending = true; busy = true; channel?.postMessage({ type: 'reset-started' }); render()
  try {
    await withMutationLock('reset', async () => {
      let operation = await getResetOperation()
      if (!operation) {
        const storedRuns = await readAll<Run>('runs')
        if (storedRuns.some(run => !run.endedAt)) throw Error('仍有計時中的 Run，請先結束測試後再重置')
        operation = { key: 'reset-operation', id: uuid(), startedAt: now(), step: 'marked' }
        await setResetOperation(operation)
      }
      if (operation.step === 'marked') { await clearVoyageStores(); operation = { ...operation, step: 'voyages-cleared' }; await setResetOperation(operation) }
      if (operation.step === 'voyages-cleared') { await clearEnvironmentRecords(); operation = { ...operation, step: 'environments-cleared' }; await setResetOperation(operation) }
      if (operation.step === 'environments-cleared') { ['lastSaved', 'lastBackup', 'sea-trial-last-voyage'].forEach(item => localStorage.removeItem(item)); operation = { ...operation, step: 'local-storage-cleared' }; await setResetOperation(operation) }
      await clearResetOperation()
    })
    voyage = null; runs = []; environment = null; active = null; selected = { scenarioId: 1, angle: 'A', phase: 'P1' }; view = 'progress'; resetPending = false; channel?.postMessage({ type: 'reset-complete' }); toast('重置完成，請建立新航次'); render()
  } catch (error) { resetPending = true; toast(error instanceof Error ? error.message : '重置失敗，請重試'); channel?.postMessage({ type: 'reset-failed' }) }
  finally { busy = false; if (resetPending) render() }
}

let scale = 1, tx = 0, ty = 0
function applyZoom() { const image = $('#route-img') as HTMLImageElement | null; if (image) image.style.transform = `translate(${tx}px,${ty}px) scale(${scale})` }
function zoomBy(amount: number) { scale = Math.max(1, Math.min(4, scale + amount)); applyZoom() }
function resetZoom() { scale = 1; tx = 0; ty = 0; applyZoom() }
function enableZoom() {
  resetZoom(); const element = $('#image-wrap'); if (!element) return
  let sx = 0, sy = 0, ox = 0, oy = 0
  element.onpointerdown = event => { sx = event.clientX; sy = event.clientY; ox = tx; oy = ty; element.setPointerCapture(event.pointerId) }
  element.onpointermove = event => { if (!element.hasPointerCapture(event.pointerId) || scale === 1) return; tx = ox + event.clientX - sx; ty = oy + event.clientY - sy; applyZoom() }
  element.onwheel = event => { event.preventDefault(); zoomBy(event.deltaY < 0 ? .2 : -.2) }
}
function fullscreen() {
  const source = ($('#route-img') as HTMLImageElement).src
  document.body.insertAdjacentHTML('beforeend', `<div class="modal full"><div class="modal-card"><button class="btn modal-close" data-close-full>關閉</button><img src="${source}" alt="滿版航跡示意圖"></div></div>`)
  ;($('[data-close-full]') as HTMLButtonElement).onclick = () => $('.modal.full')?.remove()
}

async function reloadFromStorage() {
  const voyages = await readAll<any>('voyages')
  const stored = voyages[0] ? normalizeVoyage(voyages[0]) : null
  if (stored && JSON.stringify(stored) !== JSON.stringify(voyages[0])) await withMutationLock('voyage', () => writeStore('voyages', stored, false))
  voyage = stored
  runs = voyage ? (await readAll<Run>('runs')).filter(run => run.voyageId === voyage!.id) : []
  environment = voyage ? await currentEnvironment(voyage.id) : null
  active = runs.find(run => !run.endedAt) || runs.find(run => run.endedAt && run.completed === undefined) || null
  if (active) { selected = { scenarioId: active.scenarioId, angle: active.angle, phase: active.phase }; view = active.endedAt ? 'result' : 'running' }
}
async function init() {
  const pending = await getResetOperation()
  if (pending) { resetPending = true; render(); await attemptReset(true); if (resetPending) return }
  await reloadFromStorage(); render()
  window.addEventListener('online', refreshConnection); window.addEventListener('offline', refreshConnection); void startOffline(); registerTools()
  channel?.addEventListener('message', async event => {
    const message = event.data
    if (message?.type === 'reset-started') { resetPending = true; voyage = null; runs = []; environment = null; active = null; selected = { scenarioId: 1, angle: 'A', phase: 'P1' }; view = 'progress'; document.querySelectorAll('.modal').forEach(modal => modal.remove()); render(); return }
    if (message?.type === 'reset-complete') { resetPending = false; voyage = null; runs = []; environment = null; active = null; selected = { scenarioId: 1, angle: 'A', phase: 'P1' }; view = 'progress'; render(); return }
    if (message?.type === 'reset-failed') { resetPending = true; render(); return }
    if (message?.type === 'run-started' || message?.type === 'voyage-updated' || message?.type === 'environment-updated') { if (!resetPending) { await reloadFromStorage(); render() } }
  })
}
function registerTools() {
  const context = (document as any).modelContext
  if (!context?.registerTool) return
  const signal = new AbortController().signal
  void Promise.resolve(context.registerTool({ name: 'read_voyage_progress', title: '讀取航次進度', description: '讀取目前航次各條件完成與計畫次數。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: () => ({ voyageId: voyage?.id, completed: runs.filter(run => run.completed).length, attempts: runs.length, plans: voyage?.plans, speeds: voyage?.speeds }) }, { signal }))
  void Promise.resolve(context.registerTool({ name: 'open_run_preparation', title: '開啟 Run 準備', description: '開啟指定情境、速度組與 A/B 的航跡核對頁，不會開始計時。', inputSchema: { type: 'object', properties: { scenarioId: { type: 'integer', minimum: 1, maximum: 7 }, phase: { enum: [...PHASES] }, angle: { enum: ['A', 'B'] } }, required: ['scenarioId', 'phase', 'angle'], additionalProperties: false }, annotations: { readOnlyHint: false }, execute: (input: any) => { if (!voyage) throw Error('尚未開啟航次'); if (!PHASES.includes(input.phase) || !speedReady(voyage.speeds[input.phase]) || (voyage.plans[key(input.scenarioId, input.angle, input.phase)] ?? 0) === 0) throw Error('此條件尚未設定速度或計畫次數為 0'); selected = { scenarioId: input.scenarioId, phase: input.phase, angle: input.angle }; view = 'prepare'; render(); return { opened: true, ...selected } } }, { signal }))
}
document.addEventListener('change', event => { const input = event.target as HTMLInputElement; if (input.id === 'import-file' && input.files?.[0]) void importFile(input.files[0]) })
init().catch(error => { console.error(error); const app = $('#app'); if (app) app.innerHTML = '<main class="shell"><h1>無法開啟本機資料庫</h1><p>請確認瀏覽器未封鎖網站儲存空間，再重新整理。</p></main>' })
