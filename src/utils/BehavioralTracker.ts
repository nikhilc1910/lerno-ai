import { authFetch } from "../lib/api";
import { auth } from "../components/firebaseConfig";

export interface TelemetryPayload {
  session_id: string;
  event_type: string;
  element_id?: string | null;
  interaction_speed_ms?: number | null;
  hover_duration_ms?: number | null;
  idle_before_action_ms?: number | null;
  response_latency_ms?: number | null;
  replay_count?: number | null;
  sentiment_score?: number | null;
  [key: string]: any;
}

class BehavioralTracker {
  private sessionId: string;
  private lastInteractionTime: number;
  private eventQueue: TelemetryPayload[] = [];
  private batchInterval: number | null = null;
  private hoverStartTime: Map<string, number> = new Map();
  private mouseMovements: { x: number; y: number; time: number }[] = [];
  private idleThresholdMs = 5000; // 5 seconds idle threshold
  private isIdle = false;
  private idleStartTime = 0;

  constructor() {
    this.sessionId = this.getOrCreateSessionId();
    this.lastInteractionTime = Date.now();
  }

  private getOrCreateSessionId(): string {
    if (typeof window === "undefined") return "server-session";
    let sid = sessionStorage.getItem("lerno_session_id");
    if (!sid) {
      sid = typeof crypto !== 'undefined' && crypto.randomUUID 
        ? crypto.randomUUID() 
        : Math.random().toString(36).substring(2) + Date.now().toString(36);
      sessionStorage.setItem("lerno_session_id", sid);
    }
    return sid;
  }

  public start(): void {
    if (typeof window === "undefined") return;

    // Attach interaction listeners
    window.addEventListener("mousemove", this.handleMouseMove);
    window.addEventListener("mousedown", this.handleMouseDown);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("visibilitychange", this.handleVisibilityChange);

    // Dynamic hover listeners using event delegation
    document.addEventListener("mouseover", this.handleMouseOver);
    document.addEventListener("mouseout", this.handleMouseOut);

    // Setup periodic sync (every 5 seconds)
    this.batchInterval = window.setInterval(() => this.syncTelemetry(), 5000);

    // Final sync on page unload
    window.addEventListener("beforeunload", () => this.syncTelemetrySync());
    
    this.lastInteractionTime = Date.now();
  }

  public stop(): void {
    if (typeof window === "undefined") return;

    window.removeEventListener("mousemove", this.handleMouseMove);
    window.removeEventListener("mousedown", this.handleMouseDown);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("visibilitychange", this.handleVisibilityChange);

    document.removeEventListener("mouseover", this.handleMouseOver);
    document.removeEventListener("mouseout", this.handleMouseOut);

    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
    this.syncTelemetry();
  }

  private handleInteraction = (): void => {
    const now = Date.now();

    if (this.isIdle) {
      const idleDuration = now - this.idleStartTime;
      this.queueEvent({
        session_id: this.sessionId,
        event_type: "idle",
        idle_before_action_ms: idleDuration,
      });
      this.isIdle = false;
    }

    this.lastInteractionTime = now;
  };

  private handleMouseMove = (e: MouseEvent): void => {
    const now = Date.now();
    this.mouseMovements.push({ x: e.clientX, y: e.clientY, time: now });

    if (this.mouseMovements.length > 50) {
      this.mouseMovements.shift();
    }

    this.handleInteraction();
  };

  private handleMouseDown = (e: MouseEvent): void => {
    this.handleInteraction();

    const target = e.target as HTMLElement;
    const elementId = target.id || target.getAttribute("data-telemetry-id") || target.tagName;
    
    const speed = this.calculateRecentMouseSpeed(500);

    this.queueEvent({
      session_id: this.sessionId,
      event_type: "click",
      element_id: elementId,
      interaction_speed_ms: Math.round(speed),
    });
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    this.handleInteraction();
    this.queueEvent({
      session_id: this.sessionId,
      event_type: "keystroke",
      element_id: e.key,
    });
  };

  private handleMouseOver = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const telemetryId = target.getAttribute("data-telemetry-id") || target.id;
    if (telemetryId) {
      this.hoverStartTime.set(telemetryId, Date.now());
    }
  };

  private handleMouseOut = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const telemetryId = target.getAttribute("data-telemetry-id") || target.id;
    if (telemetryId) {
      const startTime = this.hoverStartTime.get(telemetryId);
      if (startTime) {
        const duration = Date.now() - startTime;
        this.hoverStartTime.delete(telemetryId);

        if (duration > 100) {
          this.queueEvent({
            session_id: this.sessionId,
            event_type: "hover",
            element_id: telemetryId,
            hover_duration_ms: duration,
          });
        }
      }
    }
  };

  private handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.syncTelemetry();
    } else {
      this.handleInteraction();
    }
  };

  public trackCustomEvent(eventType: string, details: Partial<TelemetryPayload>): void {
    this.queueEvent({
      session_id: this.sessionId,
      event_type: eventType,
      ...details,
    });
  }

  private queueEvent(event: TelemetryPayload): void {
    this.eventQueue.push(event);
    if (this.eventQueue.length >= 20) {
      this.syncTelemetry();
    }
  }

  private calculateRecentMouseSpeed(limitMs: number): number {
    const now = Date.now();
    const recent = this.mouseMovements.filter((m) => now - m.time <= limitMs);
    if (recent.length < 2) return 0;

    let distance = 0;
    for (let i = 1; i < recent.length; i++) {
      const dx = recent[i].x - recent[i - 1].x;
      const dy = recent[i].y - recent[i - 1].y;
      distance += Math.sqrt(dx * dx + dy * dy);
    }
    const timeDelta = recent[recent.length - 1].time - recent[0].time;
    return timeDelta > 0 ? (distance / timeDelta) * 1000 : 0;
  }

  public checkIdleState(): void {
    const now = Date.now();
    if (!this.isIdle && now - this.lastInteractionTime > this.idleThresholdMs) {
      this.isIdle = true;
      this.idleStartTime = this.lastInteractionTime;
    }
  }

  private async syncTelemetry(): Promise<void> {
    this.checkIdleState();
    if (this.eventQueue.length === 0) return;
    if (!auth.currentUser) return;

    const eventsToSync = [...this.eventQueue];
    this.eventQueue = [];

    for (const event of eventsToSync) {
      try {
        await authFetch("/api/telemetry", {
          method: "POST",
          body: JSON.stringify(event),
        });
      } catch (error) {
        console.error("Failed to send telemetry event:", error);
        this.eventQueue.unshift(event);
      }
    }
  }

  private syncTelemetrySync(): void {
    this.checkIdleState();
    if (this.eventQueue.length === 0) return;
    if (!auth.currentUser) return;

    const events = [...this.eventQueue];
    this.eventQueue = [];

    events.forEach(async (event) => {
      try {
        await authFetch("/api/telemetry", {
          method: "POST",
          body: JSON.stringify(event),
          keepalive: true,
        });
      } catch (e) {
        console.error("Error in keepalive fetch", e);
      }
    });
  }
}

export const tracker = new BehavioralTracker();
