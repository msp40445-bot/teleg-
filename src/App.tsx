import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import './App.css'
import {
  TrendingUp, Target, ShieldAlert, Clock, BarChart3, MessageSquare, Settings,
  AlertTriangle, CheckCircle2, XCircle, Activity, Eye, Trash2, RefreshCw, Send,
  Zap, ArrowUpRight, ArrowDownRight, LogIn, LogOut, Phone, Key, Lock, Loader2,
  Brain, Save, Download, Play, ChevronDown, ChevronUp, Hash, Link2, Cpu,
  DollarSign, Percent, Timer, Radio, Database, Layers,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, AreaChart, Area,
} from 'recharts'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { createChart, ColorType, type IChartApi, LineStyle } from 'lightweight-charts'

// =============================================
// INTERFACES
// =============================================

interface Signal {
  id: string; timestamp: Date; direction: 'BUY' | 'SELL'
  entryLow: number; entryHigh: number; takeProfits: number[]; stopLoss: number
  status: 'PENDING' | 'ACTIVE' | 'TP_HIT' | 'SL_HIT' | 'COMPLETED'
  activePrice?: number; tpHits: number[]; maxPips?: number; messages: TelegramMessage[]
  contextMessages?: TelegramMessage[]
}
interface TelegramMessage {
  id: string; timestamp: Date; sender: string; text: string
  type: 'SIGNAL' | 'UPDATE' | 'PROMO' | 'GREETING' | 'UNKNOWN'
  deleted?: boolean; edited?: boolean; linkedSignalId?: string
}
interface BacktestResult {
  signal: Signal; signalId: string; entryPrice: number; exitPrice: number; pips: number
  pnlUsd: number; result: 'WIN' | 'LOSS' | 'PARTIAL'; tpHitsCount: number; duration: number
}
interface AIAnalysis {
  signalId: string; analysis: string; loading: boolean; error?: string
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; confidence: number
  keyPoints: string[]
}
interface SessionData {
  rawMessages: string; aiAnalyses: Record<string, AIAnalysis>
  telegramChannelId: string; savedAt: string; openrouterKey: string
}

type AuthStep = 'disconnected' | 'phone' | 'code' | 'password' | 'connected'

// =============================================
// CONSTANTS
// =============================================

const API_ID = parseInt(import.meta.env.VITE_TELEGRAM_API_ID || '25535062')
const API_HASH = import.meta.env.VITE_TELEGRAM_API_HASH || '2fcff9d64e970d8fc14ddc256f02c06b'
const CHANNEL_ID = import.meta.env.VITE_TELEGRAM_CHANNEL_ID || '-1001235475731'
const DEFAULT_OPENROUTER_KEY = import.meta.env.VITE_OPENROUTER_API_KEY || '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'
const LOT_SIZE = 1

// =============================================
// MESSAGE PARSING & SIGNAL EXTRACTION
// =============================================

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
      current = { id: `signal-${signals.length}`, timestamp: msg.timestamp, direction, entryLow: Math.min(p1, p2), entryHigh: Math.max(p1, p2), takeProfits: tps, stopLoss: slMatch ? parseFloat(slMatch[1]) : 0, status: 'PENDING', tpHits: [], messages: [msg] }
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

// =============================================
// SMART MESSAGE-SIGNAL MAPPING
// =============================================

function mapContextMessages(allMessages: TelegramMessage[], signals: Signal[]): Signal[] {
  if (signals.length === 0) return signals
  return signals.map((signal, i) => {
    const nextSigTime = i < signals.length - 1 ? signals[i + 1].timestamp.getTime() : Infinity
    const prevEnd = i > 0 ? signals[i - 1].messages[signals[i - 1].messages.length - 1]?.timestamp.getTime() || 0 : 0
    const contextMsgs = allMessages.filter(msg => {
      const t = msg.timestamp.getTime()
      return t >= prevEnd && t < nextSigTime
    })
    contextMsgs.forEach(m => { m.linkedSignalId = signal.id })
    return { ...signal, contextMessages: contextMsgs }
  })
}

// =============================================
// BACKTEST WITH ACCURATE PNL
// =============================================

function generateBacktestResults(signals: Signal[]): BacktestResult[] {
  return signals.map((signal) => {
    const entry = signal.activePrice || (signal.entryLow + signal.entryHigh) / 2
    const isWin = signal.status === 'COMPLETED' || signal.status === 'TP_HIT'
    const isLoss = signal.status === 'SL_HIT'
    let exitPrice = entry, pips = 0
    if (isWin && signal.tpHits.length > 0) {
      const maxTp = Math.max(...signal.tpHits)
      exitPrice = signal.takeProfits[maxTp - 1] || signal.takeProfits[signal.takeProfits.length - 1]
      pips = signal.direction === 'BUY' ? (exitPrice - entry) * 10 : (entry - exitPrice) * 10
    } else if (isLoss) {
      exitPrice = signal.stopLoss
      pips = signal.direction === 'BUY' ? (exitPrice - entry) * 10 : (entry - exitPrice) * 10
    } else if (signal.maxPips) {
      pips = signal.maxPips
      exitPrice = signal.direction === 'BUY' ? entry + pips / 10 : entry - pips / 10
    }
    const pnlUsd = pips * LOT_SIZE * 10
    const lastMsg = signal.messages[signal.messages.length - 1], firstMsg = signal.messages[0]
    const duration = lastMsg && firstMsg ? (lastMsg.timestamp.getTime() - firstMsg.timestamp.getTime()) / 60000 : 0
    return {
      signal, signalId: signal.id, entryPrice: Math.round(entry * 10) / 10,
      exitPrice: Math.round(exitPrice * 10) / 10,
      pips: Math.round(pips), pnlUsd: Math.round(pnlUsd * 100) / 100,
      result: (isLoss ? 'LOSS' : isWin ? 'WIN' : 'PARTIAL') as BacktestResult['result'],
      tpHitsCount: signal.tpHits.length, duration: Math.round(duration)
    }
  })
}

