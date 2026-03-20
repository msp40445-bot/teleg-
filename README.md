# Gold Signal Tracker - XAUUSD Signal Analysis & Backtesting

A frontend dashboard for tracking, analyzing, and backtesting Telegram gold (XAUUSD) trading signals. Parse signal messages, view live price data, check accuracy, and detect scam red flags.

## Features

- **Live Signal Feed** - Parses Telegram messages into structured Buy/Sell signal cards with entry zones, take profits, and stop loss levels
- **TradingView Chart** - Embedded live XAUUSD chart (15m timeframe, dark theme)
- **Backtest Analysis** - Win/loss rate, pips per signal, cumulative pips, TP hit rate charts, and detailed signal breakdown table
- **Message History & Consistency Tracker** - Full message feed with type filtering, time gap analysis to detect deleted messages, and red flag warnings
- **Telegram Bot Integration** - Connect a bot to poll live messages from signal channels
- **Paste-to-Parse** - Copy/paste exported Telegram chat history and instantly analyze it

## Local Setup (macOS)

### Prerequisites

- **Node.js** >= 18 (recommend using [nvm](https://github.com/nvm-sh/nvm) or [Homebrew](https://brew.sh))
- **npm** (comes with Node.js)

```bash
# Install Node.js via Homebrew (if not installed)
brew install node

# Or via nvm
nvm install 18
nvm use 18
```

### Installation

```bash
# Clone the repo
git clone https://github.com/msp40445-bot/teleg-.git
cd teleg-

# Install dependencies
npm install
```

### Environment Variables

The `.env` file is included in the repo with Telegram API credentials pre-configured:

```
VITE_TELEGRAM_API_ID=25535062
VITE_TELEGRAM_API_HASH=2fcff9d64e970d8fc14ddc256f02c06b
VITE_TELEGRAM_CHANNEL_ID=-1001235475731
VITE_NVIDIA_API_KEY=<your-nvidia-key>
VITE_OPENROUTER_API_KEY=<your-openrouter-key>
```

### Run Development Server

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build for Production

```bash
npm run build
```

Output is in the `dist/` folder.

### Preview Production Build

```bash
npm run preview
```

## Usage

1. **Paste Messages** - Go to Settings tab, paste Telegram chat history in `[DD/MM/YYYY HH:MM] Sender: Message` format
2. **Or Connect a Bot** - Create a Telegram bot via [@BotFather](https://t.me/BotFather), add it to the signal channel as admin, enter the bot token in Settings
3. **View Signals** - See parsed signal cards alongside a live XAUUSD TradingView chart
4. **Backtest** - Check win rate, pip performance, TP hit rates, and cumulative results
5. **History** - Review all messages, filter by type, spot time gaps (possible deletions), and read red flag analysis

## Tech Stack

- React 18 + TypeScript
- Vite
- Tailwind CSS
- Recharts (charting)
- Lucide React (icons)
- TradingView Widget (live price chart)
- Telegram Bot API (live message polling)

## Signal Format

The parser recognizes this Telegram signal format:

```
GOLD Buy 4999-4996      <- Direction + Entry Zone
TP 5010                 <- Take Profit 1
TP 5015                 <- Take Profit 2
TP 5020                 <- Take Profit 3
SL 4989                 <- Stop Loss

Active 4996             <- Activation price
TP 1 HIT 140+ Pips     <- TP hit confirmation
SL hit                  <- Stop loss hit
All Target Complete     <- All TPs hit
```
