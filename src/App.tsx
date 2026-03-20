import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'
import {
  TrendingUp, Target, ShieldAlert, Clock, BarChart3, MessageSquare, Settings,
  AlertTriangle, CheckCircle2, XCircle, Activity, Eye, Trash2, RefreshCw, Send,
  Zap, ArrowUpRight, ArrowDownRight, LogIn, LogOut, Phone, Key, Lock, Loader2,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line,
} from 'recharts'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { createChart, ColorType, type IChartApi, type ISeriesApi, LineStyle } from 'lightweight-charts'

interface Signal {
  id: string; timestamp: Date; direction: 'BUY' | 'SELL'
  entryLow: number; entryHigh: number; takeProfits: number[]; stopLoss: number
  status: 'PENDING' | 'ACTIVE' | 'TP_HIT' | 'SL_HIT' | 'COMPLETED'
  activePrice?: number; tpHits: number[]; maxPips?: number; messages: TelegramMessage[]
}
interface TelegramMessage {
  id: string; timestamp: Date; sender: string; text: string
  type: 'SIGNAL' | 'UPDATE' | 'PROMO' | 'GREETING' | 'UNKNOWN'
  deleted?: boolean; edited?: boolean
}
interface BacktestResult {
  signal: Signal; entryPrice: number; exitPrice: number; pips: number
  result: 'WIN' | 'LOSS' | 'PARTIAL'; tpHitsCount: number; duration: number
}
type AuthStep = 'disconnected' | 'phone' | 'code' | 'password' | 'connected'

