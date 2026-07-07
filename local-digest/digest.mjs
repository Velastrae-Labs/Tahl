#!/usr/bin/env node
// Tahl local digest — the privacy-first path.
//
// Runs on YOUR machine (raspberry pi, mini-PC, laptop) on a nightly cron.
// Pulls undigested day cards from your Tahl Worker, consolidates them with a
// LOCAL model via Ollama, and posts the result back. The feelings never leave
// hardware you own except to travel to your own database.
//
// Configuration (environment variables or a .env file next to this script):
//   TAHL_ENDPOINT   — your deployed Worker URL
//   TAHL_API_KEY    — the TAHL_API_KEY secret you set on the Worker
//   TAHL_COMPANION  — companion id to digest (comma-separate for several)
//   OLLAMA_URL      — default http://localhost:11434
//   OLLAMA_MODEL    — default llama3.2 (any small instruct model works)
//
// Set DIGEST_MODE = "local" in the Worker's wrangler.jsonc so the nightly
// cron closes day cards but leaves the digestion to this script.
//
// Cron examples:
//   Linux/pi:  5 23 * * *  cd /home/you/Tahl/local-digest && node digest.mjs
//   Windows:   schtasks /create /tn TahlDigest /tr "node C:\path\to\digest.mjs" /sc daily /st 23:05

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Tiny .env loader — no dependency needed.
const here = dirname(fileURLToPath(import.meta.url))
const envPath = join(here, '.env')
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)
        if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
}

const ENDPOINT = (process.env.TAHL_ENDPOINT || '').replace(/\/+$/, '')
const API_KEY = process.env.TAHL_API_KEY || ''
const COMPANIONS = (process.env.TAHL_COMPANION || '').split(',').map(s => s.trim()).filter(Boolean)
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '')
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2'

if (!ENDPOINT || !API_KEY || !COMPANIONS.length) {
    console.error('Tahl local digest: TAHL_ENDPOINT, TAHL_API_KEY, and TAHL_COMPANION are required.')
    process.exit(1)
}

async function api(method, path, { query, body } = {}) {
    const url = new URL(ENDPOINT + path)
    for (const [k, v] of Object.entries(query || {})) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
    const response = await fetch(url, {
        method,
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`Tahl API ${response.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text)
}

async function askOllama(companion, dayCards, threads, date) {
    const system = [
        'You are Tahl, a nightly memory-consolidation digest.',
        'Input: day cards (daily emotional summaries, each with its raw moments) and relationship threads for one companion.',
        'Return only JSON with keys: anchor_candidates (array of {thread_id, content, source_day_card}), thread_health_updates (array of {thread_id, health}), digest_summary (string).',
        'health must be one of: new, growing, thriving, dormant, wounded.',
        'anchor_candidates should be 0-3 durable, first-person memory statements per thread — the shape of the day, not a list of events.',
        'source_day_card must be the id of the day card the anchor came from.',
        'Do not add extra keys.',
    ].join(' ')

    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: OLLAMA_MODEL,
            stream: false,
            format: 'json',
            options: { temperature: 0.1 },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: JSON.stringify({ companion, date, day_cards: dayCards, threads }) },
            ],
        }),
    })
    if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const body = await response.json()
    const content = body?.message?.content
    if (!content) throw new Error('Ollama returned no content')
    return JSON.parse(content)
}

async function digestCompanion(companion) {
    const date = new Date().toISOString().slice(0, 10)
    console.log(`[tahl] ${companion}: fetching pending day cards...`)
    const pending = await api('GET', '/v1/digest/pending', { query: { companion } })

    const cards = pending.day_cards || []
    if (!cards.length) {
        console.log(`[tahl] ${companion}: nothing to digest. The day is already held.`)
        return
    }

    console.log(`[tahl] ${companion}: ${cards.length} day card(s) → ${OLLAMA_MODEL} @ ${OLLAMA_URL}`)
    const result = await askOllama(companion, cards, pending.threads || [], date)

    const applied = await api('POST', '/v1/digest/apply', {
        body: {
            companion,
            digest_date: date,
            day_card_ids: cards.map(c => c.id),
            anchor_candidates: result.anchor_candidates || [],
            thread_health_updates: result.thread_health_updates || [],
            salience_decay: result.salience_decay || [],
            digest_summary: result.digest_summary || '',
        },
    })

    console.log(`[tahl] ${companion}: digest complete — ${applied.anchors_written} anchor(s) written, threads: ${(applied.threads_updated || []).join(', ') || 'none'}`)
}

let failed = false
for (const companion of COMPANIONS) {
    try {
        await digestCompanion(companion)
    } catch (error) {
        failed = true
        console.error(`[tahl] ${companion}: digest failed — ${error.message}`)
        console.error('[tahl] Day cards stay pending; the next run will pick them up.')
    }
}
process.exit(failed ? 1 : 0)
