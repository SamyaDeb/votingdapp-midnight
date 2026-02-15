import { useState, useEffect, useCallback } from 'react'
import './App.css'

const API_BASE = 'http://127.0.0.1:4000'

interface VotingState {
  yes_votes: number
  no_votes: number
  voters_count: number
  is_open: boolean
}

interface ServerStatus {
  ready: boolean
  error: string | null
  walletAddress: string
  contractAddress: string
  network: string
}

function App() {
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [state, setState] = useState<VotingState | null>(null)
  const [loading, setLoading] = useState(true)
  const [voting, setVoting] = useState(false)
  const [lastTxHash, setLastTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionLog, setActionLog] = useState<string[]>([])

  const addLog = useCallback((msg: string) => {
    setActionLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 19)])
  }, [])

  // Poll server status until ready
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>
    const checkStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/status`)
        const data: ServerStatus = await res.json()
        setStatus(data)
        if (data.ready) {
          setLoading(false)
          clearInterval(interval)
          addLog('Server ready — wallet connected ✓')
          // Fetch initial state
          fetchState()
        } else if (data.error) {
          setError(data.error)
          setLoading(false)
          clearInterval(interval)
        }
      } catch {
        // Server not up yet, keep polling
      }
    }
    checkStatus()
    interval = setInterval(checkStatus, 2000)
    return () => clearInterval(interval)
  }, [addLog])

  const fetchState = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/state`)
      if (res.ok) {
        const data: VotingState = await res.json()
        setState(data)
      }
    } catch (err: any) {
      addLog(`Error fetching state: ${err.message}`)
    }
  }

  const castVote = async (choice: boolean) => {
    setVoting(true)
    setError(null)
    setLastTxHash(null)
    addLog(`Casting vote: ${choice ? 'YES ✅' : 'NO ❌'}...`)
    try {
      const res = await fetch(`${API_BASE}/api/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }),
      })
      const data = await res.json()
      if (res.ok) {
        setLastTxHash(data.txHash)
        addLog(`Vote submitted! Tx: ${data.txHash}`)
        // Refresh state after a short delay
        setTimeout(fetchState, 3000)
      } else {
        setError(data.error)
        addLog(`Vote failed: ${data.error}`)
      }
    } catch (err: any) {
      setError(err.message)
      addLog(`Vote error: ${err.message}`)
    } finally {
      setVoting(false)
    }
  }

  const openVoting = async () => {
    setVoting(true)
    addLog('Opening voting...')
    try {
      const res = await fetch(`${API_BASE}/api/open`, { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        setLastTxHash(data.txHash)
        addLog(`Voting opened! Tx: ${data.txHash}`)
        setTimeout(fetchState, 3000)
      } else {
        addLog(`Open failed: ${data.error}`)
      }
    } catch (err: any) {
      addLog(`Open error: ${err.message}`)
    } finally {
      setVoting(false)
    }
  }

  const closeVoting = async () => {
    setVoting(true)
    addLog('Closing voting...')
    try {
      const res = await fetch(`${API_BASE}/api/close`, { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        setLastTxHash(data.txHash)
        addLog(`Voting closed! Tx: ${data.txHash}`)
        setTimeout(fetchState, 3000)
      } else {
        addLog(`Close failed: ${data.error}`)
      }
    } catch (err: any) {
      addLog(`Close error: ${err.message}`)
    } finally {
      setVoting(false)
    }
  }

  // Loading screen
  if (loading) {
    return (
      <div className="app">
        <div className="loading-container">
          <div className="spinner"></div>
          <h2>Connecting to Midnight Network...</h2>
          <p className="loading-sub">Syncing wallet & joining contract</p>
          {status && (
            <div className="status-detail">
              <span className="dot pulse"></span>
              <span>{status.ready ? 'Ready' : 'Initializing...'}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Error screen
  if (error && !state) {
    return (
      <div className="app">
        <div className="error-container">
          <h2>⚠️ Connection Error</h2>
          <p>{error}</p>
          <button onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    )
  }

  const totalVotes = (state?.yes_votes ?? 0) + (state?.no_votes ?? 0)
  const yesPercent = totalVotes > 0 ? ((state?.yes_votes ?? 0) / totalVotes) * 100 : 50
  const noPercent = totalVotes > 0 ? ((state?.no_votes ?? 0) / totalVotes) * 100 : 50

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-content">
          <div className="logo">
            <span className="logo-icon">🗳️</span>
            <h1>Voting dApp</h1>
          </div>
          <div className="network-badge">
            <span className="dot green"></span>
            <span>{status?.network ?? 'devnet'}</span>
          </div>
        </div>
      </header>

      <main className="main">
        {/* Wallet Info */}
        <section className="wallet-info">
          <div className="info-row">
            <span className="label">Wallet</span>
            <span className="value mono">{status?.walletAddress?.slice(0, 20)}...{status?.walletAddress?.slice(-8)}</span>
          </div>
          <div className="info-row">
            <span className="label">Contract</span>
            <span className="value mono">{status?.contractAddress?.slice(0, 16)}...{status?.contractAddress?.slice(-8)}</span>
          </div>
        </section>

        {/* Voting Status */}
        <section className="voting-status">
          <div className={`status-badge ${state?.is_open ? 'open' : 'closed'}`}>
            {state?.is_open ? '🟢 Voting Open' : '🔴 Voting Closed'}
          </div>
        </section>

        {/* Vote Counts */}
        <section className="vote-results">
          <h2>Results</h2>
          <div className="vote-bar-container">
            <div className="vote-bar">
              <div className="yes-bar" style={{ width: `${yesPercent}%` }}>
                {totalVotes > 0 && <span>{Math.round(yesPercent)}%</span>}
              </div>
              <div className="no-bar" style={{ width: `${noPercent}%` }}>
                {totalVotes > 0 && <span>{Math.round(noPercent)}%</span>}
              </div>
            </div>
          </div>
          <div className="vote-counts">
            <div className="count yes">
              <span className="count-num">{state?.yes_votes ?? 0}</span>
              <span className="count-label">Yes Votes</span>
            </div>
            <div className="count total">
              <span className="count-num">{state?.voters_count ?? 0}</span>
              <span className="count-label">Total Voters</span>
            </div>
            <div className="count no">
              <span className="count-num">{state?.no_votes ?? 0}</span>
              <span className="count-label">No Votes</span>
            </div>
          </div>
        </section>

        {/* Voting Buttons */}
        <section className="voting-actions">
          <h2>Cast Your Vote</h2>
          <div className="vote-buttons">
            <button
              className="btn btn-yes"
              onClick={() => castVote(true)}
              disabled={voting || !state?.is_open}
            >
              {voting ? '⏳ Processing...' : '✅ Vote YES'}
            </button>
            <button
              className="btn btn-no"
              onClick={() => castVote(false)}
              disabled={voting || !state?.is_open}
            >
              {voting ? '⏳ Processing...' : '❌ Vote NO'}
            </button>
          </div>
          {!state?.is_open && (
            <p className="closed-msg">Voting is currently closed. An admin must open it first.</p>
          )}
        </section>

        {/* Admin Actions */}
        <section className="admin-actions">
          <h2>Admin Controls</h2>
          <div className="admin-buttons">
            <button className="btn btn-admin" onClick={openVoting} disabled={voting}>
              Open Voting
            </button>
            <button className="btn btn-admin" onClick={closeVoting} disabled={voting}>
              Close Voting
            </button>
            <button className="btn btn-refresh" onClick={fetchState} disabled={voting}>
              🔄 Refresh
            </button>
          </div>
        </section>

        {/* Tx Hash */}
        {lastTxHash && (
          <section className="tx-hash-section">
            <h3>Last Transaction Hash</h3>
            <div className="tx-hash">
              <code>{lastTxHash}</code>
            </div>
          </section>
        )}

        {/* Error Display */}
        {error && (
          <section className="error-section">
            <p>⚠️ {error}</p>
          </section>
        )}

        {/* Activity Log */}
        <section className="activity-log">
          <h2>Activity Log</h2>
          <div className="log-entries">
            {actionLog.length === 0 ? (
              <p className="empty-log">No activity yet</p>
            ) : (
              actionLog.map((entry, i) => (
                <div key={i} className="log-entry">{entry}</div>
              ))
            )}
          </div>
        </section>
      </main>

      <footer className="footer">
        <p>Built on Midnight Network • Zero-Knowledge Voting</p>
      </footer>
    </div>
  )
}

export default App
