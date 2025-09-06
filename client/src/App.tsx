import { BrowserRouter, Routes, Route, Link, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import axios from 'axios'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'))
  const [user, setUser] = useState<any>(() => {
    const stored = localStorage.getItem('user')
    return stored ? JSON.parse(stored) : null
  })
  function saveAuth(t: string, u: any) {
    localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify(u));
    setToken(t); setUser(u)
  }
  function logout() { localStorage.removeItem('token'); localStorage.removeItem('user'); setToken(null); setUser(null) }
  const client = axios.create({ baseURL: API_URL, headers: token ? { Authorization: `Bearer ${token}` } : {} })
  return { token, user, saveAuth, logout, client }
}

function Login() {
  const { saveAuth } = useAuth()
  const nav = useNavigate()
  const [form, setForm] = useState({ emailOrUsername: '', password: '' })
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const { data } = await axios.post(`${API_URL}/api/auth/login`, form)
    saveAuth(data.token, data.user)
    nav('/')
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <form onSubmit={onSubmit} className="bg-white rounded-lg shadow p-6 w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Login</h1>
        <input className="w-full border rounded p-2" placeholder="Email or Username" value={form.emailOrUsername} onChange={e=>setForm(f=>({...f, emailOrUsername: e.target.value}))} />
        <input type="password" className="w-full border rounded p-2" placeholder="Password" value={form.password} onChange={e=>setForm(f=>({...f, password: e.target.value}))} />
        <button className="w-full bg-blue-600 text-white rounded p-2">Sign in</button>
        <p className="text-sm text-gray-500">No account? <Link to="/signup" className="text-blue-600">Create one</Link></p>
      </form>
    </div>
  )
}

function Signup() {
  const { saveAuth } = useAuth()
  const nav = useNavigate()
  const [form, setForm] = useState({ email: '', username: '', password: '' })
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const { data } = await axios.post(`${API_URL}/api/auth/signup`, form)
    saveAuth(data.token, data.user)
    nav('/')
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <form onSubmit={onSubmit} className="bg-white rounded-lg shadow p-6 w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Sign up</h1>
        <input className="w-full border rounded p-2" placeholder="Email" value={form.email} onChange={e=>setForm(f=>({...f, email: e.target.value}))} />
        <input className="w-full border rounded p-2" placeholder="Username" value={form.username} onChange={e=>setForm(f=>({...f, username: e.target.value}))} />
        <input type="password" className="w-full border rounded p-2" placeholder="Password" value={form.password} onChange={e=>setForm(f=>({...f, password: e.target.value}))} />
        <button className="w-full bg-blue-600 text-white rounded p-2">Create account</button>
        <p className="text-sm text-gray-500">Have an account? <Link to="/login" className="text-blue-600">Sign in</Link></p>
      </form>
    </div>
  )
}

function Dashboard() {
  const { token, user, client, logout } = useAuth()
  const [session, setSession] = useState<any>(null)
  const [queue, setQueue] = useState<any[]>([])
  const [matches, setMatches] = useState<any[]>([])
  const [leaderboard, setLeaderboard] = useState<any[]>([])

  async function ensureSession() {
    const { data } = await client.get('/api/session/active')
    if (data) { setSession(data) } else {
      const res = await client.post('/api/session/start', { courts: 5, durationHours: 3 })
      setSession(res.data)
    }
  }
  async function refreshAll(sid: string) {
    const [q, m, l] = await Promise.all([
      client.get(`/api/session/${sid}/queue`),
      client.get(`/api/session/${sid}/matches`),
      client.get('/api/leaderboard')
    ])
    setQueue(q.data); setMatches(m.data); setLeaderboard(l.data)
  }
  async function joinQueue() {
    if (!session) return
    await client.post(`/api/session/${session.id}/queue/join`)
    await refreshAll(session.id)
  }
  async function generate() {
    if (!session) return
    await client.post(`/api/session/${session.id}/generate`)
    await refreshAll(session.id)
  }
  async function finishMatch(id: string, winnerTeam: number) {
    await client.post(`/api/match/${id}/finish`, { winnerTeam })
    if (session) await refreshAll(session.id)
  }

  useEffect(() => {
    if (!token) return
    ;(async () => { await ensureSession() })()
  }, [token])
  useEffect(() => { if (session) refreshAll(session.id) }, [session])

  if (!token) return (
    <div className="min-h-screen flex items-center justify-center">
      <Link to="/login" className="text-blue-600">Login to continue</Link>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="flex items-center justify-between p-4 bg-white shadow">
        <h1 className="font-semibold">Badminton Scheduler</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600">{user?.username} · {Math.round(user?.rating ?? 0)}</span>
          <button onClick={logout} className="text-sm text-red-600">Logout</button>
        </div>
      </header>
      <main className="p-4 grid md:grid-cols-3 gap-4">
        <section className="bg-white rounded shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Courts & Matches</h2>
            <button onClick={generate} className="bg-blue-600 text-white text-sm px-3 py-1 rounded">Generate</button>
          </div>
          <div className="space-y-2">
            {matches.map(m => (
              <div key={m.id} className="border rounded p-2 flex items-center justify-between">
                <div>
                  <div className="text-sm text-gray-600">Court {m.court} · {m.status}</div>
                  <div className="font-medium">{m.p1.username} & {m.p2.username} vs {m.p3.username} & {m.p4.username}</div>
                </div>
                {m.status !== 'FINISHED' && (
                  <div className="flex gap-2">
                    <button onClick={()=>finishMatch(m.id, 1)} className="text-xs bg-green-600 text-white px-2 py-1 rounded">Team 1 Won</button>
                    <button onClick={()=>finishMatch(m.id, 2)} className="text-xs bg-green-600 text-white px-2 py-1 rounded">Team 2 Won</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
        <section className="bg-white rounded shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Waiting Queue</h2>
            <button onClick={joinQueue} className="bg-gray-800 text-white text-sm px-3 py-1 rounded">Join Queue</button>
          </div>
          <ol className="space-y-1 list-decimal pl-5">
            {queue.map(q => (
              <li key={q.id} className="text-sm">{q.user.username} <span className="text-gray-500">({Math.round(q.user.rating)})</span></li>
            ))}
          </ol>
        </section>
        <section className="bg-white rounded shadow p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Leaderboard</h2>
            <div className="flex gap-2">
              <a className="text-sm text-blue-600" href={`${API_URL}/api/export/leaderboard.csv`}>
                CSV
              </a>
              <a className="text-sm text-blue-600" href={`${API_URL}/api/export/matches.pdf`}>
                PDF
              </a>
            </div>
          </div>
          <ol className="space-y-1 list-decimal pl-5">
            {leaderboard.map(u => (
              <li key={u.id} className="text-sm flex justify-between">
                <span>{u.username}</span>
                <span className="text-gray-500">{Math.round(u.rating)}</span>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard/>} />
        <Route path="/login" element={<Login/>} />
        <Route path="/signup" element={<Signup/>} />
      </Routes>
    </BrowserRouter>
  )
}
