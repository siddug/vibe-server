/**
 * Approval Service
 *
 * Handles tool approval requests by:
 * 1. Forwarding them to connected WebSocket clients
 * 2. Waiting for approval responses
 * 3. Returning the result to the caller
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  ApprovalRequest,
  ApprovalResponse,
  ApprovalStatus,
} from './control-protocol.js';

const DEFAULT_TIMEOUT_MS = 60000; // 60 seconds

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (status: ApprovalStatus, reason?: string) => void;
  timeoutId: NodeJS.Timeout;
}

/**
 * Approval Service manages tool approval requests
 */
export class ApprovalService extends EventEmitter {
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    super();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Request approval for a tool call
   * Returns a promise that resolves when the user approves/denies or times out
   */
  async requestApproval(
    toolName: string,
    toolInput: unknown,
    toolUseId?: string
  ): Promise<{ status: ApprovalStatus; reason?: string }> {
    const id = randomUUID();
    const requestId = id;

    const request: ApprovalRequest = {
      id,
      requestId,
      toolName,
      toolInput,
      toolUseId,
      timestamp: Date.now(),
    };

    return new Promise((resolve) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        this.handleResponse({
          requestId,
          status: 'timeout',
          reason: 'Approval request timed out',
        });
      }, this.timeoutMs);

      // Store pending approval
      this.pendingApprovals.set(requestId, {
        request,
        resolve: (status, reason) => resolve({ status, reason }),
        timeoutId,
      });

      // Emit event for WebSocket handlers to pick up
      this.emit('approvalRequest', request);
    });
  }

  /**
   * Handle an approval response from the frontend
   */
  handleResponse(response: ApprovalResponse): boolean {
    const pending = this.pendingApprovals.get(response.requestId);
    if (!pending) {
      return false;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeoutId);
    this.pendingApprovals.delete(response.requestId);

    // Resolve the promise
    pending.resolve(response.status, response.reason);

    // Emit event for logging/tracking
    this.emit('approvalResponse', response);

    return true;
  }

  /**
   * Get all pending approval requests
   */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values()).map((p) => p.request);
  }

  /**
   * Cancel all pending approvals (e.g., when session ends)
   */
  cancelAll(reason = 'Session ended'): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      clearTimeout(pending.timeoutId);
      pending.resolve('denied', reason);
    }
    this.pendingApprovals.clear();
  }

  /**
   * Check if there are any pending approvals
   */
  hasPending(): boolean {
    return this.pendingApprovals.size > 0;
  }
}

/**
 * Create a new approval service
 */
export function createApprovalService(
  options: { timeoutMs?: number } = {}
): ApprovalService {
  return new ApprovalService(options);
}