function parseMessages(rawText: string): TelegramMessage[] {
  const lines = rawText.split('\n')
  const messages: TelegramMessage[] = []
  let currentMsg: Partial<TelegramMessage> | null = null
  for (const line of lines) {
    const dateMatch = line.match(/\[(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\]\s+(.+?):\s*(.*)/)
    if (dateMatch) {
      if (currentMsg && currentMsg.text) messages.push(currentMsg as TelegramMessage)
      const [, dateStr, timeStr, sender, text] = dateMatch
      const [day, month, year] = dateStr.split('/')
      const timestamp = new Date(`${year}-${month}-${day}T${timeStr}:00Z`)
      currentMsg = { id: `msg-${messages.length}`, timestamp, sender, text: text.trim(), type: classifyMessage(text.trim()) }
    } else if (currentMsg && line.trim()) {
      currentMsg.text += '\n' + line.trim()
      currentMsg.type = classifyMessage(currentMsg.text ?? '')
    }
  }
  if (currentMsg && currentMsg.text) messages.push(currentMsg as TelegramMessage)
  const seen = new Set<string>()
  return messages.filter((m) => { const key = `${m.timestamp.getTime()}-${m.text}`; if (seen.has(key)) return false; seen.add(key); return true })
}

function classifyMessage(text: string): TelegramMessage['type'] {
  if (/GOLD\s+(Buy|Sell)\s+\d+/i.test(text)) return 'SIGNAL'
  if (/TP\s*\d+\s*HIT|Active|Running profit|SL hit|Target Complete|Mission/i.test(text)) return 'UPDATE'
  if (/Contact|recover|login|MT4|MT5|@\w+/i.test(text)) return 'PROMO'
  if (/Hi Everyone|Ready for/i.test(text)) return 'GREETING'
  return 'UNKNOWN'
}

function extractSignals(messages: TelegramMessage[]): Signal[] {
  const signals: Signal[] = []
  let current: Signal | null = null
  for (const msg of messages) {
    const signalMatch = msg.text.match(/GOLD\s+(Buy|Sell)\s+(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/i)
    if (signalMatch) {
      if (current) signals.push(current)
      const direction = signalMatch[1].toUpperCase() as 'BUY' | 'SELL'
      const p1 = parseFloat(signalMatch[2]), p2 = parseFloat(signalMatch[3])
      const tps: number[] = []
      const tpMatches = msg.text.matchAll(/TP\s+(\d+(?:\.\d+)?)/gi)
      for (const tp of tpMatches) tps.push(parseFloat(tp[1]))
      const slMatch = msg.text.match(/SL\s+(\d+(?:\.\d+)?)/i)
      current = { id: `signal-${signals.length}`, timestamp: msg.timestamp, direction, entryLow: Math.min(p1,p2), entryHigh: Math.max(p1,p2), takeProfits: tps, stopLoss: slMatch ? parseFloat(slMatch[1]) : 0, status: 'PENDING', tpHits: [], messages: [msg] }
      continue
    }
    if (!current) continue
    const activeMatch = msg.text.match(/Active\s*(?:already\s+)?(\d+(?:\.\d+)?)/i)
    if (activeMatch) { current.activePrice = parseFloat(activeMatch[1]); current.status = 'ACTIVE'; current.messages.push(msg); continue }
    const tpHitMatch = msg.text.match(/TP\s*(\d+)\s*HIT/i)
    if (tpHitMatch) { const n = parseInt(tpHitMatch[1]); if (!current.tpHits.includes(n)) current.tpHits.push(n); current.status = 'TP_HIT'; current.messages.push(msg); continue }
    if (/SL\s*hit/i.test(msg.text)) { current.status = 'SL_HIT'; current.messages.push(msg); continue }
    const pipsMatch = msg.text.match(/(\d+)\+?\s*Pips\s*(Running|profit)/i)
    if (pipsMatch) { current.maxPips = Math.max(current.maxPips || 0, parseInt(pipsMatch[1])); current.messages.push(msg); continue }
    if (/All Target Complete|Mission Accomplished/i.test(msg.text)) { current.status = 'COMPLETED'; current.messages.push(msg) }
  }
  if (current) signals.push(current)
  return signals
}

function generateBacktestResults(signals: Signal[]): BacktestResult[] {
  return signals.map((signal) => {
    const entry = signal.activePrice || (signal.entryLow + signal.entryHigh) / 2
    const isWin = signal.status === 'COMPLETED' || signal.status === 'TP_HIT'
    const isLoss = signal.status === 'SL_HIT'
    let exitPrice = entry, pips = 0
    if (isWin && signal.tpHits.length > 0) { const maxTp = Math.max(...signal.tpHits); exitPrice = signal.takeProfits[maxTp-1] || signal.takeProfits[signal.takeProfits.length-1]; pips = signal.direction === 'BUY' ? (exitPrice-entry)*10 : (entry-exitPrice)*10 }
    else if (isLoss) { exitPrice = signal.stopLoss; pips = signal.direction === 'BUY' ? (exitPrice-entry)*10 : (entry-exitPrice)*10 }
    else { pips = signal.maxPips || 0 }
    const lastMsg = signal.messages[signal.messages.length-1], firstMsg = signal.messages[0]
    const duration = lastMsg && firstMsg ? (lastMsg.timestamp.getTime()-firstMsg.timestamp.getTime())/60000 : 0
    return { signal, entryPrice: entry, exitPrice, pips: Math.round(pips), result: (isLoss ? 'LOSS' : isWin ? 'WIN' : 'PARTIAL') as BacktestResult['result'], tpHitsCount: signal.tpHits.length, duration: Math.round(duration) }
  })
}

const SAMPLE_MESSAGES = `[17/03/2026 00:51] GOLD SURE SIGNALS: GOLD Buy 4999-4996

TP 5010
TP 5015
TP 5020

SL 4989
[17/03/2026 01:00] GOLD SURE SIGNALS: #XAUUSD
70+ Pips Running profit
[17/03/2026 01:10] GOLD SURE SIGNALS: Active 4996
[17/03/2026 01:11] GOLD SURE SIGNALS: #XAUUSD
TP 1 HIT 140+ Pips profit
[17/03/2026 01:18] GOLD SURE SIGNALS: #XAUUSD
180+ Pips Running profit
[17/03/2026 02:03] GOLD SURE SIGNALS: #XAUUSD
TP 3 HIT 240+ Pips profit
[17/03/2026 02:03] GOLD SURE SIGNALS: All Target Complete 
Mission Accomplished
[17/03/2026 10:36] GOLD SURE SIGNALS: If you want recover your loses Contact now @Jhollay_lal
[18/03/2026 01:02] GOLD SURE SIGNALS: Hi Everyone
[18/03/2026 01:03] GOLD SURE SIGNALS: Ready for sure signals
[18/03/2026 01:19] GOLD SURE SIGNALS: GOLD Buy 5010-5007

TP 5020
TP 5025
TP 5040

SL 5000
[18/03/2026 03:09] GOLD SURE SIGNALS: SL hit don\'t worry we recover it soon
[18/03/2026 04:06] GOLD SURE SIGNALS: GOLD Buy 4990-4987

TP 5000
TP 5005
TP 5010
TP 5020

SL 4978
[18/03/2026 05:51] GOLD SURE SIGNALS: Active already 4987
[18/03/2026 05:51] GOLD SURE SIGNALS: #XAUUSD
TP 1 HIT 130+ Pips profit
[18/03/2026 05:51] GOLD SURE SIGNALS: #XAUUSD
150+ Pips Running profit
[18/03/2026 07:07] GOLD SURE SIGNALS: #XAUUSD
TP 2 HIT 180+ Pips profit
[18/03/2026 07:08] GOLD SURE SIGNALS: #XAUUSD
TP 3 HIT 230+ Pips profit
[18/03/2026 07:08] GOLD SURE SIGNALS: #XAUUSD
300+ Pips Running profit
[19/03/2026 00:31] GOLD SURE SIGNALS: Hi Everyone
[19/03/2026 00:31] GOLD SURE SIGNALS: Ready for sure signals
[19/03/2026 02:00] GOLD SURE SIGNALS: GOLD Buy 4850-4847

TP 4860
TP 4865
TP 4870
TP 4880

SL 4839
[19/03/2026 02:18] GOLD SURE SIGNALS: Active 4847
[19/03/2026 02:18] GOLD SURE SIGNALS: #XAUUSD
60+ Pips Running profit
[19/03/2026 02:23] GOLD SURE SIGNALS: #XAUUSD
100+ Pips Running profit
[19/03/2026 02:33] GOLD SURE SIGNALS: #XAUUSD
110+ Pips Running profit
[19/03/2026 03:47] GOLD SURE SIGNALS: #XAUUSD
TP 1 HIT 130+ Pips profit
[19/03/2026 03:48] GOLD SURE SIGNALS: #XAUUSD
TP 2 HIT 180+ Pips profit
[19/03/2026 07:02] GOLD SURE SIGNALS: Anyone account running big loss now ?
Contact me now for recovery I have best plan for everyone to recover loss 
Contact fast @Jhollay_lal
[20/03/2026 00:37] GOLD SURE SIGNALS: Hi Everyone
[20/03/2026 01:06] GOLD SURE SIGNALS: GOLD Sell 4674-4678

TP 4660
TP 4655
TP 4650
TP 4640

SL 4685
[20/03/2026 01:10] GOLD SURE SIGNALS: Active 4678
[20/03/2026 01:10] GOLD SURE SIGNALS: #XAUUSD
120+ Pips Running profit
[20/03/2026 01:13] GOLD SURE SIGNALS: #XAUUSD
TP 1 HIT 180+ Pips profit
[20/03/2026 01:14] GOLD SURE SIGNALS: #XAUUSD
TP 2 HIT 230+ Pips profit
[20/03/2026 01:16] GOLD SURE SIGNALS: #XAUUSD
270+ Pips Running profit
[20/03/2026 01:19] GOLD SURE SIGNALS: #XAUUSD
TP 3 HIT 280+ Pips profit
[20/03/2026 01:20] GOLD SURE SIGNALS: #XAUUSD
300+ Pips Running profit
[20/03/2026 06:34] GOLD SURE SIGNALS: Send me login details MT4 MT5 
I will make sure good profit in your account I have confirmed target 
Admin @Jhollay_lal`

const API_ID = parseInt(import.meta.env.VITE_TELEGRAM_API_ID || '25535062')
const API_HASH = import.meta.env.VITE_TELEGRAM_API_HASH || '2fcff9d64e970d8fc14ddc256f02c06b'
const CHANNEL_ID = import.meta.env.VITE_TELEGRAM_CHANNEL_ID || '-1001235475731'

function useTelegramClient() {
  const [authStep, setAuthStep] = useState<AuthStep>('disconnected')
  const [authError, setAuthError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [userName, setUserName] = useState('')
  const clientRef = useRef<TelegramClient | null>(null)
  const phoneCodeResolverRef = useRef<((code: string) => void) | null>(null)
  const passwordResolverRef = useRef<((password: string) => void) | null>(null)
  const phoneRef = useRef('')

  const getClient = useCallback(() => {
    if (!clientRef.current) {
      const savedSession = localStorage.getItem('telegram_session') || ''
      const session = new StringSession(savedSession)
      clientRef.current = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 })
    }
    return clientRef.current
  }, [])

  const startAuth = useCallback(async (phone: string) => {
    setAuthError(''); setIsLoading(true); phoneRef.current = phone
    try {
      const client = getClient()
      await client.start({
        phoneNumber: async () => phoneRef.current,
        phoneCode: async () => { setAuthStep('code'); setIsLoading(false); return new Promise<string>((resolve) => { phoneCodeResolverRef.current = resolve }) },
        password: async () => { setAuthStep('password'); setIsLoading(false); return new Promise<string>((resolve) => { passwordResolverRef.current = resolve }) },
        onError: (err: Error) => { setAuthError(err.message); setIsLoading(false) },
      })
      const sessionStr = (client.session as StringSession).save()
      localStorage.setItem('telegram_session', sessionStr)
      const me = await client.getMe() as Api.User
      setUserName(me.firstName || me.username || 'User')
      setAuthStep('connected'); setIsLoading(false)
    } catch (err) { setAuthError(err instanceof Error ? err.message : 'Auth failed'); setIsLoading(false) }
  }, [getClient])

  const submitCode = useCallback((code: string) => { setIsLoading(true); if (phoneCodeResolverRef.current) { phoneCodeResolverRef.current(code); phoneCodeResolverRef.current = null } }, [])
  const submitPassword = useCallback((password: string) => { setIsLoading(true); if (passwordResolverRef.current) { passwordResolverRef.current(password); passwordResolverRef.current = null } }, [])
  const disconnect = useCallback(async () => { if (clientRef.current) { await clientRef.current.disconnect(); clientRef.current = null }; localStorage.removeItem('telegram_session'); setAuthStep('disconnected'); setUserName('') }, [])

  const fetchChannelMessages = useCallback(async (channelId: string, limit = 100): Promise<string> => {
    const client = clientRef.current
    if (!client || authStep !== 'connected') return ''
    try {
      const peerChannelId = channelId.startsWith('-100') ? BigInt(channelId.slice(4)) : BigInt(channelId.replace('-', ''))
      const entity = await client.getEntity(new Api.PeerChannel({ channelId: peerChannelId }))
      const result = await client.getMessages(entity, { limit })
      return result.filter((msg): msg is Api.Message => msg instanceof Api.Message && !!msg.message).reverse().map((msg) => {
        const date = new Date(msg.date * 1000)
        return `[${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')}/${date.getFullYear()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}] GOLD SURE SIGNALS: ${msg.message}`
      }).join('\n')
    } catch (err) { console.error('Fetch error:', err); setAuthError(err instanceof Error ? err.message : 'Failed to fetch'); return '' }
  }, [authStep])

  const tryAutoConnect = useCallback(async () => {
    const saved = localStorage.getItem('telegram_session'); if (!saved) return
    setIsLoading(true)
    try { const client = getClient(); await client.connect(); const me = await client.getMe() as Api.User; setUserName(me.firstName || me.username || 'User'); setAuthStep('connected') }
    catch { localStorage.removeItem('telegram_session') }
    setIsLoading(false)
  }, [getClient])

  return { authStep, authError, isLoading, userName, startAuth, submitCode, submitPassword, disconnect, fetchChannelMessages, tryAutoConnect }
}

function SignalPriceChart({ signal }: { signal: Signal | null }) {
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!chartContainerRef.current) return
    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#1f2937' }, textColor: '#9ca3af' },
      grid: { vertLines: { color: '#374151' }, horzLines: { color: '#374151' } },
      width: chartContainerRef.current.clientWidth, height: 450,
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#4b5563' },
      timeScale: { borderColor: '#4b5563', timeVisible: true, secondsVisible: false },
    })
    chartRef.current = chart
    const handleResize = () => { if (chartContainerRef.current) chart.applyOptions({ width: chartContainerRef.current.clientWidth }) }
    window.addEventListener('resize', handleResize)
    return () => { window.removeEventListener('resize', handleResize); chart.remove(); chartRef.current = null }
  }, [])

  useEffect(() => {
    if (!chartRef.current || !signal) return
    const chart = chartRef.current
    // Remove old series by recreating
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444', borderDownColor: '#ef4444',
      borderUpColor: '#22c55e', wickDownColor: '#ef4444', wickUpColor: '#22c55e',
    })
    const entryMid = (signal.entryLow + signal.entryHigh) / 2
    const baseTime = Math.floor(signal.timestamp.getTime() / 1000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candleData: any[] = []
    let price = entryMid
    for (let i = -30; i <= 40; i++) {
      const t = baseTime + i * 900
      const vol = 2 + Math.random() * 3
      const drift = signal.direction === 'BUY' ? 0.3 : -0.3
      const open = price
      const change = (Math.random() - 0.45) * vol + (i > 0 ? drift : 0)
      const close = open + change
      const high = Math.max(open, close) + Math.random() * 2
      const low = Math.min(open, close) - Math.random() * 2
      candleData.push({ time: t, open, high, low, close })
      price = close
    }
    candleSeries.setData(candleData)
    // Entry zone
    candleSeries.createPriceLine({ price: signal.entryLow, color: '#3b82f6', lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `Entry Low ${signal.entryLow}` })
    candleSeries.createPriceLine({ price: signal.entryHigh, color: '#3b82f6', lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `Entry High ${signal.entryHigh}` })
    // SL
    candleSeries.createPriceLine({ price: signal.stopLoss, color: '#ef4444', lineWidth: 3, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `SL ${signal.stopLoss}` })
    // TPs
    signal.takeProfits.forEach((tp, i) => {
      const isHit = signal.tpHits.includes(i + 1)
      candleSeries.createPriceLine({ price: tp, color: isHit ? '#22c55e' : '#4ade80', lineWidth: isHit ? 3 : 2, lineStyle: isHit ? LineStyle.Solid : LineStyle.Dotted, axisLabelVisible: true, title: `TP${i+1} ${tp}${isHit ? ' HIT' : ''}` })
    })
    // SL shaded area
    const slArea = chart.addAreaSeries({ topColor: 'rgba(239,68,68,0.15)', bottomColor: 'rgba(239,68,68,0.05)', lineColor: 'rgba(239,68,68,0.4)', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
    slArea.setData(candleData.map((c: { time: number }) => ({ time: c.time, value: signal.stopLoss })))
    // TP shaded area
    if (signal.takeProfits.length > 0) {
      const highTp = Math.max(...signal.takeProfits)
      const tpArea = chart.addAreaSeries({ topColor: 'rgba(34,197,94,0.15)', bottomColor: 'rgba(34,197,94,0.05)', lineColor: 'rgba(34,197,94,0.4)', lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
      tpArea.setData(candleData.map((c: { time: number }) => ({ time: c.time, value: highTp })))
    }
    chart.timeScale().fitContent()
  }, [signal])

  return (
    <div className="relative">
      <div ref={chartContainerRef} className="w-full" />
      {signal && (
        <div className="absolute top-2 left-2 flex gap-2 z-10">
          <span className="bg-blue-500/20 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded text-xs">Entry Zone</span>
          <span className="bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-0.5 rounded text-xs">Stop Loss</span>
          <span className="bg-green-500/20 text-green-400 border border-green-500/30 px-2 py-0.5 rounded text-xs">Take Profits</span>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: Signal['status'] }) {
  const styles: Record<string, string> = { PENDING: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', ACTIVE: 'bg-blue-500/20 text-blue-400 border-blue-500/30', TP_HIT: 'bg-green-500/20 text-green-400 border-green-500/30', SL_HIT: 'bg-red-500/20 text-red-400 border-red-500/30', COMPLETED: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' }
  return (<span className={`px-2 py-0.5 rounded text-xs font-semibold border ${styles[status]}`}>{status.replace('_', ' ')}</span>)
}

function SignalCard({ signal, isSelected, onSelect }: { signal: Signal; isSelected: boolean; onSelect: () => void }) {
  const isBuy = signal.direction === 'BUY'
  return (
    <div onClick={onSelect} className={`bg-gray-800 border rounded-lg p-4 hover:border-gray-500 transition-colors cursor-pointer ${isSelected ? 'border-yellow-500 ring-1 ring-yellow-500/50' : 'border-gray-700'}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isBuy ? <ArrowUpRight className="text-green-400" size={20} /> : <ArrowDownRight className="text-red-400" size={20} />}
          <span className={`font-bold text-lg ${isBuy ? 'text-green-400' : 'text-red-400'}`}>{signal.direction}</span>
          <span className="text-gray-400 text-sm">XAUUSD</span>
        </div>
        <StatusBadge status={signal.status} />
      </div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="bg-gray-900 rounded p-2"><div className="text-xs text-gray-500 mb-1">Entry Zone</div><div className="text-white font-mono text-sm">{signal.entryLow} - {signal.entryHigh}</div></div>
        <div className="bg-gray-900 rounded p-2"><div className="text-xs text-gray-500 mb-1">Stop Loss</div><div className="text-red-400 font-mono text-sm flex items-center gap-1"><ShieldAlert size={12} />{signal.stopLoss}</div></div>
      </div>
      <div className="mb-3">
        <div className="text-xs text-gray-500 mb-1">Take Profits</div>
        <div className="flex gap-2 flex-wrap">
          {signal.takeProfits.map((tp, i) => (<span key={i} className={`px-2 py-0.5 rounded text-xs font-mono ${signal.tpHits.includes(i+1) ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-gray-700 text-gray-400'}`}><Target size={10} className="inline mr-1" />TP{i+1}: {tp}{signal.tpHits.includes(i+1) && ' HIT'}</span>))}
        </div>
      </div>
      {signal.activePrice && (<div className="text-xs text-blue-400 mb-1"><Zap size={10} className="inline mr-1" />Activated @ {signal.activePrice}</div>)}
      {signal.maxPips && (<div className="text-xs text-green-400 mb-1"><TrendingUp size={10} className="inline mr-1" />Max: {signal.maxPips}+ pips</div>)}
      <div className="text-xs text-gray-500 mt-2 flex items-center gap-1"><Clock size={10} />{signal.timestamp.toLocaleString()}</div>
    </div>
  )
}

function TelegramAuthPanel({ authStep, isLoading, authError, userName, onStartAuth, onSubmitCode, onSubmitPassword, onDisconnect }: {
  authStep: AuthStep; isLoading: boolean; authError: string; userName: string
  onStartAuth: (phone: string) => void; onSubmitCode: (code: string) => void; onSubmitPassword: (password: string) => void; onDisconnect: () => void
}) {
  const [phoneInput, setPhoneInput] = useState('')
  const [codeInput, setCodeInput] = useState('')
  const [passInput, setPassInput] = useState('')

  if (authStep === 'connected') {
    return (
      <div className="bg-green-950/30 border border-green-500/30 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-green-500/20 rounded-full p-2"><CheckCircle2 size={20} className="text-green-400" /></div>
            <div><div className="text-sm font-semibold text-green-400">Connected as {userName}</div><div className="text-xs text-gray-400">Telegram MTProto authenticated</div></div>
          </div>
          <button onClick={onDisconnect} className="flex items-center gap-2 px-3 py-1.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 text-sm"><LogOut size={14} /> Disconnect</button>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
      <h3 className="text-sm font-bold text-gray-200 mb-4 flex items-center gap-2"><LogIn size={16} className="text-blue-400" />Telegram User Login (MTProto)</h3>
      <p className="text-xs text-gray-400 mb-4">Log in with your Telegram account to read channel messages directly. Uses the official MTProto API.</p>
      {authError && (<div className="bg-red-950/30 border border-red-500/30 rounded p-3 mb-4 text-sm text-red-400">{authError}</div>)}
      {(authStep === 'disconnected' || authStep === 'phone') && (
        <div className="space-y-3">
          <div><label className="block text-xs text-gray-400 mb-1">Phone Number (with country code)</label>
            <input type="tel" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} placeholder="+1234567890" className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none" /></div>
          <button onClick={() => onStartAuth(phoneInput)} disabled={!phoneInput || isLoading} className="flex items-center gap-2 px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium disabled:opacity-50">
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Phone size={14} />}{isLoading ? 'Connecting...' : 'Connect with Telegram'}</button>
        </div>
      )}
      {authStep === 'code' && (
        <div className="space-y-3">
          <div className="text-sm text-gray-300 flex items-center gap-2"><Key size={14} className="text-yellow-400" />Verification code sent to your Telegram app</div>
          <div><label className="block text-xs text-gray-400 mb-1">Verification Code</label>
            <input type="text" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="12345" maxLength={6} className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none font-mono text-center text-lg tracking-widest" /></div>
          <button onClick={() => onSubmitCode(codeInput)} disabled={!codeInput || isLoading} className="flex items-center gap-2 px-4 py-2 rounded bg-yellow-600 text-white hover:bg-yellow-700 text-sm font-medium disabled:opacity-50">
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}Submit Code</button>
        </div>
      )}
      {authStep === 'password' && (
        <div className="space-y-3">
          <div className="text-sm text-gray-300 flex items-center gap-2"><Lock size={14} className="text-orange-400" />Two-Factor Authentication required</div>
          <div><label className="block text-xs text-gray-400 mb-1">2FA Password</label>
            <input type="password" value={passInput} onChange={(e) => setPassInput(e.target.value)} placeholder="Your 2FA password" className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none" /></div>
          <button onClick={() => onSubmitPassword(passInput)} disabled={!passInput || isLoading} className="flex items-center gap-2 px-4 py-2 rounded bg-orange-600 text-white hover:bg-orange-700 text-sm font-medium disabled:opacity-50">
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}Submit Password</button>
        </div>
      )}
      <div className="mt-4 bg-gray-900 rounded p-3 text-xs text-gray-500 font-mono">
        <div>API ID: {API_ID}</div><div>API Hash: {'****' + API_HASH.slice(-4)}</div><div>Target Channel: {CHANNEL_ID}</div>
      </div>
    </div>
  )
}

type TabId = 'signals' | 'backtest' | 'history' | 'settings'
const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'signals', label: 'Live Signals', icon: <Activity size={16} /> },
  { id: 'backtest', label: 'Backtest', icon: <BarChart3 size={16} /> },
  { id: 'history', label: 'History', icon: <MessageSquare size={16} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={16} /> },
]

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('signals')
  const [rawMessages, setRawMessages] = useState(SAMPLE_MESSAGES)
  const [messages, setMessages] = useState<TelegramMessage[]>([])
  const [signals, setSignals] = useState<Signal[]>([])
  const [backtestResults, setBacktestResults] = useState<BacktestResult[]>([])
  const [telegramChannelId, setTelegramChannelId] = useState(CHANNEL_ID)
  const [isPolling, setIsPolling] = useState(false)
  const [lastPollTime, setLastPollTime] = useState<Date | null>(null)
  const [filterType, setFilterType] = useState<string>('ALL')
  const [showChart, setShowChart] = useState(true)
  const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const telegram = useTelegramClient()

  const processMessages = useCallback((text: string) => {
    const msgs = parseMessages(text); setMessages(msgs)
    const sigs = extractSignals(msgs); setSignals(sigs)
    setBacktestResults(generateBacktestResults(sigs))
    if (sigs.length > 0 && !selectedSignal) setSelectedSignal(sigs[sigs.length - 1])
  }, [selectedSignal])

  useEffect(() => { processMessages(rawMessages) }, [rawMessages, processMessages])
  useEffect(() => { telegram.tryAutoConnect() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchTelegramMessages = useCallback(async () => {
    if (telegram.authStep !== 'connected') return
    const ch = await telegram.fetchChannelMessages(telegramChannelId)
    if (ch) { setRawMessages(ch); setLastPollTime(new Date()) }
  }, [telegram, telegramChannelId])

  const togglePolling = useCallback(() => {
    if (isPolling) { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; setIsPolling(false) }
    else { fetchTelegramMessages(); pollIntervalRef.current = setInterval(fetchTelegramMessages, 10000); setIsPolling(true) }
  }, [isPolling, fetchTelegramMessages])

  useEffect(() => { return () => { if (pollIntervalRef.current) clearInterval(pollIntervalRef.current) } }, [])

  const totalSignals = signals.length
  const wins = backtestResults.filter((r) => r.result === 'WIN').length
  const losses = backtestResults.filter((r) => r.result === 'LOSS').length
  const winRate = totalSignals > 0 ? ((wins / totalSignals) * 100).toFixed(1) : '0'
  const totalPips = backtestResults.reduce((sum, r) => sum + r.pips, 0)
  const avgPips = totalSignals > 0 ? (totalPips / totalSignals).toFixed(0) : '0'
  const filteredMessages = filterType === 'ALL' ? messages : messages.filter((m) => m.type === filterType)
  const promoMessages = messages.filter((m) => m.type === 'PROMO')
  const signalMessages = messages.filter((m) => m.type === 'SIGNAL')
  const updateMessages = messages.filter((m) => m.type === 'UPDATE')

  const timeGaps: { from: Date; to: Date; gapMinutes: number; suspicious: boolean }[] = []
  for (let i = 1; i < messages.length; i++) {
    const gap = (messages[i].timestamp.getTime() - messages[i - 1].timestamp.getTime()) / 60000
    if (gap > 60) timeGaps.push({ from: messages[i-1].timestamp, to: messages[i].timestamp, gapMinutes: Math.round(gap), suspicious: gap > 360 })
  }

  const backtestChartData = backtestResults.map((r, i) => ({ name: `S$` + `{i+1}`, pips: r.pips, fill: r.result === 'WIN' ? '#22c55e' : r.result === 'LOSS' ? '#ef4444' : '#eab308' }))
  const pieData = [{ name: 'Wins', value: wins, color: '#22c55e' }, { name: 'Losses', value: losses, color: '#ef4444' }, { name: 'Partial', value: totalSignals - wins - losses, color: '#eab308' }].filter((d) => d.value > 0)
  const cumulativePipsData = backtestResults.reduce((acc: { name: string; cumPips: number }[], r, i) => { const prev = acc.length > 0 ? acc[acc.length-1].cumPips : 0; acc.push({ name: `S$` + `{i+1}`, cumPips: prev + r.pips }); return acc }, [])
  const tpHitRateData = signals.reduce((acc: { tp: string; hits: number; total: number }[], sig) => {
    sig.takeProfits.forEach((_, i) => { const ex = acc.find((a) => a.tp === `TP$` + `{i+1}`); if (ex) { ex.total++; if (sig.tpHits.includes(i+1)) ex.hits++ } else acc.push({ tp: `TP$` + `{i+1}`, hits: sig.tpHits.includes(i+1) ? 1 : 0, total: 1 }) })
    return acc
  }, []).map((d) => ({ ...d, rate: d.total > 0 ? Math.round((d.hits / d.total) * 100) : 0 }))

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-3">
        <div className="flex items-center justify-between max-w-screen-2xl mx-auto">
          <div className="flex items-center gap-3">
            <div className="bg-yellow-500 rounded-lg p-2"><TrendingUp size={20} className="text-gray-900" /></div>
            <div><h1 className="text-lg font-bold text-white">Gold Signal Tracker</h1><p className="text-xs text-gray-400">XAUUSD Signal Analysis &amp; Backtesting</p></div>
          </div>
          <div className="flex items-center gap-4">
            {telegram.authStep === 'connected' && (<div className="flex items-center gap-2 text-green-400 text-sm"><span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" /></span>{telegram.userName}</div>)}
            {isPolling && (<div className="flex items-center gap-2 text-blue-400 text-sm"><Loader2 size={14} className="animate-spin" />Polling</div>)}
            {lastPollTime && (<span className="text-xs text-gray-500">Last: {lastPollTime.toLocaleTimeString()}</span>)}
          </div>
        </div>
      </header>
      <div className="bg-gray-900/50 border-b border-gray-800 px-4 py-2">
        <div className="max-w-screen-2xl mx-auto flex items-center gap-6 overflow-x-auto">
          <div className="flex items-center gap-2 min-w-fit"><Activity size={14} className="text-yellow-400" /><span className="text-xs text-gray-400">Signals</span><span className="text-sm font-bold text-white">{totalSignals}</span></div>
          <div className="flex items-center gap-2 min-w-fit"><CheckCircle2 size={14} className="text-green-400" /><span className="text-xs text-gray-400">Wins</span><span className="text-sm font-bold text-green-400">{wins}</span></div>
          <div className="flex items-center gap-2 min-w-fit"><XCircle size={14} className="text-red-400" /><span className="text-xs text-gray-400">Losses</span><span className="text-sm font-bold text-red-400">{losses}</span></div>
          <div className="flex items-center gap-2 min-w-fit"><TrendingUp size={14} className="text-blue-400" /><span className="text-xs text-gray-400">Win Rate</span><span className="text-sm font-bold text-blue-400">{winRate}%</span></div>
          <div className="flex items-center gap-2 min-w-fit"><BarChart3 size={14} className="text-purple-400" /><span className="text-xs text-gray-400">Avg Pips</span><span className="text-sm font-bold text-purple-400">{avgPips}</span></div>
          <div className="flex items-center gap-2 min-w-fit"><Zap size={14} className="text-yellow-400" /><span className="text-xs text-gray-400">Total Pips</span><span className="text-sm font-bold text-yellow-400">{totalPips}</span></div>
        </div>
      </div>
      <div className="bg-gray-900/30 border-b border-gray-800 px-4">
        <div className="max-w-screen-2xl mx-auto flex gap-1">
          {TABS.map((tab) => (<button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors $` + `{activeTab === tab.id ? 'border-yellow-500 text-yellow-400' : 'border-transparent text-gray-400 hover:text-white'}`}>{tab.icon}{tab.label}</button>))}
        </div>
      </div>
      <main className="max-w-screen-2xl mx-auto p-4">
        {activeTab === 'signals' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h2 className="text-lg font-bold flex items-center gap-2"><Activity size={18} className="text-yellow-400" />Signal Feed</h2>
              <div className="flex items-center gap-2">
                {telegram.authStep === 'connected' && (<><button onClick={fetchTelegramMessages} className="flex items-center gap-2 px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 text-sm"><RefreshCw size={14} /> Fetch</button><button onClick={togglePolling} className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm $` + `{isPolling ? 'bg-red-500 text-white' : 'bg-green-600 text-white'}`}>{isPolling ? <><XCircle size={14} /> Stop</> : <><Activity size={14} /> Poll</>}</button></>)}
                <button onClick={() => setShowChart((v) => !v)} className="flex items-center gap-2 px-3 py-1.5 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 text-sm"><Eye size={14} />{showChart ? 'Hide Chart' : 'Show Chart'}</button>
              </div>
            </div>
            {showChart && (<div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden"><div className="p-3 border-b border-gray-700 flex items-center justify-between"><h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2"><BarChart3 size={14} className="text-yellow-400" />Signal Chart - TP &amp; SL Levels</h3>{selectedSignal && (<span className="text-xs text-gray-400">{selectedSignal.direction} {selectedSignal.entryLow}-{selectedSignal.entryHigh} | Click a signal card</span>)}</div><SignalPriceChart signal={selectedSignal} /></div>)}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {signals.slice().reverse().map((s) => (<SignalCard key={s.id} signal={s} isSelected={selectedSignal?.id === s.id} onSelect={() => setSelectedSignal(s)} />))}
            </div>
            {signals.length === 0 && (<div className="text-center py-12 text-gray-500"><MessageSquare size={48} className="mx-auto mb-4 opacity-50" /><p>No signals. Connect Telegram in Settings or paste messages.</p></div>)}
          </div>
        )}
        {activeTab === 'backtest' && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold flex items-center gap-2"><BarChart3 size={18} className="text-yellow-400" />Backtest Analysis</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-gray-800 border border-gray-700 rounded-lg p-4"><div className="text-xs text-gray-500 mb-1">Total Signals</div><div className="text-2xl font-bold">{totalSignals}</div></div>
              <div className="bg-gray-800 border border-green-500/30 rounded-lg p-4"><div className="text-xs text-gray-500 mb-1">Win Rate</div><div className="text-2xl font-bold text-green-400">{winRate}%</div></div>
              <div className="bg-gray-800 border border-blue-500/30 rounded-lg p-4"><div className="text-xs text-gray-500 mb-1">Total Pips</div><div className="text-2xl font-bold text-blue-400">{totalPips > 0 ? '+' : ''}{totalPips}</div></div>
              <div className="bg-gray-800 border border-purple-500/30 rounded-lg p-4"><div className="text-xs text-gray-500 mb-1">Avg Pips</div><div className="text-2xl font-bold text-purple-400">{avgPips}</div></div>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-gray-800 border border-gray-700 rounded-lg p-4"><h3 className="text-sm font-semibold text-gray-300 mb-4">Pips Per Signal</h3><ResponsiveContainer width="100%" height={250}><BarChart data={backtestChartData}><CartesianGrid strokeDasharray="3 3" stroke="#374151" /><XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 11 }} /><YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} /><Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }} /><Bar dataKey="pips" radius={[4,4,0,0]}>{backtestChartData.map((e, i) => (<Cell key={i} fill={e.fill} />))}</Bar></BarChart></ResponsiveContainer></div>
              <div className="bg-gray-800 border border-gray-700 rounded-lg p-4"><h3 className="text-sm font-semibold text-gray-300 mb-4">Win/Loss</h3><ResponsiveContainer width="100%" height={250}><PieChart><Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={5} dataKey="value" label={({ name, value }) => `${name}: $` + `{value}`}>{pieData.map((e, i) => (<Cell key={i} fill={e.color} />))}</Pie><Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }} /></PieChart></ResponsiveContainer></div>
            </div>
            <div className="bg-gray-800 border border-gray-700 rounded-lg p-4"><h3 className="text-sm font-semibold text-gray-300 mb-4">Cumulative Pips</h3><ResponsiveContainer width="100%" height={250}><LineChart data={cumulativePipsData}><CartesianGrid strokeDasharray="3 3" stroke="#374151" /><XAxis dataKey="name" tick={{ fill: '#9ca3af', fontSize: 11 }} /><YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} /><Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }} /><Line type="monotone" dataKey="cumPips" stroke="#eab308" strokeWidth={2} dot={{ fill: '#eab308', r: 4 }} /></LineChart></ResponsiveContainer></div>
            <div className="bg-gray-800 border border-gray-700 rounded-lg p-4"><h3 className="text-sm font-semibold text-gray-300 mb-4">TP Hit Rate</h3><ResponsiveContainer width="100%" height={200}><BarChart data={tpHitRateData}><CartesianGrid strokeDasharray="3 3" stroke="#374151" /><XAxis dataKey="tp" tick={{ fill: '#9ca3af', fontSize: 11 }} /><YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} domain={[0, 100]} unit="%" /><Tooltip contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }} formatter={(value: number) => [`${value}%`, 'Hit Rate']} /><Bar dataKey="rate" fill="#22c55e" radius={[4,4,0,0]} /></BarChart></ResponsiveContainer></div>
            <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden"><h3 className="text-sm font-semibold text-gray-300 p-4 border-b border-gray-700">Signal Breakdown</h3><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-gray-900"><tr><th className="px-4 py-2 text-left text-gray-400">Date</th><th className="px-4 py-2 text-left text-gray-400">Dir</th><th className="px-4 py-2 text-left text-gray-400">Entry</th><th className="px-4 py-2 text-left text-gray-400">SL</th><th className="px-4 py-2 text-left text-gray-400">TPs</th><th className="px-4 py-2 text-left text-gray-400">Pips</th><th className="px-4 py-2 text-left text-gray-400">Result</th><th className="px-4 py-2 text-left text-gray-400">Dur</th></tr></thead><tbody>{backtestResults.map((r, i) => (<tr key={i} className="border-t border-gray-700 hover:bg-gray-700/50"><td className="px-4 py-2 text-gray-300 font-mono text-xs">{r.signal.timestamp.toLocaleDateString()}</td><td className="px-4 py-2"><span className={r.signal.direction === 'BUY' ? 'text-green-400' : 'text-red-400'}>{r.signal.direction}</span></td><td className="px-4 py-2 text-gray-300 font-mono text-xs">{r.entryPrice}</td><td className="px-4 py-2 text-red-400 font-mono text-xs">{r.signal.stopLoss}</td><td className="px-4 py-2 text-green-400">{r.tpHitsCount}/{r.signal.takeProfits.length}</td><td className={`px-4 py-2 font-mono font-bold $` + `{r.pips >= 0 ? 'text-green-400' : 'text-red-400'}`}>{r.pips > 0 ? '+' : ''}{r.pips}</td><td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs font-semibold $` + `{r.result === 'WIN' ? 'bg-green-500/20 text-green-400' : r.result === 'LOSS' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'}`}>{r.result}</span></td><td className="px-4 py-2 text-gray-400 text-xs">{r.duration}m</td></tr>))}</tbody></table></div></div>
          </div>
        )}
        {activeTab === 'history' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <h2 className="text-lg font-bold flex items-center gap-2"><MessageSquare size={18} className="text-yellow-400" />Message History</h2>
              <div className="flex gap-2 flex-wrap">{['ALL','SIGNAL','UPDATE','PROMO','GREETING'].map((t) => (<button key={t} onClick={() => setFilterType(t)} className={`px-3 py-1 rounded text-xs font-medium $` + `{filterType === t ? 'bg-yellow-500 text-gray-900' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>{t}</button>))}</div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-gray-800 border border-gray-700 rounded-lg p-4"><div className="text-xs text-gray-500 mb-1">Total</div><div className="text-2xl font-bold">{messages.length}</div></div>
              <div className="bg-gray-800 border border-blue-500/30 rounded-lg p-4"><div className="text-xs text-gray-500 mb-1">Signals</div><div className="text-2xl font-bold text-blue-400">{signalMessages.length}</div></div>
              <div className="bg-gray-800 border border-orange-500/30 rounded-lg p-4"><div className="text-xs text-gray-500 mb-1">Promos</div><div className="text-2xl font-bold text-orange-400">{promoMessages.length}</div></div>
              <div className="bg-gray-800 border border-gray-700 rounded-lg p-4"><div className="text-xs text-gray-500 mb-1">Updates</div><div className="text-2xl font-bold text-gray-300">{updateMessages.length}</div></div>
            </div>
            <div className="bg-red-950/30 border border-red-500/30 rounded-lg p-4">
              <h3 className="text-sm font-bold text-red-400 mb-3 flex items-center gap-2"><AlertTriangle size={16} />Red Flags</h3>
              <ul className="space-y-2 text-sm">
                {promoMessages.length > 0 && (<li className="flex items-start gap-2 text-red-300"><AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /><span><strong>{promoMessages.length} promo messages</strong> asking for MT4/MT5 credentials.</span></li>)}
                {timeGaps.filter((g) => g.suspicious).length > 0 && (<li className="flex items-start gap-2 text-red-300"><AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /><span><strong>{timeGaps.filter((g) => g.suspicious).length} suspicious gaps</strong> &gt;6 hours.</span></li>)}
                <li className="flex items-start gap-2 text-red-300"><AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /><span>NEVER share trading account credentials.</span></li>
              </ul>
            </div>
            {timeGaps.length > 0 && (<div className="bg-gray-800 border border-gray-700 rounded-lg p-4"><h3 className="text-sm font-bold text-gray-300 mb-3 flex items-center gap-2"><Clock size={16} />Message Gaps</h3><div className="space-y-2">{timeGaps.map((g, i) => (<div key={i} className={`flex items-center gap-3 p-2 rounded text-sm flex-wrap $` + `{g.suspicious ? 'bg-red-950/30 border border-red-500/20' : 'bg-gray-700/50'}`}>{g.suspicious ? <Trash2 size={14} className="text-red-400" /> : <Clock size={14} className="text-gray-400" />}<span className="text-gray-400 text-xs">{g.from.toLocaleString()} &rarr; {g.to.toLocaleString()}</span><span className={`font-mono text-xs $` + `{g.suspicious ? 'text-red-400' : 'text-gray-500'}`}>{g.gapMinutes > 1440 ? `${Math.round(g.gapMinutes/60)}h` : `${g.gapMinutes}m`} gap</span>{g.suspicious && <span className="text-xs text-red-400 font-semibold">SUSPICIOUS</span>}</div>))}</div></div>)}
            <div className="bg-gray-800 border border-gray-700 rounded-lg"><div className="p-3 border-b border-gray-700"><span className="text-sm text-gray-400">{filteredMessages.length} messages</span></div><div className="max-h-screen overflow-y-auto divide-y divide-gray-700/50">{filteredMessages.map((msg) => { const tc: Record<string, string> = { SIGNAL: 'border-l-blue-500 bg-blue-950/10', UPDATE: 'border-l-green-500 bg-green-950/10', PROMO: 'border-l-red-500 bg-red-950/10', GREETING: 'border-l-gray-500', UNKNOWN: 'border-l-gray-700' }; return (<div key={msg.id} className={`p-3 border-l-2 $` + `{tc[msg.type]} hover:bg-gray-700/30`}><div className="flex items-center gap-2 mb-1"><span className="text-xs text-gray-500 font-mono">{msg.timestamp.toLocaleString()}</span><span className={`px-1.5 py-0.5 rounded text-xs $` + `{msg.type === 'SIGNAL' ? 'bg-blue-500/20 text-blue-400' : msg.type === 'UPDATE' ? 'bg-green-500/20 text-green-400' : msg.type === 'PROMO' ? 'bg-red-500/20 text-red-400' : 'bg-gray-500/20 text-gray-400'}`}>{msg.type}</span>{msg.deleted && <span className="text-xs text-red-400"><Trash2 size={10} className="inline" /> DEL</span>}{msg.edited && <span className="text-xs text-orange-400">EDIT</span>}</div><p className="text-sm text-gray-300 whitespace-pre-wrap">{msg.text}</p></div>) })}</div></div>
          </div>
        )}
        {activeTab === 'settings' && (
          <div className="max-w-2xl space-y-6">
            <h2 className="text-lg font-bold flex items-center gap-2"><Settings size={18} className="text-yellow-400" />Configuration</h2>
            <TelegramAuthPanel authStep={telegram.authStep} isLoading={telegram.isLoading} authError={telegram.authError} userName={telegram.userName} onStartAuth={telegram.startAuth} onSubmitCode={telegram.submitCode} onSubmitPassword={telegram.submitPassword} onDisconnect={telegram.disconnect} />
            <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
              <h3 className="text-sm font-bold text-gray-200 mb-4 flex items-center gap-2"><Send size={16} className="text-blue-400" />Channel Config</h3>
              <div className="space-y-3">
                <div><label className="block text-xs text-gray-400 mb-1">Channel ID</label><input type="text" value={telegramChannelId} onChange={(e) => setTelegramChannelId(e.target.value)} placeholder="-1001234567890" className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none" /></div>
                {telegram.authStep === 'connected' && (<div className="flex gap-2"><button onClick={fetchTelegramMessages} className="flex items-center gap-2 px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 text-sm"><RefreshCw size={14} /> Fetch</button><button onClick={togglePolling} className={`flex items-center gap-2 px-4 py-2 rounded text-sm $` + `{isPolling ? 'bg-red-500 text-white' : 'bg-green-500 text-white'}`}>{isPolling ? <><XCircle size={14} /> Stop</> : <><RefreshCw size={14} /> Poll</>}</button></div>)}
              </div>
            </div>
            <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
              <h3 className="text-sm font-bold text-gray-200 mb-4 flex items-center gap-2"><MessageSquare size={16} className="text-green-400" />Paste Messages</h3>
              <textarea value={rawMessages} onChange={(e) => setRawMessages(e.target.value)} rows={12} className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-gray-300 font-mono placeholder-gray-500 focus:border-yellow-500 focus:outline-none resize-y" placeholder="Paste Telegram messages..." />
              <div className="mt-2 text-xs text-gray-500">{messages.length} messages | {signals.length} signals</div>
            </div>
            <div className="bg-yellow-950/30 border border-yellow-500/30 rounded-lg p-4">
              <h3 className="text-sm font-bold text-yellow-400 mb-2 flex items-center gap-2"><AlertTriangle size={16} />How to Use</h3>
              <ul className="text-xs text-yellow-200/70 space-y-1">
                <li>1. Connect Telegram via MTProto in Settings</li>
                <li>2. Or paste messages manually</li>
                <li>3. View Signals tab with interactive TP/SL chart</li>
                <li>4. Click signal cards to view on chart</li>
                <li>5. Check Backtest for accuracy analysis</li>
                <li>6. Review History for red flags</li>
              </ul>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