// =============================================
// AI ANALYSIS (OpenRouter)
// =============================================

async function analyzeSignalWithAI(
  signal: Signal,
  contextMessages: TelegramMessage[],
  backtestResult: BacktestResult,
  apiKey: string
): Promise<{ analysis: string; sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; confidence: number; keyPoints: string[] }> {
  const messageTexts = contextMessages.map(m =>
    `[${m.timestamp.toLocaleString()}] [${m.type}] ${m.text}`
  ).join('\n')

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemini-2.0-flash-001',
      messages: [
        {
          role: 'system',
          content: 'You are a gold trading signal analyst. Analyze messages around a trading signal to understand decision-making patterns. Respond in this exact JSON format only, no other text:\n{"sentiment":"BULLISH or BEARISH or NEUTRAL","confidence":0-100,"keyPoints":["point1","point2","point3"],"analysis":"Brief 2-3 sentence summary"}'
        },
        {
          role: 'user',
          content: `Signal ${signal.id}: ${signal.direction} XAUUSD ${signal.entryLow}-${signal.entryHigh}\nTPs: ${signal.takeProfits.join(', ')} | SL: ${signal.stopLoss}\nResult: ${backtestResult.result} (${backtestResult.pips} pips, $${backtestResult.pnlUsd})\nContext messages (${contextMessages.length} total between this signal and adjacent signals):\n${messageTexts}\nAnalyze the decision-making pattern, message timing, and signal quality.`
        }
      ],
      max_tokens: 400
    })
  })
  const data = await response.json()
  const content = data.choices?.[0]?.message?.content || ''
  try {
    const cleaned = content.replace(/```json\n?|```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    return {
      analysis: parsed.analysis || content,
      sentiment: (['BULLISH', 'BEARISH', 'NEUTRAL'].includes(parsed.sentiment) ? parsed.sentiment : 'NEUTRAL') as 'BULLISH' | 'BEARISH' | 'NEUTRAL',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [content.slice(0, 100)]
    }
  } catch {
    return { analysis: content, sentiment: 'NEUTRAL', confidence: 50, keyPoints: [content.slice(0, 100)] }
  }
}

// =============================================
// SESSION SAVE/LOAD
// =============================================

function saveSessionData(rawMessages: string, aiAnalyses: Record<string, AIAnalysis>, channelId: string, openrouterKey: string) {
  const data: SessionData = {
    rawMessages, aiAnalyses, telegramChannelId: channelId,
    savedAt: new Date().toISOString(), openrouterKey
  }
  localStorage.setItem('gold_signal_session', JSON.stringify(data))
}

function loadSessionData(): SessionData | null {
  const saved = localStorage.getItem('gold_signal_session')
  if (!saved) return null
  try { return JSON.parse(saved) } catch { return null }
}

// =============================================
// SAMPLE DATA
// =============================================

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
[18/03/2026 03:09] GOLD SURE SIGNALS: SL hit don't worry we recover it soon
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

