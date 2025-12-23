/**
 * User Message Hook - SessionStart
 * Displays context information to the user via stderr
 *
 * This hook runs in parallel with context-hook to show users what context
 * has been loaded into their session. Uses stderr as the communication channel
 * since it's currently the only way to display messages in Claude Code UI.
 */
import { basename } from "path";
import { ensureWorkerRunning, getWorkerBaseUrl, getWorkerHeaders, isClientMode } from "../shared/worker-utils.js";
import { HOOK_EXIT_CODES } from "../shared/hook-constants.js";

// Ensure worker is running
await ensureWorkerRunning();

const baseUrl = getWorkerBaseUrl();
const headers = getWorkerHeaders();
const project = basename(process.cwd());
const clientMode = isClientMode();

// Fetch formatted context directly from worker API
const response = await fetch(
  `${baseUrl}/api/context/inject?project=${encodeURIComponent(project)}&colors=true`,
  { method: 'GET', headers, signal: AbortSignal.timeout(5000) }
);

if (!response.ok) {
  throw new Error(`Failed to fetch context: ${response.status}`);
}

const output = await response.text();

const modeLabel = clientMode ? "🔗 Connected to remote server" : "📺 Watch live in browser";
const serverUrl = clientMode ? baseUrl : `http://localhost:37777/`;

console.error(
  "\n\n📝 Claude-Mem Context Loaded\n" +
  "   ℹ️  Note: This appears as stderr but is informational only\n\n" +
  output +
  "\n\n💡 New! Wrap all or part of any message with <private> ... </private> to prevent storing sensitive information in your observation history.\n" +
  "\n💬 Community https://discord.gg/J4wttp9vDu" +
  `\n${modeLabel} ${serverUrl}\n`
);

process.exit(HOOK_EXIT_CODES.USER_MESSAGE_ONLY);