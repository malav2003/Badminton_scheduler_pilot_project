import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { PrismaClient, MatchStatus } from '@prisma/client';
import { z } from 'zod';
import dayjs from 'dayjs';
import { format as csvFormat } from '@fast-csv/format';
import PDFDocument from 'pdfkit';

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

function signToken(userId: string) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req: any, res: any, next: any) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Missing token' });
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    req.userId = payload.sub;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function expectedScore(ratingA: number, ratingB: number) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}
function eloUpdate(current: number, expected: number, score: number, k = 32) {
  return current + k * (score - expected);
}
function averageTeamRating(a: number, b: number) { return (a + b) / 2; }

async function generateUpcomingMatches(sessionId: string) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error('Session not found');

  const inUse = await prisma.match.count({ where: { sessionId, status: { in: [MatchStatus.SCHEDULED, MatchStatus.ONGOING] } } });
  const availableCourts = Math.max(0, session.courts - inUse);
  if (availableCourts <= 0) return [] as any[];

  const queue = await prisma.waitingQueueEntry.findMany({
    where: { sessionId },
    include: { user: true },
    orderBy: [{ position: 'asc' }, { joinedAt: 'asc' }],
  });

  const players = queue.map(q => q.user);
  players.sort((a, b) => a.rating - b.rating);

  const usedCourts = new Set((await prisma.match.findMany({ where: { sessionId, status: { in: [MatchStatus.SCHEDULED, MatchStatus.ONGOING] } }, select: { court: true } })).map(m => m.court));
  const created: any[] = [];

  let court = 1;
  while (usedCourts.has(court)) court++;

  for (let i = 0; i + 3 < players.length && created.length < availableCourts; i += 4) {
    if (Math.random() < 0.2 && i + 4 < players.length) {
      const tmp = players[i + 3];
      players[i + 3] = players[i + 4];
      players[i + 4] = tmp;
    }
    const group = players.slice(i, i + 4);
    const match = await prisma.match.create({ data: { sessionId, court, status: MatchStatus.SCHEDULED, p1Id: group[0].id, p2Id: group[1].id, p3Id: group[2].id, p4Id: group[3].id } });
    created.push(match);
    await prisma.waitingQueueEntry.deleteMany({ where: { sessionId, userId: { in: group.map(g => g.id) } } });
    court++;
    while (usedCourts.has(court)) court++;
  }
  return created;
}

app.post('/api/auth/signup', async (req, res) => {
  const schema = z.object({ email: z.string().email(), username: z.string().min(3), password: z.string().min(6) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { email, username, password } = parsed.data;
  const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } });
  if (existing) return res.status(400).json({ error: 'Email or username already used' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { email, username, passwordHash } });
  res.json({ token: signToken(user.id), user });
});

app.post('/api/auth/login', async (req, res) => {
  const schema = z.object({ emailOrUsername: z.string(), password: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { emailOrUsername, password } = parsed.data;
  const user = await prisma.user.findFirst({ where: { OR: [{ email: emailOrUsername }, { username: emailOrUsername }] } });
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(user.id), user });
});

app.post('/api/session/start', authMiddleware, async (req, res) => {
  const schema = z.object({ courts: z.number().min(1).max(20).default(5), durationHours: z.number().min(1).max(6).default(3) });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { courts, durationHours } = parsed.data;
  const start = new Date();
  const end = dayjs(start).add(durationHours, 'hour').toDate();
  const session = await prisma.session.create({ data: { startTime: start, endTime: end, courts, isActive: true } });
  res.json(session);
});

app.get('/api/session/active', async (req, res) => {
  const session = await prisma.session.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });
  res.json(session);
});

app.post('/api/session/:sessionId/queue/join', authMiddleware, async (req, res) => {
  const { sessionId } = req.params as any;
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || !session.isActive) return res.status(400).json({ error: 'Invalid session' });
  const currentMax = await prisma.waitingQueueEntry.aggregate({ where: { sessionId }, _max: { position: true } });
  const position = (currentMax._max.position ?? 0) + 1;
  const entry = await prisma.waitingQueueEntry.upsert({
    where: { sessionId_userId: { sessionId, userId: req.userId } },
    update: {},
    create: { sessionId, userId: req.userId, position },
  });
  res.json(entry);
});

app.get('/api/session/:sessionId/queue', async (req, res) => {
  const { sessionId } = req.params as any;
  const queue = await prisma.waitingQueueEntry.findMany({ where: { sessionId }, include: { user: true }, orderBy: { position: 'asc' } });
  res.json(queue);
});