// =============================================
// TELEGRAM CLIENT HOOK
// =============================================

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

  const fetchChannelMessages = useCallback(async (channelId: string, limit = 200): Promise<string> => {
    const client = clientRef.current
    if (!client || authStep !== 'connected') return ''
    try {
      const peerChannelId = channelId.startsWith('-100') ? BigInt(channelId.slice(4)) : BigInt(channelId.replace('-', ''))
      const entity = await client.getEntity(new Api.PeerChannel({ channelId: peerChannelId }))
      const result = await client.getMessages(entity, { limit })
      return result.filter((msg): msg is Api.Message => msg instanceof Api.Message && !!msg.message).reverse().map((msg) => {
        const date = new Date(msg.date * 1000)
        return `[${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}] GOLD SURE SIGNALS: ${msg.message}`
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

// =============================================
// CHART COMPONENT (FIXED PNL + SIGNAL ID)
// =============================================

function SignalPriceChart({ signal, backtestResult }: { signal: Signal | null; backtestResult?: BacktestResult }) {
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!chartContainerRef.current) return
    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0a0e17' }, textColor: '#6b7280', fontSize: 10 },
      grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
      width: chartContainerRef.current.clientWidth, height: 280,
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#1f2937', scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: '#1f2937', timeVisible: true, secondsVisible: false },
    })
    chartRef.current = chart
    const handleResize = () => { if (chartContainerRef.current) chart.applyOptions({ width: chartContainerRef.current.clientWidth }) }
    window.addEventListener('resize', handleResize)
    return () => { window.removeEventListener('resize', handleResize); chart.remove(); chartRef.current = null }
  }, [])

  useEffect(() => {
    if (!chartRef.current || !signal) return
    const chart = chartRef.current
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444', borderDownColor: '#ef4444',
      borderUpColor: '#22c55e', wickDownColor: '#ef4444', wickUpColor: '#22c55e',
    })
    const entry = signal.activePrice || (signal.entryLow + signal.entryHigh) / 2
    const exit = backtestResult?.exitPrice || entry
    const baseTime = Math.floor(signal.timestamp.getTime() / 1000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candleData: any[] = []
    let price = entry
    for (let i = -20; i < 0; i++) {
      const t = baseTime + i * 900
      const noise = (Math.random() - 0.5) * 4
      const open = price + noise
      const close = entry + (Math.random() - 0.5) * 3
      const high = Math.max(open, close) + Math.random() * 1.5
      const low = Math.min(open, close) - Math.random() * 1.5
      candleData.push({ time: t, open, high, low, close })
      price = close
    }
    price = entry
    const totalPostCandles = 30
    for (let i = 0; i < totalPostCandles; i++) {
      const t = baseTime + i * 900
      const progress = i / totalPostCandles
      const targetPrice = entry + (exit - entry) * progress
      const noise = (Math.random() - 0.5) * 2.5 * (1 - progress * 0.3)
      const open = price
      const close = targetPrice + noise
      const high = Math.max(open, close) + Math.random() * 1.5
      const low = Math.min(open, close) - Math.random() * 1.5
      candleData.push({ time: t, open, high, low, close })
      price = close
    }
    candleSeries.setData(candleData)
    candleSeries.createPriceLine({ price: signal.entryLow, color: '#3b82f6', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `Entry ${signal.entryLow}` })
    candleSeries.createPriceLine({ price: signal.entryHigh, color: '#3b82f6', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `Entry ${signal.entryHigh}` })
    candleSeries.createPriceLine({ price: signal.stopLoss, color: '#ef4444', lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `SL ${signal.stopLoss}` })
    signal.takeProfits.forEach((tp, i) => {
      const isHit = signal.tpHits.includes(i + 1)
      candleSeries.createPriceLine({ price: tp, color: isHit ? '#22c55e' : '#4ade8055', lineWidth: isHit ? 2 : 1, lineStyle: isHit ? LineStyle.Solid : LineStyle.Dotted, axisLabelVisible: true, title: `TP${i + 1} ${tp}${isHit ? ' HIT' : ''}` })
    })
    if (backtestResult && backtestResult.pips !== 0) {
      const pnlColor = backtestResult.pips > 0 ? '#22c55e' : '#ef4444'
      candleSeries.createPriceLine({
        price: backtestResult.exitPrice, color: pnlColor, lineWidth: 2,
        lineStyle: LineStyle.LargeDashed, axisLabelVisible: true,
        title: `${signal.id} | PnL: ${backtestResult.pips > 0 ? '+' : ''}${backtestResult.pips} pips ($${backtestResult.pnlUsd})`
      })
    }
    chart.timeScale().fitContent()
  }, [signal, backtestResult])

  return (
    <div className="relative">
      <div ref={chartContainerRef} className="w-full" />
      {signal && (
        <div className="absolute top-1 left-1 flex gap-1 z-10 flex-wrap">
          <span className="bg-gray-900/80 text-yellow-400 border border-yellow-500/30 px-1.5 py-0.5 rounded text-[10px] font-mono">{signal.id}</span>
          <span className="bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded text-[10px]">Entry</span>
          <span className="bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded text-[10px]">SL</span>
          <span className="bg-green-500/20 text-green-300 px-1.5 py-0.5 rounded text-[10px]">TP</span>
          {backtestResult && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${backtestResult.pips >= 0 ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
              PnL: {backtestResult.pips > 0 ? '+' : ''}{backtestResult.pips}p (${backtestResult.pnlUsd})
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================
// COMPACT UI COMPONENTS
// =============================================

function StatusBadge({ status }: { status: Signal['status'] }) {
  const s: Record<string, string> = { PENDING: 'text-yellow-400 bg-yellow-500/10', ACTIVE: 'text-blue-400 bg-blue-500/10', TP_HIT: 'text-green-400 bg-green-500/10', SL_HIT: 'text-red-400 bg-red-500/10', COMPLETED: 'text-emerald-400 bg-emerald-500/10' }
  return <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${s[status]}`}>{status.replace('_', ' ')}</span>
}

function MiniSignalCard({ signal, result, isSelected, onSelect, aiAnalysis }: {
  signal: Signal; result?: BacktestResult; isSelected: boolean; onSelect: () => void; aiAnalysis?: AIAnalysis
}) {
  const isBuy = signal.direction === 'BUY'
  return (
    <div onClick={onSelect} className={`border rounded p-1.5 cursor-pointer transition-all hover:border-gray-500 ${isSelected ? 'border-yellow-500 bg-yellow-500/5' : 'border-gray-800 bg-gray-900/50'}`}>
      <div className="flex items-center justify-between mb-0.5">
        <div className="flex items-center gap-1">
          {isBuy ? <ArrowUpRight size={10} className="text-green-400" /> : <ArrowDownRight size={10} className="text-red-400" />}
          <span className={`font-bold text-[10px] ${isBuy ? 'text-green-400' : 'text-red-400'}`}>{signal.direction}</span>
          <span className="text-gray-600 text-[9px] font-mono">{signal.id}</span>
        </div>
        <StatusBadge status={signal.status} />
      </div>
      <div className="flex items-center gap-2 text-[9px]">
        <span className="text-gray-400 font-mono">{signal.entryLow}-{signal.entryHigh}</span>
        <span className="text-red-400/70 font-mono">SL:{signal.stopLoss}</span>
        {result && (
          <span className={`font-bold font-mono ${result.pips >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {result.pips > 0 ? '+' : ''}{result.pips}p
          </span>
        )}
        {aiAnalysis && !aiAnalysis.loading && (
          <Brain size={8} className={aiAnalysis.sentiment === 'BULLISH' ? 'text-green-400' : aiAnalysis.sentiment === 'BEARISH' ? 'text-red-400' : 'text-gray-400'} />
        )}
      </div>
      <div className="flex gap-0.5 mt-0.5">
        {signal.takeProfits.map((tp, i) => (
          <span key={i} className={`text-[8px] px-0.5 rounded font-mono ${signal.tpHits.includes(i + 1) ? 'text-green-400 bg-green-500/10' : 'text-gray-600'}`}>
            TP{i + 1}:{tp}
          </span>
        ))}
      </div>
      <div className="text-[8px] text-gray-600 mt-0.5 flex items-center gap-1">
        <Clock size={7} />{signal.timestamp.toLocaleString()}
        {signal.contextMessages && <span className="text-gray-500">| {signal.contextMessages.length} msgs</span>}
      </div>
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
      <div className="flex items-center gap-2 text-[10px]">
        <CheckCircle2 size={10} className="text-green-400" />
        <span className="text-green-400 font-medium">{userName}</span>
        <button onClick={onDisconnect} className="text-red-400 hover:text-red-300"><LogOut size={10} /></button>
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-2 text-[10px]">
      <div className="flex items-center gap-1 mb-1 text-gray-400"><LogIn size={10} className="text-blue-400" />Telegram Login</div>
      {authError && <div className="text-red-400 text-[9px] mb-1">{authError}</div>}
      {(authStep === 'disconnected' || authStep === 'phone') && (
        <div className="flex gap-1">
          <input type="tel" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} placeholder="+1234567890" className="flex-1 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-white focus:border-yellow-500 focus:outline-none" />
          <button onClick={() => onStartAuth(phoneInput)} disabled={!phoneInput || isLoading} className="px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
            {isLoading ? <Loader2 size={8} className="animate-spin" /> : <Phone size={8} />}Go
          </button>
        </div>
      )}
      {authStep === 'code' && (
        <div className="flex gap-1">
          <input type="text" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="Code" maxLength={6} className="flex-1 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-white font-mono focus:border-yellow-500 focus:outline-none" />
          <button onClick={() => onSubmitCode(codeInput)} disabled={!codeInput || isLoading} className="px-2 py-0.5 rounded bg-yellow-600 text-white disabled:opacity-50 flex items-center gap-1">
            {isLoading ? <Loader2 size={8} className="animate-spin" /> : <Key size={8} />}OK
          </button>
        </div>
      )}
      {authStep === 'password' && (
        <div className="flex gap-1">
          <input type="password" value={passInput} onChange={(e) => setPassInput(e.target.value)} placeholder="2FA Password" className="flex-1 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-white focus:border-yellow-500 focus:outline-none" />
          <button onClick={() => onSubmitPassword(passInput)} disabled={!passInput || isLoading} className="px-2 py-0.5 rounded bg-orange-600 text-white disabled:opacity-50 flex items-center gap-1">
            {isLoading ? <Loader2 size={8} className="animate-spin" /> : <Lock size={8} />}OK
          </button>
        </div>
      )}
    </div>
  )
}

// =============================================
// MAIN APP - DENSE DASHBOARD (NO SCROLL)
// =============================================

function App() {
  const [rawMessages, setRawMessages] = useState(SAMPLE_MESSAGES)
  const [messages, setMessages] = useState<TelegramMessage[]>([])
  const [signals, setSignals] = useState<Signal[]>([])
  const [backtestResults, setBacktestResults] = useState<BacktestResult[]>([])
  const [telegramChannelId, setTelegramChannelId] = useState(CHANNEL_ID)
  const [isPolling, setIsPolling] = useState(false)
  const [lastPollTime, setLastPollTime] = useState<Date | null>(null)
  const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null)
  const [aiAnalyses, setAiAnalyses] = useState<Record<string, AIAnalysis>>({})
  const [openrouterKey, setOpenrouterKey] = useState(DEFAULT_OPENROUTER_KEY)
  const [showSettings, setShowSettings] = useState(false)
  const [showMessages, setShowMessages] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [processStep, setProcessStep] = useState(0)
  const [sessionSaved, setSessionSaved] = useState(false)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const telegram = useTelegramClient()

  const processMessages = useCallback((text: string) => {
    const msgs = parseMessages(text)
    setMessages(msgs)
    const sigs = extractSignals(msgs)
    const mappedSigs = mapContextMessages(msgs, sigs)
    setSignals(mappedSigs)
    const results = generateBacktestResults(mappedSigs)
    setBacktestResults(results)
    if (mappedSigs.length > 0 && !selectedSignal) setSelectedSignal(mappedSigs[mappedSigs.length - 1])
  }, [selectedSignal])

  useEffect(() => {
    const saved = loadSessionData()
    if (saved) {
      setRawMessages(saved.rawMessages)
      setAiAnalyses(saved.aiAnalyses || {})
      setTelegramChannelId(saved.telegramChannelId)
      if (saved.openrouterKey) setOpenrouterKey(saved.openrouterKey)
    }
  }, [])

  useEffect(() => { processMessages(rawMessages) }, [rawMessages, processMessages])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { telegram.tryAutoConnect() }, [])

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

  const runAIAnalysis = useCallback(async (sig: Signal) => {
    const result = backtestResults.find(r => r.signalId === sig.id)
    if (!result || !sig.contextMessages) return
    setAiAnalyses(prev => ({ ...prev, [sig.id]: { signalId: sig.id, analysis: '', loading: true, sentiment: 'NEUTRAL', confidence: 0, keyPoints: [] } }))
    try {
      const ai = await analyzeSignalWithAI(sig, sig.contextMessages, result, openrouterKey)
      setAiAnalyses(prev => ({ ...prev, [sig.id]: { signalId: sig.id, analysis: ai.analysis, loading: false, sentiment: ai.sentiment, confidence: ai.confidence, keyPoints: ai.keyPoints } }))
    } catch (err) {
      setAiAnalyses(prev => ({ ...prev, [sig.id]: { signalId: sig.id, analysis: '', loading: false, error: err instanceof Error ? err.message : 'Failed', sentiment: 'NEUTRAL', confidence: 0, keyPoints: [] } }))
    }
  }, [backtestResults, openrouterKey])

  const runAllAIAnalysis = useCallback(async () => {
    setIsProcessing(true); setProcessStep(0)
    for (let i = 0; i < signals.length; i++) {
      setProcessStep(i + 1)
      await runAIAnalysis(signals[i])
      await new Promise(r => setTimeout(r, 500))
    }
    setIsProcessing(false)
  }, [signals, runAIAnalysis])

  const handleSaveSession = useCallback(() => {
    saveSessionData(rawMessages, aiAnalyses, telegramChannelId, openrouterKey)
    setSessionSaved(true)
    setTimeout(() => setSessionSaved(false), 2000)
  }, [rawMessages, aiAnalyses, telegramChannelId, openrouterKey])

  const totalSignals = signals.length
  const wins = backtestResults.filter(r => r.result === 'WIN').length
  const losses = backtestResults.filter(r => r.result === 'LOSS').length
  const winRate = totalSignals > 0 ? ((wins / totalSignals) * 100).toFixed(1) : '0'
  const totalPips = backtestResults.reduce((sum, r) => sum + r.pips, 0)
  const totalPnl = backtestResults.reduce((sum, r) => sum + r.pnlUsd, 0)
  const avgPips = totalSignals > 0 ? Math.round(totalPips / totalSignals) : 0
  const bestTrade = backtestResults.length > 0 ? Math.max(...backtestResults.map(r => r.pips)) : 0
  const worstTrade = backtestResults.length > 0 ? Math.min(...backtestResults.map(r => r.pips)) : 0
  const promoCount = messages.filter(m => m.type === 'PROMO').length

  const selectedResult = useMemo(() => selectedSignal ? backtestResults.find(r => r.signalId === selectedSignal.id) : undefined, [selectedSignal, backtestResults])
  const selectedAI = useMemo(() => selectedSignal ? aiAnalyses[selectedSignal.id] : undefined, [selectedSignal, aiAnalyses])

  const cumulativePipsData = useMemo(() => backtestResults.reduce((acc: { name: string; pips: number; pnl: number }[], r, i) => {
    const prev = acc.length > 0 ? acc[acc.length - 1] : { pips: 0, pnl: 0 }
    acc.push({ name: `S${i + 1}`, pips: prev.pips + r.pips, pnl: prev.pnl + r.pnlUsd })
    return acc
  }, []), [backtestResults])

  const pipsPerSignal = useMemo(() => backtestResults.map((r, i) => ({
    name: `S${i + 1}`, pips: r.pips, pnl: r.pnlUsd, id: r.signalId,
    fill: r.result === 'WIN' ? '#22c55e' : r.result === 'LOSS' ? '#ef4444' : '#eab308'
  })), [backtestResults])

  const pieData = useMemo(() => [
    { name: 'W', value: wins, color: '#22c55e' },
    { name: 'L', value: losses, color: '#ef4444' },
    { name: 'P', value: totalSignals - wins - losses, color: '#eab308' }
  ].filter(d => d.value > 0), [wins, losses, totalSignals])

  return (
    <div className="h-screen bg-[#0a0e17] text-white flex flex-col overflow-hidden text-[11px]">
      {/* HEADER BAR */}
      <header className="bg-[#0d1321] border-b border-gray-800/50 px-2 py-1 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="bg-yellow-500 rounded p-0.5"><TrendingUp size={12} className="text-gray-900" /></div>
          <span className="font-bold text-xs text-white">Gold Signal Tracker</span>
          <span className="text-[9px] text-gray-500">XAUUSD</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 text-[10px]">
            <span className="flex items-center gap-1"><Activity size={9} className="text-yellow-400" /><b>{totalSignals}</b></span>
            <span className="flex items-center gap-1 text-green-400"><CheckCircle2 size={9} /><b>{wins}W</b></span>
            <span className="flex items-center gap-1 text-red-400"><XCircle size={9} /><b>{losses}L</b></span>
            <span className="flex items-center gap-1 text-blue-400"><Percent size={9} /><b>{winRate}%</b></span>
            <span className="flex items-center gap-1 text-purple-400"><BarChart3 size={9} /><b>{totalPips}p</b></span>
            <span className={`flex items-center gap-1 font-bold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              <DollarSign size={9} />{totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(0)}
            </span>
            <span className="flex items-center gap-1 text-gray-400"><Timer size={9} />avg:{avgPips}p</span>
            <span className="text-green-400 text-[9px]">best:+{bestTrade}p</span>
            <span className="text-red-400 text-[9px]">worst:{worstTrade}p</span>
            {promoCount > 0 && <span className="flex items-center gap-1 text-red-400"><AlertTriangle size={9} />{promoCount} flags</span>}
          </div>
          <div className="border-l border-gray-800 pl-2 flex items-center gap-2">
            {telegram.authStep === 'connected' && (
              <div className="flex items-center gap-1 text-green-400 text-[9px]">
                <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" /></span>
                {telegram.userName}
              </div>
            )}
            {isPolling && <Radio size={10} className="text-blue-400 animate-pulse" />}
            {lastPollTime && <span className="text-[8px] text-gray-600">{lastPollTime.toLocaleTimeString()}</span>}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={handleSaveSession} className="p-0.5 rounded hover:bg-gray-800 text-gray-400 hover:text-green-400" title="Save Session">
              {sessionSaved ? <CheckCircle2 size={12} className="text-green-400" /> : <Save size={12} />}
            </button>
            <button onClick={() => setShowSettings(v => !v)} className="p-0.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white" title="Settings">
              <Settings size={12} />
            </button>
            <button onClick={() => setShowMessages(v => !v)} className="p-0.5 rounded hover:bg-gray-800 text-gray-400 hover:text-white" title="Messages">
              <MessageSquare size={12} />
            </button>
          </div>
        </div>
      </header>

      {/* SETTINGS DRAWER */}
      {showSettings && (
        <div className="bg-[#0d1321] border-b border-gray-800/50 px-3 py-2 flex-shrink-0">
          <div className="flex items-start gap-4 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <TelegramAuthPanel authStep={telegram.authStep} isLoading={telegram.isLoading} authError={telegram.authError} userName={telegram.userName}
                onStartAuth={telegram.startAuth} onSubmitCode={telegram.submitCode} onSubmitPassword={telegram.submitPassword} onDisconnect={telegram.disconnect} />
            </div>
            <div className="flex-1 min-w-[200px]">
              <div className="flex gap-1 mb-1 items-center text-[10px] text-gray-400"><Send size={8} />Channel</div>
              <div className="flex gap-1">
                <input value={telegramChannelId} onChange={e => setTelegramChannelId(e.target.value)} className="flex-1 bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-white font-mono focus:border-yellow-500 focus:outline-none" />
                {telegram.authStep === 'connected' && (
                  <>
                    <button onClick={fetchTelegramMessages} className="px-2 py-0.5 rounded bg-blue-600 text-white text-[10px] hover:bg-blue-700"><RefreshCw size={8} /></button>
                    <button onClick={togglePolling} className={`px-2 py-0.5 rounded text-[10px] ${isPolling ? 'bg-red-500' : 'bg-green-600'} text-white`}>{isPolling ? 'Stop' : 'Poll'}</button>
                  </>
                )}
              </div>
            </div>
            <div className="flex-1 min-w-[200px]">
              <div className="flex gap-1 mb-1 items-center text-[10px] text-gray-400"><Brain size={8} />OpenRouter API Key</div>
              <input value={openrouterKey} onChange={e => setOpenrouterKey(e.target.value)} type="password" className="w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-white font-mono focus:border-yellow-500 focus:outline-none" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <div className="flex gap-1 mb-1 items-center text-[10px] text-gray-400"><MessageSquare size={8} />Paste Messages</div>
              <textarea value={rawMessages} onChange={e => setRawMessages(e.target.value)} rows={3} className="w-full bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[9px] text-gray-300 font-mono focus:border-yellow-500 focus:outline-none resize-y" />
              <div className="text-[8px] text-gray-600 mt-0.5">{messages.length} msgs | {signals.length} signals</div>
            </div>
          </div>
        </div>
      )}

      {/* MAIN DASHBOARD GRID */}
      <div className="flex-1 grid grid-cols-12 gap-0.5 p-0.5 overflow-hidden min-h-0">

        {/* LEFT PANEL: Signal List */}
        <div className="col-span-2 flex flex-col min-h-0 bg-[#0d1321] rounded border border-gray-800/30">
          <div className="px-1.5 py-1 border-b border-gray-800/50 flex items-center justify-between flex-shrink-0">
            <span className="text-[10px] font-bold text-gray-300 flex items-center gap-1"><Layers size={10} className="text-yellow-400" />Signals ({totalSignals})</span>
            <div className="flex gap-0.5">
              <button onClick={runAllAIAnalysis} disabled={isProcessing} className="p-0.5 rounded hover:bg-gray-800 text-gray-400 hover:text-purple-400 disabled:opacity-50" title="AI Analyze All">
                {isProcessing ? <Loader2 size={10} className="animate-spin text-purple-400" /> : <Brain size={10} />}
              </button>
            </div>
          </div>
          {isProcessing && (
            <div className="px-1.5 py-0.5 bg-purple-500/10 border-b border-purple-500/20 flex-shrink-0">
              <div className="flex items-center gap-1 text-[9px] text-purple-400">
                <Cpu size={8} className="animate-pulse" />Processing {processStep}/{totalSignals}
              </div>
              <div className="w-full bg-gray-800 rounded-full h-0.5 mt-0.5">
                <div className="bg-purple-500 h-0.5 rounded-full transition-all" style={{ width: `${(processStep / totalSignals) * 100}%` }} />
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto space-y-0.5 p-0.5 min-h-0">
            {signals.slice().reverse().map(s => (
              <MiniSignalCard key={s.id} signal={s} result={backtestResults.find(r => r.signalId === s.id)}
                isSelected={selectedSignal?.id === s.id} onSelect={() => setSelectedSignal(s)} aiAnalysis={aiAnalyses[s.id]} />
            ))}
            {signals.length === 0 && (
              <div className="text-center py-4 text-gray-600 text-[10px]"><Activity size={16} className="mx-auto mb-1 opacity-30" />No signals</div>
            )}
          </div>
        </div>

        {/* CENTER: Chart + Backtest */}
        <div className={`${showMessages ? 'col-span-6' : 'col-span-7'} flex flex-col min-h-0 gap-0.5`}>
          <div className="bg-[#0d1321] rounded border border-gray-800/30 flex-shrink-0">
            <div className="px-1.5 py-0.5 border-b border-gray-800/50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-gray-300 flex items-center gap-1"><BarChart3 size={10} className="text-yellow-400" />Chart</span>
                {selectedSignal && (
                  <span className="text-[9px] text-gray-500">
                    {selectedSignal.id} | {selectedSignal.direction} {selectedSignal.entryLow}-{selectedSignal.entryHigh}
                  </span>
                )}
              </div>
              {selectedSignal && selectedResult && (
                <span className={`text-[10px] font-bold font-mono ${selectedResult.pips >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  PnL: {selectedResult.pips > 0 ? '+' : ''}{selectedResult.pips}p (${selectedResult.pnlUsd})
                </span>
              )}
            </div>
            <SignalPriceChart signal={selectedSignal} backtestResult={selectedResult} />
          </div>

          {/* Backtest Charts Row */}
          <div className="flex-1 grid grid-cols-3 gap-0.5 min-h-0">
            <div className="bg-[#0d1321] rounded border border-gray-800/30 flex flex-col min-h-0">
              <div className="px-1.5 py-0.5 border-b border-gray-800/50 flex-shrink-0">
                <span className="text-[9px] font-bold text-gray-400">Pips/Signal (linked)</span>
              </div>
              <div className="flex-1 min-h-0 p-0.5">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={pipsPerSignal} margin={{ top: 2, right: 2, bottom: 2, left: -15 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 8 }} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 8 }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0d1321', border: '1px solid #1f2937', borderRadius: '4px', fontSize: '10px' }}
                      formatter={(value: number, name: string) => [name === 'pips' ? `${value} pips` : `$${value}`, name]}
                      labelFormatter={(label) => {
                        const item = pipsPerSignal.find(p => p.name === label)
                        return item ? `${item.id} | ${label}` : label
                      }}
                    />
                    <Bar dataKey="pips" radius={[2, 2, 0, 0]}>
                      {pipsPerSignal.map((e, i) => <Cell key={i} fill={e.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-[#0d1321] rounded border border-gray-800/30 flex flex-col min-h-0">
              <div className="px-1.5 py-0.5 border-b border-gray-800/50 flex-shrink-0">
                <span className="text-[9px] font-bold text-gray-400">Cumulative PnL</span>
              </div>
              <div className="flex-1 min-h-0 p-0.5">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={cumulativePipsData} margin={{ top: 2, right: 2, bottom: 2, left: -15 }}>
                    <defs>
                      <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#eab308" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#eab308" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 8 }} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 8 }} />
                    <Tooltip contentStyle={{ backgroundColor: '#0d1321', border: '1px solid #1f2937', borderRadius: '4px', fontSize: '10px' }}
                      formatter={(value: number, name: string) => [name === 'pips' ? `${value} pips` : `$${value}`, name]} />
                    <Area type="monotone" dataKey="pips" stroke="#eab308" strokeWidth={1.5} fill="url(#pnlGradient)" dot={{ fill: '#eab308', r: 2 }} />
                    <Line type="monotone" dataKey="pnl" stroke="#3b82f6" strokeWidth={1} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-[#0d1321] rounded border border-gray-800/30 flex flex-col min-h-0">
              <div className="px-1.5 py-0.5 border-b border-gray-800/50 flex-shrink-0">
                <span className="text-[9px] font-bold text-gray-400">Win/Loss</span>
              </div>
              <div className="flex-1 min-h-0 flex items-center">
                <div className="w-1/2 h-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius="40%" outerRadius="70%" paddingAngle={3} dataKey="value"
                        label={({ name, value }) => `${name}:${value}`} labelLine={false}>
                        {pieData.map((e, i) => <Cell key={i} fill={e.color} />)}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="w-1/2 space-y-1 pr-2 text-[9px]">
                  <div className="flex justify-between"><span className="text-gray-500">Win Rate</span><span className="text-green-400 font-bold">{winRate}%</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Total Pips</span><span className="text-yellow-400 font-bold">{totalPips}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Total PnL</span><span className={`font-bold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>${totalPnl.toFixed(0)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Avg Pips</span><span className="text-purple-400">{avgPips}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Best</span><span className="text-green-400">+{bestTrade}p</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Worst</span><span className="text-red-400">{worstTrade}p</span></div>
                </div>
              </div>
            </div>
          </div>

          {/* Backtest Table */}
          <div className="bg-[#0d1321] rounded border border-gray-800/30 flex-shrink-0 max-h-[180px] overflow-y-auto">
            <table className="w-full text-[9px]">
              <thead className="bg-gray-900/50 sticky top-0">
                <tr>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">ID</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">Date</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">Dir</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">Entry</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">Exit</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">SL</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">TPs</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">Pips</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">PnL</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">Result</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">Msgs</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">AI</th>
                </tr>
              </thead>
              <tbody>
                {backtestResults.map((r) => (
                  <tr key={r.signalId} onClick={() => setSelectedSignal(r.signal)}
                    className={`border-t border-gray-800/30 cursor-pointer hover:bg-gray-800/30 ${selectedSignal?.id === r.signalId ? 'bg-yellow-500/5' : ''}`}>
                    <td className="px-1.5 py-0.5 text-yellow-400 font-mono">{r.signalId}</td>
                    <td className="px-1.5 py-0.5 text-gray-400 font-mono">{r.signal.timestamp.toLocaleDateString()}</td>
                    <td className="px-1.5 py-0.5"><span className={r.signal.direction === 'BUY' ? 'text-green-400' : 'text-red-400'}>{r.signal.direction}</span></td>
                    <td className="px-1.5 py-0.5 text-gray-300 font-mono">{r.entryPrice}</td>
                    <td className="px-1.5 py-0.5 text-gray-300 font-mono">{r.exitPrice}</td>
                    <td className="px-1.5 py-0.5 text-red-400/70 font-mono">{r.signal.stopLoss}</td>
                    <td className="px-1.5 py-0.5 text-green-400">{r.tpHitsCount}/{r.signal.takeProfits.length}</td>
                    <td className={`px-1.5 py-0.5 font-mono font-bold ${r.pips >= 0 ? 'text-green-400' : 'text-red-400'}`}>{r.pips > 0 ? '+' : ''}{r.pips}</td>
                    <td className={`px-1.5 py-0.5 font-mono font-bold ${r.pnlUsd >= 0 ? 'text-green-400' : 'text-red-400'}`}>${r.pnlUsd}</td>
                    <td className="px-1.5 py-0.5">
                      <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${r.result === 'WIN' ? 'bg-green-500/10 text-green-400' : r.result === 'LOSS' ? 'bg-red-500/10 text-red-400' : 'bg-yellow-500/10 text-yellow-400'}`}>{r.result}</span>
                    </td>
                    <td className="px-1.5 py-0.5 text-gray-500">{r.signal.contextMessages?.length || r.signal.messages.length}</td>
                    <td className="px-1.5 py-0.5">
                      {aiAnalyses[r.signalId] ? (
                        aiAnalyses[r.signalId].loading ? <Loader2 size={8} className="animate-spin text-purple-400" /> :
                          <Brain size={8} className={aiAnalyses[r.signalId].sentiment === 'BULLISH' ? 'text-green-400' : aiAnalyses[r.signalId].sentiment === 'BEARISH' ? 'text-red-400' : 'text-gray-400'} />
                      ) : <span className="text-gray-700">-</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* RIGHT PANEL: AI Analysis + Signal Detail */}
        <div className={`${showMessages ? 'col-span-4' : 'col-span-3'} flex flex-col min-h-0 gap-0.5`}>
          <div className="bg-[#0d1321] rounded border border-gray-800/30 flex-1 flex flex-col min-h-0">
            <div className="px-1.5 py-0.5 border-b border-gray-800/50 flex items-center justify-between flex-shrink-0">
              <span className="text-[10px] font-bold text-gray-300 flex items-center gap-1">
                <Brain size={10} className="text-purple-400" />AI Decision Analysis
              </span>
              {selectedSignal && (
                <button onClick={() => runAIAnalysis(selectedSignal)} className="px-1.5 py-0.5 rounded bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 text-[9px] flex items-center gap-0.5">
                  <Zap size={8} />Analyze
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 min-h-0">
              {selectedAI ? (
                selectedAI.loading ? (
                  <div className="flex items-center gap-2 text-purple-400 text-[10px]"><Loader2 size={12} className="animate-spin" />Analyzing {selectedSignal?.contextMessages?.length || 0} messages...</div>
                ) : selectedAI.error ? (
                  <div className="text-red-400 text-[10px]">{selectedAI.error}</div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${selectedAI.sentiment === 'BULLISH' ? 'bg-green-500/10 text-green-400' : selectedAI.sentiment === 'BEARISH' ? 'bg-red-500/10 text-red-400' : 'bg-gray-500/10 text-gray-400'}`}>
                        {selectedAI.sentiment}
                      </span>
                      <span className="text-[9px] text-gray-500">Confidence: {selectedAI.confidence}%</span>
                      <div className="flex-1 bg-gray-800 rounded-full h-1">
                        <div className={`h-1 rounded-full ${selectedAI.confidence > 70 ? 'bg-green-500' : selectedAI.confidence > 40 ? 'bg-yellow-500' : 'bg-red-500'}`}
                          style={{ width: `${selectedAI.confidence}%` }} />
                      </div>
                    </div>
                    <div className="text-[10px] text-gray-300 leading-relaxed">{selectedAI.analysis}</div>
                    {selectedAI.keyPoints.length > 0 && (
                      <div className="space-y-0.5">
                        {selectedAI.keyPoints.map((point, i) => (
                          <div key={i} className="flex items-start gap-1 text-[9px] text-gray-400">
                            <span className="text-yellow-400 mt-0.5">*</span>{point}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              ) : (
                <div className="text-center py-4 text-gray-600 text-[10px]">
                  <Brain size={20} className="mx-auto mb-1 opacity-20" />
                  Select a signal and click Analyze
                </div>
              )}
            </div>
          </div>

          {/* Signal Context Messages */}
          <div className="bg-[#0d1321] rounded border border-gray-800/30 flex-1 flex flex-col min-h-0">
            <div className="px-1.5 py-0.5 border-b border-gray-800/50 flex items-center justify-between flex-shrink-0">
              <span className="text-[10px] font-bold text-gray-300 flex items-center gap-1">
                <Link2 size={10} className="text-blue-400" />
                {selectedSignal ? `Context: ${selectedSignal.id} (${selectedSignal.contextMessages?.length || 0} msgs)` : 'Signal Context'}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 divide-y divide-gray-800/30">
              {selectedSignal?.contextMessages?.map(msg => {
                const tc: Record<string, string> = {
                  SIGNAL: 'border-l-blue-500 bg-blue-950/5', UPDATE: 'border-l-green-500 bg-green-950/5',
                  PROMO: 'border-l-red-500 bg-red-950/5', GREETING: 'border-l-gray-600', UNKNOWN: 'border-l-gray-800'
                }
                return (
                  <div key={msg.id} className={`px-1.5 py-0.5 border-l-2 ${tc[msg.type]}`}>
                    <div className="flex items-center gap-1">
                      <span className="text-[8px] text-gray-600 font-mono">{msg.timestamp.toLocaleString()}</span>
                      <span className={`px-0.5 rounded text-[7px] ${msg.type === 'SIGNAL' ? 'bg-blue-500/20 text-blue-400' : msg.type === 'UPDATE' ? 'bg-green-500/20 text-green-400' : msg.type === 'PROMO' ? 'bg-red-500/20 text-red-400' : 'bg-gray-500/10 text-gray-500'}`}>{msg.type}</span>
                    </div>
                    <p className="text-[9px] text-gray-400 whitespace-pre-wrap leading-tight">{msg.text}</p>
                  </div>
                )
              })}
              {(!selectedSignal || !selectedSignal.contextMessages || selectedSignal.contextMessages.length === 0) && (
                <div className="text-center py-4 text-gray-600 text-[10px]">Select a signal to see linked messages</div>
              )}
            </div>
          </div>

          {/* All Messages Panel (toggle) */}
          {showMessages && (
            <div className="bg-[#0d1321] rounded border border-gray-800/30 flex-1 flex flex-col min-h-0">
              <div className="px-1.5 py-0.5 border-b border-gray-800/50 flex items-center justify-between flex-shrink-0">
                <span className="text-[10px] font-bold text-gray-300 flex items-center gap-1">
                  <Database size={10} className="text-cyan-400" />All Messages A-Z ({messages.length})
                </span>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0 divide-y divide-gray-800/20">
                {messages.map(msg => (
                  <div key={msg.id} className={`px-1 py-0.5 text-[8px] ${msg.linkedSignalId ? 'bg-yellow-500/3' : ''}`}>
                    <span className="text-gray-600 font-mono">{msg.timestamp.toLocaleString()}</span>
                    <span className={`ml-1 ${msg.type === 'SIGNAL' ? 'text-blue-400' : msg.type === 'UPDATE' ? 'text-green-400' : msg.type === 'PROMO' ? 'text-red-400' : 'text-gray-500'}`}>[{msg.type}]</span>
                    {msg.linkedSignalId && <span className="ml-1 text-yellow-400/50">[{msg.linkedSignalId}]</span>}
                    <span className="ml-1 text-gray-400">{msg.text.slice(0, 80)}{msg.text.length > 80 ? '...' : ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
