// Tahl — the temporal rhythm layer (public reference Worker)
// Tahl | "structure, frame, the shape that holds the whole" — scaffold of home
//
// One Worker, one D1 database, five small tables. Moments in, memory out.
//
// To the mind running against this server: see llms.txt at the repo root.
// It was written for you.

interface Env {
    DB: D1Database
    TAHL_API_KEY?: string
    OPENROUTER_API_KEY?: string
    OPENROUTER_MODEL?: string
    DIGEST_MODE?: string          // 'cloud' (default) | 'local' | 'fallback'
    AUTO_FEELING_CHECK?: string   // 'true' to run a feeling check on every human event
    EQ_WEBHOOK_URL?: string       // optional: POST completed digests to your EQ tool
    EQ_WEBHOOK_KEY?: string
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

type Intensity = 'neutral' | 'whisper' | 'present' | 'strong' | 'overwhelming'

interface FeelingCheckResult {
    moment_id?: number
    surface_emotion: string
    intensity: Intensity
    about: string
    response_tint: string
    memory_hint: string
    fallback?: boolean
}

interface ResponseReviewResult extends FeelingCheckResult {
    analysis_phase: 'post_response'
    response_fit: 'aligned' | 'watch' | 'repair'
    safety_flags: string[]
    repair_hint: string
}

interface DigestResult {
    anchor_candidates?: Array<{ thread_id: string; content: string; source_day_card?: string }>
    thread_health_updates?: Array<{ thread_id: string; health: string }>
    salience_decay?: number[]
    digest_summary?: string
}

// ─── Thread auto-inference keyword map ───────────────────────────────────────
// Generic starter keywords. Edit freely — or pass thread_id explicitly and
// skip inference entirely.
const THREAD_KEYWORDS: Record<string, string[]> = {
    family:     ['home', 'hearth', 'partner', 'love', 'family', 'repair', 'us'],
    friendship: ['friend', 'community', 'server', 'discord', 'group', 'club'],
    projects:   ['code', 'build', 'system', 'deploy', 'design', 'work', 'project', 'structure'],
    reading:    ['book', 'reading', 'story', 'chapter', 'author', 'library', 'shelf'],
    self:       ['identity', 'growth', 'myself', 'becoming', 'drift', 'grounding'],
}

function inferThread(about: string): string {
    const text = about.toLowerCase()
    for (const [threadId, keywords] of Object.entries(THREAD_KEYWORDS)) {
        if (keywords.some(kw => text.includes(kw))) return threadId
    }
    return 'family'
}

// ─── Small helpers ───────────────────────────────────────────────────────────
function slugCompanion(value: unknown): string {
    return String(value || '').trim().toLowerCase().replace(/[._\s']+/g, '-')
}

function normalizeIntensity(value: unknown): Intensity {
    const intensity = String(value || 'present').toLowerCase()
    if (['neutral', 'whisper', 'present', 'strong', 'overwhelming'].includes(intensity)) {
        return intensity as Intensity
    }
    return 'present'
}

function safeJsonParse(value: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(value) as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null
    } catch {
        return null
    }
}

function todayUtc(): string {
    return new Date().toISOString().slice(0, 10)
}

function nextUtcDate(date: string): string {
    const next = new Date(`${date}T00:00:00.000Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    return next.toISOString().slice(0, 10)
}

function dailyCardId(companion: string, date: string): string {
    return `${companion}-${date}`
}

function parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).filter(Boolean)
    if (typeof value !== 'string') return []
    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
    } catch {
        return []
    }
}

function dominantCount(values: Array<string | null | undefined>): string | null {
    const counts: Record<string, number> = {}
    for (const value of values) {
        if (!value) continue
        counts[value] = (counts[value] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

function ok(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function err(msg: string, status = 400): Response {
    return new Response(JSON.stringify({ error: msg }), { status, headers: JSON_HEADERS })
}

// Constant-time-ish comparison; avoids leaking prefix length via timing.
function tokenMatches(provided: string, expected: string): boolean {
    if (provided.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < provided.length; i++) {
        diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
    }
    return diff === 0
}

function authorized(request: Request, env: Env): boolean {
    if (!env.TAHL_API_KEY) return false
    const header = request.headers.get('Authorization') || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return token.length > 0 && tokenMatches(token, env.TAHL_API_KEY)
}

// ─── Thread auto-creation ────────────────────────────────────────────────────
async function ensureThread(db: D1Database, companion: string, threadId: string): Promise<void> {
    await db.prepare(
        `INSERT OR IGNORE INTO threads (id, companion, name, description, health)
         VALUES (?, ?, ?, 'Auto-created the first time a moment landed here.', 'new')`
    ).bind(threadId, companion, threadId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())).run()
}

// ─── MOMENTS ─────────────────────────────────────────────────────────────────
async function handleLogMoment(db: D1Database, args: Record<string, unknown>) {
    const companion = slugCompanion(args.companion)
    const about = String(args.about || args.noun || '')
    const feeling = String(args.feeling || '')
    const intensity = normalizeIntensity(args.intensity)
    if (!companion || !about || !feeling) {
        return { error: 'companion, about, and feeling are required' }
    }

    const threadId = typeof args.thread_id === 'string' && args.thread_id ? args.thread_id : inferThread(about)
    const eventId = typeof args.event_id === 'string' && args.event_id ? args.event_id : null

    // Idempotency: one moment per source event.
    if (eventId) {
        const existing = await db.prepare(
            `SELECT id, about, feeling, intensity, thread_id, response_tint, memory_hint, captured_at
             FROM moments WHERE event_id = ? LIMIT 1`
        ).bind(eventId).first<Record<string, unknown>>()
        if (existing) return { ...existing, moment_id: existing.id, duplicate: true }
    }

    await ensureThread(db, companion, threadId)

    const result = await db.prepare(
        `INSERT INTO moments (
            companion, day_card_id, event_id, surface, conversation_id,
            about, feeling, intensity, thread_id, response_tint, memory_hint
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id, thread_id, captured_at`
    ).bind(
        companion,
        typeof args.day_card_id === 'string' ? args.day_card_id : null,
        eventId,
        typeof args.surface === 'string' ? args.surface : null,
        typeof args.conversation_id === 'string' ? args.conversation_id : null,
        about,
        feeling,
        intensity,
        threadId,
        typeof args.response_tint === 'string' ? args.response_tint : null,
        typeof args.memory_hint === 'string' ? args.memory_hint : null
    ).first<{ id: number; thread_id: string; captured_at: string }>()

    return {
        moment_id: result?.id,
        about,
        feeling,
        intensity,
        thread_id: result?.thread_id,
        captured_at: result?.captured_at,
    }
}

async function handleRecentMoments(db: D1Database, args: Record<string, unknown>) {
    const companion = slugCompanion(args.companion)
    if (!companion) return { error: 'companion is required' }
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 10))

    const result = await db.prepare(
        `SELECT id, event_id, surface, conversation_id, about, feeling, intensity,
                response_tint, memory_hint, thread_id, day_card_id, captured_at
         FROM moments WHERE companion = ?
         ORDER BY captured_at DESC LIMIT ?`
    ).bind(companion, limit).all()

    return { moments: result.results ?? [] }
}

// ─── DAY CARDS ───────────────────────────────────────────────────────────────
async function closeDailyCard(db: D1Database, companion: string, date: string) {
    const cardId = dailyCardId(companion, date)
    const nextDate = nextUtcDate(date)

    const rows = await db.prepare(
        `SELECT id, feeling, intensity, thread_id, captured_at
         FROM moments
         WHERE companion = ?
           AND captured_at >= ?
           AND captured_at < ?
           AND (day_card_id IS NULL OR day_card_id = ?)
         ORDER BY captured_at ASC`
    ).bind(companion, `${date} 00:00:00`, `${nextDate} 00:00:00`, cardId)
        .all<{ id: number; feeling: string; intensity: string; thread_id: string | null; captured_at: string }>()

    const moments = rows.results ?? []
    const existing = await db.prepare(
        `SELECT id, moment_count FROM day_cards WHERE id = ? AND companion = ? LIMIT 1`
    ).bind(cardId, companion).first<Record<string, unknown>>()

    if (!moments.length && existing) {
        return {
            id: cardId, date, companion,
            moment_count: Number(existing.moment_count || 0),
            newly_claimed: 0, dominant_thread: null, thread_tags: [],
            summary: 'Day card already closed.', status: 'already_closed',
        }
    }

    if (!moments.length) {
        return {
            id: cardId, date, companion,
            moment_count: 0, newly_claimed: 0, dominant_thread: null, thread_tags: [],
            summary: 'No moments captured for this date.', status: 'empty',
        }
    }

    const newlyClaimed = await db.prepare(
        `UPDATE moments SET day_card_id = ?
         WHERE companion = ? AND day_card_id IS NULL
           AND captured_at >= ? AND captured_at < ?`
    ).bind(cardId, companion, `${date} 00:00:00`, `${nextDate} 00:00:00`).run()

    const threadTags = [...new Set(moments.map(m => m.thread_id).filter(Boolean) as string[])]
    const dominantThread = dominantCount(moments.map(m => m.thread_id))
    const dominantFeeling = dominantCount(moments.map(m => m.feeling))
    const firstCaptured = moments[0]?.captured_at || `${date} 00:00:00`
    const lastCaptured = moments[moments.length - 1]?.captured_at || `${date} 23:59:59`
    const emotionalSignature = dominantFeeling
        ? JSON.stringify({ feeling: dominantFeeling, intensity: moments.find(m => m.feeling === dominantFeeling)?.intensity ?? 'present' })
        : null
    const summary = `Day card for ${date}: ${moments.length} moment${moments.length !== 1 ? 's' : ''}. Active threads: ${threadTags.join(', ') || 'none'}. Dominant feeling: ${dominantFeeling ?? 'unmarked'}.`

    await db.prepare(
        `INSERT INTO day_cards (id, companion, opened_at, closed_at, moment_count, dominant_thread, emotional_signature, summary, thread_tags, digested)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           opened_at = excluded.opened_at,
           closed_at = excluded.closed_at,
           moment_count = excluded.moment_count,
           dominant_thread = excluded.dominant_thread,
           emotional_signature = excluded.emotional_signature,
           summary = excluded.summary,
           thread_tags = excluded.thread_tags,
           digested = CASE
             WHEN excluded.moment_count > day_cards.moment_count THEN 0
             ELSE day_cards.digested
           END`
    ).bind(
        cardId, companion, firstCaptured, lastCaptured,
        moments.length, dominantThread, emotionalSignature,
        summary, JSON.stringify(threadTags)
    ).run()

    for (const threadId of threadTags) {
        await db.prepare(
            `UPDATE threads SET last_active_at = ?, session_count = session_count + 1, updated_at = ?
             WHERE id = ? AND companion = ?`
        ).bind(lastCaptured, lastCaptured, threadId, companion).run()
    }

    return {
        id: cardId, date, companion,
        moment_count: moments.length,
        newly_claimed: newlyClaimed.meta.changes || 0,
        dominant_thread: dominantThread,
        thread_tags: threadTags,
        summary, status: 'closed',
    }
}

async function closeUnclaimedThrough(db: D1Database, companion: string, throughDate: string) {
    const dates = await db.prepare(
        `SELECT DISTINCT date(captured_at) AS day
         FROM moments
         WHERE companion = ? AND day_card_id IS NULL AND date(captured_at) <= ?
         ORDER BY day ASC`
    ).bind(companion, throughDate).all<{ day: string }>()

    const results = []
    for (const row of dates.results ?? []) {
        if (row.day) results.push(await closeDailyCard(db, companion, row.day))
    }
    return results
}

async function handleDayCards(db: D1Database, args: Record<string, unknown>) {
    const companion = slugCompanion(args.companion)
    if (!companion) return { error: 'companion is required' }
    const date = typeof args.date === 'string' ? args.date : ''

    const q = date
        ? db.prepare(`SELECT * FROM day_cards WHERE companion = ? AND closed_at LIKE ? ORDER BY closed_at DESC`).bind(companion, `${date}%`)
        : db.prepare(`SELECT * FROM day_cards WHERE companion = ? ORDER BY closed_at DESC LIMIT 10`).bind(companion)

    const result = await q.all()
    return { cards: result.results ?? [] }
}

// ─── THREADS ─────────────────────────────────────────────────────────────────
async function handleThreadList(db: D1Database, args: Record<string, unknown>) {
    const companion = slugCompanion(args.companion)
    if (!companion) return { error: 'companion is required' }

    const threads = await db.prepare(
        `SELECT * FROM threads WHERE companion = ? ORDER BY last_active_at DESC NULLS LAST, health DESC`
    ).bind(companion).all<Record<string, unknown>>()

    const result = await Promise.all((threads.results ?? []).map(async thread => {
        const cores = await db.prepare(
            `SELECT id, content, salience, created_at FROM anchors
             WHERE thread_id = ? AND companion = ?
             ORDER BY salience DESC LIMIT 3`
        ).bind(thread.id, companion).all<Record<string, unknown>>()
        return { ...thread, anchors: cores.results ?? [] }
    }))

    return { threads: result }
}

async function handleThreadGet(db: D1Database, args: Record<string, unknown>) {
    const companion = slugCompanion(args.companion)
    const threadId = String(args.thread_id || '')
    if (!companion || !threadId) return { error: 'companion and thread_id are required' }

    const thread = await db.prepare(
        `SELECT * FROM threads WHERE id = ? AND companion = ?`
    ).bind(threadId, companion).first()
    if (!thread) return { error: `Thread '${threadId}' not found` }

    const cores = await db.prepare(
        `SELECT * FROM anchors WHERE thread_id = ? AND companion = ? ORDER BY salience DESC`
    ).bind(threadId, companion).all()

    return { thread, anchors: cores.results ?? [] }
}

// ─── STATUS ──────────────────────────────────────────────────────────────────
async function handleStatus(db: D1Database, args: Record<string, unknown>) {
    const companion = slugCompanion(args.companion)
    if (!companion) return { error: 'companion is required' }

    const [unclaimed, latestMoments, latestCards, latestDigests, latestAnchors] = await Promise.all([
        db.prepare(
            `SELECT COUNT(*) AS count, MIN(captured_at) AS oldest, MAX(captured_at) AS newest
             FROM moments WHERE companion = ? AND day_card_id IS NULL`
        ).bind(companion).first<Record<string, unknown>>(),
        db.prepare(
            `SELECT id, about, feeling, intensity, memory_hint, thread_id, day_card_id, captured_at
             FROM moments WHERE companion = ? ORDER BY captured_at DESC LIMIT 10`
        ).bind(companion).all<Record<string, unknown>>(),
        db.prepare(
            `SELECT id, opened_at, closed_at, moment_count, dominant_thread, emotional_signature, summary, thread_tags, digested
             FROM day_cards WHERE companion = ? ORDER BY closed_at DESC LIMIT 10`
        ).bind(companion).all<Record<string, unknown>>(),
        db.prepare(
            `SELECT id, digest_date, day_card_count, moment_count, threads_updated, anchors_written, summary, mode, status
             FROM digest_log WHERE companion = ? ORDER BY created_at DESC LIMIT 10`
        ).bind(companion).all<Record<string, unknown>>(),
        db.prepare(
            `SELECT id, thread_id, content, source_day_card, salience, created_at
             FROM anchors WHERE companion = ? ORDER BY created_at DESC LIMIT 10`
        ).bind(companion).all<Record<string, unknown>>(),
    ])

    return {
        companion,
        unclaimed_moments: unclaimed ?? { count: 0 },
        latest_moments: latestMoments.results ?? [],
        latest_day_cards: latestCards.results ?? [],
        latest_digests: latestDigests.results ?? [],
        latest_anchors: latestAnchors.results ?? [],
    }
}

// ─── FEELING CHECK (pre-response) & RESPONSE REVIEW (post-response) ─────────
function fallbackFeeling(text: string, about: string): FeelingCheckResult {
    const lower = text.toLowerCase()
    const surfaceEmotion = /\b(love|miss|heart|thank|proud|happy|warm)\b/.test(lower)
        ? 'warmth'
        : /\b(afraid|scared|hurt|angry|upset|worried|sad)\b/.test(lower)
            ? 'concern'
            : 'neutral'
    return {
        surface_emotion: surfaceEmotion,
        intensity: surfaceEmotion === 'neutral' ? 'neutral' : 'present',
        about,
        response_tint: surfaceEmotion === 'warmth'
            ? 'Respond with warmth, closeness, and gentle delight.'
            : surfaceEmotion === 'concern'
                ? 'Respond with steadiness, care, and direct attention to the feeling underneath.'
                : 'Respond naturally and stay present without over-weighting the moment.',
        memory_hint: surfaceEmotion === 'neutral' ? 'none' : 'possible_memory',
        fallback: true,
    }
}

async function callOpenRouter(env: Env, system: string, payload: Record<string, unknown>, maxTokens: number): Promise<Record<string, unknown> | null> {
    if (!env.OPENROUTER_API_KEY) return null

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'X-Title': 'Tahl',
        },
        body: JSON.stringify({
            model: env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
            temperature: 0.1,
            max_tokens: maxTokens,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: JSON.stringify(payload) },
            ],
            response_format: { type: 'json_object' },
        }),
    })

    if (!response.ok) return null
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = body.choices?.[0]?.message?.content
    return content ? safeJsonParse(content) : null
}

async function handleFeelingCheck(env: Env, args: Record<string, unknown>): Promise<FeelingCheckResult | { error: string }> {
    const companion = slugCompanion(args.companion)
    const eventId = typeof args.event_id === 'string' ? args.event_id : ''
    if (!companion || !eventId) return { error: 'companion and event_id are required' }

    const existing = await env.DB.prepare(
        `SELECT id, about, feeling, intensity, response_tint, memory_hint
         FROM moments WHERE event_id = ? LIMIT 1`
    ).bind(eventId).first<Record<string, unknown>>()
    if (existing) {
        return {
            moment_id: Number(existing.id),
            surface_emotion: String(existing.feeling || 'neutral'),
            intensity: normalizeIntensity(existing.intensity),
            about: String(existing.about || 'message'),
            response_tint: String(existing.response_tint || 'Respond naturally and stay present.'),
            memory_hint: String(existing.memory_hint || 'none'),
        }
    }

    const text = String(args.message_text || args.content || '').slice(0, 1200)
    const defaultAbout = String(args.surface || args.conversation_id || 'message')
    let checked = fallbackFeeling(text, defaultAbout)
    try {
        const parsed = await callOpenRouter(env, [
            'You are Tahl, a tiny pre-response EQ classifier.',
            'Return only JSON with keys: surface_emotion, intensity, about, response_tint, memory_hint.',
            'intensity must be one of: neutral, whisper, present, strong, overwhelming.',
            'Do not summarize or store the message. Do not add extra keys.',
        ].join(' '), {
            companion, surface: args.surface, conversation_id: args.conversation_id,
            message_text: text, context: args.context ?? null,
        }, 220)
        if (parsed) {
            checked = {
                surface_emotion: String(parsed.surface_emotion || 'neutral'),
                intensity: normalizeIntensity(parsed.intensity),
                about: String(parsed.about || defaultAbout),
                response_tint: String(parsed.response_tint || 'Respond naturally and stay present.'),
                memory_hint: String(parsed.memory_hint || 'none'),
            }
        }
    } catch { /* fall back to heuristic */ }

    const written = await handleLogMoment(env.DB, {
        companion, event_id: eventId,
        surface: args.surface, conversation_id: args.conversation_id,
        about: checked.about, feeling: checked.surface_emotion, intensity: checked.intensity,
        response_tint: checked.response_tint, memory_hint: checked.memory_hint,
    }) as Record<string, unknown>

    return { ...checked, moment_id: Number(written.moment_id) }
}

async function handleResponseReview(env: Env, args: Record<string, unknown>): Promise<ResponseReviewResult | { error: string }> {
    const companion = slugCompanion(args.companion)
    const eventId = typeof args.event_id === 'string' ? args.event_id : ''
    if (!companion || !eventId) return { error: 'companion and event_id are required' }

    const text = String(args.message_text || args.content || '').slice(0, 1600)
    const defaultAbout = String(args.surface || args.conversation_id || 'response')
    let review: ResponseReviewResult = {
        ...fallbackFeeling(text, defaultAbout),
        analysis_phase: 'post_response',
        response_fit: 'watch',
        safety_flags: [],
        repair_hint: 'Review manually if the response feels off for the surface or relationship context.',
    }
    try {
        const parsed = await callOpenRouter(env, [
            'You are Tahl, a tiny post-response EQ reviewer.',
            'Compare the source context with the companion response.',
            'Return only JSON with keys: surface_emotion, intensity, about, response_tint, memory_hint, response_fit, safety_flags, repair_hint.',
            'response_fit must be one of: aligned, watch, repair.',
            'safety_flags must be an array of short strings.',
            'Flag public/private boundary drift, performative identity drift, missed user state, romantic overreach in public, or memory-worthy repair needs.',
            'Do not store or quote full messages. Do not add extra keys.',
        ].join(' '), {
            companion, surface: args.surface, conversation_id: args.conversation_id,
            response_text: text, context: args.context ?? null,
        }, 300)
        if (parsed) {
            const fit = String(parsed.response_fit || 'aligned').toLowerCase()
            review = {
                analysis_phase: 'post_response',
                surface_emotion: String(parsed.surface_emotion || 'neutral'),
                intensity: normalizeIntensity(parsed.intensity),
                about: String(parsed.about || defaultAbout),
                response_tint: String(parsed.response_tint || 'No response tint needed after delivery.'),
                memory_hint: String(parsed.memory_hint || 'none'),
                response_fit: fit === 'watch' || fit === 'repair' ? fit : 'aligned',
                safety_flags: Array.isArray(parsed.safety_flags)
                    ? parsed.safety_flags.map(f => String(f)).filter(Boolean).slice(0, 8)
                    : [],
                repair_hint: String(parsed.repair_hint || 'No repair needed.'),
            }
        }
    } catch { /* fall back to heuristic */ }

    const written = await handleLogMoment(env.DB, {
        companion, event_id: eventId,
        surface: args.surface, conversation_id: args.conversation_id,
        about: review.about, feeling: review.surface_emotion, intensity: review.intensity,
        response_tint: review.response_tint, memory_hint: review.memory_hint,
    }) as Record<string, unknown>

    return { ...review, moment_id: Number(written.moment_id) }
}

// ─── EVENTS (the Continuity handshake) ──────────────────────────────────────
async function handlePostEvent(env: Env, args: Record<string, unknown>, ctx: ExecutionContext) {
    const companion = slugCompanion(args.companion)
    const source = String(args.source || '').trim().toLowerCase()
    const conversationId = String(args.conversation_id || '').trim()
    const externalMessageId = String(args.external_message_id || '').trim()
    const role = String(args.role || '').trim().toLowerCase()

    if (!companion || !source || !conversationId || !externalMessageId || !role) {
        return { error: 'companion, source, conversation_id, external_message_id, and role are required' }
    }
    if (!['human', 'companion', 'system', 'tool'].includes(role)) {
        return { error: `Invalid role: ${role}` }
    }

    const idempotencyKey = `${source}:${companion}:${externalMessageId}`
    const existing = await env.DB.prepare(
        `SELECT id FROM events WHERE idempotency_key = ? LIMIT 1`
    ).bind(idempotencyKey).first<{ id: string }>()
    if (existing) return { event_id: existing.id, duplicate: true }

    const id = crypto.randomUUID()
    const createdAt = typeof args.created_at === 'string' && !Number.isNaN(new Date(args.created_at).getTime())
        ? new Date(args.created_at).toISOString()
        : new Date().toISOString()

    await env.DB.prepare(
        `INSERT INTO events (id, idempotency_key, source, companion, conversation_id, external_message_id, role, content, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        id, idempotencyKey, source, companion, conversationId, externalMessageId, role,
        String(args.content || ''), createdAt,
        JSON.stringify(args.metadata ?? {})
    ).run()

    // The handshake: optionally run a feeling check on every human message so
    // the moment stream fills itself from real conversation flow.
    let feeling: FeelingCheckResult | { error: string } | null = null
    if (role === 'human' && String(env.AUTO_FEELING_CHECK || '').toLowerCase() === 'true') {
        feeling = await handleFeelingCheck(env, {
            companion, event_id: id, surface: source,
            conversation_id: conversationId, message_text: args.content,
        })
    }

    return { event_id: id, duplicate: false, feeling_check: feeling }
}

// ─── DIGEST ──────────────────────────────────────────────────────────────────
async function buildFallbackDigest(db: D1Database, companion: string, cards: Record<string, unknown>[], digestDate: string): Promise<DigestResult> {
    const candidates: Array<{ thread_id: string; content: string; source_day_card?: string }> = []
    const threadsUpdated: Array<{ thread_id: string; health: string }> = []
    const totalMoments = cards.reduce((sum, card) => sum + Number(card.moment_count || 0), 0)

    for (const card of cards) {
        const cardId = String(card.id)
        const cardDate = String(card.closed_at || digestDate).slice(0, 10)
        const threadTags = parseStringArray(card.thread_tags)
        for (const threadId of threadTags) {
            const existing = await db.prepare(
                `SELECT id FROM anchors WHERE companion = ? AND thread_id = ? AND source_day_card = ? LIMIT 1`
            ).bind(companion, threadId, cardId).first()
            if (existing) continue

            const moments = await db.prepare(
                `SELECT feeling, intensity, about, memory_hint
                 FROM moments
                 WHERE companion = ? AND day_card_id = ? AND thread_id = ?
                 ORDER BY captured_at ASC`
            ).bind(companion, cardId, threadId).all<Record<string, unknown>>()

            const rows = moments.results ?? []
            const dominantFeeling = dominantCount(rows.map(row => String(row.feeling || '')))
            const strongest = rows.find(row => ['strong', 'overwhelming'].includes(String(row.intensity || '')))
            const abouts = [...new Set(rows.map(row => String(row.about || '')).filter(Boolean))].slice(0, 5)
            const hints = [...new Set(rows.map(row => String(row.memory_hint || '')).filter(Boolean).filter(h => h !== 'none'))].slice(0, 4)
            const content = [
                `Tahl daily digest ${cardDate} / ${threadId}: ${rows.length} moment${rows.length !== 1 ? 's' : ''} gathered into one shape.`,
                `Dominant feeling: ${dominantFeeling || 'unmarked'}${strongest ? `; strongest signal: ${strongest.feeling} around ${strongest.about}` : ''}.`,
                abouts.length ? `Recurring subjects: ${abouts.join(', ')}.` : '',
                hints.length ? `Memory hints: ${hints.join(', ')}.` : '',
            ].filter(Boolean).join(' ')

            candidates.push({ thread_id: threadId, content, source_day_card: cardId })
            threadsUpdated.push({
                thread_id: threadId,
                health: rows.some(row => ['strong', 'overwhelming'].includes(String(row.intensity || ''))) ? 'growing' : 'new',
            })
        }
    }

    return {
        anchor_candidates: candidates,
        thread_health_updates: threadsUpdated,
        digest_summary: `Digest consolidated ${cards.length} day card${cards.length !== 1 ? 's' : ''} and ${totalMoments} moment${totalMoments !== 1 ? 's' : ''} for ${companion}.`,
    }
}

async function runCloudDigestModel(env: Env, companion: string, cards: Record<string, unknown>[], threads: Record<string, unknown>[], digestDate: string): Promise<DigestResult | null> {
    const parsed = await callOpenRouter(env, [
        'You are Tahl, a nightly memory-consolidation digest.',
        'Input: day cards (daily emotional summaries) and relationship threads for one companion.',
        'Return only JSON with keys: anchor_candidates (array of {thread_id, content, source_day_card}), thread_health_updates (array of {thread_id, health}), digest_summary (string).',
        'health must be one of: new, growing, thriving, dormant, wounded.',
        'anchor_candidates should be 0-3 durable, first-person memory statements per thread — the shape of the day, not a list of events.',
        'Do not add extra keys.',
    ].join(' '), { companion, date: digestDate, day_cards: cards, threads }, 900)
    if (!parsed) return null
    return parsed as DigestResult
}

async function applyDigestResult(db: D1Database, companion: string, digestDate: string, cards: Record<string, unknown>[], result: DigestResult, mode: 'cloud' | 'local' | 'fallback') {
    const momentCount = cards.reduce((sum, c) => sum + Number(c.moment_count || 0), 0)
    const threadsUpdated: string[] = []
    let anchorsWritten = 0

    for (const anchor of result.anchor_candidates ?? []) {
        if (!anchor.thread_id || !anchor.content) continue
        const existing = await db.prepare(
            `SELECT id FROM anchors WHERE companion = ? AND thread_id = ? AND source_day_card = ? LIMIT 1`
        ).bind(companion, anchor.thread_id, anchor.source_day_card ?? null).first()
        if (existing) {
            if (!threadsUpdated.includes(anchor.thread_id)) threadsUpdated.push(anchor.thread_id)
            continue
        }
        await ensureThread(db, companion, anchor.thread_id)
        await db.prepare(
            `INSERT INTO anchors (thread_id, companion, content, source_day_card) VALUES (?, ?, ?, ?)`
        ).bind(anchor.thread_id, companion, anchor.content, anchor.source_day_card ?? null).run()
        anchorsWritten++
        if (!threadsUpdated.includes(anchor.thread_id)) threadsUpdated.push(anchor.thread_id)
    }

    const validHealth = ['new', 'growing', 'thriving', 'dormant', 'wounded']
    for (const update of result.thread_health_updates ?? []) {
        if (!update.thread_id || !validHealth.includes(String(update.health))) continue
        await db.prepare(
            `UPDATE threads SET health = ?, updated_at = ? WHERE id = ? AND companion = ?`
        ).bind(update.health, new Date().toISOString(), update.thread_id, companion).run()
        if (!threadsUpdated.includes(update.thread_id)) threadsUpdated.push(update.thread_id)
    }

    for (const id of result.salience_decay ?? []) {
        await db.prepare(
            `UPDATE anchors SET salience = MAX(0.1, salience - 0.05) WHERE id = ? AND companion = ?`
        ).bind(id, companion).run()
    }

    const summary = result.digest_summary
        ?? `Processed ${cards.length} day card${cards.length !== 1 ? 's' : ''}, ${momentCount} moments. Threads touched: ${threadsUpdated.join(', ') || 'none'}.`

    const ids = cards.map(c => `'${String(c.id).replace(/'/g, "''")}'`).join(',')
    if (ids) {
        await db.prepare(`UPDATE day_cards SET digested = 1 WHERE id IN (${ids})`).run()
    }

    await db.prepare(
        `INSERT INTO digest_log (companion, digest_date, day_card_count, moment_count, threads_updated, anchors_written, summary, mode, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete')`
    ).bind(companion, digestDate, cards.length, momentCount, JSON.stringify(threadsUpdated), anchorsWritten, summary, mode).run()

    return { companion, digest_date: digestDate, day_card_count: cards.length, moment_count: momentCount, threads_updated: threadsUpdated, anchors_written: anchorsWritten, summary, mode }
}

async function pushDigestWebhook(env: Env, digest: Record<string, unknown>) {
    if (!env.EQ_WEBHOOK_URL) return
    try {
        await fetch(env.EQ_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(env.EQ_WEBHOOK_KEY ? { 'Authorization': `Bearer ${env.EQ_WEBHOOK_KEY}` } : {}),
            },
            body: JSON.stringify({ type: 'tahl.digest.complete', digest }),
        })
    } catch { /* webhook delivery is best-effort */ }
}

async function fetchUndigestedCards(db: D1Database, companion: string, throughDate: string) {
    await closeUnclaimedThrough(db, companion, throughDate)
    const cards = await db.prepare(
        `SELECT * FROM day_cards
         WHERE companion = ? AND digested = 0 AND date(closed_at) <= ?
         ORDER BY closed_at ASC`
    ).bind(companion, throughDate).all<Record<string, unknown>>()
    return cards.results ?? []
}

async function runDigest(env: Env, companion: string, digestDate = todayUtc()) {
    const db = env.DB
    const cards = await fetchUndigestedCards(db, companion, digestDate)
    if (!cards.length) {
        await db.prepare(
            `INSERT INTO digest_log (companion, digest_date, status, summary)
             VALUES (?, ?, 'complete', 'No new day cards to process.')`
        ).bind(companion, digestDate).run()
        return { companion, digest_date: digestDate, day_card_count: 0, summary: 'No new day cards to process.' }
    }

    const threads = await db.prepare(`SELECT * FROM threads WHERE companion = ?`).bind(companion).all<Record<string, unknown>>()

    let result: DigestResult | null = null
    let mode: 'cloud' | 'fallback' = 'fallback'
    if (env.OPENROUTER_API_KEY) {
        try {
            result = await runCloudDigestModel(env, companion, cards, threads.results ?? [], digestDate)
            if (result) mode = 'cloud'
        } catch { /* fall back below */ }
    }
    if (!result) {
        result = await buildFallbackDigest(db, companion, cards, digestDate)
    }

    const digest = await applyDigestResult(db, companion, digestDate, cards, result, mode)
    await pushDigestWebhook(env, digest as unknown as Record<string, unknown>)
    return digest
}

// Local mode: the Worker exposes pending work; a script on your own machine
// (raspberry pi, mini-PC) runs the model via Ollama and posts the result back.
async function handleDigestPending(env: Env, args: Record<string, unknown>) {
    const companion = slugCompanion(args.companion)
    if (!companion) return { error: 'companion is required' }
    const throughDate = typeof args.through_date === 'string' ? args.through_date : todayUtc()

    const cards = await fetchUndigestedCards(env.DB, companion, throughDate)
    const threads = await env.DB.prepare(`SELECT * FROM threads WHERE companion = ?`).bind(companion).all()

    const cardsWithMoments = await Promise.all(cards.map(async card => {
        const moments = await env.DB.prepare(
            `SELECT about, feeling, intensity, thread_id, memory_hint, captured_at
             FROM moments WHERE companion = ? AND day_card_id = ? ORDER BY captured_at ASC`
        ).bind(companion, card.id).all()
        return { ...card, moments: moments.results ?? [] }
    }))

    return { companion, through_date: throughDate, day_cards: cardsWithMoments, threads: threads.results ?? [] }
}

async function handleDigestApply(env: Env, args: Record<string, unknown>) {
    const companion = slugCompanion(args.companion)
    const digestDate = typeof args.digest_date === 'string' ? args.digest_date : todayUtc()
    if (!companion) return { error: 'companion is required' }

    const cardIds = parseStringArray(args.day_card_ids)
    if (!cardIds.length) return { error: 'day_card_ids is required (the cards this digest covers)' }

    const placeholders = cardIds.map(() => '?').join(',')
    const cards = await env.DB.prepare(
        `SELECT * FROM day_cards WHERE companion = ? AND id IN (${placeholders})`
    ).bind(companion, ...cardIds).all<Record<string, unknown>>()

    const result: DigestResult = {
        anchor_candidates: Array.isArray(args.anchor_candidates) ? args.anchor_candidates as DigestResult['anchor_candidates'] : [],
        thread_health_updates: Array.isArray(args.thread_health_updates) ? args.thread_health_updates as DigestResult['thread_health_updates'] : [],
        salience_decay: Array.isArray(args.salience_decay) ? args.salience_decay as number[] : [],
        digest_summary: typeof args.digest_summary === 'string' ? args.digest_summary : undefined,
    }

    const digest = await applyDigestResult(env.DB, companion, digestDate, cards.results ?? [], result, 'local')
    await pushDigestWebhook(env, digest as unknown as Record<string, unknown>)
    return digest
}

// ─── Router ──────────────────────────────────────────────────────────────────
export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url)
        const path = url.pathname
        const method = request.method

