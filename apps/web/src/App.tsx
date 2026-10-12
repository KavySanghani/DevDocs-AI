import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  Layers,
  Database,
  Shield,
  Server,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  FileCode2,
  MessageSquareQuote,
  GitBranch,
} from 'lucide-react';
import { webConfig } from './config/env';
import type { HealthResponse } from '@devdocs/shared';

interface HealthState {
  loading: boolean;
  data: HealthResponse | null;
  error: string | null;
  latencyMs: number | null;
  lastChecked: string | null;
}

export const App: React.FC = () => {
  const [health, setHealth] = useState<HealthState>({
    loading: true,
    data: null,
    error: null,
    latencyMs: null,
    lastChecked: null,
  });

  const checkHealth = useCallback(async () => {
    setHealth((prev) => ({ ...prev, loading: true, error: null }));
    const startTime = performance.now();

    try {
      const endpoint = `${webConfig.apiBaseUrl}/health`;
      const res = await fetch(endpoint, {
        headers: { Accept: 'application/json' },
      });

      const elapsed = Math.round(performance.now() - startTime);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json = (await res.json()) as HealthResponse;
      setHealth({
        loading: false,
        data: json,
        error: null,
        latencyMs: elapsed,
        lastChecked: new Date().toLocaleTimeString(),
      });
    } catch (err) {
      setHealth({
        loading: false,
        data: null,
        error: err instanceof Error ? err.message : 'Failed to reach API endpoint',
        latencyMs: null,
        lastChecked: new Date().toLocaleTimeString(),
      });
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  const roadmapPhases = [
    {
      num: '01',
      title: 'Architecture & Bootstrap',
      desc: 'Monorepo, strict TypeScript, Fastify API, React UI, structured logging & error handling.',
      status: 'active',
      icon: Server,
    },
    {
      num: '02',
      title: 'Database & Migrations',
      desc: 'PostgreSQL schema, pgvector extension, versioned SQL migration runner.',
      status: 'queued',
      icon: Database,
    },
    {
      num: '03',
      title: 'Auth & Multi-Tenancy',
      desc: 'JWT authentication, bcrypt password hashing, organization-scoped RBAC.',
      status: 'queued',
      icon: Shield,
    },
    {
      num: '04-05',
      title: 'Ingestion & Embeddings',
      desc: 'PDF/Markdown parsing, structure-aware chunking, OpenAI embeddings with backoff.',
      status: 'queued',
      icon: FileCode2,
    },
    {
      num: '06-08',
      title: 'Hybrid RAG & Grounded Chat',
      desc: 'pgvector semantic search + PostgreSQL FTS, RRF rank fusion, citation validation.',
      status: 'queued',
      icon: MessageSquareQuote,
    },
    {
      num: '10-11',
      title: 'Workers & GitHub Ingestion',
      desc: 'Async job queue, idempotency keys, repository parsing and AST code chunking.',
      status: 'queued',
      icon: GitBranch,
    },
  ];

  return (
    <div className="app-container" id="app-root">
      {/* Header */}
      <header className="app-header" id="main-header">
        <div className="brand-wrapper">
          <div className="brand-icon" id="brand-logo-icon">
            <Layers size={24} color="#ffffff" />
          </div>
          <div>
            <h1 className="brand-title">DevDocs AI</h1>
            <p className="brand-subtitle">Engineering Knowledge &amp; Codebase Assistant</p>
          </div>
        </div>

        <div className="phase-pill" id="phase-badge">
          <span className="pulse-dot" />
          <span>Instruction 01 Baseline</span>
        </div>
      </header>

      {/* Hero Banner */}
      <section className="hero-banner" id="hero-section">
        <h2 className="hero-heading">Interview-Ready Hybrid RAG Platform</h2>
        <p className="hero-text">
          Enterprise knowledge retrieval engineered with Fastify, PostgreSQL/pgvector, React,
          and verifiable citation tracking. Bootstrapped with strict typing, structured logging, and
          deterministic environment validation.
        </p>
      </section>

      {/* Main Grid: Health & Telemetry */}
      <div className="dashboard-grid">
        {/* Fastify Health Endpoint Card */}
        <div className="glass-card" id="card-api-health">
          <div className="card-header">
            <div className="card-title">
              <Activity size={20} color="var(--brand-primary)" />
              <span>Fastify API Health</span>
            </div>
            <button
              id="btn-recheck-health"
              className="btn-primary"
              onClick={() => void checkHealth()}
              disabled={health.loading}
            >
              <RefreshCw size={14} className={health.loading ? 'animate-spin' : ''} />
              <span>{health.loading ? 'Probing...' : 'Check Health'}</span>
            </button>
          </div>

          <div className="metrics-list" id="health-metrics-container">
            <div className="metric-row">
              <span className="metric-label">API Status</span>
              {health.loading ? (
                <span className="badge-status loading">Probing</span>
              ) : health.data ? (
                <span className="badge-status ok">
                  <CheckCircle2 size={12} style={{ display: 'inline', marginRight: 4 }} />
                  {health.data.status}
                </span>
              ) : (
                <span className="badge-status error">
                  <AlertCircle size={12} style={{ display: 'inline', marginRight: 4 }} />
                  Offline
                </span>
              )}
            </div>

            <div className="metric-row">
              <span className="metric-label">Round-Trip Latency</span>
              <span className="metric-value">
                {health.latencyMs !== null ? `${health.latencyMs} ms` : '—'}
              </span>
            </div>

            <div className="metric-row">
              <span className="metric-label">Server Uptime</span>
              <span className="metric-value">
                {health.data ? `${health.data.uptime.toFixed(1)}s` : '—'}
              </span>
            </div>

            <div className="metric-row">
              <span className="metric-label">Server Version</span>
              <span className="metric-value">{health.data?.version ?? '—'}</span>
            </div>

            <div className="metric-row">
              <span className="metric-label">Environment</span>
              <span className="metric-value">{health.data?.environment ?? '—'}</span>
            </div>

            <div className="metric-row">
              <span className="metric-label">Last Ping</span>
              <span className="metric-value">{health.lastChecked ?? 'Pending'}</span>
            </div>
          </div>
        </div>

        {/* Runtime Environment & Architecture Info */}
        <div className="glass-card" id="card-runtime-env">
          <div className="card-header">
            <div className="card-title">
              <Server size={20} color="var(--brand-secondary)" />
              <span>Monorepo Architecture</span>
            </div>
          </div>

          <div className="metrics-list">
            <div className="metric-row">
              <span className="metric-label">API Core</span>
              <span className="metric-value">Fastify 5 + TypeScript</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Frontend Stack</span>
              <span className="metric-value">React 18 + Vite</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Shared Domain Models</span>
              <span className="metric-value">@devdocs/shared (Zod)</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Client Mode</span>
              <span className="metric-value">{webConfig.mode}</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">TypeScript Strictness</span>
              <span className="metric-value" style={{ color: 'var(--status-ok)' }}>100% Strict</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Logging Strategy</span>
              <span className="metric-value">Pino + Header Redaction</span>
            </div>
          </div>
        </div>
      </div>

      {/* Roadmap & Architecture Modules */}
      <section className="roadmap-section" id="roadmap-section">
        <h2 className="section-title">Incremental Delivery Plan</h2>
        <div className="roadmap-grid">
          {roadmapPhases.map((phase) => {
            const Icon = phase.icon;
            const isActive = phase.status === 'active';
            return (
              <div
                key={phase.num}
                className={`roadmap-card ${isActive ? 'active' : ''}`}
                id={`phase-card-${phase.num}`}
              >
                <div className="roadmap-card-header">
                  <span className="phase-number">Phase {phase.num}</span>
                  <span className={`status-tag ${isActive ? 'done' : 'queued'}`}>
                    {isActive ? 'Current' : 'Planned'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Icon size={16} color={isActive ? 'var(--brand-primary)' : 'var(--text-muted)'} />
                  <h3 className="phase-title" style={{ margin: 0 }}>{phase.title}</h3>
                </div>
                <p className="phase-desc">{phase.desc}</p>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
