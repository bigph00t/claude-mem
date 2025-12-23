/**
 * TunnelManager - Manages cloudflared tunnel process
 *
 * Handles starting, stopping, and monitoring cloudflared tunnels
 * for remote access functionality.
 */

import { ChildProcess, spawn, exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { getWorkerPort } from '../../shared/worker-utils.js';

const execAsync = promisify(exec);

export interface TunnelStatus {
  active: boolean;
  url: string | null;
  pid: number | null;
  provider: 'cloudflare' | 'tailscale' | 'ngrok' | 'manual';
  error: string | null;
}

export interface CloudflaredInfo {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export class TunnelManager {
  private tunnelProcess: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private provider: 'cloudflare' | 'tailscale' | 'ngrok' | 'manual' = 'cloudflare';

  /**
   * Check if cloudflared is installed and get version info
   */
  async checkCloudflared(): Promise<CloudflaredInfo> {
    try {
      const isWindows = process.platform === 'win32';
      const whichCmd = isWindows ? 'where cloudflared' : 'which cloudflared';

      const { stdout: pathOutput } = await execAsync(whichCmd, { timeout: 5000 });
      const cloudflaredPath = pathOutput.trim().split('\n')[0];

      // Get version
      const { stdout: versionOutput } = await execAsync('cloudflared --version', { timeout: 5000 });
      const versionMatch = versionOutput.match(/cloudflared version (\S+)/);
      const version = versionMatch ? versionMatch[1] : versionOutput.trim();

      return {
        installed: true,
        version,
        path: cloudflaredPath
      };
    } catch (error) {
      return {
        installed: false,
        version: null,
        path: null
      };
    }
  }

  /**
   * Start a cloudflared quick tunnel
   * Returns the public URL once established
   */
  async startTunnel(provider: 'cloudflare' | 'tailscale' | 'ngrok' | 'manual' = 'cloudflare'): Promise<string> {
    if (this.tunnelProcess) {
      throw new Error('Tunnel already running');
    }

    this.provider = provider;

    if (provider !== 'cloudflare') {
      throw new Error(`Provider ${provider} not yet supported. Only cloudflare is currently implemented.`);
    }

    const port = getWorkerPort();

    logger.info('TUNNEL', 'Starting cloudflared tunnel', { port });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stopTunnel();
        reject(new Error('Tunnel startup timeout (30s) - no URL received'));
      }, 30000);

      this.tunnelProcess = spawn('cloudflared', [
        'tunnel',
        '--url', `http://localhost:${port}`
      ], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.tunnelProcess.on('error', (error) => {
        clearTimeout(timeout);
        this.tunnelProcess = null;
        reject(new Error(`Failed to start cloudflared: ${error.message}`));
      });

      this.tunnelProcess.on('exit', (code, signal) => {
        logger.info('TUNNEL', 'cloudflared process exited', { code, signal });
        this.tunnelProcess = null;
        this.tunnelUrl = null;
      });

      // cloudflared outputs the URL to stderr
      this.tunnelProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        logger.debug('TUNNEL', 'cloudflared output', { output: output.substring(0, 200) });

        // Look for the tunnel URL
        // Format: "Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): https://xxx.trycloudflare.com"
        // Or: "https://xxx.trycloudflare.com"
        const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (urlMatch && !this.tunnelUrl) {
          this.tunnelUrl = urlMatch[0];
          clearTimeout(timeout);
          logger.success('TUNNEL', 'Tunnel established', { url: this.tunnelUrl });
          resolve(this.tunnelUrl);
        }
      });

      // Also check stdout just in case
      this.tunnelProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        const urlMatch = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (urlMatch && !this.tunnelUrl) {
          this.tunnelUrl = urlMatch[0];
          clearTimeout(timeout);
          logger.success('TUNNEL', 'Tunnel established', { url: this.tunnelUrl });
          resolve(this.tunnelUrl);
        }
      });
    });
  }

  /**
   * Stop the tunnel process
   */
  stopTunnel(): void {
    if (this.tunnelProcess) {
      logger.info('TUNNEL', 'Stopping tunnel', { pid: this.tunnelProcess.pid });

      // Send SIGTERM first, then SIGKILL after timeout
      this.tunnelProcess.kill('SIGTERM');

      const killTimeout = setTimeout(() => {
        if (this.tunnelProcess) {
          this.tunnelProcess.kill('SIGKILL');
        }
      }, 5000);

      this.tunnelProcess.on('exit', () => {
        clearTimeout(killTimeout);
      });

      this.tunnelProcess = null;
      this.tunnelUrl = null;
    }
  }

  /**
   * Get current tunnel status
   */
  getStatus(): TunnelStatus {
    return {
      active: this.tunnelProcess !== null && this.tunnelUrl !== null,
      url: this.tunnelUrl,
      pid: this.tunnelProcess?.pid || null,
      provider: this.provider,
      error: null
    };
  }

  /**
   * Check if tunnel is running
   */
  isRunning(): boolean {
    return this.tunnelProcess !== null;
  }

  /**
   * Get the tunnel URL
   */
  getUrl(): string | null {
    return this.tunnelUrl;
  }

  /**
   * Generate a random auth token
   */
  static generateAuthToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 32; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }
}

// Singleton instance
let tunnelManagerInstance: TunnelManager | null = null;

export function getTunnelManager(): TunnelManager {
  if (!tunnelManagerInstance) {
    tunnelManagerInstance = new TunnelManager();
  }
  return tunnelManagerInstance;
}
