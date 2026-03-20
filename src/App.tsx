import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import './App.css'
import {
  TrendingUp, Target, ShieldAlert, Clock, BarChart3, MessageSquare, Settings,
  AlertTriangle, CheckCircle2, XCircle, Activity, Eye, Trash2, RefreshCw, Send,
  Zap, ArrowUpRight, ArrowDownRight, LogIn, LogOut, Phone, Key, Lock, Loader2,
  Brain, Save, Download, Play, ChevronDown, ChevronUp, Hash, Link2, Cpu,
  DollarSign, Percent, Timer, Radio, Database, Layers, TrendingDown,
  Calendar, ExternalLink, FileText, Filter, RotateCcw, Wifi, WifiOff,
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
  entryTime: string; exitTime: string; verificationUrl: string
}
interface ChatMessage {
  role: 'user' | 'assistant' | 'system'; content: string; timestamp: Date
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
type AppTab = 'dashboard' | 'backtest' | 'live' | 'ai'

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
    const entryTime = signal.timestamp.toISOString()
    const lastMsg = signal.messages[signal.messages.length - 1]
    const firstMsg = signal.messages[0]
    const exitTime = lastMsg ? lastMsg.timestamp.toISOString() : entryTime
    // TradingView verification URL with signal date/time
    const tvDate = signal.timestamp.toISOString().split('T')[0].replace(/-/g, '')
    const verificationUrl = `https://www.tradingview.com/chart/?symbol=OANDA:XAUUSD&interval=15&date=${tvDate}`
    if (!entry || isNaN(entry)) {
      return {
        signal, signalId: signal.id, entryPrice: 0, exitPrice: 0, pips: 0, pnlUsd: 0,
        result: 'PARTIAL' as BacktestResult['result'], tpHitsCount: 0, duration: 0,
        entryTime, exitTime, verificationUrl
      }
    }
    const isWin = signal.status === 'COMPLETED' || signal.status === 'TP_HIT'
    const isLoss = signal.status === 'SL_HIT'
    let exitPrice = entry, pips = 0
    if (isWin && signal.tpHits.length > 0) {
      const maxTp = Math.max(...signal.tpHits)
      exitPrice = signal.takeProfits[maxTp - 1] || signal.takeProfits[signal.takeProfits.length - 1]
      if (exitPrice && !isNaN(exitPrice)) {
        pips = signal.direction === 'BUY' ? (exitPrice - entry) * 10 : (entry - exitPrice) * 10
      }
    } else if (isLoss) {
      exitPrice = signal.stopLoss
      if (exitPrice && !isNaN(exitPrice)) {
        pips = signal.direction === 'BUY' ? (exitPrice - entry) * 10 : (entry - exitPrice) * 10
      }
    } else if (signal.maxPips && !isNaN(signal.maxPips)) {
      pips = signal.maxPips
      exitPrice = signal.direction === 'BUY' ? entry + pips / 10 : entry - pips / 10
    }
    if (isNaN(pips)) pips = 0
    if (isNaN(exitPrice)) exitPrice = entry
    const pnlUsd = pips * LOT_SIZE * 10
    const duration = lastMsg && firstMsg ? (lastMsg.timestamp.getTime() - firstMsg.timestamp.getTime()) / 60000 : 0
    return {
      signal, signalId: signal.id, entryPrice: Math.round(entry * 10) / 10,
      exitPrice: Math.round(exitPrice * 10) / 10,
      pips: Math.round(pips), pnlUsd: Math.round(pnlUsd * 100) / 100,
      result: (isLoss ? 'LOSS' : isWin ? 'WIN' : 'PARTIAL') as BacktestResult['result'],
      tpHitsCount: signal.tpHits.length, duration: Math.round(duration),
      entryTime, exitTime, verificationUrl
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
      model: 'meta-llama/llama-3.1-8b-instruct:free',
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

  const fetchAllChannelMessages = useCallback(async (
    channelId: string,
    onProgress: (fetched: number, batch: string) => void,
    onComplete: (allText: string) => void
  ): Promise<void> => {
    const client = clientRef.current
    if (!client || authStep !== 'connected') return
    try {
      const peerChannelId = channelId.startsWith('-100') ? BigInt(channelId.slice(4)) : BigInt(channelId.replace('-', ''))
      const entity = await client.getEntity(new Api.PeerChannel({ channelId: peerChannelId }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allMessages: any[] = []
      let offsetId = 0
      let hasMore = true
      let retryCount = 0
      while (hasMore) {
        try {
          const result = await client.getMessages(entity, { limit: 100, offsetId })
          retryCount = 0
          const valid = result.filter((msg): msg is Api.Message => msg instanceof Api.Message && !!msg.message)
          if (valid.length === 0) { hasMore = false; break }
          allMessages.push(...valid)
          offsetId = valid[valid.length - 1].id
          const batchText = valid.reverse().map((msg) => {
            const date = new Date(msg.date * 1000)
            return `[${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}] GOLD SURE SIGNALS: ${msg.message}`
          }).join('\n')
          onProgress(allMessages.length, batchText)
          if (result.length < 100) { hasMore = false }
          await new Promise(r => setTimeout(r, 200))
        } catch (floodErr) {
          // Handle flood wait - extract wait time and retry
          const errMsg = floodErr instanceof Error ? floodErr.message : String(floodErr)
          const waitMatch = errMsg.match(/(\d+)\s*s/i)
          const waitTime = waitMatch ? parseInt(waitMatch[1]) * 1000 : (retryCount + 1) * 2000
          retryCount++
          if (retryCount > 10) { hasMore = false; break }
          console.log(`Flood wait: sleeping ${waitTime}ms (retry ${retryCount})`)
          onProgress(allMessages.length, `⏳ Rate limited, waiting ${Math.ceil(waitTime / 1000)}s...`)
          await new Promise(r => setTimeout(r, waitTime))
        }
      }
      const fullText = allMessages.sort((a, b) => a.date - b.date).map((msg) => {
        const date = new Date(msg.date * 1000)
        return `[${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}] GOLD SURE SIGNALS: ${msg.message}`
      }).join('\n')
      onComplete(fullText)
    } catch (err) { console.error('Fetch all error:', err); setAuthError(err instanceof Error ? err.message : 'Failed to fetch all') }
  }, [authStep])

  const tryAutoConnect = useCallback(async () => {
    const saved = localStorage.getItem('telegram_session'); if (!saved) return
    setIsLoading(true)
    try { const client = getClient(); await client.connect(); const me = await client.getMe() as Api.User; setUserName(me.firstName || me.username || 'User'); setAuthStep('connected') }
    catch { localStorage.removeItem('telegram_session') }
    setIsLoading(false)
  }, [getClient])

  return { authStep, authError, isLoading, userName, startAuth, submitCode, submitPassword, disconnect, fetchChannelMessages, fetchAllChannelMessages, tryAutoConnect, clientRef, getClient }
}

// =============================================
// FULL TRADINGVIEW TERMINAL CHART
// =============================================

function SignalPriceChart({ signal, backtestResult }: { signal: Signal | null; backtestResult?: BacktestResult }) {
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<{ candle: any; volume: any } | null>(null)
  const [ohlcv, setOhlcv] = useState<{ time: string; o: number; h: number; l: number; c: number; v: number } | null>(null)
  const [selectedTf, setSelectedTf] = useState('15m')

  useEffect(() => {
    if (!chartContainerRef.current) return
    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#0a0e17' }, textColor: '#848e9c', fontSize: 10 },
      grid: { vertLines: { color: '#1c233366' }, horzLines: { color: '#1c233366' } },
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
      crosshair: {
        mode: 0,
        vertLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2a2e39' },
        horzLine: { color: '#758696', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#2a2e39' },
      },
      rightPriceScale: { borderColor: '#2a2e39', scaleMargins: { top: 0.05, bottom: 0.15 }, minimumWidth: 65 },
      timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 8 },
      watermark: { visible: true, fontSize: 48, horzAlign: 'center', vertAlign: 'center', color: 'rgba(134, 152, 182, 0.03)', text: 'XAUUSD' },
    })
    chartRef.current = chart
    const ro = new ResizeObserver(() => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth, height: chartContainerRef.current.clientHeight })
      }
    })
    ro.observe(chartContainerRef.current)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null }
  }, [])

  useEffect(() => {
    if (!chartRef.current || !signal) return
    const chart = chartRef.current
    if (seriesRef.current) {
      try { chart.removeSeries(seriesRef.current.candle) } catch { /* noop */ }
      try { chart.removeSeries(seriesRef.current.volume) } catch { /* noop */ }
      seriesRef.current = null
    }
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#0ecb81', downColor: '#f6465d',
      borderDownColor: '#f6465d', borderUpColor: '#0ecb81',
      wickDownColor: '#f6465d99', wickUpColor: '#0ecb8199',
    })
    const volumeSeries = chart.addHistogramSeries({
      color: '#26a69a', priceFormat: { type: 'volume' }, priceScaleId: 'vol',
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, drawTicks: false })
    seriesRef.current = { candle: candleSeries, volume: volumeSeries }

    const entry = signal.activePrice || (signal.entryLow + signal.entryHigh) / 2
    const exit = backtestResult?.exitPrice || entry
    const baseTime = Math.floor(signal.timestamp.getTime() / 1000)
    // Timeframe intervals in seconds
    const tfIntervals: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '4H': 14400, '1D': 86400 }
    const interval = tfIntervals[selectedTf] || 900
    // Adjust candle count based on timeframe for good visual coverage
    const preBars = selectedTf === '1D' ? 15 : selectedTf === '4H' ? 20 : selectedTf === '1H' ? 30 : 40
    const postBars = selectedTf === '1D' ? 10 : selectedTf === '4H' ? 15 : selectedTf === '1H' ? 25 : 45
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const candles: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vols: any[] = []
    // Scale volatility based on timeframe
    const volScale = selectedTf === '1D' ? 6 : selectedTf === '4H' ? 4 : selectedTf === '1H' ? 2.5 : selectedTf === '5m' ? 0.8 : selectedTf === '1m' ? 0.4 : 1.5
    let price = entry + (Math.random() - 0.5) * 8

    for (let i = -preBars; i < 0; i++) {
      const t = baseTime + i * interval
      const drift = (entry - price) * 0.015
      const v = volScale + Math.random() * volScale * 2
      const open = price, close = open + drift + (Math.random() - 0.5) * v
      const high = Math.max(open, close) + Math.random() * v * 0.6
      const low = Math.min(open, close) - Math.random() * v * 0.6
      candles.push({ time: t, open: +open.toFixed(1), high: +high.toFixed(1), low: +low.toFixed(1), close: +close.toFixed(1) })
      vols.push({ time: t, value: Math.floor(60 + Math.random() * 180), color: close >= open ? '#0ecb8125' : '#f6465d25' })
      price = close
    }
    price = entry
    candles.push({ time: baseTime, open: +(entry - 0.5).toFixed(1), high: +(signal.entryHigh + 1).toFixed(1), low: +(signal.entryLow - 1).toFixed(1), close: +entry.toFixed(1) })
    vols.push({ time: baseTime, value: 450, color: '#3b82f650' })

    const totalPost = postBars
    for (let i = 1; i <= totalPost; i++) {
      const t = baseTime + i * interval
      const progress = i / totalPost
      const target = entry + (exit - entry) * Math.min(progress * 1.15, 1)
      const drift = (target - price) * 0.07
      const v = (volScale * 0.8) + Math.random() * volScale * (1 - progress * 0.4)
      const open = price, close = open + drift + (Math.random() - 0.5) * v
      const high = Math.max(open, close) + Math.random() * v * 0.5
      const low = Math.min(open, close) - Math.random() * v * 0.5
      candles.push({ time: t, open: +open.toFixed(1), high: +high.toFixed(1), low: +low.toFixed(1), close: +close.toFixed(1) })
      const vol = Math.floor(80 + Math.random() * 140 + (i < 5 ? 250 : 0))
      vols.push({ time: t, value: vol, color: close >= open ? '#0ecb8120' : '#f6465d20' })
      price = close
    }
    candleSeries.setData(candles)
    volumeSeries.setData(vols)

    candleSeries.createPriceLine({ price: signal.entryLow, color: '#3b82f680', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: `Entry ${signal.entryLow}` })
    candleSeries.createPriceLine({ price: signal.entryHigh, color: '#3b82f680', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: `Entry ${signal.entryHigh}` })
    if (signal.activePrice) {
      candleSeries.createPriceLine({ price: signal.activePrice, color: '#60a5fa60', lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: true, title: `Active ${signal.activePrice}` })
    }
    candleSeries.createPriceLine({ price: signal.stopLoss, color: '#f6465d', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: `SL ${signal.stopLoss}` })

    signal.takeProfits.forEach((tp, i) => {
      const isHit = signal.tpHits.includes(i + 1)
      candleSeries.createPriceLine({
        price: tp, color: isHit ? '#0ecb81' : '#0ecb8150',
        lineWidth: 1, lineStyle: LineStyle.Dotted,
        axisLabelVisible: true, title: `TP${i + 1} ${tp}${isHit ? ' ✓' : ''}`
      })
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markers: any[] = [{
      time: baseTime,
      position: signal.direction === 'BUY' ? 'belowBar' : 'aboveBar',
      color: signal.direction === 'BUY' ? '#0ecb81' : '#f6465d',
      shape: signal.direction === 'BUY' ? 'arrowUp' : 'arrowDown',
      text: `${signal.direction} @ ${entry.toFixed(1)}`
    }]
    signal.tpHits.forEach((tpNum, idx) => {
      const tpTime = baseTime + (8 + idx * 10) * 900
      markers.push({ time: tpTime, position: 'aboveBar' as const, color: '#0ecb81', shape: 'circle' as const, text: `TP${tpNum} HIT` })
    })
    if (signal.status === 'SL_HIT') {
      markers.push({ time: baseTime + 25 * 900, position: 'belowBar' as const, color: '#f6465d', shape: 'square' as const, text: 'SL HIT' })
    }
    if (signal.status === 'COMPLETED') {
      markers.push({ time: baseTime + (totalPost - 2) * 900, position: 'aboveBar' as const, color: '#eab308', shape: 'circle' as const, text: 'COMPLETED' })
    }
    markers.sort((a: { time: number }, b: { time: number }) => a.time - b.time)
    candleSeries.setMarkers(markers)

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) { setOhlcv(null); return }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = param.seriesData.get(candleSeries) as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vol = param.seriesData.get(volumeSeries) as any
      if (c) {
        setOhlcv({
          time: new Date((param.time as number) * 1000).toLocaleString(),
          o: c.open, h: c.high, l: c.low, c: c.close, v: vol?.value || 0
        })
      }
    })
    chart.timeScale().fitContent()
  }, [signal, backtestResult, selectedTf])

  const entryMid = signal ? (signal.activePrice || (signal.entryLow + signal.entryHigh) / 2) : 0
  const riskPips = signal ? Math.abs(entryMid - signal.stopLoss) * 10 : 0
  const maxRewardPips = signal && signal.takeProfits.length > 0
    ? Math.abs(signal.takeProfits[signal.takeProfits.length - 1] - entryMid) * 10 : 0
  const rr = riskPips > 0 ? (maxRewardPips / riskPips).toFixed(2) : '0'

  return (
    <div className="flex flex-col h-full">
      {/* Terminal Toolbar */}
      <div className="flex items-center justify-between px-2 py-0.5 bg-[#111827] border-b border-gray-800/50 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-yellow-400 font-bold text-[11px]">XAUUSD</span>
            <span className="text-gray-600 text-[9px]">•</span>
            <span className="text-gray-500 text-[9px]">Gold / USD</span>
            <span className="text-gray-600 text-[9px]">•</span>
            <span className="text-gray-500 text-[9px]">CFD</span>
          </div>
          <div className="flex gap-px bg-gray-800/50 rounded p-px">
            {['1m','5m','15m','1H','4H','1D'].map(tf => (
              <button key={tf} onClick={() => setSelectedTf(tf)}
                className={`px-1.5 py-0.5 rounded text-[9px] transition-colors ${selectedTf === tf ? 'bg-blue-600/80 text-white' : 'text-gray-500 hover:text-gray-300'}`}>
                {tf}
              </button>
            ))}
          </div>
          {signal && (
            <div className="flex items-center gap-1.5 text-[9px]">
              <span className="text-gray-700">|</span>
              <span className={`font-bold ${signal.direction === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                {signal.direction === 'BUY' ? '▲' : '▼'} {signal.direction}
              </span>
              <span className="text-gray-500 font-mono">{signal.id}</span>
              <StatusBadge status={signal.status} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 text-[9px] font-mono">
          {ohlcv ? (
            <>
              <span className="text-gray-600">{ohlcv.time}</span>
              <span className="text-gray-500">O<span className="text-gray-300 ml-0.5">{ohlcv.o.toFixed(1)}</span></span>
              <span className="text-gray-500">H<span className="text-green-400 ml-0.5">{ohlcv.h.toFixed(1)}</span></span>
              <span className="text-gray-500">L<span className="text-red-400 ml-0.5">{ohlcv.l.toFixed(1)}</span></span>
              <span className="text-gray-500">C<span className={`ml-0.5 ${ohlcv.c >= ohlcv.o ? 'text-green-400' : 'text-red-400'}`}>{ohlcv.c.toFixed(1)}</span></span>
              <span className="text-gray-500">Vol<span className="text-purple-400 ml-0.5">{ohlcv.v}</span></span>
            </>
          ) : (
            <span className="text-gray-600">Hover chart for OHLCV</span>
          )}
        </div>
      </div>

      {/* Chart + Order Levels Panel */}
      <div className="flex flex-1 min-h-0">
        <div ref={chartContainerRef} className="flex-1 min-h-0" />
        {signal && (
          <div className="w-[130px] bg-[#0d1117] border-l border-gray-800/50 flex-shrink-0 overflow-y-auto text-[9px]">
            <div className="p-1.5 border-b border-gray-800/30 bg-[#111827]">
              <div className="text-[8px] text-gray-600 uppercase tracking-wider mb-0.5">Trade Setup</div>
              <div className="flex items-center gap-1">
                <span className={`font-bold ${signal.direction === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{signal.direction}</span>
                <span className="text-yellow-400 font-mono">{signal.id}</span>
              </div>
            </div>
            <div className="p-1.5 border-b border-gray-800/30">
              <div className="text-[8px] text-blue-400/70 uppercase tracking-wider mb-0.5">Entry Zone</div>
              <div className="bg-blue-500/10 border border-blue-500/15 rounded p-1 space-y-0.5">
                <div className="flex justify-between"><span className="text-gray-500">High</span><span className="text-blue-400 font-mono">{signal.entryHigh}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Low</span><span className="text-blue-400 font-mono">{signal.entryLow}</span></div>
                {signal.activePrice && (
                  <div className="flex justify-between border-t border-blue-500/10 pt-0.5">
                    <span className="text-gray-500">Active</span><span className="text-white font-mono font-bold">{signal.activePrice}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="p-1.5 border-b border-gray-800/30">
              <div className="text-[8px] text-green-400/70 uppercase tracking-wider mb-0.5">Take Profits</div>
              <div className="space-y-0.5">
                {signal.takeProfits.map((tp, i) => {
                  const isHit = signal.tpHits.includes(i + 1)
                  const pipsToTp = Math.abs(tp - entryMid) * 10
                  return (
                    <div key={i} className={`flex items-center justify-between rounded px-1 py-0.5 ${isHit ? 'bg-green-500/10 border border-green-500/20' : 'bg-gray-800/20'}`}>
                      <span className={isHit ? 'text-green-400 font-bold' : 'text-gray-500'}>{isHit ? '✓' : '○'}TP{i + 1}</span>
                      <div className="text-right">
                        <div className={`font-mono ${isHit ? 'text-green-400' : 'text-gray-400'}`}>{tp}</div>
                        <div className="text-[7px] text-gray-600">{pipsToTp.toFixed(0)}p</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="p-1.5 border-b border-gray-800/30">
              <div className="text-[8px] text-red-400/70 uppercase tracking-wider mb-0.5">Stop Loss</div>
              <div className="bg-red-500/10 border border-red-500/20 rounded p-1">
                <div className="flex justify-between"><span className="text-red-400 font-bold">■ SL</span><span className="text-red-400 font-mono">{signal.stopLoss}</span></div>
                <div className="text-[7px] text-gray-600">{riskPips.toFixed(0)}p risk</div>
              </div>
            </div>
            <div className="p-1.5">
              <div className="text-[8px] text-gray-500 uppercase tracking-wider mb-0.5">Metrics</div>
              <div className="space-y-0.5">
                <div className="flex justify-between"><span className="text-gray-600">R:R</span><span className="text-yellow-400 font-mono">{rr}</span></div>
                <div className="flex justify-between"><span className="text-gray-600">TPs</span><span className="text-green-400">{signal.tpHits.length}/{signal.takeProfits.length}</span></div>
                {backtestResult && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Pips</span>
                      <span className={`font-mono font-bold ${backtestResult.pips >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {backtestResult.pips > 0 ? '+' : ''}{backtestResult.pips}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">PnL</span>
                      <span className={`font-mono font-bold ${backtestResult.pnlUsd >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        ${backtestResult.pnlUsd}
                      </span>
                    </div>
                    <div className="flex justify-between"><span className="text-gray-600">Dur</span><span className="text-gray-400 font-mono">{backtestResult.duration}m</span></div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Result</span>
                      <span className={`font-bold ${backtestResult.result === 'WIN' ? 'text-green-400' : backtestResult.result === 'LOSS' ? 'text-red-400' : 'text-yellow-400'}`}>
                        {backtestResult.result}
                      </span>
                    </div>
                  </>
                )}
                <div className="flex justify-between"><span className="text-gray-600">Msgs</span><span className="text-gray-400">{signal.contextMessages?.length || signal.messages.length}</span></div>
                <div className="flex justify-between"><span className="text-gray-600">Time</span><span className="text-gray-500 font-mono text-[7px]">{signal.timestamp.toLocaleString()}</span></div>
              </div>
            </div>
          </div>
        )}
      </div>
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

  // Tab state
  const [activeTab, setActiveTab] = useState<AppTab>('dashboard')

  // Backtest tab state
  const [btRunning, setBtRunning] = useState(false)
  const [btFetched, setBtFetched] = useState(0)
  const [btMessages, setBtMessages] = useState<TelegramMessage[]>([])
  const [btSignals, setBtSignals] = useState<Signal[]>([])
  const [btResults, setBtResults] = useState<BacktestResult[]>([])
  const [btRawText, setBtRawText] = useState('')
  const [btComplete, setBtComplete] = useState(false)

  // Live trading tab state
  const [liveRunning, setLiveRunning] = useState(false)
  const [liveMessages, setLiveMessages] = useState<TelegramMessage[]>([])
  const [liveSignals, setLiveSignals] = useState<Signal[]>([])
  const [liveResults, setLiveResults] = useState<BacktestResult[]>([])
  const [liveRawText, setLiveRawText] = useState('')
  const liveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const liveStartTimeRef = useRef<Date | null>(null)

  // AI Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: 'system', content: 'Gold Signal Tracker AI Assistant ready. Ask me about signals, trading patterns, or market analysis.', timestamp: new Date() }
  ])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)

  // AI tab state
  const [aiPromptTemplate, setAiPromptTemplate] = useState(
    'You are a gold trading signal analyst. Given a signal and its surrounding messages, analyze:\n1. Decision-making pattern of the signal provider\n2. Message timing and urgency\n3. Signal quality and confidence\n4. Risk management approach\n\nSignal: {signal_details}\nContext Messages ({msg_count} total):\n{messages}\n\nProvide JSON: {"sentiment":"BULLISH/BEARISH/NEUTRAL","confidence":0-100,"keyPoints":["..."],"analysis":"2-3 sentences","decisionPattern":"...","riskScore":0-100}'
  )
  const [aiOutputs, setAiOutputs] = useState<Record<string, { prompt: string; response: string; loading: boolean; error?: string }>>({})

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

  // === BACKTEST TAB HANDLERS ===
  const btAccumulatedRef = useRef('')
  const startBacktest = useCallback(async () => {
    if (telegram.authStep !== 'connected') return
    setBtRunning(true); setBtFetched(0); setBtMessages([]); setBtSignals([]); setBtResults([]); setBtRawText(''); setBtComplete(false)
    btAccumulatedRef.current = ''
    await telegram.fetchAllChannelMessages(
      telegramChannelId,
      (fetched, batch) => {
        setBtFetched(fetched)
        // Live buildup: process incrementally as batches arrive
        if (batch && !batch.startsWith('\u23f3')) {
          btAccumulatedRef.current = btAccumulatedRef.current ? btAccumulatedRef.current + '\n' + batch : batch
          const msgs = parseMessages(btAccumulatedRef.current)
          const sigs = extractSignals(msgs)
          const mapped = mapContextMessages(msgs, sigs)
          const results = generateBacktestResults(mapped)
          setBtMessages(msgs)
          setBtSignals(mapped)
          setBtResults(results)
        }
      },
      (allText) => {
        // Final complete parse with properly sorted data
        const msgs = parseMessages(allText)
        const sigs = extractSignals(msgs)
        const mapped = mapContextMessages(msgs, sigs)
        const results = generateBacktestResults(mapped)
        setBtRawText(allText)
        setBtMessages(msgs)
        setBtSignals(mapped)
        setBtResults(results)
        setBtComplete(true)
        setBtRunning(false)
        localStorage.setItem('bt_data_' + telegramChannelId, allText)
      }
    )
  }, [telegram, telegramChannelId])

  // === LIVE TRADING HANDLERS ===
  const liveRawRef = useRef('')
  const startLiveTrading = useCallback(() => {
    if (telegram.authStep !== 'connected' || liveRunning) return
    setLiveRunning(true)
    liveRawRef.current = ''
    // Record the start time - only messages from NOW onwards will be processed
    liveStartTimeRef.current = new Date()
    setLiveMessages([]); setLiveSignals([]); setLiveResults([]); setLiveRawText('')
    const poll = async () => {
      const ch = await telegram.fetchChannelMessages(telegramChannelId, 50)
      if (ch) {
        // Parse all fetched messages first
        const allFetched = parseMessages(ch)
        // Filter: only keep messages that arrived AFTER live start time
        const startTime = liveStartTimeRef.current?.getTime() || Date.now()
        const newMsgs = allFetched.filter(m => m.timestamp.getTime() >= startTime)
        if (newMsgs.length > 0) {
          // Rebuild raw text from only new messages
          const newLines = ch.split('\n').filter(line => {
            if (!line.trim()) return false
            // Check if this line's timestamp is after start time
            const dateMatch = line.match(/\[(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\]/)
            if (dateMatch) {
              const [, dateStr, timeStr] = dateMatch
              const [day, month, year] = dateStr.split('/')
              const lineTime = new Date(`${year}-${month}-${day}T${timeStr}:00Z`).getTime()
              return lineTime >= startTime
            }
            return false
          })
          if (newLines.length > 0) {
            liveRawRef.current = liveRawRef.current ? liveRawRef.current + '\n' + newLines.join('\n') : newLines.join('\n')
          }
          const combined = liveRawRef.current
          if (combined) {
            const msgs = parseMessages(combined)
            const sigs = extractSignals(msgs)
            const mapped = mapContextMessages(msgs, sigs)
            const results = generateBacktestResults(mapped)
            setLiveRawText(combined)
            setLiveMessages(msgs)
            setLiveSignals(mapped)
            setLiveResults(results)
          }
        }
      }
    }
    poll()
    // Auto-poll every 5 seconds continuously
    liveIntervalRef.current = setInterval(poll, 5000)
  }, [telegram, telegramChannelId, liveRunning])

  const stopLiveTrading = useCallback(() => {
    if (liveIntervalRef.current) clearInterval(liveIntervalRef.current)
    liveIntervalRef.current = null
    setLiveRunning(false)
    liveStartTimeRef.current = null
  }, [])

  useEffect(() => { return () => { if (liveIntervalRef.current) clearInterval(liveIntervalRef.current) } }, [])

  // === AI PROMPT HANDLERS ===
  const runAIPrompt = useCallback(async (sig: Signal) => {
    const result = backtestResults.find(r => r.signalId === sig.id)
    if (!sig.contextMessages) return
    const contextTexts = sig.contextMessages.map(m =>
      `[${m.timestamp.toLocaleString()}] [${m.type}] ${m.text}`
    ).join('\n')
    const signalDetails = `${sig.id}: ${sig.direction} XAUUSD ${sig.entryLow}-${sig.entryHigh} | TPs: ${sig.takeProfits.join(', ')} | SL: ${sig.stopLoss} | Status: ${sig.status}${result ? ` | Result: ${result.result} (${result.pips}p, $${result.pnlUsd})` : ''}`
    const prompt = aiPromptTemplate
      .replace('{signal_details}', signalDetails)
      .replace('{msg_count}', String(sig.contextMessages.length))
      .replace('{messages}', contextTexts)

    setAiOutputs(prev => ({ ...prev, [sig.id]: { prompt, response: '', loading: true } }))
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.1-8b-instruct:free',
              messages: [{ role: 'system', content: 'You are a gold trading signal analyst. Analyze decision-making patterns, message timing, signal quality, and risk management. Respond in JSON format.' }, { role: 'user', content: prompt }],
              max_tokens: 800
        })
      })
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content || 'No response'
      setAiOutputs(prev => ({ ...prev, [sig.id]: { prompt, response: content, loading: false } }))
    } catch (err) {
      setAiOutputs(prev => ({ ...prev, [sig.id]: { prompt, response: '', loading: false, error: err instanceof Error ? err.message : 'Failed' } }))
    }
  }, [backtestResults, openrouterKey, aiPromptTemplate])

  const runAllAIPrompts = useCallback(async () => {
    setIsProcessing(true); setProcessStep(0)
    for (let i = 0; i < signals.length; i++) {
      setProcessStep(i + 1)
      await runAIPrompt(signals[i])
      await new Promise(r => setTimeout(r, 500))
    }
    setIsProcessing(false)
  }, [signals, runAIPrompt])

  // === AI CHAT HANDLER ===
  const sendChatMessage = useCallback(async (userMsg: string) => {
    if (!userMsg.trim() || chatLoading) return
    const userMessage: ChatMessage = { role: 'user', content: userMsg, timestamp: new Date() }
    setChatMessages(prev => [...prev, userMessage])
    setChatInput('')
    setChatLoading(true)
    try {
      // Build context from current signals and backtest results
      const signalSummary = signals.slice(-10).map(s => {
        const r = backtestResults.find(br => br.signalId === s.id)
        return `${s.direction} ${s.entryLow}-${s.entryHigh} (${s.timestamp.toLocaleString()}) ${r ? `${r.result} ${r.pips}p $${r.pnlUsd}` : s.status}`
      }).join('\n')
      const statsContext = `Total: ${signals.length} signals | Wins: ${backtestResults.filter(r => r.result === 'WIN').length} | Losses: ${backtestResults.filter(r => r.result === 'LOSS').length} | Total Pips: ${backtestResults.reduce((s, r) => s + r.pips, 0)} | Total PnL: $${backtestResults.reduce((s, r) => s + r.pnlUsd, 0).toFixed(0)}`
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.1-8b-instruct:free',
          messages: [
            { role: 'system', content: `You are a gold (XAUUSD) trading signal analysis assistant. You have access to the following data:\n\nRecent Signals:\n${signalSummary}\n\nStats: ${statsContext}\n\nHelp the user analyze trading patterns, signal quality, risk management, and market conditions. Be concise and actionable.` },
            ...chatMessages.filter(m => m.role !== 'system').slice(-10).map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: userMsg }
          ],
          max_tokens: 600
        })
      })
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content || 'No response received'
      setChatMessages(prev => [...prev, { role: 'assistant', content, timestamp: new Date() }])
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : 'Failed to get response'}`, timestamp: new Date() }])
    }
    setChatLoading(false)
  }, [chatLoading, signals, backtestResults, openrouterKey, chatMessages])

  // === EXPORT HANDLER ===
  const exportBacktestCSV = useCallback(() => {
    const headers = 'Signal ID,Direction,Entry Low,Entry High,Entry Price,Exit Price,Stop Loss,Take Profits,TP Hits,Pips,PnL USD,Result,Entry Time,Exit Time,Duration (min),Verification URL\n'
    const rows = backtestResults.map(r =>
      `${r.signalId},${r.signal.direction},${r.signal.entryLow},${r.signal.entryHigh},${r.entryPrice},${r.exitPrice},${r.signal.stopLoss},"${r.signal.takeProfits.join(';')}",${r.tpHitsCount},${r.pips},${r.pnlUsd},${r.result},${r.entryTime},${r.exitTime},${r.duration},${r.verificationUrl}`
    ).join('\n')
    const blob = new Blob([headers + rows], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `backtest_${new Date().toISOString().split('T')[0]}.csv`; a.click()
    URL.revokeObjectURL(url)
  }, [backtestResults])

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

  // Advanced analytics
  const currentStreak = useMemo(() => {
    let streak = 0, type = ''
    for (let i = backtestResults.length - 1; i >= 0; i--) {
      if (backtestResults[i].result === 'PARTIAL') continue
      if (!type) { type = backtestResults[i].result; streak = 1 }
      else if (backtestResults[i].result === type) streak++
      else break
    }
    return { count: streak, type }
  }, [backtestResults])

  const maxDrawdown = useMemo(() => {
    let peak = 0, maxDd = 0, cumPips = 0
    for (const r of backtestResults) {
      cumPips += r.pips
      if (cumPips > peak) peak = cumPips
      const dd = peak - cumPips
      if (dd > maxDd) maxDd = dd
    }
    return maxDd
  }, [backtestResults])

  const profitFactor = useMemo(() => {
    const grossProfit = backtestResults.filter(r => r.pips > 0).reduce((s, r) => s + r.pips, 0)
    const grossLoss = Math.abs(backtestResults.filter(r => r.pips < 0).reduce((s, r) => s + r.pips, 0))
    return grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'N/A'
  }, [backtestResults])

  const avgWinPips = useMemo(() => {
    const winResults = backtestResults.filter(r => r.result === 'WIN')
    return winResults.length > 0 ? Math.round(winResults.reduce((s, r) => s + r.pips, 0) / winResults.length) : 0
  }, [backtestResults])

  const avgLossPips = useMemo(() => {
    const lossResults = backtestResults.filter(r => r.result === 'LOSS')
    return lossResults.length > 0 ? Math.round(lossResults.reduce((s, r) => s + r.pips, 0) / lossResults.length) : 0
  }, [backtestResults])

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
          <div className="flex gap-px bg-gray-800/40 rounded p-px ml-2">
            {([['dashboard', 'Dashboard', BarChart3], ['backtest', 'Backtest', Database], ['live', 'Live', Radio], ['ai', 'AI', Brain]] as const).map(([tab, label, Icon]) => (
              <button key={tab} onClick={() => setActiveTab(tab as AppTab)}
                className={`px-2 py-0.5 rounded text-[9px] flex items-center gap-1 transition-colors ${activeTab === tab ? 'bg-yellow-500/20 text-yellow-400' : 'text-gray-500 hover:text-gray-300'}`}>
                <Icon size={9} />{label}
              </button>
            ))}
          </div>
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
            <span className={`text-[9px] ${currentStreak.type === 'WIN' ? 'text-green-400' : currentStreak.type === 'LOSS' ? 'text-red-400' : 'text-gray-500'}`}>
              streak:{currentStreak.count}{currentStreak.type === 'WIN' ? 'W' : currentStreak.type === 'LOSS' ? 'L' : '-'}
            </span>
            <span className="text-orange-400 text-[9px]">dd:{maxDrawdown}p</span>
            <span className="text-cyan-400 text-[9px]">pf:{profitFactor}</span>
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
            <button onClick={exportBacktestCSV} className="p-0.5 rounded hover:bg-gray-800 text-gray-400 hover:text-cyan-400" title="Export CSV">
              <Download size={12} />
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

      {/* TAB CONTENT */}
      {activeTab === 'dashboard' && (
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
          <div className="bg-[#0d1321] rounded border border-gray-800/30 flex-[2] min-h-0">
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
                <div className="w-1/2 space-y-0.5 pr-2 text-[9px]">
                  <div className="flex justify-between"><span className="text-gray-500">Win Rate</span><span className="text-green-400 font-bold">{winRate}%</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Total Pips</span><span className="text-yellow-400 font-bold">{totalPips}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Total PnL</span><span className={`font-bold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>${totalPnl.toFixed(0)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Avg Win</span><span className="text-green-400">+{avgWinPips}p</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Avg Loss</span><span className="text-red-400">{avgLossPips}p</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Max DD</span><span className="text-orange-400">{maxDrawdown}p</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">PF</span><span className="text-cyan-400">{profitFactor}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Streak</span><span className={currentStreak.type === 'WIN' ? 'text-green-400' : 'text-red-400'}>{currentStreak.count}{currentStreak.type === 'WIN' ? 'W' : 'L'}</span></div>
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
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">Time</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">Msgs</th>
                  <th className="px-1.5 py-0.5 text-left text-gray-500 font-medium">Verify</th>
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
                    <td className="px-1.5 py-0.5 text-gray-500 font-mono text-[8px]">{new Date(r.entryTime).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td>
                    <td className="px-1.5 py-0.5 text-gray-500">{r.signal.contextMessages?.length || r.signal.messages.length}</td>
                    <td className="px-1.5 py-0.5">
                      <a href={r.verificationUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300" title="Verify on TradingView" onClick={e => e.stopPropagation()}>
                        <ExternalLink size={8} />
                      </a>
                    </td>
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
      )}

      {/* BACKTEST TAB */}
      {activeTab === 'backtest' && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0 p-1 gap-1">
          <div className="bg-[#0d1321] rounded border border-gray-800/30 p-2 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database size={14} className="text-cyan-400" />
                <span className="text-sm font-bold text-white">Backtest - Full Channel Import</span>
                <span className="text-[9px] text-gray-500 font-mono">{telegramChannelId}</span>
              </div>
              <div className="flex items-center gap-2">
                {btRunning ? (
                  <div className="flex items-center gap-2">
                    <Loader2 size={12} className="animate-spin text-cyan-400" />
                    <span className="text-[10px] text-cyan-400">Fetching... {btFetched} messages</span>
                  </div>
                ) : (
                  <button onClick={startBacktest} disabled={telegram.authStep !== 'connected'}
                    className="px-3 py-1 rounded bg-cyan-600 text-white text-[10px] hover:bg-cyan-700 disabled:opacity-50 flex items-center gap-1">
                    <Play size={10} />Start Backtest
                  </button>
                )}
                {btComplete && <span className="text-[9px] text-green-400 flex items-center gap-1"><CheckCircle2 size={9} />Complete</span>}
              </div>
            </div>
            {btRunning && (
              <div className="mt-1 flex items-center gap-2">
                <div className="flex-1 bg-gray-800 rounded-full h-1">
                  <div className="bg-cyan-500 h-1 rounded-full transition-all" style={{ width: `${Math.min(100, btFetched / 50)}%` }} />
                </div>
                <span className="text-[8px] text-gray-500 font-mono">{btMessages.length} msgs → {btSignals.length} sigs | W:{btResults.filter(r => r.result === 'WIN').length} L:{btResults.filter(r => r.result === 'LOSS').length}</span>
              </div>
            )}
          </div>

          <div className="flex-1 grid grid-cols-12 gap-1 min-h-0 overflow-hidden">
            {/* BT Stats */}
            <div className="col-span-3 bg-[#0d1321] rounded border border-gray-800/30 flex flex-col min-h-0">
              <div className="px-2 py-1 border-b border-gray-800/50 flex-shrink-0">
                <span className="text-[10px] font-bold text-gray-300">Backtest Results</span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                <div className="grid grid-cols-2 gap-1">
                  <div className="bg-gray-900/50 rounded p-1.5">
                    <div className="text-[8px] text-gray-500">Messages</div>
                    <div className="text-sm font-bold text-white">{btMessages.length}</div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-1.5">
                    <div className="text-[8px] text-gray-500">Signals</div>
                    <div className="text-sm font-bold text-yellow-400">{btSignals.length}</div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-1.5">
                    <div className="text-[8px] text-gray-500">Wins</div>
                    <div className="text-sm font-bold text-green-400">{btResults.filter(r => r.result === 'WIN').length}</div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-1.5">
                    <div className="text-[8px] text-gray-500">Losses</div>
                    <div className="text-sm font-bold text-red-400">{btResults.filter(r => r.result === 'LOSS').length}</div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-1.5">
                    <div className="text-[8px] text-gray-500">Win Rate</div>
                    <div className="text-sm font-bold text-blue-400">
                      {btSignals.length > 0 ? ((btResults.filter(r => r.result === 'WIN').length / btSignals.length) * 100).toFixed(1) : '0'}%
                    </div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-1.5">
                    <div className="text-[8px] text-gray-500">Total Pips</div>
                    <div className={`text-sm font-bold ${btResults.reduce((s, r) => s + r.pips, 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {btResults.reduce((s, r) => s + r.pips, 0)}
                    </div>
                  </div>
                  <div className="col-span-2 bg-gray-900/50 rounded p-1.5">
                    <div className="text-[8px] text-gray-500">Total PnL</div>
                    <div className={`text-lg font-bold ${btResults.reduce((s, r) => s + r.pnlUsd, 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      ${btResults.reduce((s, r) => s + r.pnlUsd, 0).toFixed(0)}
                    </div>
                  </div>
                </div>
                {/* BT signal list with detail */}
                <div className="text-[8px] text-gray-500 uppercase tracking-wider mt-2 flex justify-between">
                  <span>Signals ({btSignals.length})</span>
                  <span>Head: {btSignals[0]?.timestamp.toLocaleDateString() || '-'} | Latest: {btSignals[btSignals.length - 1]?.timestamp.toLocaleDateString() || '-'}</span>
                </div>
                <div className="space-y-0.5">
                  {btSignals.map((sig, i) => {
                    const r = btResults[i]
                    const runnerStatus = sig.tpHits.length > 0 ? (sig.tpHits.length >= 2 ? 'CLOSED' : 'RUNNER → BE') : (sig.status === 'SL_HIT' ? 'CLOSED' : 'PENDING')
                    return (
                      <div key={sig.id} className={`bg-gray-900/30 rounded px-1.5 py-0.5 text-[8px] border-l-2 ${r?.result === 'WIN' ? 'border-l-green-500' : r?.result === 'LOSS' ? 'border-l-red-500' : 'border-l-gray-700'}`}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <span className={sig.direction === 'BUY' ? 'text-green-400' : 'text-red-400'}>{sig.direction}</span>
                            <span className="text-gray-500 font-mono">{sig.entryLow}-{sig.entryHigh}</span>
                            <span className="text-gray-600">{sig.timestamp.toLocaleDateString()}</span>
                          </div>
                          {r && (
                            <div className="flex items-center gap-1">
                              <span className={`font-mono font-bold ${r.pips >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {r.pips > 0 ? '+' : ''}{r.pips}p
                              </span>
                              <span className={`px-0.5 rounded text-[7px] ${r.result === 'WIN' ? 'bg-green-500/10 text-green-400' : r.result === 'LOSS' ? 'bg-red-500/10 text-red-400' : 'bg-yellow-500/10 text-yellow-400'}`}>
                                {r.result}
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 text-[7px] text-gray-600 mt-0.5">
                          <span>E:{r?.entryPrice || '-'}</span><span>→</span><span>X:{r?.exitPrice || '-'}</span>
                          <span>|</span><span>SL:{sig.stopLoss}</span>
                          <span>|</span>{sig.takeProfits.map((tp, j) => (
                            <span key={j} className={sig.tpHits.includes(j + 1) ? 'text-green-400' : ''}>
                              TP{j + 1}:{tp}{sig.tpHits.includes(j + 1) ? '\u2713' : ''}
                            </span>
                          ))}
                          <span>|</span><span className={runnerStatus === 'RUNNER \u2192 BE' ? 'text-yellow-400' : runnerStatus === 'CLOSED' ? 'text-gray-500' : 'text-blue-400'}>{runnerStatus}</span>
                          {r && r.duration > 0 && <><span>|</span><span>{r.duration}m</span></>}
                          {r && <><span>|</span><a href={r.verificationUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 flex items-center gap-0.5" onClick={e => e.stopPropagation()}><ExternalLink size={7} />TV</a></>}
                        </div>
                        <div className="text-[6px] text-gray-700 mt-0.5">
                          {sig.timestamp.toLocaleString()} → {r ? new Date(r.exitTime).toLocaleString() : '-'}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* BT Chart Area */}
            <div className="col-span-9 flex flex-col min-h-0 gap-1">
              <div className="bg-[#0d1321] rounded border border-gray-800/30 flex-1 min-h-0 p-1">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={btResults.map((r, i) => ({
                    name: `S${i + 1}`, pips: r.pips, pnl: r.pnlUsd,
                    fill: r.result === 'WIN' ? '#22c55e' : r.result === 'LOSS' ? '#ef4444' : '#eab308'
                  }))} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 9 }} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 9 }} />
                    <Tooltip contentStyle={{ backgroundColor: '#0d1321', border: '1px solid #1f2937', borderRadius: '4px', fontSize: '10px' }}
                      formatter={(value: number) => [`${value} pips`, 'Pips']} />
                    <Bar dataKey="pips" radius={[2, 2, 0, 0]}>
                      {btResults.map((r, i) => <Cell key={i} fill={r.result === 'WIN' ? '#22c55e' : r.result === 'LOSS' ? '#ef4444' : '#eab308'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-[#0d1321] rounded border border-gray-800/30 flex-1 min-h-0 p-1">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={btResults.reduce((acc: { name: string; pips: number; pnl: number }[], r, i) => {
                    const prev = acc.length > 0 ? acc[acc.length - 1] : { pips: 0, pnl: 0 }
                    acc.push({ name: `S${i + 1}`, pips: prev.pips + r.pips, pnl: prev.pnl + r.pnlUsd })
                    return acc
                  }, [])} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                    <defs>
                      <linearGradient id="btGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="name" tick={{ fill: '#6b7280', fontSize: 9 }} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 9 }} />
                    <Tooltip contentStyle={{ backgroundColor: '#0d1321', border: '1px solid #1f2937', borderRadius: '4px', fontSize: '10px' }}
                      formatter={(value: number, name: string) => [name === 'pips' ? `${value} pips` : `$${value}`, name]} />
                    <Area type="monotone" dataKey="pips" stroke="#06b6d4" strokeWidth={2} fill="url(#btGrad)" dot={{ fill: '#06b6d4', r: 2 }} />
                    <Line type="monotone" dataKey="pnl" stroke="#eab308" strokeWidth={1} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* LIVE TRADING TAB */}
      {activeTab === 'live' && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0 p-1 gap-1">
          <div className="bg-[#0d1321] rounded border border-gray-800/30 p-2 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Radio size={14} className={liveRunning ? 'text-green-400 animate-pulse' : 'text-gray-500'} />
                <span className="text-sm font-bold text-white">Live Trading</span>
                <span className="text-[9px] text-gray-500 font-mono">{telegramChannelId}</span>
                {liveRunning && (
                  <span className="flex items-center gap-1 text-[9px] text-green-400">
                    <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" /></span>
                    LIVE
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {liveRunning ? (
                  <button onClick={stopLiveTrading} className="px-3 py-1 rounded bg-red-600 text-white text-[10px] hover:bg-red-700 flex items-center gap-1">
                    <XCircle size={10} />Stop
                  </button>
                ) : (
                  <button onClick={startLiveTrading} disabled={telegram.authStep !== 'connected'}
                    className="px-3 py-1 rounded bg-green-600 text-white text-[10px] hover:bg-green-700 disabled:opacity-50 flex items-center gap-1">
                    <Play size={10} />Start Live
                  </button>
                )}
                <div className="flex items-center gap-2 text-[9px]">
                  <span className="text-gray-500">{liveMessages.length} msgs</span>
                  <span className="text-yellow-400">{liveSignals.length} sigs</span>
                  <span className="text-green-400">W:{liveResults.filter(r => r.result === 'WIN').length}</span>
                  <span className="text-red-400">L:{liveResults.filter(r => r.result === 'LOSS').length}</span>
                  {liveResults.length > 0 && <span className={`font-bold ${liveResults.reduce((s, r) => s + r.pips, 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {liveResults.reduce((s, r) => s + r.pips, 0)}p
                  </span>}
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 grid grid-cols-12 gap-1 min-h-0 overflow-hidden">
            {/* Live Signal Feed */}
            <div className="col-span-4 bg-[#0d1321] rounded border border-gray-800/30 flex flex-col min-h-0">
              <div className="px-2 py-1 border-b border-gray-800/50 flex-shrink-0 flex items-center justify-between">
                <span className="text-[10px] font-bold text-gray-300 flex items-center gap-1"><Zap size={10} className="text-yellow-400" />Signals ({liveSignals.length})</span>
                {liveSignals.length > 0 && <span className="text-[8px] text-gray-600">Latest: {liveSignals[liveSignals.length - 1]?.timestamp.toLocaleString()}</span>}
              </div>
              <div className="flex-1 overflow-y-auto p-1 space-y-0.5 min-h-0">
                {liveSignals.slice().reverse().map(sig => {
                  const r = liveResults.find(lr => lr.signalId === sig.id)
                  const runnerStatus = sig.tpHits.length > 0 ? (sig.tpHits.length >= 2 ? 'CLOSED' : 'RUNNER') : (sig.status === 'SL_HIT' ? 'SL' : sig.status === 'ACTIVE' ? 'ACTIVE' : 'OPEN')
                  return (
                    <div key={sig.id} className={`bg-gray-900/30 rounded p-1.5 border-l-2 ${r?.result === 'WIN' ? 'border-l-green-500' : r?.result === 'LOSS' ? 'border-l-red-500' : sig.status === 'ACTIVE' ? 'border-l-blue-500' : 'border-l-gray-700'}`}>
                      <div className="flex items-center justify-between mb-0.5">
                        <div className="flex items-center gap-1">
                          {sig.direction === 'BUY' ? <ArrowUpRight size={10} className="text-green-400" /> : <ArrowDownRight size={10} className="text-red-400" />}
                          <span className={`font-bold text-[10px] ${sig.direction === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{sig.direction}</span>
                          <span className="text-gray-500 font-mono text-[8px]">{sig.entryLow}-{sig.entryHigh}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className={`px-1 rounded text-[7px] ${runnerStatus === 'RUNNER' ? 'bg-yellow-500/10 text-yellow-400' : runnerStatus === 'ACTIVE' ? 'bg-blue-500/10 text-blue-400' : runnerStatus === 'SL' ? 'bg-red-500/10 text-red-400' : runnerStatus === 'CLOSED' ? 'bg-gray-500/10 text-gray-500' : 'bg-cyan-500/10 text-cyan-400'}`}>{runnerStatus}</span>
                          {r && <span className={`font-mono font-bold text-[9px] ${r.pips >= 0 ? 'text-green-400' : 'text-red-400'}`}>{r.pips > 0 ? '+' : ''}{r.pips}p</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 text-[7px] text-gray-600">
                        <span className="text-red-400/60">SL:{sig.stopLoss}</span>
                        {sig.takeProfits.map((tp, j) => (
                          <span key={j} className={sig.tpHits.includes(j + 1) ? 'text-green-400' : ''}>TP{j + 1}:{tp}{sig.tpHits.includes(j + 1) ? '\u2713' : ''}</span>
                        ))}
                        <span className="ml-auto">{sig.timestamp.toLocaleTimeString()}</span>
                      </div>
                      {sig.contextMessages && sig.contextMessages.length > 0 && (
                        <div className="text-[7px] text-gray-700 mt-0.5 flex items-center gap-1">
                          <Link2 size={7} />{sig.contextMessages.length} linked msgs | {sig.messages.length} updates
                        </div>
                      )}
                    </div>
                  )
                })}
                {liveSignals.length === 0 && (
                  <div className="text-center py-8 text-gray-600 text-[10px]">
                    <Radio size={20} className="mx-auto mb-2 opacity-20" />
                    {liveRunning ? 'Waiting for signals...' : 'Start live to begin'}
                  </div>
                )}
              </div>
            </div>

            {/* Live Message Feed */}
            <div className="col-span-8 bg-[#0d1321] rounded border border-gray-800/30 flex flex-col min-h-0">
              <div className="px-2 py-1 border-b border-gray-800/50 flex-shrink-0">
                <span className="text-[10px] font-bold text-gray-300 flex items-center gap-1"><MessageSquare size={10} className="text-blue-400" />Live Message Feed ({liveMessages.length})</span>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0 divide-y divide-gray-800/20">
                {liveMessages.slice().reverse().map(msg => {
                  const typeColor: Record<string, string> = {
                    SIGNAL: 'border-l-blue-500 bg-blue-950/10', UPDATE: 'border-l-green-500 bg-green-950/10',
                    PROMO: 'border-l-red-500 bg-red-950/5', GREETING: 'border-l-gray-600', UNKNOWN: 'border-l-gray-800'
                  }
                  return (
                    <div key={msg.id} className={`px-2 py-1 border-l-2 ${typeColor[msg.type]}`}>
                      <div className="flex items-center gap-1">
                        <span className="text-[8px] text-gray-600 font-mono">{msg.timestamp.toLocaleString()}</span>
                        <span className={`px-0.5 rounded text-[7px] ${msg.type === 'SIGNAL' ? 'bg-blue-500/20 text-blue-400' : msg.type === 'UPDATE' ? 'bg-green-500/20 text-green-400' : msg.type === 'PROMO' ? 'bg-red-500/20 text-red-400' : 'bg-gray-500/10 text-gray-500'}`}>{msg.type}</span>
                        {msg.linkedSignalId && <span className="text-yellow-400/50 text-[7px]">[{msg.linkedSignalId}]</span>}
                      </div>
                      <p className="text-[9px] text-gray-400 whitespace-pre-wrap leading-tight mt-0.5">{msg.text}</p>
                    </div>
                  )
                })}
                {liveMessages.length === 0 && (
                  <div className="text-center py-8 text-gray-600 text-[10px]">
                    <Activity size={20} className="mx-auto mb-2 opacity-20" />
                    {liveRunning ? 'Listening for messages...' : 'Start live trading to see messages'}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AI ANALYSIS TAB */}
      {activeTab === 'ai' && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0 p-1 gap-1">
          {/* Prompt Template Editor */}
          <div className="bg-[#0d1321] rounded border border-gray-800/30 p-2 flex-shrink-0">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Brain size={14} className="text-purple-400" />
                <span className="text-sm font-bold text-white">AI Prompt Engineer</span>
                <span className="text-[9px] text-gray-500">Bind signals to context messages and analyze decision-making</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={runAllAIPrompts} disabled={isProcessing || signals.length === 0}
                  className="px-3 py-1 rounded bg-purple-600 text-white text-[10px] hover:bg-purple-700 disabled:opacity-50 flex items-center gap-1">
                  {isProcessing ? <Loader2 size={10} className="animate-spin" /> : <Zap size={10} />}
                  Analyze All ({signals.length})
                </button>
                {isProcessing && <span className="text-[9px] text-purple-400">{processStep}/{signals.length}</span>}
              </div>
            </div>
            <textarea value={aiPromptTemplate} onChange={e => setAiPromptTemplate(e.target.value)} rows={3}
              className="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1 text-[9px] text-gray-300 font-mono focus:border-purple-500 focus:outline-none resize-y" />
            <div className="text-[8px] text-gray-600 mt-0.5">Variables: {'{signal_details}'} {'{msg_count}'} {'{messages}'}</div>
          </div>

          {/* AI Results Grid */}
          <div className="flex-1 grid grid-cols-12 gap-1 min-h-0 overflow-hidden">
            {/* Signal List for AI */}
            <div className="col-span-3 bg-[#0d1321] rounded border border-gray-800/30 flex flex-col min-h-0">
              <div className="px-2 py-1 border-b border-gray-800/50 flex-shrink-0">
                <span className="text-[10px] font-bold text-gray-300">Signal &rarr; Messages Binding</span>
              </div>
              <div className="flex-1 overflow-y-auto p-1 space-y-0.5 min-h-0">
                {signals.map(sig => {
                  const hasOutput = aiOutputs[sig.id]
                  return (
                    <div key={sig.id} onClick={() => setSelectedSignal(sig)}
                      className={`rounded p-1.5 cursor-pointer border transition-all ${selectedSignal?.id === sig.id ? 'border-purple-500 bg-purple-500/5' : 'border-gray-800/30 bg-gray-900/30 hover:border-gray-600'}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1">
                          <span className={`text-[10px] font-bold ${sig.direction === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>{sig.direction}</span>
                          <span className="text-gray-500 font-mono text-[9px]">{sig.id}</span>
                        </div>
                        {hasOutput ? (
                          hasOutput.loading ? <Loader2 size={8} className="animate-spin text-purple-400" /> :
                            <CheckCircle2 size={8} className="text-purple-400" />
                        ) : (
                          <button onClick={(e) => { e.stopPropagation(); runAIPrompt(sig) }}
                            className="text-[8px] px-1 py-0.5 rounded bg-purple-600/20 text-purple-400 hover:bg-purple-600/30">
                            Run
                          </button>
                        )}
                      </div>
                      <div className="text-[8px] text-gray-600 mt-0.5">
                        {sig.contextMessages?.length || 0} msgs linked | {sig.takeProfits.length} TPs | SL:{sig.stopLoss}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* AI Output Panel */}
            <div className="col-span-9 flex flex-col min-h-0 gap-1">
              {selectedSignal && (
                <>
                  {/* Context Messages for Selected Signal */}
                  <div className="bg-[#0d1321] rounded border border-gray-800/30 flex-1 flex flex-col min-h-0">
                    <div className="px-2 py-1 border-b border-gray-800/50 flex items-center justify-between flex-shrink-0">
                      <span className="text-[10px] font-bold text-gray-300 flex items-center gap-1">
                        <Link2 size={10} className="text-blue-400" />
                        Bound Messages: {selectedSignal.id} ({selectedSignal.contextMessages?.length || 0} msgs before next signal)
                      </span>
                      <span className="text-[9px] text-gray-500">
                        {selectedSignal.direction} {selectedSignal.entryLow}-{selectedSignal.entryHigh} | SL:{selectedSignal.stopLoss} | TPs:{selectedSignal.takeProfits.join(',')}
                      </span>
                    </div>
                    <div className="flex-1 overflow-y-auto min-h-0 divide-y divide-gray-800/20">
                      {selectedSignal.contextMessages?.map(msg => (
                        <div key={msg.id} className={`px-2 py-0.5 border-l-2 ${msg.type === 'SIGNAL' ? 'border-l-blue-500 bg-blue-950/5' : msg.type === 'UPDATE' ? 'border-l-green-500 bg-green-950/5' : msg.type === 'PROMO' ? 'border-l-red-500' : 'border-l-gray-800'}`}>
                          <div className="flex items-center gap-1">
                            <span className="text-[7px] text-gray-600 font-mono">{msg.timestamp.toLocaleString()}</span>
                            <span className={`px-0.5 rounded text-[6px] ${msg.type === 'SIGNAL' ? 'bg-blue-500/20 text-blue-400' : msg.type === 'UPDATE' ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/10 text-gray-500'}`}>{msg.type}</span>
                          </div>
                          <p className="text-[8px] text-gray-400 whitespace-pre-wrap leading-tight">{msg.text}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* AI Response */}
                  <div className="bg-[#0d1321] rounded border border-purple-800/30 flex-1 flex flex-col min-h-0">
                    <div className="px-2 py-1 border-b border-purple-800/50 flex items-center justify-between flex-shrink-0 bg-purple-900/10">
                      <span className="text-[10px] font-bold text-purple-300 flex items-center gap-1">
                        <Brain size={10} />AI Analysis Output - {selectedSignal.id}
                      </span>
                      <button onClick={() => runAIPrompt(selectedSignal)} disabled={aiOutputs[selectedSignal.id]?.loading}
                        className="px-2 py-0.5 rounded bg-purple-600/20 text-purple-400 hover:bg-purple-600/30 text-[9px] flex items-center gap-0.5 disabled:opacity-50">
                        {aiOutputs[selectedSignal.id]?.loading ? <Loader2 size={8} className="animate-spin" /> : <Zap size={8} />}
                        {aiOutputs[selectedSignal.id] ? 'Re-run' : 'Run'}
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 min-h-0">
                      {aiOutputs[selectedSignal.id] ? (
                        aiOutputs[selectedSignal.id].loading ? (
                          <div className="flex items-center gap-2 text-purple-400 text-[10px]"><Loader2 size={12} className="animate-spin" />Sending prompt with {selectedSignal.contextMessages?.length || 0} bound messages...</div>
                        ) : aiOutputs[selectedSignal.id].error ? (
                          <div className="text-red-400 text-[10px]">{aiOutputs[selectedSignal.id].error}</div>
                        ) : (
                          <div className="space-y-2">
                            <div>
                              <div className="text-[8px] text-purple-400/50 uppercase tracking-wider mb-0.5">Prompt Sent</div>
                              <pre className="text-[8px] text-gray-600 bg-gray-950/50 rounded p-1.5 whitespace-pre-wrap max-h-[80px] overflow-y-auto font-mono">{aiOutputs[selectedSignal.id].prompt}</pre>
                            </div>
                            <div>
                              <div className="text-[8px] text-purple-400/50 uppercase tracking-wider mb-0.5">AI Response</div>
                              <pre className="text-[9px] text-gray-300 bg-gray-950/50 rounded p-1.5 whitespace-pre-wrap font-mono leading-relaxed">{aiOutputs[selectedSignal.id].response}</pre>
                            </div>
                          </div>
                        )
                      ) : (
                        <div className="text-center py-6 text-gray-600 text-[10px]">
                          <Brain size={24} className="mx-auto mb-2 opacity-20" />
                          Click "Run" to analyze this signal with AI<br />
                          <span className="text-[8px] text-gray-700">The prompt will include {selectedSignal.contextMessages?.length || 0} bound context messages</span>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
              {!selectedSignal && (
                <div className="bg-[#0d1321] rounded border border-gray-800/30 flex-1 flex items-center justify-center">
                  <div className="text-center text-gray-600 text-[10px]">
                    <Brain size={24} className="mx-auto mb-2 opacity-20" />
                    Select a signal to view bound messages and AI analysis
                  </div>
                </div>
              )}

              {/* AI CHAT PANEL */}
              <div className="bg-[#0d1321] rounded border border-purple-800/30 flex flex-col" style={{height: '200px'}}>
                <div className="px-2 py-1 border-b border-purple-800/50 flex items-center justify-between flex-shrink-0 bg-purple-900/10">
                  <span className="text-[10px] font-bold text-purple-300 flex items-center gap-1">
                    <MessageSquare size={10} />AI Chat
                  </span>
                  <span className="text-[8px] text-gray-600">meta-llama/llama-3.1-8b-instruct:free</span>
                </div>
                <div className="flex-1 overflow-y-auto p-1.5 space-y-1 min-h-0">
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`text-[9px] ${msg.role === 'user' ? 'text-right' : msg.role === 'system' ? 'text-center' : 'text-left'}`}>
                      {msg.role === 'system' ? (
                        <span className="text-gray-600 italic">{msg.content}</span>
                      ) : (
                        <div className={`inline-block max-w-[85%] px-2 py-1 rounded-lg ${msg.role === 'user' ? 'bg-blue-600/20 text-blue-300 rounded-br-none' : 'bg-gray-800/50 text-gray-300 rounded-bl-none'}`}>
                          <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                          <span className="text-[7px] text-gray-600 block mt-0.5">{msg.timestamp.toLocaleTimeString()}</span>
                        </div>
                      )}
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="flex items-center gap-1 text-purple-400 text-[9px]">
                      <Loader2 size={10} className="animate-spin" />Thinking...
                    </div>
                  )}
                </div>
                <div className="p-1.5 border-t border-gray-800/50 flex gap-1 flex-shrink-0">
                  <input
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(chatInput) } }}
                    placeholder="Ask about signals, patterns, risk..."
                    className="flex-1 bg-gray-900/50 border border-gray-800 rounded px-2 py-1 text-[9px] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-purple-600"
                  />
                  <button
                    onClick={() => sendChatMessage(chatInput)}
                    disabled={chatLoading || !chatInput.trim()}
                    className="px-2 py-1 rounded bg-purple-600/30 text-purple-400 hover:bg-purple-600/40 disabled:opacity-30 text-[9px] flex items-center gap-0.5"
                  >
                    <Send size={8} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* FLOATING RUNNING TASKS INDICATOR */}
      {(btRunning || liveRunning || isProcessing) && (
        <div className="fixed bottom-3 right-3 bg-[#0d1321] border border-gray-700 rounded-lg shadow-xl p-2 min-w-[160px] z-50">
          <div className="text-[9px] font-bold text-gray-400 mb-1 flex items-center gap-1">
            <Loader2 size={10} className="animate-spin text-yellow-400" />Running Tasks
          </div>
          <div className="space-y-0.5">
            {btRunning && (
              <div className="flex items-center gap-1 text-[8px]">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                <span className="text-cyan-400">Backtest</span>
                <span className="text-gray-500 font-mono ml-auto">{btFetched} msgs</span>
              </div>
            )}
            {liveRunning && (
              <div className="flex items-center gap-1 text-[8px]">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                <span className="text-green-400">Live Trading</span>
                <span className="text-gray-500 font-mono ml-auto">{liveMessages.length} msgs</span>
              </div>
            )}
            {isProcessing && (
              <div className="flex items-center gap-1 text-[8px]">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
                <span className="text-purple-400">AI Analysis</span>
                <span className="text-gray-500 font-mono ml-auto">{processStep}/{signals.length}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
