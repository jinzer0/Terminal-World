import { SystemClock, type Clock } from './clock.js';

export type PresenceStatus = 'offline' | 'online' | 'away';

export interface PresenceChangedPayload {
  memberId: string;
  nickname: string;
  status: PresenceStatus;
  activeSessionCount: number;
  occurredAt: string;
}

export interface AvatarMovedPayload {
  sessionId: string;
  memberId: string | null;
  nickname: string | null;
  isGuest: boolean;
  spaceId: string;
  worldX: number;
  worldY: number;
  status: PresenceStatus | 'guest';
  occurredAt: string;
}

export interface ChatMessagePayload {
  id: string;
  roomId: string;
  authorMemberId: string | null;
  authorNickname: string;
  body: string;
  sentAt: string;
  expiresAt: string;
}

export interface ChatDeletedPayload {
  id: string;
  roomId: string;
  deletedAt: string;
}

export interface FocusChangedPayload {
  memberId: string;
  nickname: string;
  state: 'started' | 'stopped';
  focusSessionId: string;
  startedAt: string;
  endedAt: string | null;
  countedSeconds: number | null;
  occurredAt: string;
}

export interface SessionEndedPayload {
  sessionId: string;
  memberId: string | null;
  isGuest: boolean;
  reason: string;
  mode: 'normal' | 'disconnect';
  endedAt: string;
}

export interface RealtimeEventMap {
  'presence.changed': PresenceChangedPayload;
  'avatar.moved': AvatarMovedPayload;
  'chat.message': ChatMessagePayload;
  'chat.deleted': ChatDeletedPayload;
  'focus.changed': FocusChangedPayload;
  'session.ended': SessionEndedPayload;
}

export type RealtimeEventType = keyof RealtimeEventMap;

export interface RealtimeEvent<K extends RealtimeEventType = RealtimeEventType> {
  type: K;
  seq: number;
  timestamp: string;
  payload: RealtimeEventMap[K];
}

export type RealtimeEventListener<K extends RealtimeEventType = RealtimeEventType> = (
  event: RealtimeEvent<K>,
) => void;

export type RealtimeAnyListener = (event: RealtimeEvent) => void;

/**
 * In-process typed pub/sub hub used by SSH TUI sessions and the local SSE Bridge.
 * Listener errors are isolated per subscriber so one failing client cannot disrupt others.
 */
export class RealtimeHub {
  private readonly typedListeners = new Map<RealtimeEventType, Set<RealtimeEventListener<RealtimeEventType>>>();
  private readonly anyListeners = new Set<RealtimeAnyListener>();
  private seq = 0;

  constructor(private readonly clock: Clock = new SystemClock()) {}

  subscribe<K extends RealtimeEventType>(
    type: K,
    listener: RealtimeEventListener<K>,
  ): () => void {
    let set = this.typedListeners.get(type);
    if (!set) {
      set = new Set();
      this.typedListeners.set(type, set);
    }
    const wrapped = listener as RealtimeEventListener<RealtimeEventType>;
    set.add(wrapped);
    return () => {
      this.unsubscribe(type, listener);
    };
  }

  unsubscribe<K extends RealtimeEventType>(
    type: K,
    listener: RealtimeEventListener<K>,
  ): void {
    const set = this.typedListeners.get(type);
    if (!set) return;
    set.delete(listener as RealtimeEventListener<RealtimeEventType>);
    if (set.size === 0) {
      this.typedListeners.delete(type);
    }
  }

  subscribeAll(listener: RealtimeAnyListener): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.unsubscribeAll(listener);
    };
  }

  unsubscribeAll(listener: RealtimeAnyListener): void {
    this.anyListeners.delete(listener);
  }

  subscribeMany<K extends RealtimeEventType>(
    types: readonly K[],
    listener: (event: RealtimeEvent<K>) => void,
  ): () => void {
    const unsubscribers = types.map((type) =>
      this.subscribe(type, listener as RealtimeEventListener<K>),
    );
    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }

  publish<K extends RealtimeEventType>(
    type: K,
    payload: RealtimeEventMap[K],
    timestamp?: string,
  ): RealtimeEvent<K> {
    this.seq += 1;
    const event: RealtimeEvent<K> = {
      type,
      seq: this.seq,
      timestamp: timestamp ?? this.clock.now().toISOString(),
      payload,
    };

    const listeners = this.typedListeners.get(type);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // Isolate individual subscriber failures (e.g., closed SSH/SSE stream).
        }
      }
    }

    for (const listener of [...this.anyListeners]) {
      try {
        listener(event);
      } catch {
        // Isolate individual subscriber failures.
      }
    }

    return event;
  }

  listenerCount(type?: RealtimeEventType): number {
    if (type) {
      return (this.typedListeners.get(type)?.size ?? 0) + this.anyListeners.size;
    }
    let count = this.anyListeners.size;
    for (const set of this.typedListeners.values()) {
      count += set.size;
    }
    return count;
  }

  clear(): void {
    this.typedListeners.clear();
    this.anyListeners.clear();
  }
}
