import React, { useState, useEffect, useCallback } from 'react';
import type { RemoteStatus, CloudflaredInfo, Settings } from '../types';

interface RemoteAccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSave: (settings: Settings) => void;
}

// Status badge component
function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span className={`status-badge ${active ? 'active' : 'inactive'}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

// Toggle switch component
function ToggleSwitch({
  id,
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <label htmlFor={id} className="toggle-label">{label}</label>
        {description && <span className="toggle-description">{description}</span>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        className={`toggle-switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

// Copy button component
function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? 'copied' : ''}`}
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
      {label && <span>{label}</span>}
    </button>
  );
}

export function RemoteAccessModal({
  isOpen,
  onClose,
  settings,
  onSave
}: RemoteAccessModalProps) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [cloudflaredInfo, setCloudflaredInfo] = useState<CloudflaredInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isTunnelStarting, setIsTunnelStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);

  // Fetch status on mount and periodically
  const fetchStatus = useCallback(async () => {
    try {
      const [statusRes, cloudflaredRes] = await Promise.all([
        fetch('/api/remote/status'),
        fetch('/api/remote/check-cloudflared')
      ]);

      if (statusRes.ok) {
        const statusData = await statusRes.json();
        setStatus(statusData);
      }

      if (cloudflaredRes.ok) {
        const cloudflaredData = await cloudflaredRes.json();
        setCloudflaredInfo(cloudflaredData);
      }

      setIsLoading(false);
      setError(null);
    } catch (err) {
      setError('Failed to fetch status');
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchStatus();
      // Poll every 5 seconds while modal is open
      const interval = setInterval(fetchStatus, 5000);
      return () => clearInterval(interval);
    }
  }, [isOpen, fetchStatus]);

  // Handle ESC key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  const handleStartTunnel = async () => {
    setIsTunnelStarting(true);
    setError(null);

    try {
      const res = await fetch('/api/remote/start-tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: settings.CLAUDE_MEM_TUNNEL_PROVIDER || 'cloudflare' })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start tunnel');
      }

      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsTunnelStarting(false);
    }
  };

  const handleStopTunnel = async () => {
    try {
      await fetch('/api/remote/stop-tunnel', { method: 'POST' });
      await fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleGenerateToken = async () => {
    try {
      const res = await fetch('/api/remote/generate-token', { method: 'POST' });
      const data = await res.json();
      setNewToken(data.token);
      setShowToken(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleSaveToken = () => {
    if (newToken) {
      onSave({ ...settings, CLAUDE_MEM_AUTH_TOKEN: newToken });
      setNewToken(null);
    }
  };

  const handleToggleAutostart = (checked: boolean) => {
    onSave({ ...settings, CLAUDE_MEM_TUNNEL_AUTOSTART: checked ? 'true' : 'false' });
  };

  const handleConfigure = async () => {
    setIsReconnecting(true);

    try {
      const res = await fetch('/api/remote/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remoteEnabled: true,
          tunnelUrl: status?.tunnelUrl,
          tunnelAutostart: settings.CLAUDE_MEM_TUNNEL_AUTOSTART === 'true'
        })
      });

      if (!res.ok) {
        throw new Error('Failed to configure');
      }

      // Wait for server restart
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Poll until server is back
      for (let i = 0; i < 30; i++) {
        try {
          const healthRes = await fetch('/api/health');
          if (healthRes.ok) {
            setIsReconnecting(false);
            await fetchStatus();
            return;
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      throw new Error('Server did not restart in time');
    } catch (err) {
      setError((err as Error).message);
      setIsReconnecting(false);
    }
  };

  if (!isOpen) return null;

  const tunnelUrl = status?.tunnelUrl || status?.tunnel?.url;
  const isTunnelActive = status?.tunnel?.active ?? false;
  const hasToken = status?.hasAuthToken ?? false;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="remote-access-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>Remote Access</h2>
          <button onClick={onClose} className="modal-close-btn" title="Close (Esc)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="modal-body remote-access-body">
          {isLoading ? (
            <div className="loading-state">Loading...</div>
          ) : isReconnecting ? (
            <div className="loading-state">
              <div className="spinner" />
              <p>Restarting server...</p>
            </div>
          ) : (
            <>
              {error && (
                <div className="error-banner">
                  {error}
                  <button onClick={() => setError(null)}>×</button>
                </div>
              )}

              {/* Status Section */}
              <section className="remote-section">
                <h3>Status</h3>
                <div className="status-grid">
                  <div className="status-item">
                    <span className="status-label">Tunnel</span>
                    <StatusBadge active={isTunnelActive} label={isTunnelActive ? 'Active' : 'Inactive'} />
                  </div>
                  <div className="status-item">
                    <span className="status-label">Authentication</span>
                    <StatusBadge active={hasToken} label={hasToken ? 'Configured' : 'Not Set'} />
                  </div>
                </div>
              </section>

              {/* Cloudflared Section */}
              <section className="remote-section">
                <h3>Cloudflare Tunnel</h3>

                {cloudflaredInfo && !cloudflaredInfo.installed ? (
                  <div className="install-instructions">
                    <p className="warning-text">cloudflared not found. Install it first:</p>
                    <div className="code-block">
                      <code>
                        # macOS<br />
                        brew install cloudflared<br /><br />
                        # Ubuntu/Debian (download .deb)<br />
                        curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb<br /><br />
                        # Arch Linux<br />
                        yay -S cloudflared<br /><br />
                        # Windows<br />
                        winget install cloudflare.cloudflared
                      </code>
                    </div>
                  </div>
                ) : (
                  <>
                    {cloudflaredInfo?.version && (
                      <p className="version-info">cloudflared v{cloudflaredInfo.version}</p>
                    )}

                    {isTunnelActive ? (
                      <div className="tunnel-active">
                        <div className="tunnel-url-row">
                          <input
                            type="text"
                            readOnly
                            value={tunnelUrl || ''}
                            className="tunnel-url-input"
                          />
                          <CopyButton text={tunnelUrl || ''} />
                        </div>
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={handleStopTunnel}
                        >
                          Stop Tunnel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleStartTunnel}
                        disabled={isTunnelStarting}
                      >
                        {isTunnelStarting ? 'Starting...' : 'Start Tunnel'}
                      </button>
                    )}

                    <ToggleSwitch
                      id="tunnel-autostart"
                      label="Auto-start tunnel"
                      description="Start tunnel automatically when worker starts"
                      checked={settings.CLAUDE_MEM_TUNNEL_AUTOSTART === 'true'}
                      onChange={handleToggleAutostart}
                    />
                  </>
                )}
              </section>

              {/* Authentication Section */}
              <section className="remote-section">
                <h3>Authentication</h3>
                <p className="section-description">
                  Generate an auth token to secure remote connections.
                  Clients will need this token to connect.
                </p>

                {newToken ? (
                  <div className="new-token-section">
                    <p className="warning-text">Save this token now - it won't be shown again!</p>
                    <div className="token-display">
                      <input
                        type={showToken ? 'text' : 'password'}
                        readOnly
                        value={newToken}
                        className="token-input"
                      />
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setShowToken(!showToken)}
                      >
                        {showToken ? 'Hide' : 'Show'}
                      </button>
                      <CopyButton text={newToken} />
                    </div>
                    <div className="token-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleSaveToken}
                      >
                        Save Token
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => setNewToken(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="token-status">
                    {hasToken ? (
                      <p className="success-text">Auth token is configured</p>
                    ) : (
                      <p className="warning-text">No auth token set - remote access will be insecure</p>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleGenerateToken}
                    >
                      {hasToken ? 'Generate New Token' : 'Generate Token'}
                    </button>
                  </div>
                )}
              </section>

              {/* Client Setup Section */}
              {isTunnelActive && (
                <section className="remote-section">
                  <h3>Client Setup Instructions</h3>
                  <div className="setup-instructions">
                    <div className="step">
                      <span className="step-number">1</span>
                      <div className="step-content">
                        <p>Install claude-mem on your other device:</p>
                        <div className="code-inline">
                          <code>claude plugins install claude-mem</code>
                          <CopyButton text="claude plugins install claude-mem" />
                        </div>
                      </div>
                    </div>
                    <div className="step">
                      <span className="step-number">2</span>
                      <div className="step-content">
                        <p>When prompted, select <strong>"Client Mode"</strong></p>
                      </div>
                    </div>
                    <div className="step">
                      <span className="step-number">3</span>
                      <div className="step-content">
                        <p>Enter the server URL:</p>
                        <div className="code-inline">
                          <code>{tunnelUrl}</code>
                          <CopyButton text={tunnelUrl || ''} />
                        </div>
                      </div>
                    </div>
                    {hasToken && (
                      <div className="step">
                        <span className="step-number">4</span>
                        <div className="step-content">
                          <p>Enter your auth token (copy from above)</p>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