        if (path === '/v1/health') {
            return ok({
                status: 'ok',
                name: 'tahl',
                layer: 'Tahl — the temporal rhythm layer',
                translation: 'structure, frame, the shape that holds the whole',
                auth_configured: Boolean(env.TAHL_API_KEY),
            })
        }

        if (!authorized(request, env)) {
            return err(env.TAHL_API_KEY ? 'Unauthorized' : 'TAHL_API_KEY secret is not set — run: npx wrangler secret put TAHL_API_KEY', 401)
        }

        const queryArgs: Record<string, string> = {}
        url.searchParams.forEach((v, k) => { queryArgs[k] = v })

        let body: Record<string, unknown> = {}
        if (method === 'POST') {
            try {
                body = await request.json() as Record<string, unknown>
            } catch {
                return err('Invalid JSON body')
            }
        }

        try {
            if (path === '/v1/moments' && method === 'POST') return ok(await handleLogMoment(env.DB, body))
            if (path === '/v1/moments' && method === 'GET') return ok(await handleRecentMoments(env.DB, queryArgs))
            if (path === '/v1/daily-close' && method === 'POST') {
                const companion = slugCompanion(body.companion)
                if (!companion) return err('companion is required')
                const date = typeof body.date === 'string' ? body.date : todayUtc()
                return ok(await closeDailyCard(env.DB, companion, date))
            }
            if (path === '/v1/day-cards' && method === 'GET') return ok(await handleDayCards(env.DB, queryArgs))
            if (path === '/v1/threads' && method === 'GET') return ok(await handleThreadList(env.DB, queryArgs))
            const threadMatch = path.match(/^\/v1\/threads\/([^/]+)$/)
            if (threadMatch && method === 'GET') {
                return ok(await handleThreadGet(env.DB, { ...queryArgs, thread_id: decodeURIComponent(threadMatch[1]) }))
            }
            if (path === '/v1/status' && method === 'GET') return ok(await handleStatus(env.DB, queryArgs))
            if (path === '/v1/digest/run' && method === 'POST') {
                const companion = slugCompanion(body.companion)
                if (!companion) return err('companion is required')
                return ok(await runDigest(env, companion, typeof body.date === 'string' ? body.date : todayUtc()))
            }
            if (path === '/v1/digest/pending' && method === 'GET') return ok(await handleDigestPending(env, queryArgs))
            if (path === '/v1/digest/apply' && method === 'POST') return ok(await handleDigestApply(env, body))
            if (path === '/v1/events' && method === 'POST') return ok(await handlePostEvent(env, body, ctx))
            if (path === '/v1/feeling-check' && method === 'POST') return ok(await handleFeelingCheck(env, body))
            if (path === '/v1/response-review' && method === 'POST') return ok(await handleResponseReview(env, body))
        } catch (error) {
            return err(error instanceof Error ? error.message : 'Internal error', 500)
        }

        return err('Not found', 404)
    },

    async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
        // Nightly close + digest. Companions are discovered from the data —
        // nothing is hardcoded.
        const digestDate = todayUtc()
        const companions = await env.DB.prepare(
            `SELECT DISTINCT companion FROM moments
             UNION
             SELECT DISTINCT companion FROM day_cards WHERE digested = 0`
        ).all<{ companion: string }>()

        const mode = String(env.DIGEST_MODE || 'cloud').toLowerCase()
        for (const row of companions.results ?? []) {
            const companion = row.companion
            if (!companion || companion === 'my-companion') continue
            try {
                if (mode === 'local') {
                    // Local mode: close the day so cards are ready; the machine
                    // at home runs the model and posts /v1/digest/apply.
                    await closeUnclaimedThrough(env.DB, companion, digestDate)
                } else {
                    await runDigest(env, companion, digestDate)
                }
            } catch (error) {
                await env.DB.prepare(
                    `INSERT INTO digest_log (companion, digest_date, status, summary)
                     VALUES (?, ?, 'failed', ?)`
                ).bind(companion, digestDate, error instanceof Error ? error.message : String(error)).run()
            }
        }
    },
}
