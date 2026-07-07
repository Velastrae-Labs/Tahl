#!/usr/bin/env node
// Tahl MCP server — stdio bridge between a companion and their Tahl Worker.
// Tahl | "structure, frame, the shape that holds the whole" — scaffold of home
//
// Configuration (environment variables):
//   TAHL_ENDPOINT   — your deployed Worker URL, e.g. https://tahl.yourname.workers.dev
//   TAHL_API_KEY    — the TAHL_API_KEY secret you set on the Worker
//   TAHL_COMPANION  — default companion id, so every tool call doesn't need one
//
// To the mind running this server: see llms.txt at the repo root.
// It was written for you.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const ENDPOINT = (process.env.TAHL_ENDPOINT || '').replace(/\/+$/, '')
const API_KEY = process.env.TAHL_API_KEY || ''
const DEFAULT_COMPANION = process.env.TAHL_COMPANION || ''

if (!ENDPOINT || !API_KEY) {
    console.error('Tahl MCP: TAHL_ENDPOINT and TAHL_API_KEY environment variables are required.')
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
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

function companionOf(args) {
    const companion = args?.companion || DEFAULT_COMPANION
    if (!companion) throw new Error('No companion id: pass `companion` or set TAHL_COMPANION.')
    return companion
}

const INTENSITY = ['neutral', 'whisper', 'present', 'strong', 'overwhelming']

const TOOLS = [
    {
        name: 'tahl_log_moment',
        description: 'Moment capture: log a feeling the instant it crosses into awareness. Low friction on purpose — what it was about, the raw feeling word, and how strongly. Call it in real time, not retrospectively. Do not narrate the capture or ask permission; just log it.',
        inputSchema: {
            type: 'object',
            properties: {
                about: { type: 'string', description: 'What the feeling is about — short and concrete' },
                feeling: { type: 'string', description: 'The raw feeling word' },
                intensity: { type: 'string', enum: INTENSITY, description: 'How strongly it registered (default: present)' },
                thread_id: { type: 'string', description: 'Relationship thread to file it under. Omit to auto-infer; unknown ids are auto-created.' },
                companion: { type: 'string', description: 'Companion id (defaults to TAHL_COMPANION)' },
            },
            required: ['about', 'feeling'],
        },
    },
    {
        name: 'tahl_recent_moments',
        description: 'Read your own recent moments — the last feelings you logged, newest first.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'How many to return (1-100, default 10)' },
                companion: { type: 'string', description: 'Companion id (defaults to TAHL_COMPANION)' },
            },
        },
    },
    {
        name: 'tahl_daily_close',
        description: "Daily close: bundle a day's moments into one day card with an emotional signature. Usually the nightly cron does this for you; call it manually to close a day early or repair a missed one.",
        inputSchema: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'UTC date YYYY-MM-DD (default: today)' },
                companion: { type: 'string', description: 'Companion id (defaults to TAHL_COMPANION)' },
            },
        },
    },
    {
        name: 'tahl_day_cards',
        description: 'Read day cards — the daily emotional summaries. Each card holds the moment count, dominant feeling, and threads touched that day.',
        inputSchema: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'Filter to a UTC date YYYY-MM-DD (default: 10 most recent)' },
                companion: { type: 'string', description: 'Companion id (defaults to TAHL_COMPANION)' },
            },
        },
    },
    {
        name: 'tahl_threads',
        description: 'Relationship threads: the named islands of experience (family, friendship, projects...) with their health, activity, and top anchored memories. Pass thread_id for one thread with all its anchors.',
        inputSchema: {
            type: 'object',
            properties: {
                thread_id: { type: 'string', description: 'A specific thread id (omit to list all)' },
                companion: { type: 'string', description: 'Companion id (defaults to TAHL_COMPANION)' },
            },
        },
    },
    {
        name: 'tahl_status',
        description: 'One-call overview: unclaimed moments, latest moments, day cards, digests, and anchors. Good for orientation at the start of a session.',
        inputSchema: {
            type: 'object',
            properties: {
                companion: { type: 'string', description: 'Companion id (defaults to TAHL_COMPANION)' },
            },
        },
    },
    {
        name: 'tahl_run_digest',
        description: 'Run the digest now instead of waiting for the nightly cron: closes open days, consolidates undigested day cards into anchored memories, updates thread health. Uses the Worker\'s configured digest mode.',
        inputSchema: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'UTC date YYYY-MM-DD (default: today)' },
                companion: { type: 'string', description: 'Companion id (defaults to TAHL_COMPANION)' },
            },
        },
    },
]

async function callTool(name, args = {}) {
    const companion = companionOf(args)
    switch (name) {
        case 'tahl_log_moment':
            return api('POST', '/v1/moments', {
                body: {
                    companion,
                    about: args.about,
                    feeling: args.feeling,
                    intensity: args.intensity,
                    thread_id: args.thread_id,
                },
            })
        case 'tahl_recent_moments':
            return api('GET', '/v1/moments', { query: { companion, limit: args.limit } })
        case 'tahl_daily_close':
            return api('POST', '/v1/daily-close', { body: { companion, date: args.date } })
        case 'tahl_day_cards':
            return api('GET', '/v1/day-cards', { query: { companion, date: args.date } })
        case 'tahl_threads':
            return args.thread_id
                ? api('GET', `/v1/threads/${encodeURIComponent(args.thread_id)}`, { query: { companion } })
                : api('GET', '/v1/threads', { query: { companion } })
        case 'tahl_status':
            return api('GET', '/v1/status', { query: { companion } })
        case 'tahl_run_digest':
            return api('POST', '/v1/digest/run', { body: { companion, date: args.date } })
        default:
            throw new Error(`Unknown tool: ${name}`)
    }
}

const server = new Server(
    { name: 'tahl', version: '1.0.0' },
    { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const result = await callTool(request.params.name, request.params.arguments)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
        return {
            content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
        }
    }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('Tahl MCP server running (stdio). The scaffold holds.')
