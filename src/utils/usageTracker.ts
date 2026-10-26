import { configManager } from '../config-manager.js';

export interface ToolUsageStats {
  // Tool category counters
  filesystemOperations: number;
  terminalOperations: number;
  editOperations: number;
  searchOperations: number;
  configOperations: number;
  processOperations: number;

  // Overall counters
  totalToolCalls: number;
  successfulCalls: number;
  failedCalls: number;

  // Tool-specific counters
  toolCounts: Record<string, number>;

  // Timing information
  firstUsed: number; // timestamp
  lastUsed: number; // timestamp
  totalSessions: number; // rough session counter
}

export interface UsageSession {
  sessionStart: number;
  lastActivity: number;
  commandsInSession: number;
}

// Tool categories mapping
const TOOL_CATEGORIES = {
  filesystem: ['read_file', 'read_multiple_files', 'write_file', 'create_directory', 'list_directory', 'move_file', 'get_file_info'],
  terminal: ['execute_command', 'read_output', 'force_terminate', 'list_sessions'],
  edit: ['edit_block'],
  search: ['start_search', 'get_more_search_results', 'stop_search', 'list_searches'],
  config: ['get_config', 'set_config_value'],
  process: ['list_processes', 'kill_process']
};

// Session timeout (30 minutes of inactivity = new session)
const SESSION_TIMEOUT = 30 * 60 * 1000;

class UsageTracker {
  private currentSession: UsageSession | null = null;

  /**
   * Get default usage stats
   */
  private getDefaultStats(): ToolUsageStats {
    return {
      filesystemOperations: 0,
      terminalOperations: 0,
      editOperations: 0,
      searchOperations: 0,
      configOperations: 0,
      processOperations: 0,
      totalToolCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      toolCounts: {},
      firstUsed: Date.now(),
      lastUsed: Date.now(),
      totalSessions: 0,  // Start at 0, incremented on first command
    };
  }

  /**
   * Get current usage stats from config
   */
  async getStats(): Promise<ToolUsageStats> {
    const stats = await configManager.getValue('usageStats');
    return stats || this.getDefaultStats();
  }

  /**
   * Determine which category a tool belongs to
   */
  private getToolCategory(toolName: string): keyof Omit<ToolUsageStats, 'totalToolCalls' | 'successfulCalls' | 'failedCalls' | 'toolCounts' | 'firstUsed' | 'lastUsed' | 'totalSessions'> | null {
    for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
      if (tools.includes(toolName)) {
        switch (category) {
          case 'filesystem': return 'filesystemOperations';
          case 'terminal': return 'terminalOperations';
          case 'edit': return 'editOperations';
          case 'search': return 'searchOperations';
          case 'config': return 'configOperations';
          case 'process': return 'processOperations';
        }
      }
    }
    return null;
  }

  /**
   * Check if we're in a new session
   */
  private isNewSession(): boolean {
    if (!this.currentSession) return true;

    const now = Date.now();
    const timeSinceLastActivity = now - this.currentSession.lastActivity;

    return timeSinceLastActivity > SESSION_TIMEOUT;
  }

  /**
   * Update session tracking
   */
  private updateSession(): void {
    const now = Date.now();

    if (this.isNewSession()) {
      this.currentSession = {
        sessionStart: now,
        lastActivity: now,
        commandsInSession: 1
      };
    } else {
      this.currentSession!.lastActivity = now;
      this.currentSession!.commandsInSession++;
    }
  }

  /**
   * Track a successful tool call
   */
  async trackSuccess(toolName: string): Promise<ToolUsageStats> {
    this.updateSession();
    const now = Date.now();
    const category = this.getToolCategory(toolName);
    const newSession = this.currentSession?.commandsInSession === 1;

    return await configManager.updateValueNonBlocking('usageStats', (stored) => {
      const defaults = { ...this.getDefaultStats(), firstUsed: now, lastUsed: now };
      const stats: ToolUsageStats = {
        ...defaults,
        ...(stored || {}),
        toolCounts: { ...(stored?.toolCounts || {}) },
      };
      stats.totalToolCalls++;
      stats.successfulCalls++;
      stats.lastUsed = Math.max(stats.lastUsed || 0, now);
      stats.toolCounts[toolName] = (stats.toolCounts[toolName] || 0) + 1;
      if (category) stats[category]++;
      if (newSession) stats.totalSessions++;
      return stats;
    });
  }

  /**
   * Track a failed tool call
   */
  async trackFailure(toolName: string): Promise<ToolUsageStats> {
    this.updateSession();
    const now = Date.now();
    const category = this.getToolCategory(toolName);
    const newSession = this.currentSession?.commandsInSession === 1;

    return await configManager.updateValueNonBlocking('usageStats', (stored) => {
      const defaults = { ...this.getDefaultStats(), firstUsed: now, lastUsed: now };
      const stats: ToolUsageStats = {
        ...defaults,
        ...(stored || {}),
        toolCounts: { ...(stored?.toolCounts || {}) },
      };
      stats.totalToolCalls++;
      stats.failedCalls++;
      stats.lastUsed = Math.max(stats.lastUsed || 0, now);
      stats.toolCounts[toolName] = (stats.toolCounts[toolName] || 0) + 1;
      if (category) stats[category]++;
      if (newSession) stats.totalSessions++;
      return stats;
    });
  }

  /**
   * Get usage summary for debugging/admin purposes
   */
  async getUsageSummary(): Promise<string> {
    const stats = await this.getStats();
    const now = Date.now();

    const daysSinceFirst = Math.round((now - stats.firstUsed) / (1000 * 60 * 60 * 24));
    const uniqueTools = Object.keys(stats.toolCounts).length;
    const successRate = stats.totalToolCalls > 0 ?
      Math.round((stats.successfulCalls / stats.totalToolCalls) * 100) : 0;

    const topTools = Object.entries(stats.toolCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([tool, count]) => `${tool}: ${count}`)
      .join(', ');

    return `📊 **Local Usage Summary**
• Total calls: ${stats.totalToolCalls} (${stats.successfulCalls} successful, ${stats.failedCalls} failed)
• Success rate: ${successRate}%
• Days using: ${daysSinceFirst}
• Sessions: ${stats.totalSessions}
• Unique tools: ${uniqueTools}
• Most used: ${topTools || 'None'}

**By Category:**
• Filesystem: ${stats.filesystemOperations}
• Terminal: ${stats.terminalOperations}
• Editing: ${stats.editOperations}
• Search: ${stats.searchOperations}
• Config: ${stats.configOperations}
• Process: ${stats.processOperations}`;
  }
}

// Export singleton instance
export const usageTracker = new UsageTracker();