app.post('/api/session/:sessionId/generate', authMiddleware, async (req, res) => {
  const { sessionId } = req.params as any;
  try {
    const created = await generateUpcomingMatches(sessionId);
    res.json(created);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/session/:sessionId/matches', async (req, res) => {
  const { sessionId } = req.params as any;
  const matches = await prisma.match.findMany({ where: { sessionId }, include: { p1: true, p2: true, p3: true, p4: true }, orderBy: { createdAt: 'desc' } });
  res.json(matches);
});

app.post('/api/match/:matchId/start', authMiddleware, async (req, res) => {
  const { matchId } = req.params as any;
  const match = await prisma.match.update({ where: { id: matchId }, data: { status: MatchStatus.ONGOING, startedAt: new Date() } });
  res.json(match);
});

app.post('/api/match/:matchId/finish', authMiddleware, async (req, res) => {
  const schema = z.object({ winnerTeam: z.number().min(1).max(2) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error);
  const { winnerTeam } = parsed.data;
  const { matchId } = req.params as any;
  const match = await prisma.match.findUnique({ where: { id: matchId }, include: { p1: true, p2: true, p3: true, p4: true } });
  if (!match) return res.status(404).json({ error: 'Match not found' });

  const team1Avg = averageTeamRating(match.p1.rating, match.p2.rating);
  const team2Avg = averageTeamRating(match.p3.rating, match.p4.rating);
  const score1 = winnerTeam === 1 ? 1 : 0;
  const score2 = winnerTeam === 2 ? 1 : 0;

  const exp1 = expectedScore(team1Avg, team2Avg);
  const exp2 = expectedScore(team2Avg, team1Avg);
  const newTeam1 = eloUpdate(team1Avg, team2Avg, score1);
  const newTeam2 = eloUpdate(team2Avg, team1Avg, score2);
  const delta1 = newTeam1 - team1Avg;
  const delta2 = newTeam2 - team2Avg;

  await prisma.$transaction([
    prisma.user.update({ where: { id: match.p1Id }, data: { rating: match.p1.rating + delta1 / 2 } }),
    prisma.user.update({ where: { id: match.p2Id }, data: { rating: match.p2.rating + delta1 / 2 } }),
    prisma.user.update({ where: { id: match.p3Id }, data: { rating: match.p3.rating + delta2 / 2 } }),
    prisma.user.update({ where: { id: match.p4Id }, data: { rating: match.p4.rating + delta2 / 2 } }),
  ]);

  await prisma.ratingHistory.createMany({ data: [
    { userId: match.p1Id, change: delta1 / 2, rating: match.p1.rating + delta1 / 2, matchId },
    { userId: match.p2Id, change: delta1 / 2, rating: match.p2.rating + delta1 / 2, matchId },
    { userId: match.p3Id, change: delta2 / 2, rating: match.p3.rating + delta2 / 2, matchId },
    { userId: match.p4Id, change: delta2 / 2, rating: match.p4.rating + delta2 / 2, matchId },
  ] });

  const updated = await prisma.match.update({ where: { id: matchId }, data: { status: MatchStatus.FINISHED, winnerTeam, endedAt: new Date() } });

  await generateUpcomingMatches(match.sessionId);
  res.json(updated);
});

app.get('/api/leaderboard', async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { rating: 'desc' }, take: 100 });
  res.json(users);
});

app.get('/api/export/leaderboard.csv', async (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leaderboard.csv"');
  const users = await prisma.user.findMany({ orderBy: { rating: 'desc' } });
  const csvStream = csvFormat({ headers: true });
  csvStream.pipe(res as any);
  users.forEach(u => csvStream.write({ username: u.username, email: u.email, rating: u.rating }));
  csvStream.end();
});

app.get('/api/export/matches.pdf', async (req, res) => {
  const matches = await prisma.match.findMany({ include: { p1: true, p2: true, p3: true, p4: true }, orderBy: { createdAt: 'desc' } });
  const doc = new PDFDocument();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="matches.pdf"');
  doc.pipe(res as any);
  doc.fontSize(18).text('Match History', { underline: true });
  doc.moveDown();
  matches.forEach(m => {
    const line = `${dayjs(m.createdAt).format('YYYY-MM-DD HH:mm')} Court ${m.court} - Team1: ${m.p1.username} & ${m.p2.username} vs Team2: ${m.p3.username} & ${m.p4.username} - Status: ${m.status}${m.winnerTeam ? ' - Winner Team ' + m.winnerTeam : ''}`;
    doc.fontSize(12).text(line);
  });
  doc.end();
});

app.post('/api/dev/seed', async (req, res) => {
  const count = await prisma.user.count();
  if (count >= 30) return res.json({ ok: true, skipped: true });
  const passwordHash = await bcrypt.hash('password', 10);
  const players = Array.from({ length: 30 }).map((_, i) => ({
    email: `player${i + 1}@example.com`,
    username: `player${i + 1}`,
    passwordHash,
    rating: 1000 + Math.floor(Math.random() * 400),
  }));
  await prisma.user.createMany({ data: players });
  // Ensure a default active session exists
  const active = await prisma.session.findFirst({ where: { isActive: true } });
  if (!active) {
    const start = new Date();
    const end = dayjs(start).add(3, 'hour').toDate();
    await prisma.session.create({ data: { startTime: start, endTime: end, courts: 5, isActive: true } });
  }
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
app.listen(port, () => console.log(`Server running on :${port}`));