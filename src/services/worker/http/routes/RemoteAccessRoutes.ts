/**
 * Remote Access Routes
 *
 * Handles remote access configuration, tunnel management,
 * and client setup for multi-device claude-mem access.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { requireLocalhost } from '../middleware.js';
import { getTunnelManager, TunnelManager } from '../../TunnelManager.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';

export class RemoteAccessRoutes extends BaseRouteHandler {
  private tunnelManager: TunnelManager;

  constructor() {
    super();
    this.tunnelManager = getTunnelManager();
  }

  setupRoutes(app: express.Application): void {
    // Check cloudflared installation (localhost only - setup)
    app.get('/api/remote/check-cloudflared', requireLocalhost, this.handleCheckCloudflared.bind(this));

    // Get tunnel status
    app.get('/api/remote/status', this.handleGetStatus.bind(this));

    // Start tunnel (localhost only)
    app.post('/api/remote/start-tunnel', requireLocalhost, this.handleStartTunnel.bind(this));

    // Stop tunnel (localhost only)
    app.post('/api/remote/stop-tunnel', requireLocalhost, this.handleStopTunnel.bind(this));

    // Configure remote access (localhost only)
    app.post('/api/remote/configure', requireLocalhost, this.handleConfigure.bind(this));

    // Generate auth token (localhost only)
    app.post('/api/remote/generate-token', requireLocalhost, this.handleGenerateToken.bind(this));

    // Test remote connection (for clients)
    app.get('/api/remote/test-connection', this.handleTestConnection.bind(this));

    // Get client setup info (for dashboard display)
    app.get('/api/remote/client-setup', requireLocalhost, this.handleGetClientSetup.bind(this));
  }

  /**
   * Check if cloudflared is installed
   */
  private handleCheckCloudflared = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const info = await this.tunnelManager.checkCloudflared();
    res.json(info);
  });

  /**
   * Get current tunnel and remote access status
   */
  private handleGetStatus = this.wrapHandler((req: Request, res: Response): void => {
    const tunnelStatus = this.tunnelManager.getStatus();
    const settings = this.loadSettings();

    res.json({
      tunnel: tunnelStatus,
      remoteEnabled: settings.CLAUDE_MEM_REMOTE_ENABLED === 'true',
      installMode: settings.CLAUDE_MEM_INSTALL_MODE,
      hasAuthToken: !!settings.CLAUDE_MEM_AUTH_TOKEN,
      tunnelProvider: settings.CLAUDE_MEM_TUNNEL_PROVIDER,
      tunnelUrl: settings.CLAUDE_MEM_TUNNEL_URL || tunnelStatus.url,
      tunnelAutostart: settings.CLAUDE_MEM_TUNNEL_AUTOSTART === 'true'
    });
  });

  /**
   * Start cloudflared tunnel
   */
  private handleStartTunnel = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { provider = 'cloudflare' } = req.body;

    if (this.tunnelManager.isRunning()) {
      res.status(400).json({ error: 'Tunnel already running' });
      return;
    }

    try {
      const url = await this.tunnelManager.startTunnel(provider);

      // Save tunnel URL to settings
      this.updateSettings({ CLAUDE_MEM_TUNNEL_URL: url });

      res.json({
        success: true,
        url,
        pid: this.tunnelManager.getStatus().pid
      });
    } catch (error) {
      logger.error('REMOTE', 'Failed to start tunnel', {}, error as Error);
      res.status(500).json({
        success: false,
        error: (error as Error).message
      });
    }
  });

  /**
   * Stop cloudflared tunnel
   */
  private handleStopTunnel = this.wrapHandler((req: Request, res: Response): void => {
    this.tunnelManager.stopTunnel();

    // Clear tunnel URL in settings
    this.updateSettings({ CLAUDE_MEM_TUNNEL_URL: '' });

    res.json({ success: true });
  });

  /**
   * Configure remote access settings
   * This will trigger a server restart if necessary
   */
  private handleConfigure = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const {
      remoteEnabled,
      authToken,
      tunnelProvider,
      tunnelUrl,
      tunnelAutostart
    } = req.body;

    const updates: Record<string, string> = {};

    if (remoteEnabled !== undefined) {
      updates.CLAUDE_MEM_REMOTE_ENABLED = remoteEnabled ? 'true' : 'false';
    }
    if (authToken !== undefined) {
      updates.CLAUDE_MEM_AUTH_TOKEN = authToken;
    }
    if (tunnelProvider !== undefined) {
      updates.CLAUDE_MEM_TUNNEL_PROVIDER = tunnelProvider;
    }
    if (tunnelUrl !== undefined) {
      updates.CLAUDE_MEM_TUNNEL_URL = tunnelUrl;
    }
    if (tunnelAutostart !== undefined) {
      updates.CLAUDE_MEM_TUNNEL_AUTOSTART = tunnelAutostart ? 'true' : 'false';
    }

    this.updateSettings(updates);

    logger.info('REMOTE', 'Remote access configured', updates);

    // Respond before restart
    res.json({
      success: true,
      restarting: true,
      message: 'Configuration saved. Server will restart.'
    });

    // Schedule restart
    setTimeout(() => {
      logger.info('SYSTEM', 'Restarting for remote access configuration...');
      process.exit(0); // Clean exit - will be restarted by parent process
    }, 100);
  });

  /**
   * Generate a new random auth token
   */
  private handleGenerateToken = this.wrapHandler((req: Request, res: Response): void => {
    const token = TunnelManager.generateAuthToken();
    res.json({ token });
  });

  /**
   * Test connection endpoint for clients to verify they can reach the server
   */
  private handleTestConnection = this.wrapHandler((req: Request, res: Response): void => {
    const settings = this.loadSettings();

    res.json({
      success: true,
      serverTime: new Date().toISOString(),
      installMode: settings.CLAUDE_MEM_INSTALL_MODE,
      remoteEnabled: settings.CLAUDE_MEM_REMOTE_ENABLED === 'true'
    });
  });

  /**
   * Get client setup instructions and connection details
   */
  private handleGetClientSetup = this.wrapHandler((req: Request, res: Response): void => {
    const settings = this.loadSettings();
    const tunnelStatus = this.tunnelManager.getStatus();

    const serverUrl = settings.CLAUDE_MEM_TUNNEL_URL || tunnelStatus.url;

    res.json({
      serverUrl,
      hasAuthToken: !!settings.CLAUDE_MEM_AUTH_TOKEN,
      // Don't expose actual token - just confirm it exists
      instructions: {
        step1: 'Install claude-mem on your other device: claude plugins install claude-mem',
        step2: 'When prompted, select "Client Mode"',
        step3: serverUrl ? `Enter server URL: ${serverUrl}` : 'Start tunnel first to get server URL',
        step4: settings.CLAUDE_MEM_AUTH_TOKEN ? 'Enter the auth token from your server' : 'No auth token configured (consider setting one for security)'
      }
    });
  });

  /**
   * Load current settings
   */
  private loadSettings(): Record<string, string> {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    return SettingsDefaultsManager.loadFromFile(settingsPath);
  }

  /**
   * Update settings file
   */
  private updateSettings(updates: Record<string, string>): void {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');

    // Ensure directory exists
    const dir = path.dirname(settingsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Load existing settings
    let settings: Record<string, string> = {};
    if (existsSync(settingsPath)) {
      const data = readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(data);
    }

    // Apply updates
    Object.assign(settings, updates);

    // Write back
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }
}
